import { CONTEXT_TOKEN_BUDGET, CONTEXT_WINDOW, SUMMARY_MAX_CHARS } from '../config.js';
import { newId, now } from '../shared/utils.js';

function clipText(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function isCjk(code) {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** Cheap token estimate: CJK chars are roughly one token, other text about four chars. */
export function estimateTokens(value) {
  const text = String(value || '');
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (isCjk(code)) tokens += 1;
    else if (code > 0xffff) tokens += 1;
    else if (!/\s/.test(char)) tokens += 0.25;
  }
  return Math.ceil(tokens);
}

// Two markers that mean the persisted memory card has lost facts:
//
//   * fallback — the model was unavailable, so a deterministic excerpt took its
//     place. Readable, but not a memory card.
//   * omitted  — the model returned more than the character budget and the
//     middle was cut to keep both the goals and the latest request.
//
// They are the only way to tell a lossy card from a good one after a restart,
// and they are what makes an explicit compaction able to repair itself: only a
// user-initiated run may re-read messages the card already claims to cover.
export const SUMMARY_OMITTED_MARK = '【中段已省略】';
export const SUMMARY_FALLBACK_MARK = '【自动摘录】';

/** True when the persisted card is known to have dropped facts. */
export function isLossySummary(summary) {
  const text = String(summary || '');
  if (!text) return false;
  if (text.includes(SUMMARY_FALLBACK_MARK) || text.includes(SUMMARY_OMITTED_MARK)) return true;
  // Cards written before the markers existed were cut with a clip that always
  // lands one character past the ceiling.
  return text.length > SUMMARY_MAX_CHARS;
}

/**
 * Keeps a card inside its character budget without deleting the newest facts.
 *
 * The asked-for structure ends with the latest user request, so clipping the
 * tail threw away exactly that. An over-long answer now loses its middle, and
 * the marker records the loss so an explicit compaction can rebuild it from the
 * original messages (which are never deleted).
 */
export function clipSummary(value) {
  const text = String(value || '').trim();
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const tailLength = Math.floor(SUMMARY_MAX_CHARS * 0.35);
  const headLength = Math.max(0, SUMMARY_MAX_CHARS - tailLength - SUMMARY_OMITTED_MARK.length);
  return `${text.slice(0, headLength)}${SUMMARY_OMITTED_MARK}${text.slice(-tailLength)}`;
}

function imageMemoryPart(image) {
  const parts = [`image_id=${image.id}`];
  if (image.prompt) parts.push(`prompt=${clipText(image.prompt, 180)}`);
  if (image.parentId) parts.push(`based_on=${image.parentId}`);
  if (image.aspectRatio) parts.push(`ratio=${image.aspectRatio}`);
  return parts.join(' | ');
}

export function buildImageMemory(chat, limit = 20) {
  const all = [];
  for (const message of chat.messages || []) {
    for (const image of message.images || []) all.push(image);
  }
  if (!all.length) return '';

  const recent = all.slice(-limit);
  const lines = recent.map((image) => `- ${imageMemoryPart(image)}`);
  const last = chat.lastImageId ? `\n最近一张：image_id=${chat.lastImageId}` : '';
  const hidden = all.length - recent.length;
  // Only point at the summary when one exists: an empty card plus "见摘要" is
  // an instruction to invent the missing ids.
  const omitted = hidden
    ? chat.summary
      ? `\n（更早的 ${hidden} 张见摘要）`
      : `\n（更早的 ${hidden} 张未加载，也没有摘要；不要编造它们的 image_id）`
    : '';
  return `【会话图片索引】\n${lines.join('\n')}${omitted}${last}`;
}

export function createChatDocument(userId) {
  return {
    id: newId(),
    userId,
    title: '',
    createdAt: now(),
    updatedAt: now(),
    lastImageId: null,
    coverUrl: null,
    messages: [],
    summary: '',
    summaryUpto: 0,
    workspaceJson: '',
  };
}

export function serializeChat(chat) {
  const withImages = [...chat.messages].reverse().find((message) => message.images?.length);
  return {
    id: chat.id,
    userId: chat.userId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastImageId: chat.lastImageId || null,
    coverUrl: withImages?.images?.[0]?.url || null,
    messagesJson: JSON.stringify(chat.messages),
    summary: chat.summary || '',
    summaryUpto: chat.summaryUpto || 0,
    workspaceJson: chat.workspaceJson || '',
  };
}

function workspaceToClient(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.root) return null;
    return { root: parsed.root, name: parsed.name || '' };
  } catch {
    return null;
  }
}

function attachmentPromptBlocks(message) {
  const list = (Array.isArray(message.attachments) ? message.attachments : []).filter(
    (attachment) => attachment?.id,
  );
  if (!list.length) return '';
  return list
    .map((attachment, index) =>
      [
        `[附件 ${index + 1}：${attachment.name || '未命名'}（${
          attachment.kind || attachment.ext || '文件'
        }${attachment.chars ? `，共 ${attachment.chars} 字符` : ''}）]`,
        String(attachment.text || '（内容不可用）'),
        `[附件 ${index + 1} 结束]`,
      ].join('\n'),
    )
    .join('\n\n');
}

export function chatToClient(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastImageId: chat.lastImageId,
    summary: chat.summary || '',
    summaryUpto: chat.summaryUpto || 0,
    archivedAt: chat.archivedAt || null,
    workspace: workspaceToClient(chat.workspaceJson),
    messages: chat.messages
      .filter(
        (message) =>
          !(
            message.draft &&
            !message.content &&
            !message.images?.length &&
            !String(message.process || '').trim()
          ),
      )
      .map((message) => {
        if (!Array.isArray(message.attachments) || !message.attachments.length) return message;
        return {
          ...message,
          attachments: message.attachments.map(({ text, ...rest }) => rest),
        };
      }),
  };
}

export function toLlmHistory(chat) {
  const rows = [];
  const all = chat.messages || [];
  const from = Math.max(0, chat.summaryUpto || 0);
  for (const message of all.slice(from)) {
    if (message.role === 'user') {
      let content = message.content || '';
      const refs = Array.isArray(message.references) && message.references.length
        ? message.references
        : message.referenceImageId
          ? [{ id: message.referenceImageId, role: '参考' }]
          : [];
      if (refs.length) {
        content +=
          '\n' +
          refs
            .map(
              (ref, index) =>
                `[参考图 ${index + 1}${ref.role && ref.role !== '参考' ? `（${ref.role}）` : ''} image_id=${ref.id}]`,
            )
            .join('\n');
      }
      const attachmentBlock = attachmentPromptBlocks(message);
      if (attachmentBlock) content = content ? `${content}\n\n${attachmentBlock}` : attachmentBlock;
      const row = { role: 'user', content };
      // The ids travel with the row so the async assembly step can attach the
      // pixels. This function stays synchronous: the context trimmer runs over
      // text, and reading image bytes here would make every caller async.
      if (refs.length) row.imageIds = refs.map((ref) => ref.id);
      rows.push(row);
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push(message.content);
      for (const image of message.images || []) {
        parts.push(`[已生成图片 ${imageMemoryPart(image)}]`);
      }
      if (parts.length) rows.push({ role: 'assistant', content: parts.join('\n') });
    }
  }

  // Keep the newest messages within both a token budget and a message cap.
  let start = rows.length;
  let tokens = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const count = rows.length - index;
    const cost = estimateTokens(rows[index].content) + 4;
    if (count > CONTEXT_WINDOW && count > 1) break;
    if (tokens + cost > CONTEXT_TOKEN_BUDGET && count > 1) break;
    tokens += cost;
    start = index;
  }
  const result = rows.slice(start);
  if (start > 0) {
    // This number is a gap, not a pointer to the summary. Rows already start at
    // the summary cutoff, so every row dropped here sits AFTER the summary and
    // exists nowhere in the request. The old code let the caller describe it as
    // "covered by the summary", which invited the model to invent the detail.
    result.omitted = start;
  }
  return result;
}
