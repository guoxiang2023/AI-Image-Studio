import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentMessages,
  buildDocumentPlanMessages,
  buildTranscript,
  collectDocumentImages,
  finalizeDocument,
  parseDocumentMarkdown,
  parseDocumentPlan,
  selectFinalDocumentImages,
} from '../src/domain/document.js';
import { buildAnthropicRequest } from '../src/ai/anthropic.js';
import { SYSTEM_PROMPT, TOOLS } from '../src/ai/prompts.js';
import sharp from 'sharp';
import { buildDocx } from '../src/media/docx.js';
import { buildPdf } from '../src/media/pdf.js';
import { createZip } from '../src/media/zip-writer.js';
import { openZip } from '../src/media/zip-reader.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
  'base64',
);
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ID_C = 'cccccccccccccccccccccccc';
const ID_D = 'dddddddddddddddddddddddd';
const ID_E = 'eeeeeeeeeeeeeeeeeeeeeeee';

test('ZIP writer round-trips compressed and stored entries', () => {
  const archive = createZip([
    { name: 'hello.txt', data: '你好，Luma' },
    { name: 'media/raw.bin', data: Buffer.from([0, 1, 2, 255]), compress: false },
  ]);
  const zip = openZip(archive);
  assert.equal(zip.readText('hello.txt'), '你好，Luma');
  assert.deepEqual([...zip.read('media/raw.bin')], [0, 1, 2, 255]);
});

test('parses headings, paragraphs, lists, quotes, and image lines', () => {
  const parsed = parseDocumentMarkdown(`# 光影方案

这是一段导语，包含 **重点** 和 \`代码\`。

## 思路

- 第一点
- 第二点

![主视觉](image:${ID_A})

> 保留文字层级。`);

  assert.equal(parsed.title, '光影方案');
  assert.equal(
    parsed.blocks.map((block) => block.type).join(','),
    'paragraph,heading,bullets,image,quote',
  );
  assert.equal(parsed.blocks[2].items.length, 2);
  assert.equal(parsed.blocks[3].id, ID_A);
  assert.equal(parsed.blocks[3].caption, '主视觉');

  const fenced = parseDocumentMarkdown('```markdown\n# 外层标题\n\n正文\n```');
  assert.equal(fenced.title, '外层标题');
  assert.equal(fenced.blocks[0].text, '正文');
});

test('finalizes images: drops unknown/duplicate IDs and never appends unselected images', () => {
  const images = [
    { id: ID_A, prompt: 'morning light', caption: '清晨', aspectRatio: '1:1' },
    { id: ID_B, prompt: 'night scene', caption: '', aspectRatio: '16:9' },
  ];
  const result = finalizeDocument({
    title: '会话标题',
    images,
    markdown: `# 最终方案

![清晨](image:${ID_A})

![重复](image:${ID_A})

![不存在](image:${ID_C})`,
  });

  const imageBlocks = result.blocks.filter((block) => block.type === 'image');
  assert.deepEqual(
    imageBlocks.map((block) => block.id),
    [ID_A],
  );
  assert.equal(result.title, '最终方案');
  assert.equal(result.imageCount, 1);
});

test('builds a DOCX with embedded image XML, rels, and media', () => {
  const buffer = buildDocx({
    title: '测试文档',
    meta: '由 Luma 整理',
    blocks: [
      { type: 'heading', level: 2, text: '章节' },
      { type: 'paragraph', text: '正文 **加粗**' },
      { type: 'image', data: PNG, width: 1, height: 1, caption: '图注' },
    ],
  });
  const zip = openZip(buffer);
  const document = zip.readText('word/document.xml');
  const rels = zip.readText('word/_rels/document.xml.rels');
  const types = zip.readText('[Content_Types].xml');

  assert.match(document, /测试文档/);
  assert.match(document, /r:embed="rIdImg1"/);
  assert.match(document, /<wp:extent cx="\d+" cy="\d+"\/>/);
  assert.match(document, /图注/);
  assert.match(rels, /Target="media\/image1\.jpeg"/);
  assert.match(types, /image\/jpeg/);
  assert.deepEqual(zip.read('word/media/image1.jpeg'), PNG);
});

test('selects only final deliverable images', () => {
  const images = [
    { id: ID_A, prompt: 'draft', parentId: null },
    { id: ID_B, prompt: 'edit', parentId: ID_A },
    { id: ID_C, prompt: 'final', parentId: ID_B },
    { id: ID_D, prompt: 'discarded', parentId: null },
    { id: ID_E, prompt: 'missing', parentId: null },
  ];
  const result = selectFinalDocumentImages(images, {
    hiddenIds: [ID_D],
    unavailableIds: [ID_E],
    limit: 10,
  });

  assert.deepEqual(
    result.map((image) => image.id),
    [ID_C],
  );
  assert.equal(result[0].index, 1);

  const hiddenFinal = selectFinalDocumentImages(images, {
    hiddenIds: [ID_C, ID_D],
    unavailableIds: [ID_E],
    limit: 10,
  });
  assert.deepEqual(hiddenFinal, []);

  const limited = selectFinalDocumentImages(
    [
      { id: ID_A, prompt: 'older' },
      { id: ID_B, prompt: 'newer' },
    ],
    { limit: 1 },
  );
  assert.deepEqual(
    limited.map((image) => image.id),
    [ID_B],
  );
});

test('collects unique images in order and keeps the newest when limited', () => {
  const chat = {
    messages: [
      { role: 'assistant', images: [{ id: ID_A, prompt: 'a' }, { id: ID_A, prompt: 'a' }] },
      { role: 'assistant', images: [{ id: ID_B, prompt: 'b' }] },
    ],
  };
  const all = collectDocumentImages(chat, 10);
  assert.deepEqual(
    all.images.map((image) => image.id),
    [ID_A, ID_B],
  );
  const latest = collectDocumentImages(chat, 1);
  assert.deepEqual(
    latest.images.map((image) => image.id),
    [ID_B],
  );
  assert.equal(latest.omitted, 1);
});

test('transcript keeps the summary and newest messages under the limit', () => {
  const chat = {
    summary: '早期摘要',
    summaryUpto: 0,
    messages: [
      { role: 'user', content: '第一段'.repeat(100) },
      { role: 'assistant', content: '第二段'.repeat(100) },
      { role: 'user', content: '最后的问题' },
    ],
  };
  const text = buildTranscript(chat, 400);
  assert.match(text, /早期摘要/);
  assert.match(text, /最后的问题/);
  assert.match(text, /较早的 \d+ 条对话已省略/);
});

test('plans final structure and keeps only valid final images', () => {
  const images = [
    { id: ID_A, index: 1, prompt: '主视觉初稿' },
    { id: ID_B, index: 2, prompt: '最终主视觉' },
  ];
  const planMessages = buildDocumentPlanMessages({
    chat: { title: '夜跑海报评审' },
    images,
    transcript: '用户：用第二张，第一张不要。',
  });
  assert.deepEqual(
    planMessages.map((message) => message.role),
    ['system', 'user'],
  );
  assert.match(planMessages[1].content, /只输出一个 JSON 对象/);
  assert.match(planMessages[1].content, /只选终稿图片/);

  const plan = parseDocumentPlan(
    `\`\`\`json
{"title":"夜跑海报终稿评审","document_type":"评审材料","audience":"品牌评审组","objective":"确认主视觉","core_message":"采用最终版霓虹街道主视觉","sections":[{"heading":"最终方案","purpose":"展示终稿","points":["霓虹街道","标题清晰"]}],"final_images":[{"image_id":"${ID_B}","caption":"最终主视觉","role":"主交付"},{"image_id":"${ID_B}","caption":"重复"},{"image_id":"${ID_C}","caption":"不存在"}],"key_facts":["主视觉 3:2"],"open_issues":[]}
\`\`\``,
    images,
  );
  assert.equal(plan.title, '夜跑海报终稿评审');
  assert.equal(plan.documentType, '评审材料');
  assert.deepEqual(
    plan.images.map((image) => image.id),
    [ID_B],
  );
  assert.equal(plan.images[0].caption, '最终主视觉');
  assert.equal(plan.sections.length, 1);
  assert.deepEqual(plan.keyFacts, ['主视觉 3:2']);
  assert.equal(parseDocumentPlan('不是 JSON', images), null);
});

test('document request keeps a user turn for Anthropic Messages', () => {
  const messages = buildDocumentMessages({
    chat: { title: '夜跑海报' },
    images: [
      {
        id: ID_A,
        index: 1,
        prompt: 'night run',
        caption: '夜跑',
        aspectRatio: '3:2',
        parentId: null,
      },
    ],
    transcript: '用户：做一张夜跑海报',
  });
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user'],
  );
  assert.match(messages[1].content, new RegExp(`image_id=${ID_A}`));
  assert.match(messages[1].content, /做一张夜跑海报/);
  assert.match(messages[1].content, /只写终稿/);
  assert.match(messages[1].content, /过程稿/);
  assert.match(messages[1].content, /每个结论都能在前文找到依据/);

  const request = buildAnthropicRequest(
    { baseUrl: 'https://api.anthropic.com', model: 'claude-test', apiKey: 'secret' },
    messages,
    { tools: false },
  );
  assert.equal(request.body.system, messages[0].content);
  assert.equal(request.body.messages.length, 1);
  assert.equal(request.body.messages[0].role, 'user');
  assert.equal(request.body.messages[0].content[0].text, messages[1].content);
});

test('renders a PDF with selectable text and an embedded image', async (t) => {
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#3366ff' },
  })
    .jpeg()
    .toBuffer();
  let buffer;
  try {
    buffer = await buildPdf({
      title: 'PDF 测试文档',
      meta: '由 Luma 整理',
      blocks: [
        { type: 'paragraph', text: '这一段中文应当可以被 PDF 文本层读取。' },
        { type: 'image', data: image, width: 120, height: 80, caption: '测试图片' },
      ],
    });
  } catch (error) {
    if (error?.status === 500 && /中文字体/.test(error.message)) {
      t.skip('主机没有可用的中文字体');
      return;
    }
    throw error;
  }

  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join('');
    assert.match(text, /PDF 测试文档/);
    assert.match(text, /这一段中文/);
    assert.match(text, /测试图片/);
  } finally {
    await pdf.destroy();
  }
});

test('exposes document generation as an agent tool', () => {
  const tool = TOOLS.find((entry) => entry.function?.name === 'create_document');
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.format.enum, ['pdf', 'docx']);
  assert.match(tool.function.description, /默认生成 Word/);
  assert.match(tool.function.parameters.properties.format.description, /默认 docx/);
  assert.match(SYSTEM_PROMPT, /create_document/);
  assert.match(SYSTEM_PROMPT, /默认生成 Word/);
  assert.match(SYSTEM_PROMPT, /我的文档/);
});
