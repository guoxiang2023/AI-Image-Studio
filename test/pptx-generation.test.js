import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function reply(res, content, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'mock-pptx',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
    }),
  );
}

async function setup(t, handler) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-pptx-gen-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const { insertChat } = await import('../src/data/repositories/chats.js');
  const { defaultSettings, saveUserSettings } = await import(
    '../src/services/model-settings-service.js'
  );

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 9)));

  const requests = [];
  const llm = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      requests.push(body);
      handler(res, body?.messages?.[1]?.content || '');
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const port = llm.address().port;

  const userId = 'user-pptx-test';
  const chatId = 'd'.repeat(24);
  insertChat({
    id: chatId,
    userId,
    title: '季度复盘',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: '这季度我们做了工作目录和文档生成，帮我做一份汇报 PPT' },
      {
        role: 'assistant',
        content:
          '本季度完成了两项能力：工作目录支持按需读取项目文件，文档生成支持 Word、PDF 与 PPT 三种格式。',
      },
      { role: 'user', content: '下一步要验证 PowerPoint 兼容性。' },
    ]),
    summary: '',
    summaryUpto: 0,
  });

  const settings = defaultSettings();
  const provider = {
    ...settings.llm.providers[0],
    id: 'llm-pptx',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  settings.llm = { ...settings.llm, ...provider, providers: [provider], activeId: provider.id };
  saveUserSettings(userId, settings);

  t.after(async () => {
    await new Promise((resolve) => llm.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { userId, chatId, requests };
}

test('create_document with pptx produces a deck, not a document', async (t) => {
  const plan = {
    title: '季度复盘',
    subtitle: '2026 Q4 · 产品与技术',
    slides: [
      { layout: 'cover', title: '季度复盘', subtitle: '2026 Q4 · 产品与技术' },
      { layout: 'section', title: '关键进展' },
      {
        layout: 'bullets',
        title: '工作目录让分析不再靠粘贴',
        bullets: ['绑定目录后按需读取', '凭据文件自动跳过'],
      },
      { layout: 'bullets', title: '下一步', bullets: ['验证 PowerPoint 兼容性'] },
    ],
  };
  const { userId, chatId, requests } = await setup(t, (res) => reply(res, JSON.stringify(plan)));

  const { runTool } = await import('../src/services/tools-service.js');
  const { listUserDocuments, getUserDocument } = await import(
    '../src/services/document-library-service.js'
  );

  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.format, 'pptx');
  assert.equal(result.document.slide_count, 4);
  assert.ok(result.document.size > 1000, 'the archive carries real content');
  assert.match(result.document.title, /季度复盘/);

  // The prompt must ask for pages, not chapters.
  const prompt = requests[0].messages[1].content;
  assert.match(prompt, /一页一个观点/);
  assert.match(prompt, /"slides"/);

  const saved = listUserDocuments(userId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].format, 'pptx');
  assert.match(saved[0].filename, /\.pptx$/);

  const detail = getUserDocument(userId, saved[0].id);
  assert.equal(detail.blocks.length, 4, 'preview keeps one entry per slide');
  assert.equal(detail.blocks[0].layout, 'cover');
  assert.deepEqual(detail.blocks[2].bullets, ['绑定目录后按需读取', '凭据文件自动跳过']);
});

test('a broken plan degrades to a deterministic deck instead of failing', async (t) => {
  const { userId, chatId } = await setup(t, (res) => reply(res, '抱歉，我不会输出 JSON。'));

  const { runTool } = await import('../src/services/tools-service.js');
  const { getUserDocument, listUserDocuments } = await import(
    '../src/services/document-library-service.js'
  );

  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined, result.error);
  assert.equal(result.document.format, 'pptx');
  assert.ok(result.document.slide_count >= 2, 'fallback still yields a real deck');

  const detail = getUserDocument(userId, listUserDocuments(userId)[0].id);
  assert.equal(detail.blocks[0].layout, 'cover');
  assert.ok(detail.blocks.some((slide) => slide.bullets?.length), 'fallback pages carry content');
});

test('a truncated plan also falls back rather than shipping a stub', async (t) => {
  const { userId, chatId } = await setup(t, (res) =>
    reply(res, '{"title":"半截','length'),
  );

  const { runTool } = await import('../src/services/tools-service.js');
  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined, result.error);
  assert.ok(result.document.slide_count >= 2);
});

test('docx stays the default when no format is requested', async (t) => {
  const { userId, chatId } = await setup(t, (res) =>
    reply(res, JSON.stringify({ title: '文档', sections: [{ heading: '正文' }] })),
  );

  const { runTool } = await import('../src/services/tools-service.js');
  const result = await runTool('create_document', {}, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.document.format, 'docx');
});

// README promises that images removed from the gallery, or superseded by a
// later edit, never enter a deliverable. The deck used to allowlist raw chat
// images, so a hidden draft could still be embedded.
test('only curated images can reach the deck', async (t) => {
  let promptSeen = '';
  let hiddenId = '';
  let finalId = '';

  // The reply is built from whatever ids exist by the time it is requested, so
  // the mock asks for a hidden image and the real final one.
  const { userId, chatId } = await setup(t, (res, prompt) => {
    promptSeen = prompt;
    reply(
      res,
      JSON.stringify({
        title: '配图测试',
        slides: [
          { layout: 'cover', title: '配图测试', subtitle: '' },
          { layout: 'image', title: '隐藏图', bullets: ['x'], image_id: hiddenId },
          { layout: 'image', title: '终稿图', bullets: ['y'], image_id: finalId },
        ],
      }),
    );
  });

  const [, { saveImageBuffer }, { insertGalleryImage, hideGalleryImage }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/media/image-storage.js'),
    import('../src/data/repositories/gallery.js'),
  ]);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
    'base64',
  );
  const saved = await saveImageBuffer(userId, png, 'png');
  const finalSaved = await saveImageBuffer(userId, png, 'png');
  hiddenId = saved.id;
  finalId = finalSaved.id;

  insertGalleryImage({
    id: saved.id,
    userId,
    ext: 'png',
    prompt: '架构图草稿',
    size: '1024x1024',
    aspectRatio: '1:1',
    chatId,
    createdAt: Date.now(),
    parentId: null,
  });
  insertGalleryImage({
    id: finalSaved.id,
    userId,
    ext: 'png',
    prompt: '修正的架构图',
    size: '1024x1024',
    aspectRatio: '1:1',
    chatId,
    createdAt: Date.now(),
    parentId: null,
  });
  hideGalleryImage(userId, saved.id);

  // Chat carries the hidden image and the real final one. The hidden image is
  // offered to the planner only if curation is bypassed.
  const { getDb } = await import('../src/data/database.js');
  getDb()
    .prepare('UPDATE chats SET messages_json = ? WHERE id = ?')
    .run(
      JSON.stringify([
        { role: 'user', content: '画一张架构图' },
        {
          role: 'assistant',
          content: '已生成',
          images: [{ id: saved.id, prompt: '架构图', url: `/files/${saved.id}.png` }],
        },
        { role: 'user', content: '基于这张再改一版' },
        {
          role: 'assistant',
          content: '已更新',
          images: [
            { id: finalSaved.id, prompt: '架构图终稿', url: `/files/${finalSaved.id}.png` },
          ],
        },
      ]),
      chatId,
    );

  const { runTool } = await import('../src/services/tools-service.js');
  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined, result.error);

  // The catalog is the only place the model may take ids from; the transcript
  // above still mentions every generated image by id, which is fine.
  const catalogStart = promptSeen.indexOf('【可用图片清单】');
  const catalogEnd = promptSeen.indexOf('【对话内容】');
  assert.ok(catalogStart >= 0 && catalogEnd > catalogStart, 'prompt has an image catalog');
  const catalog = promptSeen.slice(catalogStart, catalogEnd);
  assert.match(catalog, new RegExp(finalSaved.id), 'the final image is offered');
  assert.doesNotMatch(
    catalog,
    new RegExp(saved.id),
    'a hidden image must not be offered to the planner',
  );

  // The deck embeds only the curated image.
  assert.equal(result.document.image_count, 1);

  const { openZip } = await import('../src/media/zip-reader.js');
  const { getUserDocument, listUserDocuments, userDocumentPath } = await import(
    '../src/services/document-library-service.js'
  );
  const doc = getUserDocument(userId, listUserDocuments(userId)[0].id);
  const buffer = await (await import('node:fs/promises')).readFile(userDocumentPath(userId, doc));
  const zip = openZip(buffer);
  const media = zip.names().filter((name) => name.startsWith('ppt/media/'));
  assert.equal(media.length, 1, 'exactly one picture part is embedded');
});

test('a plan cut off by max_tokens keeps the pages that finished', async (t) => {
  // Valid objects followed by a dangling tail: JSON.parse rejects the whole
  // string, yet every completed page is still usable.
  const full = JSON.stringify({
    title: '锦江物流园项目 2026 年度汇报',
    slides: [
      { layout: 'cover', title: '锦江物流园项目 2026 年度汇报', subtitle: '成果与规划' },
      { layout: 'bullets', title: '一期主体结构封顶', bullets: ['合计 53,533.30㎡，用地 45 亩'] },
      { layout: 'bullets', title: '2027 年计划投资 2.45 亿元', bullets: ['土建 1.42 亿元'] },
    ],
  });
  const truncated = `${full.slice(0, full.lastIndexOf('},') + 1)},{"layout":"bullets","title":"被`;

  const { userId, chatId } = await setup(t, (res) => reply(res, truncated, 'length'));
  const { runTool } = await import('../src/services/tools-service.js');
  const { getUserDocument } = await import('../src/services/document-library-service.js');

  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId }, chat: { id: chatId }, signal: undefined, emit() {},
  });

  assert.equal(result.error, undefined, result.error);
  // Both finished pages survive; the truncated one does not become a stub.
  assert.equal(result.document.slide_count, 2);
  const preview = getUserDocument(userId, result.document.id).blocks;
  assert.deepEqual(preview.map((slide) => slide.layout), ['cover', 'bullets']);
  assert.ok(
    preview[1].bullets.includes('合计 53,533.30㎡，用地 45 亩'),
    'the salvaged bullet keeps its exact number',
  );
});

test('a salvaged deck is reported as degraded, not as a finished 终稿', async (t) => {
  const full = JSON.stringify({
    title: '锦江物流园项目汇报',
    slides: [
      { layout: 'cover', title: '锦江物流园项目汇报', subtitle: '成果与规划' },
      { layout: 'bullets', title: '2026 年投资完成率 98.4%', bullets: ['计划 1.82 亿元，完成 1.79 亿元'] },
      { layout: 'bullets', title: '被截断的页', bullets: ['这页没有写完'] },
    ],
  });
  const truncated = `${full.slice(0, full.lastIndexOf('},') + 1)},{"layout":"bullets","title":"被`;

  const { userId, chatId } = await setup(t, (res) => reply(res, truncated, 'length'));
  const { runTool } = await import('../src/services/tools-service.js');
  const { getUserDocument } = await import('../src/services/document-library-service.js');

  const events = [];
  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId }, chat: { id: chatId }, signal: undefined,
    emit(event) { events.push(event); },
  });

  assert.equal(result.degraded, 'salvaged', 'the tool result carries the degraded state');
  assert.match(result.note, /初稿/, 'the note tells the caller not to present it as a final deck');
  const created = events.find((event) => event.type === 'document');
  assert.equal(created.document.degraded, 'salvaged', 'the UI event carries it too');

  const saved = getUserDocument(userId, result.document.id);
  assert.equal(saved.blocks.length, 2, 'the completed pages are still delivered');
});

test('a fallback deck is also flagged as degraded', async (t) => {
  const { userId, chatId } = await setup(t, (res) => reply(res, '抱歉，我无法完成这个任务。'));
  const { runTool } = await import('../src/services/tools-service.js');

  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId }, chat: { id: chatId }, signal: undefined, emit() {},
  });

  assert.equal(result.error, undefined, result.error);
  assert.equal(result.degraded, 'fallback');
  assert.match(result.note, /初稿/);
});

test('a complete plan is not flagged', async (t) => {
  const plan = {
    title: '季度复盘',
    slides: [
      { layout: 'cover', title: '季度复盘', subtitle: '2026 Q4' },
      { layout: 'bullets', title: '完成两项能力', bullets: ['工作目录', '文档生成'] },
    ],
  };
  const { userId, chatId } = await setup(t, (res) => reply(res, JSON.stringify(plan)));
  const { runTool } = await import('../src/services/tools-service.js');

  const result = await runTool('create_document', { format: 'pptx' }, {
    user: { id: userId }, chat: { id: chatId }, signal: undefined, emit() {},
  });

  assert.equal(result.degraded, undefined, 'a complete plan stays a 终稿');
  assert.match(result.note, /可.*查看和下载/);
});
