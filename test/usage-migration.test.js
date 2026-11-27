import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb, initDb } from '../src/data/database.js';
import { insertUsageEvent } from '../src/data/repositories/usage.js';

let dataDir;

after(async () => {
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('migrates pricing_json and usage source columns', async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-usage-migration-'));
  const legacy = new DatabaseSync(path.join(dataDir, 'app.db'));
  legacy.exec(`
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY,
      llm_json TEXT NOT NULL,
      image_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO user_settings (user_id, llm_json, image_json, updated_at)
    VALUES ('u1', '{}', '{}', 1);

    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      turn_id TEXT,
      kind TEXT NOT NULL,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 1,
      images INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    INSERT INTO usage_events
      (user_id, kind, total_tokens, requests, created_at)
    VALUES ('u1', 'chat', 10, 1, 1), ('u1', 'image', 0, 1, 2);
  `);
  legacy.close();

  initDb(dataDir);
  const columns = new Set(
    getDb().prepare('PRAGMA table_info(user_settings)').all().map((row) => row.name),
  );
  assert.ok(columns.has('pricing_json'));
  assert.equal(
    getDb().prepare('SELECT pricing_json FROM user_settings WHERE user_id = ?').get('u1')
      .pricing_json,
    '{}',
  );
  const usageColumns = new Set(
    getDb().prepare('PRAGMA table_info(usage_events)').all().map((row) => row.name),
  );
  assert.ok(usageColumns.has('estimated'));
  assert.ok(usageColumns.has('provider_id'));
  assert.ok(usageColumns.has('provider_name'));
  assert.ok(usageColumns.has('provider_type'));
  // Per-call outcome metadata is added to an existing database and legacy rows
  // stay readable as successful calls with an unknown stage and no timing.
  for (const name of ['stage', 'status', 'finish_reason', 'elapsed_ms', 'error']) {
    assert.ok(usageColumns.has(name), `usage_events must gain ${name}`);
  }
  const usage = getDb()
    .prepare(
      `SELECT kind, estimated, provider_id, provider_type, stage, status, elapsed_ms,
              finish_reason, error
       FROM usage_events WHERE user_id = ? ORDER BY kind`,
    )
    .all('u1');
  assert.deepEqual(
    usage.map((row) => [row.kind, row.estimated, row.provider_id, row.provider_type]),
    [
      ['chat', 0, null, null],
      ['image', 0, null, null],
    ],
  );
  assert.deepEqual(
    usage.map((row) => [row.stage, row.status, row.elapsed_ms, row.finish_reason, row.error]),
    [
      [null, 'ok', 0, null, null],
      [null, 'ok', 0, null, null],
    ],
  );
  // The new rows can be inserted through the repository after migration.
  insertUsageEvent({
    userId: 'u1',
    kind: 'document',
    stage: 'document.plan',
    status: 'error',
    finishReason: null,
    elapsedMs: 1234,
    error: '对话模型请求失败 (500)：upstream error',
    promptTokens: 40,
    completionTokens: 0,
    totalTokens: 40,
    createdAt: 3,
  });
  const inserted = getDb()
    .prepare(
      `SELECT stage, status, elapsed_ms, error, requests FROM usage_events
       WHERE user_id = ? AND kind = 'document'`,
    )
    .get('u1');
  assert.equal(inserted.stage, 'document.plan');
  assert.equal(inserted.status, 'error');
  assert.equal(inserted.elapsed_ms, 1234);
  assert.equal(inserted.requests, 1);
  assert.match(inserted.error, /upstream error/);
});
