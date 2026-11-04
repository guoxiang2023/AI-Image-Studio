import { getDb } from '../database.js';

export function listChats(userId, { archived = false } = {}) {
  return getDb()
    .prepare(
      `SELECT id, title, cover_url, created_at, updated_at, archived_at
       FROM chats
       WHERE user_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
       ORDER BY ${archived ? 'archived_at DESC' : 'updated_at DESC'}`,
    )
    .all(userId);
}

export function getChat(userId, id) {
  return getDb().prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(id, userId);
}

export function insertChat(chat) {
  getDb()
    .prepare(
      `INSERT INTO chats (id, user_id, title, created_at, updated_at, last_image_id, cover_url, messages_json, summary, summary_upto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chat.id,
      chat.userId,
      chat.title,
      chat.createdAt,
      chat.updatedAt,
      chat.lastImageId,
      chat.coverUrl,
      chat.messagesJson,
      chat.summary || '',
      chat.summaryUpto || 0,
    );
}

export function updateChat(chat) {
  getDb()
    .prepare(
      `UPDATE chats SET title = ?, updated_at = ?, last_image_id = ?, cover_url = ?, messages_json = ?, summary = ?, summary_upto = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      chat.title,
      chat.updatedAt,
      chat.lastImageId,
      chat.coverUrl,
      chat.messagesJson,
      chat.summary || '',
      chat.summaryUpto || 0,
      chat.id,
      chat.userId,
    );
}

export function updateChatSummary(userId, id, summary, upto) {
  getDb()
    .prepare('UPDATE chats SET summary = ?, summary_upto = ? WHERE id = ? AND user_id = ?')
    .run(summary, upto, id, userId);
}

export function setChatArchived(userId, id, archivedAt) {
  return (
    getDb()
      .prepare('UPDATE chats SET archived_at = ? WHERE id = ? AND user_id = ?')
      .run(archivedAt, id, userId).changes > 0
  );
}

export function deleteChat(userId, id) {
  getDb().prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(id, userId);
}
