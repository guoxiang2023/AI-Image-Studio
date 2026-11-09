import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
  'base64',
);

test('exports and imports a session with portable images and attachments', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-session-transfer-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, { insertChat }, { saveImageBuffer, findImageFile }, transfer, { loadChatForUser }, zipModule] =
    await Promise.all([
      import('../src/data/database.js'),
      import('../src/data/repositories/chats.js'),
      import('../src/media/image-storage.js'),
      import('../src/services/session-transfer-service.js'),
      import('../src/services/chat-service.js'),
      import('../src/media/zip-reader.js'),
    ]);

  initDb(dataDir);
  t.after(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  const userId = 'session-transfer-user';
  const sourceId = 'a'.repeat(24);
  const first = await saveImageBuffer(userId, PNG, 'png');
  const second = await saveImageBuffer(userId, PNG, 'png');

  insertChat({
    id: sourceId,
    userId,
    title: '可复用的夜跑会话',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: second.id,
    coverUrl: first.url,
    messagesJson: JSON.stringify([
      {
        role: 'user',
        content: '基于这张参考图继续做海报',
        ts: 1,
        references: [{ id: first.id, url: first.url, role: '参考' }],
        referenceImageId: first.id,
        referenceUrl: first.url,
        attachments: [
          {
            id: 'attachment-1',
            name: 'brief.txt',
            ext: 'txt',
            kind: '纯文本',
            size: 12,
            chars: 12,
            text: '活动需求说明',
          },
        ],
      },
      {
        role: 'assistant',
        content: '已生成两版',
        ts: 2,
        images: [
          {
            id: first.id,
            url: first.url,
            prompt: '第一版',
            caption: '第一版',
            size: '1024x1024',
            aspectRatio: '1:1',
            groupId: 'g1',
            parentId: null,
            model: 'mock',
            quality: 'high',
          },
          {
            id: second.id,
            url: second.url,
            prompt: '最终版',
            caption: '最终版',
            size: '1024x1024',
            aspectRatio: '1:1',
            groupId: 'g2',
            parentId: first.id,
            model: 'mock',
            quality: 'high',
          },
        ],
      },
    ]),
    summary: '旧摘要',
    summaryUpto: 1,
  });

  const exported = await transfer.buildSessionExport({ id: userId }, sourceId);
  assert.match(exported.filename, /可复用的夜跑会话\.luma-session\.zip$/);
  const zip = zipModule.openZip(exported.buffer);
  const manifest = JSON.parse(zip.readText('manifest.json'));
  assert.equal(manifest.format, 'luma-session');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.images.length, 2);
  assert.ok(zip.has(`images/${first.id}.png`));
  assert.ok(zip.has(`images/${second.id}.png`));

  const imported = await transfer.importSessionArchive({ id: userId }, exported.buffer);
  assert.notEqual(imported.id, sourceId);
  assert.equal(imported.title, '可复用的夜跑会话');
  assert.equal(imported.messages, 2);
  assert.equal(imported.images, 2);

  const chat = loadChatForUser(userId, imported.id);
  assert.equal(chat.summary, '');
  assert.equal(chat.summaryUpto, 0);
  assert.equal(chat.messages[0].attachments[0].text, '活动需求说明');

  const reference = chat.messages[0].references[0];
  assert.notEqual(reference.id, first.id);
  assert.equal(reference.url, `/files/${reference.id}.png`);
  assert.ok(await findImageFile(userId, reference.id));

  const [oldFirst, oldSecond] = chat.messages[1].images;
  assert.notEqual(oldFirst.id, first.id);
  assert.notEqual(oldSecond.id, second.id);
  assert.equal(oldSecond.parentId, oldFirst.id);
  assert.equal(chat.lastImageId, oldSecond.id);
  assert.equal(oldFirst.caption, '第一版');
  assert.equal(oldSecond.prompt, '最终版');
  assert.ok(await findImageFile(userId, oldFirst.id));
  assert.ok(await findImageFile(userId, oldSecond.id));
});

test('rejects files that are not session archives', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-session-invalid-'));
  process.env.DATA_DIR = dataDir;
  const [{ initDb, closeDb }, transfer] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/services/session-transfer-service.js'),
  ]);
  initDb(dataDir);
  t.after(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(
    transfer.importSessionArchive({ id: 'user' }, Buffer.from('not a zip')),
    (error) => error.status === 400 && /无效|损坏/.test(error.message),
  );
});
