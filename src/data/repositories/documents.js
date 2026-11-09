import { getDb } from '../database.js';

export function insertGeneratedDocument(document) {
  getDb()
    .prepare(
      `INSERT INTO generated_documents
        (id, user_id, chat_id, title, filename, format, size, image_count, preview_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      document.id,
      document.userId,
      document.chatId || null,
      document.title,
      document.filename,
      document.format,
      document.size,
      document.imageCount || 0,
      document.previewJson || '[]',
      document.createdAt,
    );
}

export function listGeneratedDocuments(userId) {
  return getDb()
    .prepare(
      `SELECT d.id, d.chat_id, d.title, d.filename, d.format, d.size, d.image_count,
              d.created_at, c.title AS chat_title
       FROM generated_documents d
       LEFT JOIN chats c ON c.id = d.chat_id AND c.user_id = d.user_id
       WHERE d.user_id = ?
       ORDER BY d.created_at DESC`,
    )
    .all(userId);
}

export function getGeneratedDocument(userId, id) {
  return getDb()
    .prepare(
      `SELECT d.*, c.title AS chat_title
       FROM generated_documents d
       LEFT JOIN chats c ON c.id = d.chat_id AND c.user_id = d.user_id
       WHERE d.user_id = ? AND d.id = ?`,
    )
    .get(userId, id);
}

export function deleteGeneratedDocument(userId, id) {
  return (
    getDb()
      .prepare('DELETE FROM generated_documents WHERE user_id = ? AND id = ?')
      .run(userId, id).changes > 0
  );
}
