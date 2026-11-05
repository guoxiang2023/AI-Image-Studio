import { getDb } from '../database.js';

export function insertUsageEvent(event) {
  getDb()
    .prepare(
      `INSERT INTO usage_events
        (user_id, chat_id, turn_id, kind, model, provider_id, provider_name, provider_type,
         prompt_tokens, cached_tokens, completion_tokens, total_tokens, requests, images, estimated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.userId,
      event.chatId || null,
      event.turnId || null,
      event.kind,
      event.model || null,
      event.providerId || null,
      event.providerName || null,
      event.providerType || null,
      event.promptTokens || 0,
      event.cachedTokens || 0,
      event.completionTokens || 0,
      event.totalTokens || 0,
      event.requests || 1,
      event.images || 0,
      event.estimated ? 1 : 0,
      event.createdAt,
    );
}

const USAGE_FIELDS = `
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(CASE WHEN kind = 'image' THEN requests ELSE 0 END), 0) AS image_requests,
         COALESCE(SUM(CASE WHEN kind = 'image' THEN 0 ELSE requests END), 0) AS llm_requests,
         COALESCE(SUM(images), 0) AS images,
         COALESCE(SUM(CASE WHEN kind <> 'image' AND estimated = 1 THEN total_tokens ELSE 0 END), 0)
           AS estimated_tokens`;

export function listUsageByProvider(userId) {
  return getDb()
    .prepare(
      `SELECT
         COALESCE(provider_id, '') AS provider_id,
         provider_name,
         provider_type,
         COALESCE(model, '') AS model,
         ${USAGE_FIELDS}
       FROM usage_events
       WHERE user_id = ?
       GROUP BY provider_id, provider_name, provider_type, model`,
    )
    .all(userId);
}

export function listUsageByModel(userId) {
  return getDb()
    .prepare(
      `SELECT
         COALESCE(model, '') AS model,
         COALESCE(provider_type, '') AS provider_type,
         COALESCE(provider_id, '') AS provider_id,
         provider_name,
         ${USAGE_FIELDS}
       FROM usage_events
       WHERE user_id = ?
       GROUP BY model, provider_type, provider_id, provider_name`,
    )
    .all(userId);
}

export function listUsageDailyByProvider(userId, since) {
  return getDb()
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', created_at / 1000.0, 'unixepoch', 'localtime') AS day,
         COALESCE(provider_id, '') AS provider_id,
         provider_name,
         provider_type,
         COALESCE(model, '') AS model,
         ${USAGE_FIELDS}
       FROM usage_events
       WHERE user_id = ? AND created_at >= ?
       GROUP BY day, provider_id, provider_name, provider_type, model
       ORDER BY day`,
    )
    .all(userId, since);
}

export function listUsageSessionsByProvider(userId, limit = 100) {
  return getDb()
    .prepare(
      `SELECT
         c.id,
         c.title,
         c.updated_at,
         c.archived_at,
         COALESCE(u.provider_id, '') AS provider_id,
         u.provider_name,
         u.provider_type,
         COALESCE(u.model, '') AS model,
         COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
         COALESCE(SUM(CASE WHEN u.kind = 'image' THEN u.requests ELSE 0 END), 0) AS image_requests,
         COALESCE(SUM(CASE WHEN u.kind = 'image' THEN 0 ELSE u.requests END), 0) AS llm_requests,
         COALESCE(SUM(u.images), 0) AS images,
         COALESCE(
           SUM(CASE WHEN u.kind <> 'image' AND u.estimated = 1 THEN u.total_tokens ELSE 0 END),
           0
         ) AS estimated_tokens
       FROM (
         SELECT id, title, updated_at, archived_at
         FROM chats
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?
       ) c
       LEFT JOIN usage_events u
         ON u.chat_id = c.id AND u.user_id = ?
       GROUP BY c.id, u.provider_id, u.provider_name, u.provider_type, u.model
       ORDER BY c.updated_at DESC`,
    )
    .all(userId, limit, userId);
}

