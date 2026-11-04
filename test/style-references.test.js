import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

test('bundled style references materialize as stable user images', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-style-'));
  process.env.DATA_DIR = dataDir;
  const { closeDb } = await import('../src/data/database.js');
  const { publicStyleReferences, materializeStyleReference } = await import(
    '../src/studio/style-references.js'
  );
  const { findImageFile } = await import('../src/media/image-storage.js');
  const userId = 'a'.repeat(16);

  try {
    const references = publicStyleReferences();
    assert.equal(references.length, 10);
    assert.ok(references.every((ref) => ref.thumbUrl.startsWith('/style-references/thumbs/')));

    const first = await materializeStyleReference(userId, 'banner-702x186');
    assert.match(first.id, /^[a-f0-9]{24}$/);
    assert.equal(first.reference.width, 702);
    assert.ok(await findImageFile(userId, first.id));

    const second = await materializeStyleReference(userId, 'banner-702x186');
    assert.equal(second.id, first.id);
    assert.equal(await materializeStyleReference(userId, 'missing-style'), null);
  } finally {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});
