import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb, initDb } from '../src/data/database.js';

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
  const usage = getDb()
    .prepare('SELECT kind, estimated, provider_id, provider_type FROM usage_events WHERE user_id = ? ORDER BY kind')
    .all('u1');
  assert.deepEqual(
    usage.map((row) => [row.kind, row.estimated, row.provider_id, row.provider_type]),
    [
      ['chat', 0, null, null],
      ['image', 0, null, null],
    ],
  );
});
