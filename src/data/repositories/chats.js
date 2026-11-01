import { getDb } from '../database.js';

export function listChats(userId) {
  return getDb()
    .prepare(
      `SELECT id, title, cover_url, created_at, updated_at
       FROM chats WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId);
}

export function getChat(userId, id) {
  return getDb().prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(id, userId);
}

export function insertChat(chat) {
  getDb()
    .prepare(
      `INSERT INTO chats (id, user_id, title, created_at, updated_at, last_image_id, cover_url, messages_json, summary, summary_upto, skill_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      chat.skillId || null,
    );
}

export function updateChat(chat) {
  getDb()
    .prepare(
      `UPDATE chats SET title = ?, updated_at = ?, last_image_id = ?, cover_url = ?, messages_json = ?, summary = ?, summary_upto = ?, skill_id = ?
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
      chat.skillId || null,
      chat.id,
      chat.userId,
    );
}

export function updateChatSummary(userId, id, summary, upto) {
  getDb()
    .prepare('UPDATE chats SET summary = ?, summary_upto = ? WHERE id = ? AND user_id = ?')
    .run(summary, upto, id, userId);
}

export function deleteChat(userId, id) {
  getDb().prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(id, userId);
}
