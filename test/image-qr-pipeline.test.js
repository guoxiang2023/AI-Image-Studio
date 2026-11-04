import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import jsQR from 'jsqr';
import { decodePng, encodePng } from '../src/media/png.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function decodeQr(buffer) {
  const png = decodePng(buffer);
  assert.ok(png);
  return jsQR(new Uint8ClampedArray(png.rgba), png.width, png.height);
}

function extractPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const start = buffer.indexOf(signature);
  if (start < 0) return null;
  const end = buffer.indexOf(Buffer.from('IEND'), start);
  if (end < 0) return null;
  return buffer.subarray(start, end + 8);
}

function solidPng(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 32;
    rgba[i * 4 + 1] = 58;
    rgba[i * 4 + 2] = 86;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba);
}

test('generate_image saves a QR-free base and edit_image restores the QR', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-qr-'));
  process.env.DATA_DIR = dataDir;
  const userId = 'd'.repeat(16);
  const base = solidPng(600, 600);
  const qrUrl = 'https://example.com/member?from=poster';
  let editUpload = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/images/edits') editUpload = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: base.toString('base64') }] }));
    });
  });
  const port = await listen(server);

  try {
    const { initDb, closeDb } = await import('../src/data/database.js');
    initDb(dataDir);
    const { runTool } = await import('../src/services/tools-service.js');
    const { findGalleryImage } = await import('../src/data/repositories/gallery.js');
    const result = await runTool(
      'generate_image',
      { prompt: 'a poster for member benefits', count: 1 },
      {
        user: { id: userId },
        models: {
          llm: { apiKey: '' },
          image: {
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'gpt-image-2.5-flare',
            apiKey: 'test',
          },
        },
        chat: { lastImageId: null },
        references: [],
        options: {
          aspectRatio: '1:1',
          quality: null,
          count: null,
          qr: { url: qrUrl, position: 'bottom-right', size: 'medium' },
        },
        countBudget: null,
        turnId: 'e'.repeat(16),
        turnImages: [],
        userText: '会员权益海报',
        emit: () => {},
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    const filePath = path.join(
      dataDir,
      'users',
      userId,
      'images',
      `${result.images[0].image_id}.png`,
    );
    const png = decodePng(await readFile(filePath));
    assert.ok(png);
    assert.equal(png.width, 600);
    assert.equal(png.height, 600);
    assert.equal(decodeQr(await readFile(filePath))?.data, qrUrl);

    const finalId = result.images[0].image_id;
    const record = findGalleryImage(userId, finalId);
    assert.ok(record.base_id);
    assert.notEqual(record.base_id, finalId);
    assert.equal(JSON.parse(record.qr_json).url, qrUrl);
    const basePath = path.join(dataDir, 'users', userId, 'images', `${record.base_id}.png`);
    assert.equal(decodeQr(await readFile(basePath)), null);

    const edit = await runTool(
      'edit_image',
      { prompt: 'change the background color' },
      {
        user: { id: userId },
        models: {
          llm: { apiKey: '' },
          image: {
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'gpt-image-2.5-flare',
            apiKey: 'test',
          },
        },
        chat: { lastImageId: finalId },
        references: [],
        options: { aspectRatio: '1:1', quality: null, count: null },
        countBudget: null,
        turnId: 'f'.repeat(16),
        turnImages: [],
        userText: '把背景改成浅色',
        emit: () => {},
      },
    );
    assert.equal(edit.ok, true);
    const editId = edit.images[0].image_id;
    const editRecord = findGalleryImage(userId, editId);
    assert.ok(editUpload);
    const uploadedPng = extractPng(editUpload);
    assert.ok(uploadedPng);
    const savedBase = await readFile(basePath);
    assert.equal(Buffer.compare(uploadedPng, savedBase), 0);
    assert.equal(decodeQr(uploadedPng), null);
    assert.equal(editRecord.parent_id, finalId);
    assert.ok(editRecord.base_id);
    assert.equal(JSON.parse(editRecord.qr_json).url, qrUrl);
    const editPath = path.join(dataDir, 'users', userId, 'images', `${editId}.png`);
    assert.equal(decodeQr(await readFile(editPath))?.data, qrUrl);
    closeDb();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
