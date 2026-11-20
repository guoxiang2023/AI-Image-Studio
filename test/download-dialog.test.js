import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { downloadDialogOptions } = require('../desktop/download-dialog.cjs');

const downloads = '/Users/test/Downloads';

test('keeps a PDF name and offers only the pdf filter', () => {
  const options = downloadDialogOptions({
    filename: '仓储控制系统（WCS）概要设计说明书.pdf',
    downloadsDir: downloads,
  });
  assert.equal(
    options.defaultPath,
    path.join(downloads, '仓储控制系统（WCS）概要设计说明书.pdf'),
  );
  assert.deepEqual(options.filters, [{ name: 'PDF 文档', extensions: ['pdf'] }]);
});

test('offers the exact Word filter instead of png', () => {
  const options = downloadDialogOptions({
    filename: '纪要.docx',
    downloadsDir: downloads,
  });
  assert.deepEqual(options.filters, [{ name: 'Word 文档', extensions: ['docx'] }]);
});

test('the dialog title follows the file type', () => {
  assert.equal(
    downloadDialogOptions({ filename: 'a.zip', downloadsDir: downloads }).title,
    '保存压缩包',
  );
  assert.equal(
    downloadDialogOptions({ filename: 'a.pdf', downloadsDir: downloads }).title,
    '保存PDF 文档',
  );
});

test('keeps image downloads on image filters', () => {
  const png = downloadDialogOptions({ filename: 'luma-1.png', downloadsDir: downloads });
  assert.deepEqual(png.filters, [{ name: 'PNG 图片', extensions: ['png'] }]);
  const jpeg = downloadDialogOptions({ filename: 'photo.JPEG', downloadsDir: downloads });
  assert.deepEqual(jpeg.filters, [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }]);
});

test('offers a zip filter so a session export is not renamed to .png', () => {
  // macOS appends the first filter extension when the save name's own extension
  // is not allowed, so an image-only list turned `x.luma-session.zip` into
  // `x.luma-session.zip.png`. The filter has to follow the incoming name.
  for (const name of ['仓储控制系统.luma-session.zip', 'luma-session.zip']) {
    const options = downloadDialogOptions({ filename: name, downloadsDir: downloads });
    assert.deepEqual(options.filters, [{ name: '压缩包', extensions: ['zip'] }], name);
    assert.equal(options.defaultPath, path.join(downloads, name), name);
  }
});

test('leaves unknown extensions unfiltered so the name is preserved', () => {
  const options = downloadDialogOptions({ filename: 'backup.tar.gz', downloadsDir: downloads });
  assert.equal(options.filters, undefined);
  assert.equal(options.defaultPath, path.join(downloads, 'backup.tar.gz'));
});

test('falls back to a plain name when the download has no filename', () => {
  const options = downloadDialogOptions({ filename: '', downloadsDir: downloads });
  assert.equal(options.defaultPath, path.join(downloads, 'download'));
  assert.equal(options.filters, undefined);
});

test('refuses to escape the downloads directory', () => {
  const options = downloadDialogOptions({ filename: '../../etc/passwd', downloadsDir: downloads });
  assert.equal(options.defaultPath, path.join(downloads, 'passwd'));
});

test('ignores inherited properties instead of emitting a bogus filter', () => {
  for (const name of ['report.constructor', 'x.__proto__', 'a.toString']) {
    const options = downloadDialogOptions({ filename: name, downloadsDir: downloads });
    assert.equal(options.filters, undefined, name);
    assert.equal(options.defaultPath, path.join(downloads, name));
  }
});

test('treats dot-only names as a missing filename', () => {
  for (const name of ['..', '.', '../']) {
    const options = downloadDialogOptions({ filename: name, downloadsDir: downloads });
    assert.equal(options.defaultPath, path.join(downloads, 'download'), name);
    assert.equal(options.filters, undefined, name);
  }
});

test('exports the module without a path rewriter', () => {
  // The panel's own result must reach setSavePath untouched. Rewriting it after
  // the fact bypassed the native overwrite prompt: the panel confirmed a fresh
  // `x.zip.png`, the rewrite pointed at an existing `x.zip`, and the user's file
  // was replaced with no warning.
  assert.deepEqual(Object.keys(require('../desktop/download-dialog.cjs')), ['downloadDialogOptions']);
});
