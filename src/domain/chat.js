import { CONTEXT_TOKEN_BUDGET, CONTEXT_WINDOW } from '../config.js';
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
  const omitted = all.length > recent.length ? `\n（更早的 ${all.length - recent.length} 张见摘要）` : '';
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
  };
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
    messages: chat.messages
      .filter((message) => !(message.draft && !message.content && !(message.images?.length)))
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
      if (Array.isArray(message.references) && message.references.length) {
        content +=
          '\n' +
          message.references
            .map(
              (ref, index) =>
                `[参考图 ${index + 1}${ref.role && ref.role !== '参考' ? `（${ref.role}）` : ''} image_id=${ref.id}]`,
            )
            .join('\n');
      } else if (message.referenceImageId) {
        content += `\n[参考图 image_id=${message.referenceImageId}]`;
      }
      const attachmentBlock = attachmentPromptBlocks(message);
      if (attachmentBlock) content = content ? `${content}\n\n${attachmentBlock}` : attachmentBlock;
      rows.push({ role: 'user', content });
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
  if (start > 0) result.omitted = start;
  return result;
}
