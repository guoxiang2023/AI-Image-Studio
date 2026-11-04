import {
  deleteChat as deleteChatRow,
  getChat as getChatRow,
  insertChat,
  listChats as listChatRows,
  updateChat,
  updateChatSummary,
} from '../data/repositories/chats.js';
import { chatToClient, createChatDocument, serializeChat } from '../domain/chat.js';
import { now } from '../shared/utils.js';

export function newChatForUser(userId) {
  const chat = createChatDocument(userId);
  insertChat(serializeChat(chat));
  return chat;
}

export function loadChatForUser(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(id || '')) return null;
  const row = getChatRow(userId, id);
  if (!row) return null;
  let messages = [];
  try {
    messages = JSON.parse(row.messages_json || '[]');
  } catch {
    messages = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastImageId: row.last_image_id,
    coverUrl: row.cover_url,
    messages,
    summary: row.summary || '',
    summaryUpto: row.summary_upto || 0,
  };
}

export function saveChat(chat) {
  chat.updatedAt = now();
  updateChat(serializeChat(chat));
}

export function listSessions(userId) {
  return listChatRows(userId).map((row) => ({
    id: row.id,
    title: row.title || '新对话',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cover: row.cover_url,
  }));
}

export function deleteUserChat(userId, chatId) {
  deleteChatRow(userId, chatId);
}

export function updateSummary(userId, chatId, summary, upto) {
  updateChatSummary(userId, chatId, summary, upto);
}

export { chatToClient };
