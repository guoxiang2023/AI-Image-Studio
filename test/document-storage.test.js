import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

// USERS_DIR is resolved when config.js loads, so the data directory must point
// at a scratch location before the module graph is imported. That also means a
// single test process can only ever use one data directory.
test('document metadata round-trips through storage', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-docstore-'));
  process.env.DATA_DIR = dataDir;
  try {
    const { saveDocument, findDocument } = await import('../src/media/document-storage.js');
    const onlyDocumentId = async (userId) => {
      const dir = path.join(dataDir, 'users', userId, 'documents');
      const name = (await readdir(dir)).find((entry) => entry.endsWith('.json'));
      return name.replace(/\.json$/, '');
    };

    const images = [
      {
        id: 'b'.repeat(16),
        url: `/files/${'b'.repeat(16)}.jpg`,
        page: 17,
        width: 2048,
        height: 1536,
      },
      {
        id: 'c'.repeat(16),
        url: `/files/${'c'.repeat(16)}.jpg`,
        page: 18,
        width: 2048,
        height: 1536,
      },
    ];
    const pdfUser = 'a'.repeat(16);
    await saveDocument(pdfUser, Buffer.from('%PDF-1.4 test'), {
      name: '总图.pdf',
      ext: 'pdf',
      text: '总平面图',
      kind: 'PDF 文档',
      chars: 4,
      images,
    });
    const reloaded = await findDocument(pdfUser, await onlyDocumentId(pdfUser));
    assert.ok(reloaded, 'document should reload');
    assert.deepEqual(reloaded.images, images);
    assert.equal(reloaded.text, '总平面图');

    const textUser = 'd'.repeat(16);
    await saveDocument(textUser, Buffer.from('hello'), {
      name: 'note.txt',
      ext: 'txt',
      text: 'hello',
      kind: '文本',
      chars: 5,
    });
    const plain = await findDocument(textUser, await onlyDocumentId(textUser));
    assert.deepEqual(plain.images, []);

    // Files uploaded before PDF image extraction lack the key entirely.
    const legacyUser = 'e'.repeat(16);
    const legacyId = 'f'.repeat(16);
    const legacyDir = path.join(dataDir, 'users', legacyUser, 'documents');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        name: '旧文档.pdf',
        ext: 'pdf',
        kind: 'PDF 文档',
        size: 10,
        chars: 3,
        createdAt: 1,
      }),
    );
    await writeFile(path.join(legacyDir, `${legacyId}.txt`), '旧内容');
    await writeFile(path.join(legacyDir, `${legacyId}.pdf`), Buffer.from('%PDF-1.4'));
    const legacy = await findDocument(legacyUser, legacyId);
    assert.ok(legacy, 'legacy document should load');
    assert.deepEqual(legacy.images, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});