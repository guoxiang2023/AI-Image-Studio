import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

let db = null;

export function initDb(dataDir) {
  db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      llm_json TEXT NOT NULL,
      image_json TEXT NOT NULL,
      pricing_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      turn_id TEXT,
      kind TEXT NOT NULL,
      model TEXT,
      provider_id TEXT,
      provider_name TEXT,
      provider_type TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 1,
      images INTEGER NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
      ON usage_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_chat
      ON usage_events(user_id, chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_image_id TEXT,
      cover_url TEXT,
      messages_json TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summary_upto INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON chats(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS gallery_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_folders_name ON gallery_folders(user_id, name);

    CREATE TABLE IF NOT EXISTS gallery_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ext TEXT NOT NULL DEFAULT 'png',
      prompt TEXT NOT NULL DEFAULT '',
      size TEXT,
      aspect_ratio TEXT,
      chat_id TEXT,
      folder_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_images_user ON gallery_images(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generated_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      format TEXT NOT NULL,
      size INTEGER NOT NULL,
      image_count INTEGER NOT NULL DEFAULT 0,
      preview_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generated_documents_user
      ON generated_documents(user_id, created_at DESC);
  `);

  const columns = new Set(db.prepare('PRAGMA table_info(chats)').all().map((row) => row.name));
  if (!columns.has('summary')) {
    db.exec("ALTER TABLE chats ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('summary_upto')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('archived_at')) {
    db.exec('ALTER TABLE chats ADD COLUMN archived_at INTEGER');
  }
  if (columns.has('skill_id')) {
    db.exec('ALTER TABLE chats DROP COLUMN skill_id');
  }
  db.exec('DROP TABLE IF EXISTS skills');

  const settingsColumns = new Set(
    db.prepare('PRAGMA table_info(user_settings)').all().map((row) => row.name),
  );
  if (!settingsColumns.has('pricing_json')) {
    db.exec("ALTER TABLE user_settings ADD COLUMN pricing_json TEXT NOT NULL DEFAULT '{}'");
  }

  const usageColumns = new Set(
    db.prepare('PRAGMA table_info(usage_events)').all().map((row) => row.name),
  );
  if (!usageColumns.has('estimated')) {
    db.exec('ALTER TABLE usage_events ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0');
  }
  if (!usageColumns.has('cached_tokens')) {
    db.exec('ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0');
  }
  for (const [name, ddl] of Object.entries({
    provider_id: 'TEXT',
    provider_name: 'TEXT',
    provider_type: 'TEXT',
  })) {
    if (!usageColumns.has(name)) {
      db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${ddl}`);
    }
  }

  const galleryColumns = new Set(
    db.prepare('PRAGMA table_info(gallery_images)').all().map((row) => row.name),
  );
  const galleryAdditions = {
    group_id: 'TEXT',
    parent_id: 'TEXT',
    model: 'TEXT',
    quality: 'TEXT',
    caption: "TEXT NOT NULL DEFAULT ''",
    tags_json: "TEXT NOT NULL DEFAULT '[]'",
    favorite: 'INTEGER NOT NULL DEFAULT 0',
    hidden: 'INTEGER NOT NULL DEFAULT 0',
    base_id: 'TEXT',
    qr_json: "TEXT NOT NULL DEFAULT ''",
  };
  for (const [name, ddl] of Object.entries(galleryAdditions)) {
    if (!galleryColumns.has(name)) {
      db.exec(`ALTER TABLE gallery_images ADD COLUMN ${name} ${ddl}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_images_group ON gallery_images(user_id, group_id)');

  backfillGallery();

  return db;
}

function backfillGallery() {
  const chats = db.prepare('SELECT id, user_id, messages_json, created_at FROM chats').all();
  if (!chats.length) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gallery_images
      (id, user_id, ext, prompt, size, aspect_ratio, chat_id, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );

  for (const chat of chats) {
    let messages = [];
    try {
      messages = JSON.parse(chat.messages_json || '[]');
    } catch {
      continue;
    }
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.images)) continue;
      for (const image of message.images) {
        if (!image?.id || !/^[a-f0-9]{16,40}$/.test(image.id)) continue;
        const match = String(image.url || '').match(/\.(png|jpg|jpeg|webp)(?:$|\?)/i);
        let ext = match ? match[1].toLowerCase() : 'png';
        if (ext === 'jpeg') ext = 'jpg';
        insert.run(
          image.id,
          chat.user_id,
          ext,
          String(image.prompt || ''),
          image.size || null,
          image.aspectRatio || null,
          chat.id,
          Number(message.ts) || chat.created_at,
        );
      }
    }
  }
}

export function closeDb() {
  db?.close();
  db = null;
}

export function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}
