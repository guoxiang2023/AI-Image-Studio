import {
  deleteChat as deleteChatRow,
  discardUnusedChat,
  getChat as getChatRow,
  insertChat,
  listChats as listChatRows,
  setChatArchived as setChatArchivedRow,
  setChatTitle as setChatTitleRow,
  setChatTitleIfEmpty as setChatTitleIfEmptyRow,
  setChatWorkspace as setChatWorkspaceRow,
  updateChat,
  updateChatSummary,
} from '../data/repositories/chats.js';
import { chatToClient, createChatDocument, serializeChat } from '../domain/chat.js';
import { isTurnActive } from './turn-lock.js';
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
    archivedAt: row.archived_at || null,
    workspaceJson: row.workspace_json || '',
  };
}

export function saveChat(chat) {
  // A turn saves drafts while it streams. Persist the generated title only for
  // a brand-new session, so a rename made during the turn is never overwritten.
  setChatTitleIfEmptyRow(chat.userId, chat.id, chat.title);
  chat.updatedAt = now();
  updateChat(serializeChat(chat));
}

export function listSessions(userId, { archived = false } = {}) {
  // The sidebar is a list of conversations, not of rows. A session created only
  // so a directory could be bound has neither a message nor a binding when the
  // bind fails, and nothing about it is worth showing.
  return listChatRows(userId, { archived, hideEmpty: true }).map((row) => ({
    id: row.id,
    title: row.title || '新对话',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cover: row.cover_url,
    archivedAt: row.archived_at || null,
  }));
}

export function renameUserChat(userId, chatId, title) {
  return setChatTitleRow(userId, chatId, title);
}

export function setUserChatArchived(userId, chatId, archived) {
  return setChatArchivedRow(userId, chatId, archived ? now() : null);
}

export function deleteUserChat(userId, chatId) {
  deleteChatRow(userId, chatId);
}

export function setChatWorkspace(userId, chatId, workspaceJson) {
  return setChatWorkspaceRow(userId, chatId, workspaceJson);
}

/**
 * Undoes a session that was created only to carry a binding which never landed.
 *
 * Two guards, deliberately layered:
 *
 *   1. `isTurnActive` — synchronous, checked immediately before the delete. A
 *      chat can be *busy* while still holding no persisted message: `handleChat`
 *      claims the id before it awaits turn preparation. Without this check an
 *      otherwise empty row would be deleted underneath a generating turn.
 *   2. The SQL predicate in `discardUnusedChat` — atomic with the delete, so a
 *      turn that persists a message or a bind that actually landed between ticks
 *      still wins.
 *
 * Returns whether a row was removed.
 */
export function discardUnusedSession(userId, chatId) {
  if (isTurnActive(chatId)) return false;
  return discardUnusedChat(userId, chatId);
}

export function updateSummary(userId, chatId, summary, upto) {
  updateChatSummary(userId, chatId, summary, upto);
}

export { chatToClient };
