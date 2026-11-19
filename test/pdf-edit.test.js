import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { extractPdfImages } from '../src/media/pdf-images.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function pdfWithPhoto() {
  const photo = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: '#4466aa' },
  })
    .png()
    .toBuffer();
  const doc = new PDFDocument({ size: [800, 600], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.image(photo, 0, 0, { width: 400, height: 300 });
  doc.end();
  return done;
}

test('an image pulled from a PDF can drive edit_image directly', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-pdf-edit-'));
  process.env.DATA_DIR = dataDir;
  const userId = 'd'.repeat(16);

  const [extracted] = await extractPdfImages(await pdfWithPhoto());
  assert.ok(extracted, 'expected one usable bitmap in the PDF');

  const imageDir = path.join(dataDir, 'users', userId, 'images');
  await mkdir(imageDir, { recursive: true });
  const refId = 'e'.repeat(16);
  await writeFile(path.join(imageDir, `${refId}.jpg`), extracted.buffer);

  let requestPath = '';
  let requestBody = '';
  const server = http.createServer((req, res) => {
    requestPath = req.url;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('latin1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ b64_json: extracted.buffer.toString('base64') }],
        }),
      );
    });
  });
  const port = await listen(server);

  try {
    const { initDb, closeDb } = await import('../src/data/database.js');
    initDb(dataDir);
    const { runTool } = await import('../src/services/tools-service.js');
    const events = [];
    const result = await runTool(
      'edit_image',
      { prompt: 'change the sky to a stormy evening', reference_image_ids: [refId] },
      {
        user: { id: userId },
        models: {
          llm: { apiKey: '' },
          image: {
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'gpt-image-2.5-flare',
            quality: 'high',
            apiKey: 'test',
          },
        },
        chat: { lastImageId: null },
        references: [{ id: refId, role: '参考' }],
        options: { aspectRatio: null, quality: null, count: null },
        countBudget: null,
        turnId: 'f'.repeat(16),
        turnImages: [],
        userText: '把这张 PDF 里的效果图改成雨天',
        emit: (event) => events.push(event),
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.images.length, 1);
    assert.equal(requestPath, '/images/edits');
    assert.match(requestBody, /name="prompt"/);
    assert.match(requestBody, /stormy evening/);
    assert.match(requestBody, /name="image"/);
    assert.equal(events.some((event) => event.type === 'image'), true);
    closeDb();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});