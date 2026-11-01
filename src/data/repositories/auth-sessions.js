import { getDb } from '../database.js';

export function createAuthSession({ tokenHash, userId, expiresAt }) {
  getDb()
    .prepare(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(tokenHash, userId, Date.now(), expiresAt);
}

export function findAuthSession(tokenHash, now) {
  return getDb()
    .prepare(
      `SELECT s.expires_at, u.id, u.username, u.disabled
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, now);
}

export function touchAuthSession(tokenHash, expiresAt) {
  getDb()
    .prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
    .run(expiresAt, tokenHash);
}

export function deleteAuthSession(tokenHash) {
  getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteExpiredAuthSessions(now = Date.now()) {
  getDb().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
}
