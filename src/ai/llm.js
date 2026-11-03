import {
  IMAGE_TIMEOUT,
  LLM_STREAM_IDLE_TIMEOUT,
  LLM_TIMEOUT,
  PROMPT_OPTIMIZE,
  PROMPT_MODEL,
} from '../config.js';
import {
  PROMPT_OPTIMIZE_SYSTEM,
  PROMPT_EDIT_SYSTEM,
  TOOLS,
} from './prompts.js';
import { skillSystemBlock } from '../domain/skill.js';
import {
  anthropicToOpenAiResponse,
  buildAnthropicRequest,
  isAnthropic,
  readAnthropicStream,
} from './anthropic.js';
import {
  extractError,
  isAbort,
  isRetryableStatus,
  joinUrl,
  MAX_ATTEMPTS,
  networkError,
  retryDelay,
  withTimeout,
} from '../shared/utils.js';

function createIdleTimeout(parentSignal, seconds) {
  // A long answer is healthy while tokens keep arriving; only abort when the
  // provider goes silent. This replaces a total stream deadline.
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };
  const touch = () => {
    clear();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('请求超时', 'TimeoutError'));
    }, Math.max(10, Number(seconds) * 1000));
  };
  touch();
  return {
    signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
    touch,
    clear,
    get timedOut() {
      return timedOut;
    },
  };
}

export async function chatCompletion(
  llm,
  messages,
  { signal, tools = true, temperature, maxTokens = 2048, model } = {},
) {
  if (!llm.apiKey) throw new Error('未配置对话模型 API Key，请打开设置填写');
  const resolvedTemperature =
    typeof temperature === 'number'
      ? temperature
      : typeof llm.temperature === 'number'
        ? llm.temperature
        : 0.7;
  const anthropic = isAnthropic(llm);
  const request = anthropic
    ? buildAnthropicRequest(llm, messages, {
        tools: tools ? TOOLS : false,
        temperature: resolvedTemperature,
        maxTokens,
        model,
      })
    : {
        url: joinUrl(llm.baseUrl, '/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: {
          model: model || llm.model,
          messages,
          temperature: resolvedTemperature,
          max_tokens: maxTokens,
          ...(tools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
        },
      };
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: withTimeout(signal, LLM_TIMEOUT),
      });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt + 1 >= MAX_ATTEMPTS) throw networkError(err);
      await retryDelay(attempt);
      continue;
    }

    if (!res.ok) {
      const error = new Error(`对话模型请求失败 (${res.status})：${extractError(text)}`);
      if (isRetryableStatus(res.status)) {
        if (attempt + 1 < MAX_ATTEMPTS) {
          lastError = error;
          await retryDelay(attempt);
          continue;
        }
        throw networkError(error);
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text);
      return anthropic ? anthropicToOpenAiResponse(parsed) : parsed;
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error('对话模型返回了无法解析的内容');
      throw err;
    }
  }

  throw networkError(lastError);
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

async function readChatStream(res, onDelta, onActivity) {
  if (!res.body) throw new Error('对话模型没有返回可读取的数据');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const content = [];
  const calls = new Map();
  let finishReason = null;
  let terminal = false;
  let usage = null;
  let buffer = '';

  const handleLine = (line) => {
    const clean = line.replace(/\r$/, '');
    if (!clean.startsWith('data:')) return;
    const payload = clean.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      terminal = true;
      return;
    }
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
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
      terminal = true;
    }
    if (data.usage) usage = data.usage;
  };

  while (true) {
    const { value, done } = await reader.read();
    onActivity?.();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (terminal) break;
    }
    if (terminal) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);
  if (!terminal) {
    const error = new Error('对话模型连接提前中断');
    error.retryable = true;
    throw error;
  }

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
  {
    signal,
    tools = true,
    temperature,
    maxTokens = 4096,
    model,
    onDelta,
    onReset,
    idleTimeout = LLM_STREAM_IDLE_TIMEOUT,
  } = {},
) {
  if (!llm.apiKey) throw new Error('未配置对话模型 API Key，请打开设置填写');
  const resolvedTemperature =
    typeof temperature === 'number'
      ? temperature
      : typeof llm.temperature === 'number'
        ? llm.temperature
        : 0.7;
  const anthropic = isAnthropic(llm);
  const request = anthropic
    ? buildAnthropicRequest(llm, messages, {
        tools: tools ? TOOLS : false,
        temperature: resolvedTemperature,
        maxTokens,
        model,
        stream: true,
      })
    : {
        url: joinUrl(llm.baseUrl, '/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: {
          model: model || llm.model,
          messages,
          temperature: resolvedTemperature,
          max_tokens: maxTokens,
          stream: true,
          ...(tools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
        },
      };
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const idle = createIdleTimeout(signal, idleTimeout);
    let didOutput = false;
    const emitDelta = (text) => {
      didOutput = true;
      onDelta?.(text);
    };
    try {
      const res = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: idle.signal,
      });
      idle.touch();

      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`对话模型请求失败 (${res.status})：${extractError(text)}`);
        if (isRetryableStatus(res.status)) {
          if (attempt + 1 < MAX_ATTEMPTS) {
            lastError = error;
            await retryDelay(attempt);
            continue;
          }
          error.retryable = true;
          throw error;
        }
        error.retryable = false;
        throw error;
      }

      const contentType = String(res.headers.get('content-type') || '');
      if (!contentType.includes('text/event-stream')) {
        const text = await res.text();
        idle.touch();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const error = new Error('对话模型返回了无法解析的内容');
          error.retryable = false;
          throw error;
        }
        if (anthropic) {
          try {
            parsed = anthropicToOpenAiResponse(parsed);
          } catch (err) {
            err.retryable = false;
            throw err;
          }
        }
        const responseText = parsed?.choices?.[0]?.message?.content;
        if (typeof responseText === 'string' && responseText) emitDelta(responseText);
        return parsed;
      }

      return anthropic
        ? await readAnthropicStream(res, emitDelta, idle.touch)
        : await readChatStream(res, emitDelta, idle.touch);
    } catch (err) {
      if (signal?.aborted) throw err;
      const retryable =
        err?.retryable !== false &&
        (idle.timedOut || !isAbort(err) || err?.name === 'TimeoutError');
      if (!retryable) throw err;
      if (attempt + 1 >= MAX_ATTEMPTS) throw networkError(err);
      if (didOutput) onReset?.();
      lastError = err;
      await retryDelay(attempt);
    } finally {
      idle.clear();
    }
  }

  throw networkError(lastError);
}

export async function requestImage(imageCfg, pathname, init, signal) {
  if (!imageCfg.apiKey) throw new Error('未配置图片模型 API Key，请打开设置填写');
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetch(joinUrl(imageCfg.baseUrl, pathname), {
        ...init,
        signal: withTimeout(signal, IMAGE_TIMEOUT),
      });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt + 1 >= MAX_ATTEMPTS) throw networkError(err);
      await retryDelay(attempt);
      continue;
    }

    if (!res.ok) {
      const error = new Error(`图片模型请求失败 (${res.status})：${extractError(text)}`);
      if (isRetryableStatus(res.status)) {
        if (attempt + 1 < MAX_ATTEMPTS) {
          lastError = error;
          await retryDelay(attempt);
          continue;
        }
        throw networkError(error);
      }
      throw error;
    }

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

  throw networkError(lastError);
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
