import { getDb } from '../database.js';

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser({ id, username, passwordHash }) {
  getDb()
    .prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, passwordHash, Date.now());
}

export function findUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}
