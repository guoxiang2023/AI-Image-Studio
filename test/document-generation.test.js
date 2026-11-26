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

// The reuse path is what makes a long session exportable at all: the document
// already exists in the transcript, so no provider is contacted. This asserts
// the contract that matters to a user — a saved file, no requests, no API key.
test('exports an existing final draft without contacting any model', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-reuse-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const [{ insertChat }] = await Promise.all([import('../src/data/repositories/chats.js')]);
  const [{ defaultSettings, saveUserSettings }, { runTool }, { listUserDocuments }] =
    await Promise.all([
      import('../src/services/model-settings-service.js'),
      import('../src/services/tools-service.js'),
      import('../src/services/document-library-service.js'),
    ]);

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));

  // Any request here means the reuse path did not take over.
  let requests = 0;
  const llm = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"the reuse path must not call a model"}}');
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const port = llm.address().port;

  t.after(async () => {
    await new Promise((resolve) => llm.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  const userId = 'user-reuse-test';
  const chatId = 'ab'.repeat(12);
  const section = (n) =>
    `## §${n} 章节\n\n这一节的事实来自仓库里的取数路径，逐条都能复现。口径缺陷有两个，一个把跨窗去重当成可加，另一个把时点快照当成可累加，两者都与数据量无关。修复只能从取数路径入手，加机器与加索引都不解决问题。\n`;
  const draft = [
    '本轮工具调用额度已经用完，我没能调用文档生成工具。下面先把终稿正文交给你。',
    '',
    '# 报表数据集层专项',
    '',
    ...Array.from({ length: 6 }, (_, index) => `${section(index)}\n---\n`),
    '| # | 证据 | 数值 | 说明 |',
    '|---|---|---|---|',
    '| 1 | 报表 SQL | 115 条 | 说明列的句子明显更长，需要换行才显示完整 |',
    '',
    '---',
    '',
    '确认后我下一轮直接调用文档工具生成 Word。本轮因工具额度用尽未能产出文件，请以上述正文为准。',
  ].join('\n');
  insertChat({
    id: chatId,
    userId,
    title: '报表专项',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: '按这个骨架出 Word' },
      { role: 'assistant', content: draft },
    ]),
    summary: '',
    summaryUpto: 0,
  });

  // No API key at all: the file must still be produced.
  const settings = defaultSettings();
  settings.llm = { ...settings.llm, apiKey: '' };
  saveUserSettings(userId, settings);

  const result = await runTool('create_document', {}, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined);
  assert.equal(requests, 0, 'reusing a draft must not contact the model');
  assert.equal(result.reusedDraft, true);
  assert.match(result.note, /已有的终稿/);
  assert.equal(listUserDocuments(userId).length, 1);
});

// A session with no finished prose must still go through the model pipeline:
// the reuse branch covers an existing document, not every request.
test('a session without a final draft still uses the model pipeline', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-model-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const [{ insertChat }] = await Promise.all([import('../src/data/repositories/chats.js')]);
  const [{ defaultSettings, saveUserSettings }, { runTool }] = await Promise.all([
    import('../src/services/model-settings-service.js'),
    import('../src/services/tools-service.js'),
  ]);

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));

  let requests = 0;
  const llm = http.createServer((req, res) => {
    requests += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '## 章节\n\n正文。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

  const userId = 'user-model-test';
  const chatId = 'cd'.repeat(12);
  insertChat({
    id: chatId,
    userId,
    title: '普通会话',
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
    id: 'llm-model-pipeline',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  settings.llm = { ...settings.llm, ...provider, providers: [provider], activeId: provider.id };
  saveUserSettings(userId, settings);

  const result = await runTool('create_document', {}, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.reusedDraft, true, 'must not reuse a chat that has no draft');
  assert.ok(requests > 0, 'the model pipeline must still run');
});
