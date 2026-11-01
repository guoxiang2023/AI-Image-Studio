import { getDb } from '../database.js';

export function getSettings(userId) {
  return getDb().prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
}

export function saveSettings(userId, llmJson, imageJson) {
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, llm_json, image_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         llm_json = excluded.llm_json,
         image_json = excluded.image_json,
         updated_at = excluded.updated_at`,
    )
    .run(userId, llmJson, imageJson, Date.now());
}
