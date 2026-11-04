import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canDownloadUpdate } = require('../desktop/updater-utils.cjs');

test('does not download when electron-updater reports no available update', () => {
  assert.equal(
    canDownloadUpdate({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.2' },
    }),
    false,
  );
});

test('does not download without update metadata', () => {
  assert.equal(canDownloadUpdate(null), false);
  assert.equal(canDownloadUpdate({ isUpdateAvailable: true }), false);
  assert.equal(canDownloadUpdate({ isUpdateAvailable: true, updateInfo: {} }), false);
});

test('downloads when an update is actually available', () => {
  assert.equal(
    canDownloadUpdate({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.3' },
    }),
    true,
  );
});
