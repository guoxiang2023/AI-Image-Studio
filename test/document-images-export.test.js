import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-images-'));
process.env.DATA_DIR = dataDir;

let db;
let server;
let replies = [];
let requests = [];
let userId = 'user-doc-images';
let chatSeq = 0;

function nextChatId() {
  chatSeq += 1;
  return chatSeq.toString(16).padStart(24, '0');
}

function idOf(seed) {
  // Image ids are 24 hex characters; a longer value is rejected by the storage
  // layer, so the fixture must use the same shape the app produces.
  return Buffer.alloc(12, seed).toString('hex');
}

async function startLlm() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      requests.push(body);
      const reply = typeof replies === 'function' ? replies : replies.shift();
      const [content = '', finish = 'stop', status = 200] = (typeof reply === 'function' ? await reply(body) : reply) || [];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-doc-images',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content }, finish_reason: finish },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function writeImage(id, color) {
  const buffer = await sharp({
    create: { width: 240, height: 160, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  const { saveImageBuffer } = await import('../src/media/image-storage.js');
  // saveImageBuffer mints its own id; the file is renamed to the id the
  // conversation and gallery agree on so every source points at one picture.
  const saved = await saveImageBuffer(userId, buffer, 'png');
  const { rename } = await import('node:fs/promises');
  await rename(
    path.join(dataDir, 'users', userId, 'images', `${saved.id}.png`),
    path.join(dataDir, 'users', userId, 'images', `${id}.png`),
  );
  return buffer;
}

function insertChatRow({ id, messages }) {
  chatsRepo.insertChat({
    id,
    userId,
    title: '图片归档会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify(messages),
    summary: '',
    summaryUpto: 0,
  });
}

let chatsRepo = null;
let galleryRepo = null;

before(async () => {
  const port = await startLlm();
  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }, chats, gallery, settings] =
    await Promise.all([
      import('../src/data/database.js'),
      import('../src/shared/runtime.js'),
      import('../src/auth/crypto.js'),
      import('../src/data/repositories/chats.js'),
      import('../src/data/repositories/gallery.js'),
      import('../src/services/model-settings-service.js'),
    ]);
  chatsRepo = chats;
  db = { initDb, closeDb };
  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));
  galleryRepo = gallery;

  const base = settings.defaultSettings();
  const provider = {
    ...base.llm.providers[0],
    id: 'llm-doc-images',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  base.llm = { ...base.llm, ...provider, providers: [provider], activeId: provider.id };
  settings.saveUserSettings(userId, base);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('collects same-turn images and gallery-only rows without duplicating ids', async () => {
  const { collectDocumentImages } = await import('../src/domain/document.js');
  const A = idOf(0xa1);
  const B = idOf(0xb1);
  const C = idOf(0xc1);
  const chat = {
    messages: [
      { role: 'user', content: '画一张架构图' },
      { role: 'assistant', content: '好的', images: [{ id: A, prompt: '架构图 v1' }] },
    ],
  };
  const collected = collectDocumentImages(chat, 100, {
    turnImages: [{ id: B, prompt: '架构图 v2', createdAt: 200 }],
    galleryImages: [
      { id: A, prompt: '架构图 v1', createdAt: 100 },
      { id: C, prompt: '架构图 v3', createdAt: 300 },
    ],
  });
  assert.deepEqual(
    collected.images.map((image) => image.id),
    [A, B, C],
    'gallery-only and same-turn pictures are merged in generation order with no duplicate id',
  );
  assert.equal(collected.total, 3);
  assert.equal(collected.omitted, 0);
});

test('archives early versions but excludes hidden and deleted pictures', async () => {
  const { archiveDocumentImages, selectFinalDocumentImages, buildDocumentImagePlanMessages } =
    await import('../src/domain/document.js');
  const A = idOf(0xa2);
  const B = idOf(0xb2);
  const C = idOf(0xc2);
  const D = idOf(0xd2);
  const images = [
    { id: A, prompt: '技术架构图 v1' },
    { id: B, prompt: '技术架构图 v2', parentId: A },
    { id: C, prompt: '废弃图' },
    { id: D, prompt: '部署图' },
  ];
  const archive = archiveDocumentImages(images, { hiddenIds: [C], unavailableIds: [] });
  assert.deepEqual(
    archive.map((image) => image.id),
    [A, B, D],
    'the replaced early version stays in the archive; hidden pictures do not',
  );

  const body = selectFinalDocumentImages(images, { hiddenIds: [C], unavailableIds: [] });
  assert.deepEqual(
    body.map((image) => image.id),
    [B, D],
    'the body still shows only the latest version',
  );

  const missing = archiveDocumentImages(images, { unavailableIds: [D] });
  assert.deepEqual(
    missing.map((image) => image.id),
    [A, B, C],
    'a picture whose file is gone is never listed',
  );

  // A gallery favourite is an explicit pick: it stays a body candidate even
  // when the edit chain says a later picture replaced it.
  const favorited = selectFinalDocumentImages(
    [
      { id: A, prompt: '技术架构图 初稿', favorite: true },
      { id: B, prompt: '技术架构图 修订', parentId: A },
    ],
    { limit: 10 },
  );
  assert.deepEqual(
    favorited.map((image) => image.id),
    [A, B],
    'the picture the user favourited is not silently dropped as superseded',
  );

  const favouriteFirst = buildDocumentImagePlanMessages({
    chat: { title: '收藏优先' },
    images: [
      {
        id: A,
        index: 1,
        prompt: '旧版架构图',
        favorite: true,
      },
    ],
    plan: { title: '收藏优先', sections: [{ heading: '技术架构' }] },
  });
  assert.match(favouriteFirst[1].content, /画册收藏/);
  assert.match(favouriteFirst[1].content, /优先进入正文/);

  // The archive has no size threshold of its own: a long session with dozens of
  // iterations still keeps every visible picture, in generation order.
  const many = Array.from({ length: 80 }, (_, index) => ({
    id: index.toString(16).padStart(24, '0'),
    prompt: `图 ${index + 1}`,
  }));
  const whole = archiveDocumentImages(many);
  assert.deepEqual(
    whole.map((image) => image.id),
    many.map((image) => image.id),
    'no available picture is ever truncated by the archive',
  );
});

test('appends an image appendix for everything the body did not use', async () => {
  const { finalizeDocument } = await import('../src/domain/document.js');
  const A = idOf(0xa3);
  const B = idOf(0xb3);
  const C = idOf(0xc3);
  const result = finalizeDocument({
    title: '架构评审',
    images: [{ id: B, prompt: '最终技术架构' }],
    archive: [
      { id: A, prompt: '技术架构初稿' },
      { id: B, prompt: '最终技术架构' },
      { id: C, prompt: '部署架构图' },
    ],
    markdown: `# 架构评审

## 1. 技术架构

结论如下。

![最终技术架构](image:${B})`,
  });

  const imageBlocks = result.blocks.filter((block) => block.type === 'image');
  assert.deepEqual(
    imageBlocks.map((block) => block.id),
    [B, A, C],
    'inline image first, then the unused ones in generation order',
  );
  assert.equal(result.bodyImageCount, 1);
  assert.equal(result.archivedCount, 2);
  assert.equal(result.imageCount, 3);
  const heading = result.blocks.find((block) => block.type === 'heading' && /附录/.test(block.text));
  assert.ok(heading, 'the appendix is a real, visible section');
  assert.ok(
    result.blocks.some((block) => block.type === 'paragraph' && /正文已选图 1 张/.test(block.text)),
  );
  assert.ok(
    imageBlocks.slice(1).every((block) => block.archive),
    'appendix pictures are marked so the renderer can size them smaller',
  );

  const noArchive = finalizeDocument({
    title: '无归档',
    images: [{ id: B, prompt: '图' }],
    markdown: `# 无归档\n\n![图](image:${B})`,
  });
  assert.equal(noArchive.archivedCount, 0);
  assert.equal(
    noArchive.blocks.filter((block) => block.type === 'image').length,
    1,
    'without an archive nothing is invented',
  );
});

async function insertGallery(row) {
  const gallery = galleryRepo;
  gallery.insertGalleryImage({
    id: row.id,
    userId,
    ext: 'png',
    prompt: row.prompt || '',
    size: '240x160',
    aspectRatio: row.aspectRatio || '3:2',
    chatId: row.chatId,
    createdAt: row.createdAt || Date.now(),
    parentId: row.parentId || null,
  });
  if (row.hidden) gallery.hideGalleryImage(userId, row.id);
  if (row.favorite) gallery.setGalleryImageFavorite(userId, row.id, true);
}

async function readDocxMedia(id, format = 'docx') {
  const { generatedDocumentPath } = await import('../src/media/document-storage.js');
  const { openZip } = await import('../src/media/zip-reader.js');
  const buffer = await readFile(generatedDocumentPath(userId, id, format));
  const zip = openZip(buffer);
  const media = zip
    .names()
    .filter((name) => name.startsWith('word/media/'))
    .map((name) => zip.read(name));
  return { buffer, zip, media, xml: zip.readText('word/document.xml') };
}

async function pdfImageCount(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  try {
    let count = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) {
        if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintJpegXObject) count += 1;
      }
    }
    return { count, pages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

const PLAN_TEXT = JSON.stringify({
  title: 'WCS 概要设计',
  sections: [
    { heading: '技术架构', purpose: '说明技术选型', points: ['技术栈'] },
    { heading: '部署架构', purpose: '说明部署方式', points: ['机房'] },
  ],
});

async function runExport({
  chatId,
  format = 'docx',
  turnImages,
  imagePlan,
  imagePlanReply = [imagePlan],
  plan = PLAN_TEXT,
  sections,
} = {}) {
  const { runTool } = await import('../src/services/tools-service.js');
  replies = [
    [plan],
    imagePlanReply,
    ['本文说明 WCS 的技术与部署架构。'],
    ...sections,
  ];
  requests = [];
  const ctx = { user: { id: userId }, chat: { id: chatId }, emit() {}, turnImages };
  return runTool('create_document', { format }, ctx);
}

test('a Word export embeds only the final figure and omits unselected drafts', async () => {
  const chatId = nextChatId();
  const A = idOf(0xa4);
  const B = idOf(0xb4);
  const C = idOf(0xc4);
  const HIDDEN = idOf(0xd4);
  const FOREIGN = idOf(0xe4);
  await writeImage(A, '#3355aa');
  await writeImage(B, '#aa3355');
  await writeImage(C, '#33aa55');
  await writeImage(HIDDEN, '#222222');
  await writeImage(FOREIGN, '#eeeeee');

  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画一张技术架构图' },
      { role: 'assistant', content: '第一版', images: [{ id: A, prompt: '技术架构图 初稿' }] },
      { role: 'user', content: '用具体技术选型重画' },
      {
        role: 'assistant',
        content: '第二版',
        images: [{ id: B, prompt: '技术架构图 具体技术选型', parentId: A }],
      },
      { role: 'user', content: '再画一张部署图' },
      { role: 'assistant', content: '部署图', images: [{ id: C, prompt: '部署架构图' }] },
    ],
  });
  await insertGallery({ id: A, prompt: '技术架构图 初稿', chatId });
  await insertGallery({ id: B, prompt: '技术架构图 具体技术选型', chatId, parentId: A });
  await insertGallery({ id: C, prompt: '部署架构图', chatId });
  await insertGallery({ id: HIDDEN, prompt: '用户删掉的图', chatId, hidden: true });
  await insertGallery({ id: FOREIGN, prompt: '别的会话的图', chatId: idOf(0x99) });

  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({
      final_images: [{ image_id: B, caption: '最终技术架构', section: 1 }],
    }),
    sections: [
      ['## 1. 技术架构\n\n采用消息队列解耦。\n\n![最终技术架构](image:' + B + ')'],
      ['## 2. 部署架构\n\n中心机房部署。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.image_count, 1);

  const { media, xml } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 1);
  assert.match(xml, /最终技术架构/);
  assert.doesNotMatch(xml, /附录：会话图片|当轮要求|第 \d+ 轮生成图|技术架构图 初稿|部署架构图/);
  assert.doesNotMatch(xml, new RegExp(HIDDEN), 'a picture the user hid never reaches the document');
  assert.doesNotMatch(xml, new RegExp(FOREIGN), 'another session\'s picture never leaks in');

  const catalog = JSON.stringify(requests[1].messages);
  assert.match(catalog, new RegExp(B));
  assert.doesNotMatch(catalog, new RegExp(`${A}|${HIDDEN}|${FOREIGN}`));
});

test('a PDF export actually paints its selected appendix image', async (t) => {
  const chatId = nextChatId();
  const A = idOf(0xa5);
  const B = idOf(0xb5);
  await writeImage(A, '#884422');
  await writeImage(B, '#224488');

  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画两张方案图' },
      {
        role: 'assistant',
        content: '两张',
        images: [
          { id: A, prompt: '方案图 A' },
          { id: B, prompt: '方案图 B' },
        ],
      },
    ],
  });
  await insertGallery({ id: A, prompt: '方案图 A', chatId });
  await insertGallery({ id: B, prompt: '方案图 B', chatId });

  const result = await runExport({
    chatId,
    format: 'pdf',
    imagePlan: JSON.stringify({ final_images: [{ image_id: A, caption: '主方案' }] }),
    sections: [
      ['## 1. 技术架构\n\n方案确定。'],
      ['## 2. 部署架构\n\n部署完成。'],
    ],
  });
  if (result.error && /中文字体/.test(result.error)) {
    t.skip('主机没有可用的中文字体');
    return;
  }
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.image_count, 1);

  const { generatedDocumentPath } = await import('../src/media/document-storage.js');
  const buffer = await readFile(generatedDocumentPath(userId, result.document.id, 'pdf'));
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  const { count } = await pdfImageCount(buffer);
  assert.equal(count, 1);
});

test('a document created in the turn that generated the picture still contains it', async () => {
  const chatId = nextChatId();
  const B = idOf(0xb6);
  await writeImage(B, '#446688');

  // The chat row this export reloads has no image at all: the turn has not been
  // saved yet. Only the same-turn array knows the picture exists.
  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画一张技术架构图并导出 Word' },
      { role: 'assistant', content: '正在生成…' },
    ],
  });

  const result = await runExport({
    chatId,
    turnImages: [{ id: B, prompt: '技术架构图 本轮生成', createdAt: Date.now() }],
    imagePlan: JSON.stringify({ final_images: [{ image_id: B, caption: '本轮架构图', section: 1 }] }),
    sections: [
      ['## 1. 技术架构\n\n本图为本轮生成。\n\n![本轮架构图](image:' + B + ')'],
      ['## 2. 部署架构\n\n部署完成。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.image_count, 1);

  const { media } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 1, 'the same-turn picture becomes a real media part');
});

test('a picture the model planned but never cited is still archived', async () => {
  const chatId = nextChatId();
  const A = idOf(0xa7);
  const B = idOf(0xb7);
  await writeImage(A, '#112233');
  await writeImage(B, '#334455');

  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画两张图' },
      {
        role: 'assistant',
        content: '完成',
        images: [
          { id: A, prompt: '架构图' },
          { id: B, prompt: '流程图' },
        ],
      },
    ],
  });
  await insertGallery({ id: A, prompt: '架构图', chatId });
  await insertGallery({ id: B, prompt: '流程图', chatId });

  // The planner selects both, but the written chapters cite neither: a model
  // that forgets an image line must not cost the user their pictures.
  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({
      final_images: [
        { image_id: A, caption: '架构图', section: 1 },
        { image_id: B, caption: '流程图', section: 2 },
      ],
    }),
    sections: [
      ['## 1. 技术架构\n\n正文没有引用图片。'],
      ['## 2. 部署架构\n\n正文也没有引用图片。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.image_count, 2);
  const { media, xml } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 2);
  assert.match(xml, /附录：会话图片/);
  assert.match(xml, /图 1：架构图/);
  assert.match(xml, /图 2：流程图/);
});

test('an empty image plan delivers a prose-only document', async () => {
  const chatId = nextChatId();
  const A = idOf(0xa8);
  const B = idOf(0xb8);
  const C = idOf(0xc8);
  for (const [id, color] of [
    [A, '#654321'],
    [B, '#123456'],
    [C, '#abcdef'],
  ]) {
    await writeImage(id, color);
  }

  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画三张图' },
      {
        role: 'assistant',
        content: '完成',
        images: [
          { id: A, prompt: '图一' },
          { id: B, prompt: '图二' },
          { id: C, prompt: '图三' },
        ],
      },
    ],
  });
  for (const [id, prompt] of [
    [A, '图一'],
    [B, '图二'],
    [C, '图三'],
  ]) {
    await insertGallery({ id, prompt, chatId });
  }

  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({ final_images: [] }),
    sections: [
      ['## 1. 技术架构\n\n没有配图。'],
      ['## 2. 部署架构\n\n同样没有配图。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.issues, undefined);
  assert.equal(result.document.image_count, 0);
  const { media } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 0);
});

test('automatic image planning falls back only for unusable responses', async (t) => {
  const { DOCUMENT_FINAL_IMAGES } = await import('../src/config.js');
  const { getUserDocument } = await import('../src/services/document-library-service.js');
  const chatId = nextChatId();
  const draftId = 'facefeed'.padEnd(24, '0');
  const approvedId = 'facebeef'.padEnd(24, '0');
  const newerIds = Array.from({ length: DOCUMENT_FINAL_IMAGES }, (_, i) => `facecafe${i.toString(16).padStart(16, '0')}`);
  const expectedIds = [approvedId, ...newerIds.slice(1)];
  for (const id of [draftId, approvedId, ...newerIds]) await writeImage(id, '#4267a6');
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: '整理架构图' },
    { role: 'assistant', images: [{ id: draftId, prompt: '架构草稿' }] },
    { role: 'assistant', images: [{ id: approvedId, parentId: draftId, prompt: '架构定稿' }] },
    { role: 'assistant', images: newerIds.map((id) => ({ id, prompt: '补充示意图' })) },
    { role: 'assistant', content: `已确认：使用架构定稿 \`${approvedId}\`。` },
    { role: 'user', content: '按此稿生成 Word。' },
  ] });

  for (const [name, imagePlanReply, expected, degraded = true] of [
    ['invalid JSON', ['不是合法的图片方案'], expectedIds],
    ['truncated response', ['{"final_images":[]}', 'length'], expectedIds],
    ['provider failure', ['拒绝配图请求', 'stop', 400], expectedIds],
    ['valid empty plan keeps only the approved image', ['{"final_images":[]}'], [approvedId], false],
  ]) {
    await t.test(name, async () => {
      const result = await runExport({
        chatId,
        imagePlanReply,
        sections: [
          [degraded ? `方案说明。\n\n![架构定稿](image:${approvedId})` : '方案说明。'],
          ['部署说明。'],
        ],
      });
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.document.image_count, expected.length);
      const { blocks } = getUserDocument(userId, result.document.id);
      assert.deepEqual(blocks.filter((block) => block.type === 'image').map(({ id }) => id), expected);
      const { media, xml } = await readDocxMedia(result.document.id);
      assert.equal(media.length, expected.length);
      assert.deepEqual(result.issues, degraded
        ? ['未取得完整配图方案，已改用候选图片生成文末附录']
        : undefined);
      assert.match(xml, /正文已选图 0 张/);
      assert.match(xml, /附录：会话图片[\s\S]*<a:blip r:embed=/);
    });
  }
});

test('create_document can exclude available figures from Word and PDF', async (t) => {
  const { runTool } = await import('../src/services/tools-service.js');
  const { getUserDocument } = await import('../src/services/document-library-service.js');
  const { generatedDocumentPath } = await import('../src/media/document-storage.js');
  const chatId = nextChatId();
  const id = idOf(0x35);
  const body = '采用消息队列连接两个服务。';
  await writeImage(id, '#224488');
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: '画一张技术架构图' },
    { role: 'assistant', content: body, images: [{ id, prompt: '技术架构图' }] },
  ] });
  await insertGallery({ id, prompt: '技术架构图', chatId });

  for (const format of ['docx', 'pdf']) {
    await t.test(format, async (caseContext) => {
      requests = [];
      replies = ({ messages }) => {
        const prompt = messages.at(-1).content;
        if (prompt.includes('【对话纲要】')) return [PLAN_TEXT];
        if (prompt.includes('【候选图片（按时间顺序）】')) {
          return [JSON.stringify({ final_images: [{ image_id: id, section: 1 }] })];
        }
        if (prompt.includes('请写文档的第 1/')) return [`${body}\n\n![技术架构图](image:${id})`];
        if (prompt.includes('请写文档的第 2/')) return ['服务在中心机房部署。'];
        return ['本文说明技术与部署架构。'];
      };
      try {
        const result = await runTool('create_document', { format, include_images: false }, {
          user: { id: userId }, chat: { id: chatId }, emit() {},
        });
        if (format === 'pdf' && result.error && /中文字体/.test(result.error)) {
          caseContext.skip('主机没有可用的中文字体');
          return;
        }
        assert.equal(result.error, undefined, result.error);
        assert.equal(result.document.image_count, 0);
        const { blocks } = getUserDocument(userId, result.document.id);
        assert.ok(blocks.some((block) => block.type === 'paragraph' && block.text === body));
        assert.ok(!blocks.some((block) => block.type === 'image'));
        assert.doesNotMatch(JSON.stringify(requests), /候选图片（按时间顺序）/);
        if (format === 'docx') {
          const { media, xml } = await readDocxMedia(result.document.id);
          assert.equal(media.length, 0);
          assert.ok(xml.includes(body));
        } else {
          const buffer = await readFile(generatedDocumentPath(userId, result.document.id, format));
          const { count } = await pdfImageCount(buffer);
          assert.equal(count, 0);
        }
      } finally {
        replies = [];
      }
    });
  }
});

test('manual export respects the exact selection even when the model cites another version', async () => {
  const { generateSelectedDocument, listSessionDocumentImages } = await import('../src/services/document-service.js');
  const { loadChatForUser } = await import('../src/services/chat-service.js');
  const chatId = nextChatId();
  const user = { id: userId };
  const [draft, final, missing, hidden] = [0x21, 0x22, 0x23, 0x24].map(idOf);
  await Promise.all([writeImage(draft, '#aa0000'), writeImage(final, '#00aa00'), writeImage(hidden, '#aaaaff')]);
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: '绘制示意图' },
    { role: 'assistant', images: [{ id: draft, prompt: '早期版' }, { id: final, prompt: '定稿版', parentId: draft }] },
    { role: 'user', references: [{ id: missing }, { id: hidden }] },
  ] });
  await insertGallery({ id: hidden, chatId, hidden: true });
  const chat = loadChatForUser(userId, chatId);
  const inventory = await listSessionDocumentImages(user, chat);
  assert.deepEqual(inventory.map((item) => item.id), [draft, final]);
  for (const id of [missing, hidden, idOf(0x25)]) {
    await assert.rejects(generateSelectedDocument({ user, chat, format: 'docx', imageIds: [id] }));
  }
  await assert.rejects(
    generateSelectedDocument({ user, chat, format: 'docx', imageIds: [] }),
    { status: 400, message: '请至少勾选一张图片' },
  );
  replies = [
    [PLAN_TEXT],
    [JSON.stringify({ final_images: [{ image_id: final }] })],
    ['设计说明。'],
    [`技术方案。\n\n![错误版本](image:${final})`],
    ['部署说明。'],
  ];
  const { document } = await generateSelectedDocument({ user, chat, format: 'docx', imageIds: [draft] });
  const { media, xml } = await readDocxMedia(document.id);
  assert.equal(media.length, 1);
  const { channels } = await sharp(media[0]).stats();
  assert.ok(channels[0].mean > 150 && channels[1].mean < 20, 'only the selected red draft is embedded');
  assert.doesNotMatch(xml, /错误版本/);
});

test('selected export keeps chat excerpts out of the downloaded document and preview', async () => {
  const { generateSelectedDocument } = await import('../src/services/document-service.js');
  const { loadChatForUser } = await import('../src/services/chat-service.js');
  const { getUserDocument } = await import('../src/services/document-library-service.js');
  const { DOCUMENT_PLAN_CHARS } = await import('../src/config.js');
  const [inline, appendix] = [0x2a, 0x2b].map(idOf);
  const chatId = nextChatId();
  const originalRequest = '辛苦啦，给我把图右上角改成暗红色';
  const excerpt = '原始聊天标记';
  await writeImage(inline, '#223344');
  await writeImage(appendix, '#332211');
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: originalRequest },
    {
      role: 'assistant',
      content: `${excerpt}。${'设计记录。'.repeat(Math.ceil(DOCUMENT_PLAN_CHARS / 5))}`,
      images: [
        { id: inline, prompt: '仓库分区图', caption: originalRequest },
        { id: appendix, prompt: originalRequest, caption: originalRequest },
      ],
    },
  ] });
  const chat = loadChatForUser(userId, chatId);
  const intro = '仓库设置独立复核区。';
  const body = '复核区与收货区分开布置。';

  try {
    for (const truncated of [false, true]) {
      replies = ({ messages }) => {
        const prompt = messages.at(-1).content;
        if (prompt.includes('对话片段：') || prompt.includes('【合并规则】')) return [];
        if (prompt.includes('【对话纲要】')) return [PLAN_TEXT];
        if (prompt.includes('【候选图片（按时间顺序）】')) {
          return [JSON.stringify({ final_images: [{ image_id: inline, section: 1 }] })];
        }
        if (prompt.includes('请写文档的第 1/')) return [`${body}\n\n![](image:${inline})`];
        if (prompt.includes('请写文档的第 2/')) return ['中心机房部署。'];
        if (truncated) return [excerpt, 'length'];
        return [intro];
      };

      const { document } = await generateSelectedDocument({
        user: { id: userId }, chat, imageIds: [inline, appendix],
      });
      const { media, xml } = await readDocxMedia(document.id);
      const blocks = getUserDocument(userId, document.id).blocks;
      const preview = blocks.map((block) => block.text).join('\n');
      assert.equal(media.length, 2);
      assert.match(xml, /图 2：生成图/);
      assert.doesNotMatch(xml, new RegExp(originalRequest));
      assert.deepEqual(
        blocks.filter((block) => block.type === 'image').map(({ id, caption }) => [id, caption]),
        [[inline, '生成图'], [appendix, '图 2：生成图']],
      );
      for (const text of [xml, preview]) {
        assert.ok(text.includes(body));
        assert.equal(text.match(/第 1 轮生成图/g)?.length, 2);
        assert.doesNotMatch(text, new RegExp(`会话总结|${excerpt}|${originalRequest}`));
        if (!truncated) assert.ok(text.includes(intro));
      }
    }
  } finally {
    replies = [];
  }
});

test('losing a checked image after validation rejects the export without saving a document', async () => {
  const { generateSelectedDocument } = await import('../src/services/document-service.js');
  const { loadChatForUser } = await import('../src/services/chat-service.js');
  const { listUserDocuments } = await import('../src/services/document-library-service.js');
  const id = idOf(0x26);
  const chatId = nextChatId();
  await writeImage(id, '#113355');
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: '整理设计图' },
    { role: 'assistant', images: [{ id, prompt: '包装初稿', caption: '整理设计图' }] },
  ] });
  replies = [async () => {
    await rm(path.join(dataDir, 'users', userId, 'images', `${id}.png`));
    return [PLAN_TEXT];
  }, ['{"final_images":[]}'], ['方案说明。'], ['技术说明。'], ['部署说明。']];
  await assert.rejects(
    generateSelectedDocument({ user: { id: userId }, chat: loadChatForUser(userId, chatId), imageIds: [id], format: 'docx' }),
    { status: 422, message: /勾选了 1 张图片，仅 0 张可嵌入.*无法读取或转换.*文档未保存/ },
  );
  assert.ok(!listUserDocuments(userId).some((doc) => doc.chatId === chatId));
});

test('the manual picker exports every selected reference, attachment and draft in the appendix', async (t) => {
  const chatId = nextChatId();
  const [reference, sheet, draft] = [0x27, 0x28, 0x29].map(idOf);
  await Promise.all([writeImage(reference, '#112233'), writeImage(sheet, '#445566'), writeImage(draft, '#778899')]);
  insertChatRow({ id: chatId, messages: [
    { role: 'user', content: '按样本做初稿', referenceImageId: reference },
    { role: 'assistant', images: [{ id: draft, prompt: '包装初稿' }] },
    { role: 'user', content: '按包装规范校色', references: [{ id: draft }], attachments: [
      { name: '包装规范.pdf', images: [{ id: sheet, page: 3 }] },
    ] },
  ] });
  const { generateSelectedDocument } = await import('../src/services/document-service.js');
  const { loadChatForUser } = await import('../src/services/chat-service.js');
  const user = { id: userId };
  for (const format of ['docx', 'pdf']) {
    await t.test(format, async (caseContext) => {
      replies = [[PLAN_TEXT], ['{"final_images":[]}'], ['包装规范说明。'], ['采用灰色。'], ['最终色号已确认。']];
      const result = await generateSelectedDocument({
        user, chat: loadChatForUser(userId, chatId), format, imageIds: [reference, draft, sheet],
      }).catch((error) => {
        if (format !== 'pdf' || !/中文字体/.test(error.message)) throw error;
        caseContext.skip('主机没有可用的中文字体');
        return null;
      });
      if (!result) return;
      assert.equal(result.document.imageCount, 3);
      assert.equal(result.document.bodyImageCount, 0);
      assert.equal(result.document.appendixImageCount, 3);
      if (format === 'pdf') {
        const { generatedDocumentPath } = await import('../src/media/document-storage.js');
        const buffer = await readFile(generatedDocumentPath(userId, result.document.id, format));
        const { count } = await pdfImageCount(buffer);
        assert.equal(count, 3);
        return;
      }
      const { media, xml } = await readDocxMedia(result.document.id);
      assert.equal(media.length, 3);
      assert.equal((xml.match(/<a:blip r:embed=/g) || []).length, 3);
      assert.match(xml, /第 1 轮参考图/);
      assert.match(xml, /第 1 轮生成图/);
      assert.match(xml, /第 2 轮附件图/);
      assert.doesNotMatch(xml, /当轮要求|按样本做初稿|按包装规范校色/);
      assert.match(xml, /包装规范\.pdf第 3 页/);
    });
  }
});

test('a long session with many image versions exports just the chosen revision', async () => {
  const chatId = nextChatId();
  const ids = Array.from({ length: 30 }, (_, index) =>
    Buffer.alloc(12, 0x40 + index).toString('hex'),
  );
  const messages = [{ role: 'user', content: '连续出了很多版方案图' }];
  for (const [index, id] of ids.entries()) {
    await writeImage(id, '#1a2b3c');
    await insertGallery({ id, prompt: `方案图 第 ${index + 1} 版`, chatId });
    messages.push({
      role: 'assistant',
      content: `第 ${index + 1} 版`,
      images: [{ id, prompt: `方案图 第 ${index + 1} 版` }],
    });
  }
  insertChatRow({ id: chatId, messages });

  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({ final_images: [{ image_id: ids[29], caption: '最终方案图' }] }),
    sections: [
      ['## 1. 技术架构\n\n最终方案。\n\n![最终方案图](image:' + ids[29] + ')'],
      ['## 2. 部署架构\n\n部署完成。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.image_count, 1);
  const { media, xml } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 1);
  assert.match(xml, /最终方案图/);
  assert.doesNotMatch(xml, /附录：会话图片|当轮要求|方案图 第 \d+ 版/);
});

test('automatic Word export keeps the draft-approved version when a newer edit was rejected', async () => {
  const chatId = nextChatId();
  const accepted = '9a2b3c4d0000000000000001';
  const rejected = idOf(0xf7);
  const superseded = idOf(0xf8);
  const technical = idOf(0xf9);
  await writeImage(superseded, '#aa3355');
  await writeImage(accepted, '#33aa55');
  await writeImage(rejected, '#3355aa');
  await writeImage(technical, '#774499');
  insertChatRow({ id: chatId, messages: [
    { role: 'assistant', images: [{ id: superseded, prompt: '现状系统架构图' }] },
    { role: 'assistant', images: [{ id: accepted, prompt: '现状系统架构图 无角标', parentId: superseded }] },
    { role: 'assistant', images: [{ id: rejected, prompt: '现状系统架构图 新增角标', parentId: accepted }] },
    { role: 'assistant', content: '图 2-2 现状技术架构（`' + technical + '`）', images: [{ id: technical, prompt: '单体分层图' }] },
    { role: 'user', content: '不用加角标了，重新输出文档吧。' },
    { role: 'assistant', content: '已确认：图 2-1 使用无角标版本 `9a2b3c4d`。\n\n# 架构方案\n\n| 图 2-3 | 现状技术架构 | §2 |' },
    { role: 'user', content: '按此稿生成 Word。' },
  ] });
  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({ final_images: [{ image_id: accepted, caption: '无角标系统架构', section: 1 }] }),
    sections: [
      [`## 1. 技术架构\n\n现状证明。\n\n![无角标系统架构](image:${accepted})`],
      ['## 2. 部署架构\n\n部署完成。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.issues, undefined);
  assert.equal(result.document.image_count, 2);
  const { media, xml } = await readDocxMedia(result.document.id);
  assert.equal(media.length, 2);
  assert.match(xml, /无角标系统架构/);
  assert.match(xml, /图 2：现状技术架构/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), new RegExp(`${superseded}|${rejected}`));
});

test('a hidden picture whose file is gone is never reported or described', async () => {
  const chatId = nextChatId();
  const VISIBLE = idOf(0xa9);
  const HIDDEN_GONE = idOf(0xb9);
  const GONE = idOf(0xc9);
  await writeImage(VISIBLE, '#0a0b0c');

  // Neither a discarded nor an unreadable image belongs in the automatic export.
  insertChatRow({
    id: chatId,
    messages: [
      { role: 'user', content: '画图' },
      {
        role: 'assistant',
        content: '完成',
        images: [
          { id: VISIBLE, prompt: '保留的架构图' },
          { id: HIDDEN_GONE, prompt: '用户隐藏且文件已删的部署图' },
          { id: GONE, prompt: '文件已丢失的流程图' },
        ],
      },
    ],
  });
  await insertGallery({ id: VISIBLE, prompt: '保留的架构图', chatId });
  await insertGallery({
    id: HIDDEN_GONE,
    prompt: '用户隐藏且文件已删的部署图',
    chatId,
    hidden: true,
  });
  await insertGallery({ id: GONE, prompt: '文件已丢失的流程图', chatId });

  const result = await runExport({
    chatId,
    imagePlan: JSON.stringify({ final_images: [{ image_id: VISIBLE, caption: '架构图', section: 1 }] }),
    sections: [
      ['## 1. 技术架构\n\n采用分层架构。\n\n![架构图](image:' + VISIBLE + ')'],
      ['## 2. 部署架构\n\n部署完成。'],
    ],
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.issues, undefined);
  assert.equal(result.document.image_count, 1);
  const { xml } = await readDocxMedia(result.document.id);
  assert.doesNotMatch(
    xml,
    /用户隐藏且文件已删的部署图/,
    'a hidden picture is not described in the export even when its file is missing',
  );
  assert.doesNotMatch(xml, new RegExp(HIDDEN_GONE));
  assert.doesNotMatch(xml, /文件已不存在|文件已丢失的流程图/);
  assert.doesNotMatch(xml, new RegExp(GONE));
});
