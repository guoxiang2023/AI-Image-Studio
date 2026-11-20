import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Force the pure-wasm backend: the Vision helper is a compiled artifact that
// only exists after a macOS build, so tests must not depend on it.
process.env.OCR_BACKEND = 'tesseract';

const { ocrBackend, recognizeText, shutdownOcr, tidyOcrText } = await import(
  '../src/media/ocr.js'
);

// The recognizer keeps a resident worker (a wasm thread or a child process) so
// that real uploads do not pay model loading per page. Tests must release it, or
// the process never exits and `node --test` hangs.
test.after(async () => {
  await shutdownOcr();
});

test('collapses the per-glyph spaces tesseract inserts between Han characters', () => {
  assert.equal(tidyOcrText('仓 储 控 制 系 统 概 要'), '仓储控制系统概要');
});

test('collapses spaces around CJK punctuation', () => {
  assert.equal(tidyOcrText('一 、 系 统 架 构 ： 调 度 层'), '一、系统架构：调度层');
});

test('keeps the space between Latin and Han text', () => {
  assert.equal(
    tidyOcrText('二 、 接 口 协 议 采 用 TCP/IP 与 Modbus TCP'),
    '二、接口协议采用 TCP/IP 与 Modbus TCP',
  );
});

test('collapses spaces around ASCII punctuation inside Chinese text', () => {
  assert.equal(tidyOcrText('系统 (WCS) 概要'), '系统(WCS)概要');
  assert.equal(tidyOcrText('架构 : 调度层'), '架构:调度层');
});

test('drops blank lines but keeps paragraph breaks', () => {
  assert.equal(tidyOcrText('第一段\n\n\n第二段\n'), '第一段\n第二段');
});

test('normalizes CRLF line endings', () => {
  assert.equal(tidyOcrText('第一行\r\n第二行\r第三行'), '第一行\n第二行\n第三行');
});

test('an empty buffer yields no text rather than throwing', async () => {
  assert.equal((await recognizeText(Buffer.alloc(0))).text, '');
});

test('a blank image resolves to an empty string', async () => {
  const png = readFileSync(new URL('./fixtures/ocr-blank.png', import.meta.url));
  assert.equal((await recognizeText(png)).text, '');
});

test('reports a usable backend name', () => {
  assert.ok(['vision', 'tesseract'].includes(ocrBackend()));
});
