import { getDb } from '../database.js';

// A row with no message and no bound directory is not a session yet: it is
// what a create succeeds at before the bind (or the first message) it was
// created for. Showing it put an untitled "新对话" at the top of the sidebar
// forever. A bound directory keeps the row visible, because that binding is
// the only thing the row holds. Kept as a flag because storage-level readers
// (migrations, tests, export) must still see every row.
const EMPTY_OR_BOUND = "NOT (messages_json = '[]' AND workspace_json = '')";

export function listChats(userId, { archived = false, hideEmpty = false } = {}) {
  return getDb()
    .prepare(
      `SELECT id, title, cover_url, created_at, updated_at, archived_at
       FROM chats
       WHERE user_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
         ${hideEmpty ? `AND ${EMPTY_OR_BOUND}` : ''}
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
      `INSERT INTO chats (id, user_id, title, created_at, updated_at, last_image_id, cover_url, messages_json, summary, summary_upto, workspace_json)
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
      chat.workspaceJson || '',
    );
}

export function setChatWorkspace(userId, id, workspaceJson) {
  return (
    getDb()
      .prepare('UPDATE chats SET workspace_json = ? WHERE id = ? AND user_id = ?')
      .run(String(workspaceJson || ''), id, userId).changes > 0
  );
}

export function updateChat(chat) {
  getDb()
    .prepare(
      `UPDATE chats SET updated_at = ?, last_image_id = ?, cover_url = ?, messages_json = ?,
         summary = CASE WHEN summary_upto > ? THEN summary ELSE ? END,
         summary_upto = CASE WHEN summary_upto > ? THEN summary_upto ELSE ? END
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      chat.updatedAt,
      chat.lastImageId,
      chat.coverUrl,
      chat.messagesJson,
      chat.summaryUpto || 0,
      chat.summary || '',
      chat.summaryUpto || 0,
      chat.summaryUpto || 0,
      chat.id,
      chat.userId,
    );
}

export function setChatTitleIfEmpty(userId, id, title) {
  return (
    getDb()
      .prepare("UPDATE chats SET title = ? WHERE id = ? AND user_id = ? AND title = ''")
      .run(title, id, userId).changes > 0
  );
}

export function updateChatSummary(userId, id, summary, upto) {
  getDb()
    .prepare(
      `UPDATE chats SET
         summary = CASE WHEN ? >= summary_upto THEN ? ELSE summary END,
         summary_upto = CASE WHEN ? >= summary_upto THEN ? ELSE summary_upto END
       WHERE id = ? AND user_id = ?`,
    )
    .run(upto, summary, upto, upto, id, userId);
}

export function setChatTitle(userId, id, title) {
  return (
    getDb()
      .prepare('UPDATE chats SET title = ? WHERE id = ? AND user_id = ?')
      .run(title, id, userId).changes > 0
  );
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

/**
 * Deletes a session only while it is still a create-and-nothing-else row.
 *
 * The client uses this to undo a session it made for a bind that never landed.
 * Everything it must not destroy is in the WHERE clause, evaluated atomically
 * with the delete:
 *
 *   - `messages_json = '[]'` — a turn persisted a message into the row, so the
 *     user has seen something and it is no longer disposable.
 *   - `workspace_json = ''` — a bind succeeded. The server writes the binding
 *     before the HTTP response, so a caller that saw a failure can still race a
 *     binding that actually landed; deleting it would drop a live directory.
 *   - `archived_at IS NULL` — archiving is an explicit user action.
 *
 * Returns true only when a row was removed.
 */
export function discardUnusedChat(userId, id) {
  return (
    getDb()
      .prepare(
        `DELETE FROM chats
         WHERE id = ? AND user_id = ?
           AND messages_json = '[]'
           AND workspace_json = ''
           AND archived_at IS NULL`,
      )
      .run(id, userId).changes > 0
  );
}
