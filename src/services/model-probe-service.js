import { IMAGE_QUALITY } from '../config.js';
import { requestImage } from '../ai/llm.js';
import { openAiReasoning } from '../ai/reasoning.js';
import {
  anthropicEndpoint,
  anthropicHeaders,
  anthropicToOpenAiResponse,
  buildAnthropicRequest,
} from '../ai/anthropic.js';
import { draftSettings } from './model-settings-service.js';
import { extractError, friendlyError, joinUrl, withTimeout } from '../shared/utils.js';

function modelListUrls(cfg) {
  if (cfg.protocol === 'anthropic') return [anthropicEndpoint(cfg.baseUrl, '/models')];

  const urls = [joinUrl(cfg.baseUrl, '/models')];
  try {
    const base = new URL(cfg.baseUrl);
    const path = base.pathname.replace(/\/+$/, '');
    // Bifrost exposes its model catalog at /openai/models while the standard
    // OpenAI-compatible /v1/models path is not routed by the reverse proxy.
    if (/\/v1$/i.test(path)) {
      const rootPath = path.slice(0, -3);
      if (!/\/openai$/i.test(rootPath)) {
        urls.push(`${base.origin}${rootPath}/openai/models`);
      }
    }
  } catch {
    /* draftSettings already validated the URL */
  }
  return [...new Set(urls)];
}

function modelsFromPayload(parsed) {
  const raw = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : Array.isArray(parsed)
        ? parsed
        : [];
  return [
    ...new Set(
      raw
        .map((item) => (typeof item === 'string' ? item : item?.id || item?.name || ''))
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function listModelsError(response, text) {
  let hint;
  if (response.status === 401 || response.status === 403) {
    hint = '该接口不支持模型列表或 Key 无权限，可直接手动填写模型名';
  } else if (response.status === 404) {
    hint = '该接口没有 /models 端点，可直接手动填写模型名';
  } else {
    hint = extractError(text);
  }
  return `获取失败 (${response.status})：${hint}`;
}

export async function listModels({ userId, body }) {
  const target = body.target === 'image' ? 'image' : 'llm';
  const cfg = draftSettings(body, target, userId);
  if (cfg.error) return { ok: false, error: cfg.error };
  if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key' };

  const started = Date.now();
  let lastError = '获取失败';

  for (const url of modelListUrls(cfg)) {
    let response;
    let text;
    try {
      response = await fetch(url, {
        headers:
          cfg.protocol === 'anthropic'
            ? anthropicHeaders(cfg.apiKey)
            : { Authorization: `Bearer ${cfg.apiKey}` },
        signal: withTimeout(undefined, 20),
      });
      text = await response.text();
    } catch (err) {
      lastError = friendlyError(err);
      continue;
    }

    if (!response.ok) {
      lastError = listModelsError(response, text);
      if (response.status === 401 || response.status === 400 || response.status >= 500) break;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastError = '接口返回的不是 JSON';
      continue;
    }

    const models = modelsFromPayload(parsed);
    if (!models.length) {
      lastError = '接口未返回模型列表';
      continue;
    }

    return {
      ok: true,
      models: models.slice(0, 200),
      latencyMs: Date.now() - started,
    };
  }

  return { ok: false, error: lastError };
}

export async function testModel({ userId, body }) {
  const target = body.target === 'image' ? 'image' : 'llm';
  const cfg = draftSettings(body, target, userId);
  if (cfg.error) return { ok: false, error: cfg.error };
  if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key' };

  const started = Date.now();

  if (target === 'llm') {
    let request;
    if (cfg.protocol === 'anthropic') {
      const built = buildAnthropicRequest(
        cfg,
        [{ role: 'user', content: '请只回复：OK' }],
        { tools: false, maxTokens: 16, temperature: 0 },
      );
      request = {
        url: built.url,
        headers: built.headers,
        body: JSON.stringify(built.body),
      };
    } else {
      request = {
        url: joinUrl(cfg.baseUrl, '/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '请只回复：OK' }],
          max_tokens: 16,
          temperature: 0,
          ...openAiReasoning(cfg),
          stream: false,
        }),
      };
    }

    let response;
    let text;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: withTimeout(undefined, 20),
      });
      text = await response.text();
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }

    if (!response.ok) {
      let hint;
      if (response.status === 401 || response.status === 403) hint = 'Key 无效或无权限';
      else if (response.status === 404) hint = '接口地址或模型不存在';
      else hint = extractError(text);
      return { ok: false, error: `连接失败 (${response.status})：${hint}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: '接口返回的不是 JSON' };
    }
    if (cfg.protocol === 'anthropic') {
      try {
        parsed = anthropicToOpenAiResponse(parsed);
      } catch (err) {
        return { ok: false, error: friendlyError(err) };
      }
    }
    if (!Array.isArray(parsed?.choices) || !parsed.choices.length) {
      return { ok: false, error: extractError(text) || '模型未返回有效响应' };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: '对话模型已响应',
    };
  }

  try {
    await requestImage(
      cfg,
      '/images/generations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          prompt: 'connectivity test: a single small gray dot on a white background',
          size: '1024x1024',
          n: 1,
          quality: cfg.quality || IMAGE_QUALITY,
        }),
      },
      undefined,
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: '图片模型已成功出图',
    };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}
