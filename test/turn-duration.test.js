import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('persists elapsed time on each assistant turn', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-turn-duration-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, chatService, turnService] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/services/chat-service.js'),
    import('../src/services/chat-turn-service.js'),
  ]);
  initDb(dataDir);
  t.after(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '计时回复' } }] }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const userId = 'turn-duration-user';
  const chat = chatService.newChatForUser(userId);
  const events = [];
  await turnService.runPreparedTurn({
    user: { id: userId },
    prepared: {
      message: '请计时',
      models: {
        llm: { apiKey: 'mock', baseUrl: 'http://mock', model: 'mock', protocol: 'openai' },
      },
      chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'turn-duration-test',
    },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });

  const done = events.find((event) => event.type === 'done');
  assert.ok(done);
  assert.ok(done.durationMs >= 20, `expected elapsed time, got ${done.durationMs}`);
  assert.ok(Number.isFinite(done.ts) && done.ts > 0);
  const saved = chatService.loadChatForUser(userId, chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content, '计时回复');
  assert.ok(assistant.durationMs >= 20);
  assert.equal(assistant.ts, done.ts);
});
