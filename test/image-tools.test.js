import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nU8AAAAASUVORK5CYII=';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('generate_image routes session references through the edits endpoint', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-ref-'));
  process.env.DATA_DIR = dataDir;
  const userId = 'a'.repeat(16);
  const refId = 'b'.repeat(16);
  const imageDir = path.join(dataDir, 'users', userId, 'images');
  await mkdir(imageDir, { recursive: true });
  await writeFile(path.join(imageDir, `${refId}.png`), Buffer.from(TINY_PNG, 'base64'));

  let requestPath = '';
  let requestBody = '';
  const server = http.createServer((req, res) => {
    requestPath = req.url;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('latin1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
  });
  const port = await listen(server);

  try {
    const { initDb, closeDb } = await import('../src/data/database.js');
    initDb(dataDir);
    const { runTool } = await import('../src/services/tools-service.js');
    const events = [];
    const result = await runTool(
      'generate_image',
      { prompt: 'a small cat sitting on a windowsill', count: 1 },
      {
        user: { id: userId },
        models: {
          llm: { apiKey: '' },
          image: {
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'gpt-image-2.5-flare',
            quality: 'xhigh',
            apiKey: 'test',
          },
        },
        chat: { lastImageId: null },
        references: [{ id: refId, role: '风格' }],
        options: { aspectRatio: null, quality: null, count: null },
        countBudget: null,
        turnId: 'c'.repeat(16),
        turnImages: [],
        userText: '按这个风格画一只猫',
        emit: (event) => events.push(event),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.equal(requestPath, '/images/edits');
    assert.match(requestBody, /Reference image rules:/);
    assert.match(requestBody, /style reference only/);
    assert.match(requestBody, /Image 1/);
    assert.match(requestBody, /name="quality"\r\n\r\nxhigh/);
    assert.equal(events.some((event) => event.type === 'image'), true);
    closeDb();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
