import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/data/database.js';
import { insertChat } from '../src/data/repositories/chats.js';
import { setSecretBox } from '../src/shared/runtime.js';
import { updateSettingsPatch } from '../src/services/model-settings-service.js';
import { createDocumentRequest } from '../src/services/document-request.js';
import { usageOverview } from '../src/services/usage-service.js';

const USER_ID = 'user-doc-request';
const CHAT_ID = 'documentrequestchat01';
const PROVIDER_ID = 'llm-doc-request';
const MODEL = 'doc-request-model';
const API_KEY = 'sk-verysecretkey123456';
const PROMPT_MARK = '仅用于断言未落库的提示词';
const COMPLETION_MARK = '仅用于断言未落库的模型输出';

let dataDir;
const servers = [];

function rowsFor(turnId) {
  return getDb()
    .prepare(
      `SELECT * FROM usage_events
       WHERE user_id = ? AND turn_id = ?
       ORDER BY id`,
    )
    .all(USER_ID, turnId);
}

async function startServer(handler) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8'), state));
  });
  servers.push(server);
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { port, state };
}

async function stopServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function reply(res, { content, finish = 'stop', usage }) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }),
  );
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-request-'));
  setSecretBox({
    seal: (value) => `sealed:${Buffer.from(value).toString('base64')}`,
    unseal: (value) => Buffer.from(value.replace(/^sealed:/, ''), 'base64').toString('utf8'),
  });
  initDb(dataDir);
  insertChat({
    id: CHAT_ID,
    userId: USER_ID,
    title: '文档请求用量',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });
});

after(async () => {
  await stopServers();
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('persists one outcome per successful call with stage, elapsed time and finish reason', async () => {
  const { port } = await startServer((req, res) =>
    reply(res, {
      content: COMPLETION_MARK,
      finish: 'length',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  );
  updateSettingsPatch(USER_ID, {
    llm: {
      activeId: PROVIDER_ID,
      providers: [
        {
          id: PROVIDER_ID,
          name: 'Doc Provider',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: MODEL,
          apiKey: API_KEY,
        },
      ],
    },
  });
  updateSettingsPatch(USER_ID, {
    modelPricing: {
      [PROVIDER_ID]: {
        [MODEL]: { inputPerMillion: 1000, cachedPerMillion: 1000, outputPerMillion: 2000 },
      },
    },
  });

  const turnId = 'turn-success';
  const request = createDocumentRequest({
    user: { id: USER_ID },
    chat: { id: CHAT_ID },
    turnId,
  });
  const response = await request(
    'document.section',
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: MODEL,
      providerId: PROVIDER_ID,
      providerName: 'Doc Provider',
      apiKey: API_KEY,
    },
    [{ role: 'user', content: PROMPT_MARK }],
    { tools: false, maxTokens: 64 },
  );

  assert.equal(response.choices[0].finish_reason, 'length');
  const rows = rowsFor(turnId);
  assert.equal(rows.length, 1, 'exactly one persisted outcome');
  const [row] = rows;
  assert.equal(row.kind, 'document');
  assert.equal(row.stage, 'document.section');
  assert.equal(row.status, 'ok');
  assert.equal(row.finish_reason, 'length');
  assert.equal(row.requests, 1);
  assert.equal(row.model, MODEL);
  assert.equal(row.provider_id, PROVIDER_ID);
  assert.equal(row.provider_type, 'llm');
  assert.equal(row.prompt_tokens, 100);
  assert.equal(row.completion_tokens, 50);
  assert.equal(row.total_tokens, 150);
  assert.equal(row.estimated, 0);
  assert.ok(Number(row.elapsed_ms) >= 0, 'elapsed time is stored');
  assert.equal(row.error, null);

  // Privacy: neither the prompt nor the completion text is ever persisted.
  const stored = JSON.stringify(rows);
  assert.ok(!stored.includes(PROMPT_MARK), 'prompt text must not be stored');
  assert.ok(!stored.includes(COMPLETION_MARK), 'completion text must not be stored');

  const overview = usageOverview(USER_ID);
  assert.equal(overview.totals.llmRequests, 1);
  assert.equal(overview.totals.totalTokens, 150);
  assert.equal(overview.totals.cost, 0.2);
});

test('records a rejected request without assigning unreported token charges', async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `bad request for key ${API_KEY} (${PROMPT_MARK})`,
        },
      }),
    );
  });

  const turnId = 'turn-failure';
  const request = createDocumentRequest({
    user: { id: USER_ID },
    chat: { id: CHAT_ID },
    turnId,
  });
  const llm = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: MODEL,
    providerId: PROVIDER_ID,
    providerName: 'Doc Provider',
    apiKey: API_KEY,
  };

  const before = usageOverview(USER_ID).totals;
  // The caller still receives the provider's own error.
  await assert.rejects(
    () =>
      request(
        'document.plan',
        llm,
        [
          { role: 'system', content: PROMPT_MARK },
          { role: 'user', content: PROMPT_MARK.repeat(30) },
        ],
        { tools: false, maxTokens: 64 },
      ),
    /bad request for key/,
  );

  const rows = rowsFor(turnId);
  assert.equal(rows.length, 1, 'a failure persists exactly one outcome');
  const [row] = rows;
  assert.equal(row.kind, 'document');
  assert.equal(row.stage, 'document.plan');
  assert.equal(row.status, 'error');
  assert.equal(row.finish_reason, null);
  assert.equal(row.requests, 1);
  assert.ok(Number(row.elapsed_ms) >= 0);
  assert.equal(row.error, 'provider_http_400', 'the status, not the provider text, is stored');
  assert.equal(row.completion_tokens, 0);
  assert.equal(row.prompt_tokens, 0, 'a rejected request has no reported usage');
  assert.equal(row.estimated, 1, 'failure token counts are marked estimated');

  // No prompt, completion, credential or provider excerpt reaches the database.
  const stored = JSON.stringify(rows);
  assert.ok(!stored.includes(API_KEY), 'the stored row must not contain the API key');
  assert.ok(!stored.includes(PROMPT_MARK), 'the stored row must not contain the prompt');

  const after = usageOverview(USER_ID).totals;
  assert.equal(after.llmRequests, before.llmRequests + 1);
  assert.equal(after.totalTokens, before.totalTokens);
  assert.equal(after.cost, before.cost);
});

test('a retried provider call still persists a single logical outcome', async () => {
  const { port, state } = await startServer((req, res) => {
    if (state.hits === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    reply(res, {
      content: 'ok',
      finish: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  const turnId = 'turn-retry';
  const request = createDocumentRequest({
    user: { id: USER_ID },
    chat: { id: CHAT_ID },
    turnId,
  });
  // A bare stage is namespaced, so grouping cannot split on naming style.
  await request(
    'brief.summary',
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: MODEL,
      providerId: PROVIDER_ID,
      providerName: 'Doc Provider',
      apiKey: API_KEY,
    },
    [{ role: 'user', content: '摘要' }],
    { tools: false, maxTokens: 64 },
  );

  assert.equal(state.hits, 2, 'the transport retried once');
  const rows = rowsFor(turnId);
  assert.equal(rows.length, 1, 'one logical call, one persisted outcome');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].requests, 1);
  assert.equal(rows[0].total_tokens, 15);
  assert.equal(rows[0].stage, 'document.brief.summary');
});

test('records a cancelled call as an error outcome with the canceled category', async () => {
  const { port } = await startServer((req, res) => reply(res, { content: 'ignored' }));
  const turnId = 'turn-abort';
  const controller = new AbortController();
  controller.abort(new DOMException('已取消', 'AbortError'));

  const request = createDocumentRequest({
    user: { id: USER_ID },
    chat: { id: CHAT_ID },
    turnId,
  });
  await assert.rejects(() =>
    request(
      'document.section',
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: MODEL,
        providerId: PROVIDER_ID,
        providerName: 'Doc Provider',
        apiKey: API_KEY,
      },
      [{ role: 'user', content: PROMPT_MARK }],
      { tools: false, maxTokens: 64, signal: controller.signal },
    ),
  );

  const rows = rowsFor(turnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].error, 'canceled');
  assert.equal(rows[0].stage, 'document.section');
  assert.equal(rows[0].requests, 1);
  assert.ok(!JSON.stringify(rows).includes(PROMPT_MARK));
});
