import {
  SUMMARY_ENABLED,
  SUMMARY_INPUT_CHARS,
  SUMMARY_KEEP,
  SUMMARY_KEEP_TOKENS,
  SUMMARY_MAX_CALLS,
  SUMMARY_MAX_CALLS_MANUAL,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_KEEP,
  SUMMARY_TRIGGER,
  SUMMARY_TRIGGER_TOKENS,
} from '../config.js';
import {
  SUMMARY_FALLBACK_MARK,
  clipSummary,
  estimateTokens,
  isLossySummary,
} from '../domain/chat.js';
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

// A summary request is bounded, a message is not. Every saved message is read
// in full — split into parts of at most SUMMARY_INPUT_CHARS — and the watermark
// only moves to a message boundary once that whole message has been summarised.
// Truncating a message to its head and then claiming it as covered is what used
// to delete the middle and tail of long turns from memory permanently.
const PART_BREAK = '\n';

// Safety bound for one uncommitted message. The call budget otherwise governs a
// run, but a single message larger than that budget must not be re-read from the
// top on every turn: it is allowed to spend whatever parts it needs, up to this
// ceiling (~2.4M characters), so the watermark can reach a message boundary.
const MAX_UNCOMMITTED_PARTS = 200;

// How much of the card the automatic excerpt keeps for the previous memory.
// Keeping the whole old card first is what used to push the newest turns out of
// the excerpt entirely.
const FALLBACK_PREVIOUS_SHARE = 0.4;

// After this many model failures in a row a run stops asking and excerpts the
// rest; a wrong API key otherwise costs one full timeout per batch.
const MODEL_FAILURE_LIMIT = 2;
const SUMMARY_CALL_TIMEOUT = 60;

const activeCompactions = new Set();

function clipText(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function hardClip(value, length) {
  const text = String(value || '');
  return text.length > length ? text.slice(0, length) : text;
}

/** Renders one saved message as summary input. Never truncates conversation. */
function formatSummaryMessage(message) {
  if (message.role === 'user') {
    let text = `用户：${String(message.content || '')}`;
    if (Array.isArray(message.references) && message.references.length) {
      text += `（参考图 ${message.references.map((ref) => `${ref.role || '参考'}:${ref.id}`).join('、')}）`;
    } else if (message.referenceImageId) {
      text += `（参考图 ${message.referenceImageId}）`;
    }
    if (Array.isArray(message.attachments) && message.attachments.length) {
      text += `（附件：${message.attachments
        .map((attachment) => `${attachment.name || '文件'}${attachment.chars ? ` ${attachment.chars} 字符` : ''}`)
        .join('、')}）`;
      // The extracted text IS the substance of an attachment turn. Summarising
      // only its file name produced memory cards with no facts in them.
      for (const attachment of message.attachments) {
        const body = String(attachment.text || '');
        if (body.trim()) text += `\n[附件正文 ${attachment.name || '文件'}]\n${body}`;
      }
    }
    return text;
  }
  if (message.role === 'assistant') {
    let text = `助手：${String(message.content || '')}`;
    const images = (message.images || [])
      .map(
        (img) =>
          `${img.id}${img.prompt ? `「${clipText(img.prompt, 200)}」` : ''}${
            img.parentId ? `（基于 ${img.parentId}）` : ''
          }${img.aspectRatio ? `（${img.aspectRatio}）` : ''}`,
      )
      .join('；');
    if (images) text += `\n生成图片：${images}`;
    return text;
  }
  return '';
}

/** Splits text on line boundaries where possible so parts stay readable. */
function splitText(text, size) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(PART_BREAK, size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Walks the messages that still need summarising, one part at a time.
 *
 * Each part carries `end`: the message watermark that becomes honest once this
 * part is actually IN a request. A part is the last one of its message only then,
 * so the caller claims the maximum `end` among the parts it really sent. Reading
 * ahead must not advance anything — the walker only reports what a part proves,
 * and a part that was fetched but never sent proves nothing.
 */
function createPartWalker(messages, start, target) {
  let msg = start;
  let part = 0;
  let parts = [];

  const load = () => {
    while (msg < target) {
      const text = formatSummaryMessage(messages[msg]);
      parts = text ? splitText(text, SUMMARY_INPUT_CHARS) : [];
      if (parts.length) return true;
      // A message with nothing observable (an empty turn) cannot be summarised,
      // so it is skipped instead of stalling the walk.
      msg += 1;
      part = 0;
    }
    return false;
  };

  if (!load()) return { next: () => null };

  return {
    next() {
      if (part >= parts.length) {
        msg += 1;
        part = 0;
        if (!load()) return null;
      }
      const last = part === parts.length - 1;
      const item = { text: parts[part], end: last ? msg + 1 : msg };
      part += 1;
      return item;
    },
  };
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
  const lines = transcript.split('\n').filter(Boolean);
  const markCost = SUMMARY_FALLBACK_MARK.length + 2;
  const previousBudget = Math.min(
    Math.floor(SUMMARY_MAX_CHARS * FALLBACK_PREVIOUS_SHARE),
    String(previous || '').length,
  );
  const previousText = previousBudget > 0 ? clipText(previous, previousBudget) : '';
  const budget = Math.max(0, SUMMARY_MAX_CHARS - markCost - previousText.length);
  // Newest lines win the remaining budget: the tail is what later turns need.
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1;
    if (used + cost > budget) break;
    kept.unshift(clipText(lines[index], 240));
    used += cost;
  }
  return hardClip(
    [previousText, SUMMARY_FALLBACK_MARK, ...kept].filter(Boolean).join('\n'),
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
    '新增对话可能只是某条长消息的一部分；这时按已有记忆继续累积，不要假设对话已经结束。',
    previous ? `\n\n已有记忆：\n${clipText(previous, SUMMARY_MAX_CHARS)}` : '',
    `\n\n新增对话：\n${transcript}`,
  ].join('');

  const messages = [{ role: 'user', content: prompt }];
  const parsed = await chatCompletion(
    // Hidden reasoning would eat the small completion budget these utility
    // calls get; the card only needs the visible text.
    { ...llm, thinkingDisabled: true },
    messages,
    {
      tools: false,
      maxTokens: 2048,
      temperature: 0.2,
      signal: withTimeout(signal, SUMMARY_CALL_TIMEOUT),
    },
  );
  onUsage?.(parsed, messages);
  return parsed?.choices?.[0];
}

function result(chat, { upto, extra = {} }) {
  return {
    compacted: false,
    complete: true,
    rebuilt: false,
    fallback: false,
    lossy: isLossySummary(chat.summary),
    error: null,
    summary: chat.summary || '',
    upto,
    pending: 0,
    ...extra,
  };
}

async function compressChat(chat, llm, signal, { saveSummary, emit, force, rebuild, maxCalls }) {
  if (typeof saveSummary !== 'function') throw new Error('压缩会话需要 saveSummary');
  const messages = chat.messages || [];
  const baselineUpto = Math.max(0, Math.min(messages.length, Number(chat.summaryUpto) || 0));
  const start = rebuild ? 0 : baselineUpto;
  const available = messages.length - start;
  if (available <= 0) return result(chat, { upto: baselineUpto });

  const pending = pendingTokens(messages, start);
  const shouldRun =
    force || rebuild || available > SUMMARY_TRIGGER || pending > SUMMARY_TRIGGER_TOKENS;
  if (!shouldRun) return result(chat, { upto: baselineUpto });

  let target = chooseTarget(messages, start, force);
  // A rebuild re-reads the original messages, but it must not settle for less
  // coverage than the card it replaces already claims.
  if (rebuild) target = Math.max(target, baselineUpto);
  target = Math.min(target, messages.length);
  if (target <= start) return result(chat, { upto: baselineUpto });

  if (activeCompactions.has(chat.id)) {
    if (force) throw new CompactionBusyError();
    return result(chat, { upto: baselineUpto, extra: { busy: true, complete: false } });
  }
  activeCompactions.add(chat.id);

  emit?.({ type: 'status', text: '整理较早的对话…' });

  const walker = createPartWalker(messages, start, target);
  let carry = walker.next();
  if (!carry) {
    activeCompactions.delete(chat.id);
    // A rebuild has nothing to rebuild from; leave the card and its coverage
    // exactly as they are rather than inventing a claim.
    if (rebuild) return result(chat, { upto: baselineUpto });
    // Nothing in the range carries text (only rows with no conversational role,
    // which the model never sees). Extending the watermark past them is honest
    // and stops every later turn from re-walking the same empty range.
    const upto = Math.max(baselineUpto, target);
    try {
      saveSummary(chat.userId, chat.id, chat.summary || '', upto);
      chat.summaryUpto = upto;
    } catch (err) {
      console.warn('对话压缩失败:', err.message);
      return result(chat, {
        upto: baselineUpto,
        extra: { error: err.message, pending: Math.max(0, target - baselineUpto) },
      });
    }
    return result(chat, { upto, extra: { compacted: true } });
  }
  let summary = rebuild ? '' : chat.summary || '';
  let calls = 0;
  let partsRead = 0;
  let failures = 0;
  let fallbackOnly = false;
  let usedFallback = false;
  let committed = false;
  let progressed = false;
  let interruption = null;

  /**
   * Publishes the card up to a message boundary. The watermark never moves
   * backwards: a rebuild starts at 0, so every intermediate write below the old
   * coverage is refused and an interrupted rebuild leaves the old card intact
   * instead of half-replacing it.
   */
  const commit = (nextSummary, upto) => {
    if (upto < baselineUpto) return false;
    if (!rebuild && upto <= baselineUpto) return false;
    // Persist first: a failed write must not leave this process and the database
    // disagreeing about what the card covers.
    saveSummary(chat.userId, chat.id, nextSummary, upto);
    chat.summary = nextSummary;
    chat.summaryUpto = upto;
    committed = true;
    return true;
  };

  try {
    while (carry) {
      // The call budget bounds an ordinary run. It does not stop a run that has
      // not yet crossed a message boundary, because such a run has produced
      // nothing a later turn can build on.
      if (progressed && calls >= maxCalls) break;
      if (!progressed && partsRead >= MAX_UNCOMMITTED_PARTS) break;

      // Only what this request actually contains may be claimed. `claimable` is
      // the furthest message boundary proven by a part inside the batch; a part
      // merely fetched as `carry` for the next round proves nothing.
      const batch = [];
      let chars = 0;
      let claimable = Math.min(start, target);
      while (carry) {
        const cost = carry.text.length + 1;
        if (batch.length && chars + cost > SUMMARY_INPUT_CHARS) break;
        batch.push(carry.text);
        chars += cost;
        partsRead += 1;
        if (carry.end > claimable) claimable = Math.min(carry.end, target);
        carry = walker.next();
        if (chars >= SUMMARY_INPUT_CHARS) break;
      }
      if (!batch.length) break;

      const transcript = batch.join('\n');

      let next = '';
      if (!fallbackOnly) {
        try {
          const choice = await summarizeConversation(llm, summary, transcript, signal, (response, sent) =>
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
          if (choice?.finish_reason === 'length') {
            interruption = '模型摘要被截断，可重试以继续整理原文';
            break;
          }
          next = String(choice?.message?.content || '').trim();
          failures = 0;
        } catch (err) {
          if (isAbort(err)) throw err;
          failures += 1;
          if (failures >= MODEL_FAILURE_LIMIT) fallbackOnly = true;
          console.warn('对话摘要模型不可用，改用自动摘录:', err.message);
        }
      }
      if (!next) {
        if (rebuild) {
          interruption = '摘要模型不可用，已保留原记忆';
          break;
        }
        usedFallback = true;
        next = buildFallbackSummary(summary, transcript);
      }
      if (!next) break;

      summary = clipSummary(next);
      calls += 1;
      if (commit(summary, claimable)) progressed = true;
    }

    const upto = Number(chat.summaryUpto) || 0;
    // Coverage, not loop exit: a run that was refused every commit (nothing
    // reached a message boundary yet) has not finished the backlog, and saying
    // otherwise would let the UI report a half-covered session as done.
    const complete = upto >= target && !interruption;
    if (committed) emit?.({ type: 'summary', summary: chat.summary, upto });
    return result(chat, {
      upto,
      extra: {
        compacted: committed,
        complete,
        rebuilt: Boolean(rebuild && committed),
        fallback: usedFallback,
        error: interruption,
        pending: Math.max(0, target - upto),
      },
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    console.warn('对话压缩失败:', err.message);
    const upto = Number(chat.summaryUpto) || 0;
    return result(chat, {
      upto,
      extra: {
        compacted: committed,
        complete: false,
        rebuilt: Boolean(rebuild && committed),
        fallback: usedFallback,
        error: err.message,
        pending: Math.max(0, target - upto),
      },
    });
  } finally {
    activeCompactions.delete(chat.id);
  }
}

/**
 * Compaction before a turn.
 *
 * Bounded by SUMMARY_MAX_CALLS: this runs while the user waits for an answer, so
 * it makes steady progress across turns instead of summarising an arbitrarily
 * large backlog in one go. It only ever continues from the watermark; messages
 * an existing card already covers are never re-read here.
 */
export async function maybeCompressChat(chat, llm, signal, emit, { saveSummary } = {}) {
  if (!SUMMARY_ENABLED) {
    return result(chat, { upto: Math.max(0, chat.summaryUpto || 0) });
  }
  return compressChat(chat, llm, signal, {
    saveSummary,
    emit,
    force: false,
    rebuild: false,
    maxCalls: SUMMARY_MAX_CALLS,
  });
}

/**
 * Compaction the user asked for.
 *
 * Uses the manual budget, which covers a whole backlog rather than one turn's
 * worth, and rebuilds from the original messages when the persisted card is
 * known to be lossy. This is the only entry point that may re-read covered
 * messages, and the only path that can repair a truncated or excerpt-only card.
 */
export async function compressChatNow(chat, llm, signal, { saveSummary, rebuild = false } = {}) {
  return compressChat(chat, llm, signal, {
    saveSummary,
    emit: null,
    force: true,
    rebuild: Boolean(rebuild),
    maxCalls: SUMMARY_MAX_CALLS_MANUAL,
  });
}
