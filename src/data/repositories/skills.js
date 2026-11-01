import { getDb } from '../database.js';

export function listSkills(userId) {
  return getDb()
    .prepare(
      `SELECT id, name, description, data_json, created_at, updated_at
       FROM skills WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId);
}

export function findSkill(userId, id) {
  return getDb()
    .prepare(
      `SELECT id, name, description, data_json, created_at, updated_at
       FROM skills WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
}

export function insertSkill({ id, userId, name, description, dataJson }) {
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO skills (id, user_id, name, description, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, name, description, dataJson, ts, ts);
  return findSkill(userId, id);
}

export function deleteSkill(userId, id) {
  return getDb().prepare('DELETE FROM skills WHERE id = ? AND user_id = ?').run(id, userId);
}
