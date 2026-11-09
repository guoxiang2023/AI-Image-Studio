import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('malformed document plan falls back and still produces a document', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-plan-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const [{ insertChat }] = await Promise.all([
    import('../src/data/repositories/chats.js'),
  ]);
  const [{ defaultSettings, saveUserSettings }, { runTool }, { listUserDocuments }] =
    await Promise.all([
      import('../src/services/model-settings-service.js'),
      import('../src/services/tools-service.js'),
      import('../src/services/document-library-service.js'),
    ]);

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));

  let requests = 0;
  let lastRequest = null;
  const budgets = [];
  const llm = http.createServer((req, res) => {
    requests += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        lastRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        budgets.push(Number(lastRequest?.max_tokens) || 0);
      } catch {
        lastRequest = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-malformed-plan',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '这不是一个可用的 JSON 策划。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      );
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const port = llm.address().port;

  t.after(async () => {
    await new Promise((resolve) => llm.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  const userId = 'user-plan-test';
  const chatId = 'c'.repeat(24);
  insertChat({
    id: chatId,
    userId,
    title: '终稿测试',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: '做一张海报' },
      { role: 'assistant', content: '已完成' },
    ]),
    summary: '',
    summaryUpto: 0,
  });

  const settings = defaultSettings();
  const provider = {
    ...settings.llm.providers[0],
    id: 'llm-malformed-plan',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  settings.llm = {
    ...settings.llm,
    ...provider,
    providers: [provider],
    activeId: provider.id,
  };
  saveUserSettings(userId, settings);

  const result = await runTool('create_document', {}, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined);
  assert.ok(requests > 1, 'composition must still run after a failed plan');
  assert.ok(
    budgets[0] <= 2048,
    'the outline request must fit inside a conservative output budget',
  );
  assert.equal(listUserDocuments(userId).length, 1);
});
