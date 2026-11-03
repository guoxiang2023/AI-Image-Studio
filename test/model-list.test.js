import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { setSecretBox } from '../src/shared/runtime.js';
import { listModels } from '../src/services/model-probe-service.js';

let dataDir;
let server;
let baseUrl;
const requested = [];

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-model-list-test-'));
  setSecretBox({
    seal: (value) => `sealed:${Buffer.from(value).toString('base64')}`,
    unseal: (value) =>
      Buffer.from(value.replace(/^sealed:/, ''), 'base64').toString('utf8'),
  });
  initDb(dataDir);

  server = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/v1/models') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<h1>Forbidden</h1>');
      return;
    }
    if (req.url === '/openai/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'provider/image-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('falls back to /openai/models when /v1/models is blocked', async () => {
  const result = await listModels({
    userId: 'u1',
    body: {
      target: 'image',
      baseUrl,
      model: 'image-model',
      apiKey: 'secret',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['provider/image-model']);
  assert.deepEqual(requested, ['/v1/models', '/openai/models']);
});
