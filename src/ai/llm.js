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

function deltaText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function mergeToolCall(calls, part) {
  if (!part || typeof part !== 'object') return;
  const index = Number.isInteger(part.index) ? part.index : 0;
  let call = calls.get(index);
  if (!call) {
    call = { id: '', type: 'function', function: { name: '', arguments: '' } };
    calls.set(index, call);
  }
  if (part.id) call.id = part.id;
  if (part.type) call.type = part.type;
  if (part.function?.name) call.function.name += part.function.name;
  if (part.function?.arguments) {
    call.function.arguments +=
      typeof part.function.arguments === 'string'
        ? part.function.arguments
        : JSON.stringify(part.function.arguments);
  }
}

async function readChatStream(res, onDelta) {
  if (!res.body) throw new Error('对话模型没有返回可读取的数据');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const content = [];
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  let buffer = '';

  const handleLine = (line) => {
    const clean = line.replace(/\r$/, '');
    if (!clean.startsWith('data:')) return;
    const payload = clean.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (data?.error) {
      throw new Error(`对话模型请求失败：${extractError(JSON.stringify(data))}`);
    }
    const choice = data?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const text = deltaText(delta.content);
    if (text) {
      content.push(text);
      onDelta?.(text);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) mergeToolCall(calls, part);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (data.usage) usage = data.usage;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  const message = { role: 'assistant', content: content.join('') };
  if (calls.size) {
    message.tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }
  return {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export async function streamChatCompletion(
  llm,
  messages,
  { signal, tools = true, temperature, maxTokens = 4096, model, onDelta } = {},
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
    stream: true,
  };
  if (tools) {
    body.tools = TOOLS;
    body.tool_choice = 'auto';
  }
  const url = joinUrl(llm.baseUrl, '/chat/completions');
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
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
    } catch (err) {
      const retryable = attempt === 0 && !isAbort(err) && err?.name !== 'TimeoutError';
      if (!retryable) throw err;
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 700));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`对话模型请求失败 (${res.status})：${extractError(text)}`);
      if (res.status >= 500 && attempt === 0) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      throw error;
    }

    const contentType = String(res.headers.get('content-type') || '');
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        const responseText = parsed?.choices?.[0]?.message?.content;
        if (typeof responseText === 'string' && responseText) onDelta?.(responseText);
        return parsed;
      } catch {
        throw new Error('对话模型返回了无法解析的内容');
      }
    }

    return await readChatStream(res, onDelta);
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
