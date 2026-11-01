import {
  IMAGE_TIMEOUT,
  PROMPT_OPTIMIZE,
  PROMPT_MODEL,
} from '../config.js';
import {
  PROMPT_OPTIMIZE_SYSTEM,
  PROMPT_EDIT_SYSTEM,
  TOOLS,
} from './prompts.js';
import { skillSystemBlock } from '../domain/skill.js';
import { extractError, isAbort, joinUrl, withTimeout } from '../shared/utils.js';

export async function chatCompletion(
  llm,
  messages,
  { signal, tools = true, temperature, maxTokens = 2048, model } = {},
) {
  if (!llm.apiKey) throw new Error('未配置对话模型 API Key，请打开设置填写');
  const body = {
    model: model || llm.model,
    messages,
    temperature:
      typeof temperature === 'number'
        ? temperature
        : typeof llm.temperature === 'number'
          ? llm.temperature
          : 0.7,
    max_tokens: maxTokens,
  };
  if (tools) {
    body.tools = TOOLS;
    body.tool_choice = 'auto';
  }
  const url = joinUrl(llm.baseUrl, '/chat/completions');
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: withTimeout(signal, 120),
      });
      text = await res.text();
    } catch (err) {
      const retryable = attempt === 0 && !isAbort(err) && err?.name !== 'TimeoutError';
      if (!retryable) throw err;
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 700));
      continue;
    }

    if (!res.ok) {
      const error = new Error(`对话模型请求失败 (${res.status})：${extractError(text)}`);
      if (res.status >= 500 && attempt === 0) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      throw error;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('对话模型返回了无法解析的内容');
    }
  }

  throw lastError || new Error('对话模型请求失败');
}

export async function requestImage(imageCfg, pathname, init, signal) {
  if (!imageCfg.apiKey) throw new Error('未配置图片模型 API Key，请打开设置填写');
  const res = await fetch(joinUrl(imageCfg.baseUrl, pathname), {
    ...init,
    signal: withTimeout(signal, IMAGE_TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`图片模型请求失败 (${res.status})：${extractError(text)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('图片模型返回了无法解析的内容');
  }
  if (!Array.isArray(parsed.data) || !parsed.data.length) {
    throw new Error(extractError(text) || '图片模型没有返回图片');
  }
  return parsed.data;
}

export function sanitizeDirectedPrompt(text) {
  let value = String(text || '').trim();
  value = value.replace(/^```(?:[a-z]*)?\s*/i, '').replace(/\s*```$/i, '');
  value = value.replace(/^(?:final\s+)?(?:image\s+)?prompt\s*:\s*/i, '');
  value = value.replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
  if (value.length < 20 || value.length > 4000) return '';
  return value;
}

export async function directImagePrompt(
  llm,
  { userText, draft, aspectRatio, model, skill, mode = 'generate' },
  signal,
) {
  if (!PROMPT_OPTIMIZE || !llm?.apiKey) return draft;
  const system = mode === 'edit' ? PROMPT_EDIT_SYSTEM : PROMPT_OPTIMIZE_SYSTEM;
  const userPrompt = [
    `Mode: ${mode}`,
    `User request: ${userText || '(not provided)'}`,
    `Aspect ratio: ${aspectRatio || '1:1'}`,
    `Image model: ${model || 'gpt-image'}`,
    '',
    'Draft prompt:',
    draft,
  ].join('\n');
  try {
    const response = await chatCompletion(
      llm,
      [
        {
          role: 'system',
          content: system + skillSystemBlock(skill),
        },
        { role: 'user', content: userPrompt },
      ],
      {
        signal,
        tools: false,
        temperature: 0.35,
        maxTokens: 900,
        model: PROMPT_MODEL || undefined,
      },
    );
    const directed = sanitizeDirectedPrompt(response?.choices?.[0]?.message?.content);
    return directed || draft;
  } catch (err) {
    if (isAbort(err)) throw err;
    console.warn(`${mode === 'edit' ? '修改指令' : '提示词'}优化失败，使用原始提示词:`, err.message);
    return draft;
  }
}
