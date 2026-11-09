import {
  SUMMARY_ENABLED,
  SUMMARY_INPUT_CHARS,
  SUMMARY_KEEP,
  SUMMARY_KEEP_TOKENS,
  SUMMARY_MAX_CALLS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_KEEP,
  SUMMARY_TRIGGER,
  SUMMARY_TRIGGER_TOKENS,
} from '../config.js';
import { estimateTokens } from '../domain/chat.js';
import { chatCompletion } from '../ai/llm.js';
import { isAbort, withTimeout } from '../shared/utils.js';
import { recordLlmUsage } from './usage-service.js';

export class CompactionBusyError extends Error {
  constructor() {
    super('会话正在压缩，请稍后重试');
    this.name = 'CompactionBusyError';
    this.code = 'COMPACTION_BUSY';
  }
}

const activeCompactions = new Set();

function clipText(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatSummaryMessage(message) {
  if (message.role === 'user') {
    let text = `用户：${clipText(message.content, 1200)}`;
    if (Array.isArray(message.references) && message.references.length) {
      text += `（参考图 ${message.references.map((ref) => `${ref.role || '参考'}:${ref.id}`).join('、')}）`;
    } else if (message.referenceImageId) {
      text += `（参考图 ${message.referenceImageId}）`;
    }
    if (Array.isArray(message.attachments) && message.attachments.length) {
      text += `（附件：${message.attachments
        .map((attachment) => `${attachment.name || '文件'}${attachment.chars ? ` ${attachment.chars} 字符` : ''}`)
        .join('、')}）`;
    }
    return text;
  }
  if (message.role === 'assistant') {
    let text = `助手：${clipText(message.content, 1200)}`;
    const images = (message.images || [])
      .map(
        (img) =>
          `${img.id}${img.prompt ? `「${clipText(img.prompt, 200)}」` : ''}${
            img.parentId ? `（基于 ${img.parentId}）` : ''
          }`,
      )
      .join('；');
    if (images) text += `\n生成图片：${images}`;
    return text;
  }
  return '';
}

function messageTokens(message) {
  let text = String(message.content || '');
  for (const image of message.images || []) text += `\n${image.id} ${image.prompt || ''}`;
  for (const ref of message.references || []) text += `\n${ref.id} ${ref.role || ''}`;
  for (const attachment of message.attachments || []) {
    text += `\n${attachment.name || ''}\n${attachment.text || ''}`;
  }
  return estimateTokens(text) + 4;
}

function pendingTokens(messages, start) {
  let tokens = 0;
  for (let index = start; index < messages.length; index += 1) {
    tokens += messageTokens(messages[index]);
  }
  return tokens;
}

function chooseTarget(messages, start, force) {
  const length = messages.length;
  const available = length - start;
  if (available <= 0) return start;

  const minKeep = Math.min(SUMMARY_MIN_KEEP, available);
  if (force) return Math.max(start, length - minKeep);

  let tokenStart = length;
  let tokens = 0;
  for (let index = length - 1; index >= start; index -= 1) {
    const count = length - index;
    const cost = messageTokens(messages[index]);
    if (count > SUMMARY_KEEP) break;
    if (tokens + cost > SUMMARY_KEEP_TOKENS && count > minKeep) break;
    tokens += cost;
    tokenStart = index;
  }

  // Keep at most SUMMARY_KEEP messages, and at least SUMMARY_MIN_KEEP.
  const countStart = Math.max(start, length - SUMMARY_KEEP);
  const target = Math.max(tokenStart, countStart, start);
  return Math.min(target, length - minKeep);
}

function buildFallbackSummary(previous, transcript) {
  const lines = transcript
    .split('\n')
    .filter(Boolean)
    .slice(-24)
    .map((line) => clipText(line, 240));
  return clipText(
    [previous, '【自动摘录】', ...lines].filter(Boolean).join('\n'),
    SUMMARY_MAX_CHARS,
  );
}

async function summarizeConversation(llm, previous, transcript, signal, onUsage) {
  const prompt = [
    '你在为一段图片创作对话维护长期记忆，供后续轮次继续工作。',
    `请把已有记忆和新增对话整理成不超过 ${SUMMARY_MAX_CHARS} 字的中文记忆卡。`,
    '必须使用以下结构；没有内容的项写「无」：',
    '【用户目标与偏好】',
    '【已确认的方案与事实】',
    '【图片记忆】逐张保留 image_id、画面内容/提示词、画幅，以及基于/改版关系',
    '【当前进度与未完成事项】',
    '【最近一次用户要求】',
    '要求：保留用户原话中的专有名词、数字、画幅、风格、文字要求；不要编造；不要只写“用户想要图片”。',
    previous ? `\n\n已有记忆：\n${clipText(previous, SUMMARY_MAX_CHARS)}` : '',
    `\n\n新增对话：\n${transcript}`,
  ].join('');

  const messages = [{ role: 'user', content: prompt }];
  const parsed = await chatCompletion(
    llm,
    messages,
    {
      tools: false,
      maxTokens: 2048,
      temperature: 0.2,
      signal: withTimeout(signal, 60),
    },
  );
  onUsage?.(parsed, messages);
  return String(parsed?.choices?.[0]?.message?.content || '').trim().slice(0, SUMMARY_MAX_CHARS);
}

async function compressChat(chat, llm, signal, { saveSummary, emit, force }) {
  if (typeof saveSummary !== 'function') throw new Error('压缩会话需要 saveSummary');
  const messages = chat.messages || [];
  const start = Math.max(0, chat.summaryUpto || 0);
  const available = messages.length - start;
  if (available <= 0) return { compacted: false, summary: chat.summary || '', upto: start };

  const pending = pendingTokens(messages, start);
  const shouldRun = force || available > SUMMARY_TRIGGER || pending > SUMMARY_TRIGGER_TOKENS;
  if (!shouldRun) return { compacted: false, summary: chat.summary || '', upto: start };

  const target = chooseTarget(messages, start, force);
  if (target <= start) return { compacted: false, summary: chat.summary || '', upto: start };

  if (activeCompactions.has(chat.id)) {
    if (force) throw new CompactionBusyError();
    return { compacted: false, busy: true, summary: chat.summary || '', upto: start };
  }
  activeCompactions.add(chat.id);

  emit?.({ type: 'status', text: '整理较早的对话…' });
  let cursor = start;
  let summary = chat.summary || '';
  let calls = 0;
  let fallbackOnly = false;
  let usedFallback = false;

  try {
    while (cursor < target && calls < SUMMARY_MAX_CALLS) {
      const batch = [];
      let chars = 0;
      while (cursor < target) {
        const text = formatSummaryMessage(messages[cursor]);
        if (text && chars + text.length + 1 > SUMMARY_INPUT_CHARS && batch.length) break;
        if (text) {
          batch.push(text);
          chars += text.length + 1;
        }
        cursor += 1;
      }
      if (!batch.length) break;

      let next = '';
      if (!fallbackOnly) {
        try {
          next = await summarizeConversation(llm, summary, batch.join('\n'), signal, (response, sent) =>
            recordLlmUsage({
              userId: chat.userId,
              chatId: chat.id,
              kind: 'summary',
              model: llm.model,
              providerId: llm.providerId,
              providerName: llm.providerName,
              usage: response?.usage,
              messages: sent,
              completionText: response?.choices?.[0]?.message?.content,
            }),
          );
        } catch (err) {
          if (isAbort(err)) throw err;
          fallbackOnly = true;
          usedFallback = true;
          console.warn('对话摘要模型不可用，改用自动摘录:', err.message);
        }
      }
      if (!next) {
        usedFallback = true;
        next = buildFallbackSummary(summary, batch.join('\n'));
      }
      if (!next) break;

      summary = clipText(next, SUMMARY_MAX_CHARS);
      chat.summary = summary;
      chat.summaryUpto = cursor;
      saveSummary(chat.userId, chat.id, summary, cursor);
      calls += 1;
    }

    if (chat.summaryUpto > start) {
      emit?.({ type: 'summary', summary: chat.summary, upto: chat.summaryUpto });
      return {
        compacted: true,
        fallback: usedFallback,
        summary: chat.summary,
        upto: chat.summaryUpto,
      };
    }
    return { compacted: false, fallback: usedFallback, summary: chat.summary || '', upto: start };
  } catch (err) {
    if (isAbort(err)) throw err;
    console.warn('对话压缩失败:', err.message);
    return {
      compacted: chat.summaryUpto > start,
      fallback: usedFallback,
      summary: chat.summary || '',
      upto: chat.summaryUpto || start,
    };
  } finally {
    activeCompactions.delete(chat.id);
  }
}

export async function maybeCompressChat(chat, llm, signal, emit, { saveSummary } = {}) {
  if (!SUMMARY_ENABLED) return { compacted: false, summary: chat.summary || '', upto: chat.summaryUpto || 0 };
  return compressChat(chat, llm, signal, { saveSummary, emit, force: false });
}

export async function compressChatNow(chat, llm, signal, { saveSummary } = {}) {
  return compressChat(chat, llm, signal, { saveSummary, emit: null, force: true });
}
