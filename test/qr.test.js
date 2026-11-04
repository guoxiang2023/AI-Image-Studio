import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { decodePng, encodePng } from '../src/media/png.js';
import { addQrToPng } from '../src/media/qr.js';

function solidPng(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 38;
    rgba[i * 4 + 1] = 74;
    rgba[i * 4 + 2] = 112;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba);
}

function decodeQr(buffer) {
  const png = decodePng(buffer);
  assert.ok(png);
  return jsQR(new Uint8ClampedArray(png.rgba), png.width, png.height);
}

test('QR overlay is scannable at every supported position', () => {
  const url = 'https://example.com/benefit?from=poster';
  const base = solidPng(900, 1200);
  for (const position of ['bottom-right', 'bottom-left', 'bottom-center']) {
    const output = addQrToPng(base, { url, position, size: 'medium' });
    const png = decodePng(output);
    assert.ok(png);
    assert.equal(png.width, 900);
    assert.equal(png.height, 1200);
    const decoded = decodeQr(output);
    assert.equal(decoded?.data, url);
  }
});

test('QR overlay remains scannable at small sizes and large QR sizes', () => {
  const url = 'https://example.com/q/member-benefits';
  for (const [width, height, size] of [
    [512, 512, 'small'],
    [1536, 1024, 'large'],
  ]) {
    const output = addQrToPng(solidPng(width, height), {
      url,
      position: 'bottom-right',
      size,
    });
    assert.equal(decodeQr(output)?.data, url);
  }
});

test('QR overlay rejects unsafe links and non-PNG input', () => {
  const base = solidPng(512, 512);
  assert.throws(() => addQrToPng(base, { url: 'javascript:alert(1)' }), /http/);
  assert.throws(() => addQrToPng(Buffer.from('not a png'), { url: 'https://example.com' }), /PNG/);
});
