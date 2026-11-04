import { CONTEXT_WINDOW } from '../config.js';
import { newId, now } from '../shared/utils.js';

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
    messages: chat.messages.filter(
      (message) => !(message.draft && !message.content && !(message.images?.length)),
    ),
  };
}

export function toLlmHistory(chat) {
  const out = [];
  const all = chat.messages || [];
  const from = Math.max(chat.summaryUpto || 0, all.length - CONTEXT_WINDOW);
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
      out.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push(message.content);
      for (const image of message.images || []) {
        parts.push(`[已生成图片 image_id=${image.id}]`);
      }
      if (parts.length) out.push({ role: 'assistant', content: parts.join('\n') });
    }
  }
  return out;
}
