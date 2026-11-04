import { extractError } from '../shared/utils.js';
import { anthropicReasoning } from './reasoning.js';

export const ANTHROPIC_VERSION = '2023-06-01';

export function isAnthropic(llm) {
  return llm?.protocol === 'anthropic';
}

export function anthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

// Anthropic SDKs treat the base URL as the service root and request
// `/v1/messages`; gateways such as Bifrost expose `/anthropic` with the same
// convention. Accept either a root or an explicit `/v1` base.
export function anthropicBaseUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(base)) return base.slice(0, -'/messages'.length);
  if (/\/v1$/i.test(base)) return base;
  return `${base}/v1`;
}

export function anthropicEndpoint(baseUrl, path) {
  return `${anthropicBaseUrl(baseUrl)}${path}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      return '';
    })
    .join('');
}

function userContent(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(url || ''));
      if (match) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      }
    }
  }
  return blocks;
}

function toolInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function toAnthropicMessages(messages = []) {
  const system = [];
  const output = [];

  for (const message of messages) {
    if (!message?.role) continue;

    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }

    if (message.role === 'user') {
      const content = userContent(message.content);
      if (content.length) output.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      const content = [];
      const text = textOf(message.content);
      if (text) content.push({ type: 'text', text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function || {};
        if (!fn.name) continue;
        content.push({
          type: 'tool_use',
          id: call.id || `toolu_${content.length}`,
          name: fn.name,
          input: toolInput(fn.arguments),
        });
      }
      if (content.length) output.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id || '',
        content: textOf(message.content),
      };
      const last = output[output.length - 1];
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((part) => part.type === 'tool_result')
      ) {
        last.content.push(block);
      } else {
        output.push({ role: 'user', content: [block] });
      }
    }
  }

  return { system: system.join('\n\n'), messages: output };
}

export function toAnthropicTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    })
    .filter(Boolean);
}

export function buildAnthropicRequest(
  llm,
  messages,
  { tools = false, temperature, maxTokens = 4096, model, stream = false } = {},
) {
  const converted = toAnthropicMessages(messages);
  const body = {
    model: model || llm.model,
    messages: converted.messages,
    max_tokens: Math.max(1, Number(maxTokens) || 4096),
  };
  if (converted.system) body.system = converted.system;
  if (typeof temperature === 'number') {
    body.temperature = Math.min(1, Math.max(0, temperature));
  }
  if (stream) body.stream = true;
  Object.assign(body, anthropicReasoning(llm));
  if (tools) {
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length) {
      body.tools = anthropicTools;
      body.tool_choice = { type: 'auto' };
    }
  }
  return {
    url: anthropicEndpoint(llm.baseUrl, '/messages'),
    headers: anthropicHeaders(llm.apiKey),
    body,
  };
}

function stopReason(value) {
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'max_tokens') return 'length';
  if (value === 'refusal') return 'content_filter';
  return 'stop';
}

function usageOf(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

export function anthropicToOpenAiResponse(data) {
  if (data?.type === 'error' || data?.error) {
    throw new Error(extractError(JSON.stringify(data)));
  }
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = [];
  const calls = [];
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (block.text) text.push(block.text);
    } else if (block?.type === 'tool_use') {
      calls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments:
            typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        },
      });
    }
  }
  const message = { role: 'assistant', content: text.join('') };
  if (calls.length) message.tool_calls = calls;
  const usage = usageOf(data?.usage);
  return {
    choices: [
      {
        index: 0,
        message,
        finish_reason: stopReason(data?.stop_reason),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export async function readAnthropicStream(res, onDelta, onActivity) {
  if (!res.body) throw new Error('对话模型没有返回可读取的数据');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const text = [];
  const blocks = new Map();
  const calls = new Map();
  let stop = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let terminal = false;
  let buffer = '';

  const finalizeTool = (index) => {
    const block = blocks.get(index);
    if (!block || block.type !== 'tool_use') return;
    const raw = block.inputJson || JSON.stringify(block.initialInput || {});
    calls.set(index, {
      id: block.id || `toolu_${index}`,
      type: 'function',
      function: { name: block.name, arguments: raw },
    });
  };

  const handlePayload = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (data?.type === 'error' || data?.error) {
      throw new Error(`对话模型请求失败：${extractError(payload)}`);
    }

    if (data?.type === 'message_start') {
      inputTokens = Number(data.message?.usage?.input_tokens) || inputTokens;
      return;
    }

    if (data?.type === 'content_block_start') {
      const index = Number.isInteger(data.index) ? data.index : blocks.size;
      const block = data.content_block || {};
      const state = {
        type: block.type,
        id: block.id || '',
        name: block.name || '',
        initialInput: block.input,
        inputJson: '',
      };
      blocks.set(index, state);
      if (block.type === 'text' && block.text) {
        text.push(block.text);
        onDelta?.(block.text);
      }
      return;
    }

    if (data?.type === 'content_block_delta') {
      const block = blocks.get(data.index);
      const delta = data.delta || {};
      if (delta.type === 'text_delta' && delta.text) {
        text.push(delta.text);
        onDelta?.(delta.text);
      } else if (delta.type === 'input_json_delta' && block) {
        block.inputJson += delta.partial_json || '';
      }
      return;
    }

    if (data?.type === 'content_block_stop') {
      finalizeTool(data.index);
      return;
    }

    if (data?.type === 'message_delta') {
      if (data.delta?.stop_reason) stop = data.delta.stop_reason;
      if (data.usage) outputTokens = Number(data.usage.output_tokens) || outputTokens;
      return;
    }

    if (data?.type === 'message_stop') terminal = true;
  };

  while (true) {
    const { value, done } = await reader.read();
    onActivity?.();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) handlePayload(line.slice(5).trim());
      if (terminal) break;
    }
    if (terminal) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  buffer += decoder.decode();
  if (!terminal) {
    for (const line of buffer.split('\n')) {
      if (line.replace(/\r$/, '').startsWith('data:')) {
        handlePayload(line.replace(/\r$/, '').slice(5).trim());
        if (terminal) break;
      }
    }
  }
  if (!terminal) {
    const error = new Error('对话模型连接提前中断');
    error.retryable = true;
    throw error;
  }

  for (const index of blocks.keys()) finalizeTool(index);
  const message = { role: 'assistant', content: text.join('') };
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    choices: [{ index: 0, message, finish_reason: stopReason(stop) }],
    ...(inputTokens || outputTokens
      ? {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        }
      : {}),
  };
}
