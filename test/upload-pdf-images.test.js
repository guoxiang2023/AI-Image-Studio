import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';

// A text-layer PDF that also carries a real bitmap: text extraction must keep
// the text *and* the bitmap must reach storage as a reference image. This is the
// case that broke when the upload path called its storage helper without the
// user id — extraction threw, the catch swallowed it, and every embedded picture
// silently vanished while the text came through fine.
async function makeMixedPdf() {
  const canvas = createCanvas(700, 500);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2244aa';
  ctx.fillRect(0, 0, 700, 500);
  const jpeg = await sharp(canvas.toBuffer('image/png')).jpeg({ quality: 80 }).toBuffer();

  const doc = new PDFDocument({ size: [595, 842] });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(18).text('Warehouse Control System Overview', 60, 60);
  doc.image(jpeg, 60, 120, { width: 460 });
  doc.fontSize(18).text('Dispatch, device and interface layers', 60, 400);
  doc.end();
  return done;
}

test('a text-layer PDF keeps both its text and its embedded bitmap', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-upload-'));
  process.env.DATA_DIR = dataDir;
  const { extractDocumentTextAsync } = await import('../src/media/document-text.js');
  const { extractPdfImages } = await import('../src/media/pdf-images.js');

  const pdf = await makeMixedPdf();
  const parsed = await extractDocumentTextAsync(pdf, 'pdf');
  assert.ok(parsed.text.includes('Warehouse Control System Overview'), 'text layer extracted');

  const images = await extractPdfImages(pdf, { maxImages: 8 });
  assert.equal(images.length, 1, 'one embedded bitmap');
  assert.equal(images[0].type, 'bitmap');
  assert.ok(images[0].width >= 320 && images[0].height >= 320, 'meets the minimum edge');
  assert.ok(images[0].buffer.length > 0, 'bitmap has bytes');
});

test('storing a bitmap without a user id fails loudly, not silently', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-upload-'));
  process.env.DATA_DIR = dataDir;
  const { saveImageBuffer, findImageFile } = await import('../src/media/image-storage.js');

  const canvas = createCanvas(700, 500);
  const png = canvas.toBuffer('image/png');

  // Passing `undefined` is what a forgotten argument looks like. It has to throw:
  // the upload path wraps storage in a catch that returns [], so a silent success
  // would drop every embedded picture with no error anywhere.
  await assert.rejects(() => saveImageBuffer(undefined, png, 'png'));

  const userId = 'a'.repeat(16);
  const saved = await saveImageBuffer(userId, png, 'png');
  assert.ok(saved.id);
  assert.ok(await findImageFile(userId, saved.id), 'image is findable under its user');
});
