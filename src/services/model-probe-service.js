import { IMAGE_QUALITY } from '../config.js';
import { requestImage } from '../ai/llm.js';
import { draftSettings } from './model-settings-service.js';
import { extractError, friendlyError, joinUrl, withTimeout } from '../shared/utils.js';

export async function listModels({ userId, body }) {
  const target = body.target === 'image' ? 'image' : 'llm';
  const cfg = draftSettings(body, target, userId);
  if (cfg.error) return { ok: false, error: cfg.error };
  if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key' };

  const started = Date.now();
  let response;
  let text;
  try {
    response = await fetch(joinUrl(cfg.baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: withTimeout(undefined, 20),
    });
    text = await response.text();
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }

  if (!response.ok) {
    let hint;
    if (response.status === 401 || response.status === 403) {
      hint = '该接口不支持模型列表或 Key 无权限，可直接手动填写模型名';
    } else if (response.status === 404) {
      hint = '该接口没有 /models 端点，可直接手动填写模型名';
    } else {
      hint = extractError(text);
    }
    return { ok: false, error: `获取失败 (${response.status})：${hint}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '接口返回的不是 JSON' };
  }

  const raw = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : Array.isArray(parsed)
        ? parsed
        : [];
  const models = [
    ...new Set(
      raw
        .map((item) => (typeof item === 'string' ? item : item?.id || item?.name || ''))
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (!models.length) return { ok: false, error: '接口未返回模型列表' };
  return {
    ok: true,
    models: models.slice(0, 200),
    latencyMs: Date.now() - started,
  };
}

export async function testModel({ userId, body }) {
  const target = body.target === 'image' ? 'image' : 'llm';
  const cfg = draftSettings(body, target, userId);
  if (cfg.error) return { ok: false, error: cfg.error };
  if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key' };

  const started = Date.now();

  if (target === 'llm') {
    let response;
    let text;
    try {
      response = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '请只回复：OK' }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
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
          quality: IMAGE_QUALITY,
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
