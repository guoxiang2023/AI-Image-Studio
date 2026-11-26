import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentImagePlanMessages,
  buildDocumentMessages,
  buildDocumentBriefMessages,
  buildDocumentContextChunks,
  buildDocumentMergeMessages,
  buildDocumentPlanMessages,
  buildFallbackDocumentPlan,
  buildSectionTranscript,
  buildDocumentSectionMessages,
  buildTranscript,
  collectDocumentImages,
  fallbackDocumentImages,
  finalizeDocument,
  findFinalDraft,
  stripDraftPreamble,
  attachReferencedImages,
  parseDocumentImagePlan,
  parseDocumentMarkdown,
  parseDocumentPlan,
  sectionImageBuckets,
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

test('parses Markdown tables into structured blocks', () => {
  const parsed = parseDocumentMarkdown(`# 数据字典

## 任务表 wcs_task

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| task_id | varchar(32) | Y | 主键 |
| status | smallint | Y | 状态 |

索引：uk_task(task_id)。`);

  assert.equal(parsed.blocks[0].type, 'heading');
  const table = parsed.blocks.find((block) => block.type === 'table');
  assert.deepEqual(table.headers, ['字段', '类型', '必填', '说明']);
  assert.deepEqual(table.rows, [
    ['task_id', 'varchar(32)', 'Y', '主键'],
    ['status', 'smallint', 'Y', '状态'],
  ]);
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
    meta: '终稿 · 测试',
    blocks: [
      { type: 'heading', level: 2, text: '章节' },
      { type: 'paragraph', text: '正文 **加粗**' },
      { type: 'image', data: PNG, width: 1, height: 1, caption: '图注' },
    ],
  });
  const zip = openZip(buffer);
  const document = zip.readText('word/document.xml');
  const core = zip.readText('docProps/core.xml');
  const rels = zip.readText('word/_rels/document.xml.rels');
  const types = zip.readText('[Content_Types].xml');

  assert.match(document, /测试文档/);
  assert.match(document, /r:embed="rIdImg1"/);
  assert.match(document, /<wp:extent cx="\d+" cy="\d+"\/>/);
  assert.match(document, /图注/);
  assert.doesNotMatch(document, /Luma/i);
  assert.doesNotMatch(core, /Luma/i);
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

test('drops superseded diagram revisions even without parentId', () => {
  const selected = selectFinalDocumentImages([
    { id: ID_A, prompt: 'A technical architecture diagram, generic layers' },
    { id: ID_B, prompt: 'Redraw the exact same technical architecture diagram in Chinese' },
    { id: ID_C, prompt: 'Keep the layout and structure but replace every layer with concrete technology' },
  ]);
  assert.deepEqual(
    selected.map((image) => image.id),
    [ID_C],
  );

  const separate = selectFinalDocumentImages([
    { id: ID_A, prompt: 'A deployment architecture diagram with three network zones' },
    { id: ID_B, prompt: 'A disaster-recovery sequence diagram matching the reference image style' },
  ]);
  assert.deepEqual(
    separate.map((image) => image.id),
    [ID_A, ID_B],
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

test('transcript strips generation-process chatter from assistant text', () => {
  const text = buildTranscript({
    messages: [
      { role: 'user', content: '生成完整数据字典' },
      {
        role: 'assistant',
        content:
          '这次已成功生成 PDF，5 张核心配图已排入。\n| 字段 | 类型 |\n| task_id | varchar |\n需要的话，我可以补充逐图导读和评审问题清单。',
      },
    ],
  }, 40000);
  assert.doesNotMatch(text, /PDF|核心配图|逐图|评审问题清单/);
  assert.match(text, /task_id/);
});

test('transcript includes messages before the rolling summary cutoff', () => {
  const text = buildTranscript({
    summary: '早期摘要',
    summaryUpto: 2,
    messages: [
      { role: 'user', content: '架构图需求' },
      { role: 'assistant', content: '技术架构图' },
      { role: 'user', content: '最新要求：完整数据字典' },
    ],
  }, 40000);
  assert.match(text, /架构图需求/);
  assert.match(text, /技术架构图/);
  assert.match(text, /完整数据字典/);
});

test('transcript prioritizes newest messages and ignores stale summaries', () => {
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
  assert.doesNotMatch(text, /早期摘要/);
  assert.match(text, /最后的问题/);
  assert.match(text, /较早的 \d+ 条对话已省略/);
});

test('falls back to a deterministic outline and bounded chapter evidence', () => {
  const chat = {
    title: 'WCS 概要设计',
    messages: [
      { role: 'user', content: '先做架构图' },
      { role: 'assistant', content: '技术架构说明 '.repeat(900) },
      {
        role: 'assistant',
        content:
          '#### 8.2 任务表 wcs_task\n| 字段 | 类型 | 说明 |\n|---|---|---|\n| task_id | varchar(32) | 主键 |\n| status | smallint | 状态 |',
      },
      { role: 'user', content: '最终确认数据字典' },
    ],
  };
  const plan = buildFallbackDocumentPlan(chat);
  assert.equal(plan.sections.length, 9);
  assert.match(plan.sections[7].heading, /数据库设计/);
  assert.equal(plan.fallback, true);

  const context = buildSectionTranscript(
    chat,
    { heading: '数据库设计：完整数据字典、字段、索引' },
    2000,
  );
  assert.match(context, /wcs_task/);
  assert.match(context, /task_id/);
  assert.ok(context.length <= 2100);
});

test('chunks the whole conversation for semantic summarization', () => {
  const chat = {
    messages: [
      { role: 'user', content: '早期需求'.repeat(300) },
      { role: 'assistant', content: '中间讨论'.repeat(300) },
      { role: 'user', content: '最新需求'.repeat(300) },
    ],
  };
  const chunks = buildDocumentContextChunks(chat, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.match(chunks[0], /早期需求/);
  assert.match(chunks.at(-1), /最新需求/);
  const messages = buildDocumentBriefMessages({ chunk: chunks[0] });
  assert.match(messages[1].content, /事实摘要/);
  assert.match(messages[1].content, /【数据与数据库】/);
  const merge = buildDocumentMergeMessages({ summaries: ['片段一', '片段二'] });
  assert.match(merge[1].content, /必须覆盖所有片段/);
});

test('keeps forced user turns inside the section context budget', () => {
  const chat = {
    messages: [
      { role: 'user', content: '早期需求'.repeat(3000) },
      { role: 'user', content: '最新需求'.repeat(3000) },
    ],
  };
  const context = buildSectionTranscript(chat, { heading: '背景与目标' }, 2000);
  assert.ok(context.length <= 2100);
  assert.match(context, /最新需求/);
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
  assert.match(planMessages[1].content, /7–10 个章节/);
  assert.match(planMessages[1].content, /完整数据字典/);

  const imageMessages = buildDocumentImagePlanMessages({
    chat: { title: '夜跑海报评审' },
    images: [
      {
        id: ID_A,
        index: 1,
        turn: 2,
        prompt: '旧版技术架构',
        request: '画一张技术架构图',
      },
      {
        id: ID_B,
        index: 2,
        turn: 4,
        prompt: '填实技术选型的技术架构',
        request: '具体技术实现没有',
      },
    ],
    plan: { title: '夜跑海报评审', sections: [{ heading: '技术架构' }] },
  });
  assert.match(imageMessages[1].content, /只选最后生成、最新的一版/);
  assert.match(imageMessages[1].content, /具体技术实现没有/);

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
  const imagePlan = parseDocumentImagePlan(
    `{"final_images":[{"image_id":"${ID_B}","caption":"最新主视觉","section":1},{"image_id":"${ID_C}","caption":"不存在"}]}`,
    images,
    plan.sections,
  );
  assert.deepEqual(
    imagePlan.map((image) => image.id),
    [ID_B],
  );
  assert.equal(plan.sections.length, 1);
  assert.deepEqual(plan.keyFacts, ['主视觉 3:2']);
  assert.equal(parseDocumentPlan('不是 JSON', images), null);
});

test('keeps more than twelve final images and honors the caller limit', () => {
  const ids = Array.from({ length: 20 }, (_, index) =>
    index.toString(16).padStart(24, '0'),
  );
  const images = ids.map((id, index) => ({ id, index: index + 1, prompt: `图 ${index + 1}` }));
  const requested = ids.map((id, index) => ({
    image_id: id,
    caption: `第 ${index + 1} 张终稿图`,
    section: 1,
  }));

  const selected = parseDocumentImagePlan(
    JSON.stringify({ final_images: requested }),
    images,
    [{ heading: '总体设计概览' }],
    18,
  );
  assert.equal(selected.length, 18);

  const defaulted = parseDocumentImagePlan(
    JSON.stringify({ final_images: requested }),
    images,
    [{ heading: '总体设计概览' }],
  );
  assert.equal(defaulted.length, 20);

  const fallback = fallbackDocumentImages(images, [{ heading: '背景' }], 15);
  assert.equal(fallback.length, 15);

  const prompt = buildDocumentImagePlanMessages({
    chat: { title: '图数上限' },
    images,
    plan: { title: '图数上限', sections: [{ heading: '背景' }] },
    limit: 30,
  });
  assert.match(prompt[1].content, /最多选 30 张/);
});

test('spreads images across chapters so none is silently dropped', () => {
  const ids = Array.from({ length: 24 }, (_, index) =>
    index.toString(16).padStart(24, '0'),
  );
  const images = ids.map((id) => ({ id, section: 1 }));
  const sections = Array.from({ length: 7 }, (_, index) => ({ heading: `章 ${index + 1}` }));

  // 24 images on 7 chapters is the default worst case: quota must grow past 3.
  const wide = sectionImageBuckets({ images }, sections);
  assert.deepEqual(wide.dropped, []);
  assert.equal(wide.buckets.flat().length, 24);
  assert.equal(wide.perChapter, 4);
  assert.ok(
    wide.buckets.every((bucket) => bucket.length <= wide.perChapter),
    '每章引用数不能超过章节提示词的配额',
  );

  const tenChapters = sectionImageBuckets(
    { images },
    Array.from({ length: 10 }, (_, index) => ({ heading: `章 ${index + 1}` })),
  );
  assert.deepEqual(tenChapters.dropped, []);
  assert.equal(tenChapters.buckets.flat().length, 24);

  // An explicit smaller quota is the only way images get reported as dropped.
  const capped = sectionImageBuckets({ images }, sections, 3);
  assert.equal(capped.buckets.flat().length, 21);
  assert.equal(capped.dropped.length, 3);

  const emptySections = sectionImageBuckets({ images }, []);
  assert.deepEqual(emptySections.buckets, []);
  assert.equal(emptySections.dropped.length, 24);

  const unknownSection = sectionImageBuckets(
    { images: [{ id: ids[0], section: 99 }] },
    [{ heading: '章 1' }, { heading: '章 2' }],
  );
  assert.equal(unknownSection.buckets[0].length, 1);
});

test('chapter prompt cites as many images as its bucket holds', () => {
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: index.toString(16).padStart(24, '0'),
    caption: `图 ${index + 1}`,
  }));
  const messages = buildDocumentSectionMessages({
    chat: { title: '配额' },
    plan: { title: '配额', sections: [{ heading: '背景' }] },
    section: { heading: '背景' },
    index: 0,
    total: 1,
    images,
    transcript: '',
    imageQuota: 4,
  });
  assert.match(messages[1].content, /最多引用 4 张/);
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
      meta: '终稿 · 测试',
      blocks: [
        { type: 'paragraph', text: '这一段中文应当可以被 PDF 文本层读取。' },
        {
          type: 'table',
          headers: ['系统', '职责', '排除'],
          rows: [
            ['WMS', '库存账、波次、单据', '不管理设备指令'],
            ['WCS', '任务编排、设备驱动', '不负责库存账'],
          ],
        },
        { type: 'paragraph', text: '表格之后的段落必须回到左边距。' },
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
    const metadata = await pdf.getMetadata();
    assert.doesNotMatch(JSON.stringify(metadata.info || {}), /Luma/i);
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join('');
    assert.match(text, /PDF 测试文档/);
    assert.match(text, /这一段中文/);
    assert.match(text, /测试图片/);
    assert.doesNotMatch(text, /Luma/i);
    const afterTable = content.items.find((item) =>
      item.str.includes('表格之后的段落'),
    );
    assert.ok(afterTable, 'post-table paragraph should be extractable');
    assert.ok(
      afterTable.transform[4] < 100,
      `post-table paragraph must start at the page margin, got x=${afterTable.transform[4]}`,
    );
  } finally {
    await pdf.destroy();
  }
});

test('exposes document generation as an agent tool', () => {
  const tool = TOOLS.find((entry) => entry.function?.name === 'create_document');
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.format.enum, ['pdf', 'docx', 'pptx']);
  assert.match(tool.function.description, /默认生成 Word/);
  assert.match(tool.function.description, /pptx/);
  assert.match(tool.function.parameters.properties.format.description, /默认 docx/);
  assert.match(tool.function.parameters.properties.format.description, /pptx/);
  assert.match(SYSTEM_PROMPT, /create_document/);
  assert.match(SYSTEM_PROMPT, /默认生成 Word/);
  assert.match(SYSTEM_PROMPT, /我的文档/);
});

// A long session whose turn ran out of tool steps contains a hand-written
// document plus harness talk at both ends. Exporting it must reuse the prose and
// drop the talk: this is the case that used to regenerate everything and time out.
test('reuses a finished draft and strips harness talk from both ends', () => {
  const body = [
    '本轮工具调用额度已经用完，我没能调用文档生成工具。下面先把终稿正文交给你。',
    '',
    '# 终端运营平台演进方案',
    '',
    '## §0 结论',
    '',
    '报表性能的根因是指标口径在业务库即时计算，调 SQL 并不能解决它。跨窗去重被当成可加、时点快照被当成可累加，这两类错误与数据量无关，加机器、加索引都修不掉。方案是把口径从业务库摘出，建四层数据集，用注册表把可加性定义一次。技术改造是这条主线的前提，不是目的。',
    '',
    '## §0.1 风险',
    '',
    '可复现不等于正确。取证能证明现状如何运作，不能证明它算得对；因此每一类指标都要有独立的对账路径，分类全绿才允许切换。双跑期间出现的差异必须逐条归因到取数路径，而不是用容差覆盖过去。',
    '',
    '## §1 证据',
    '',
    '| # | 证据 | 数值 | 说明 |',
    '|---|---|---|---|',
    '| 1 | 报表 SQL | 115 条 | 说明列的句子明显更长，长到需要换行显示才完整 |',
    '| 2 | 时间列被函数包裹 | 1,018 处 | 谓词非 sargable，写出即索引不可用 |',
    '| 3 | ROWNUM 双层分页 | 7,934 处 | 需评估 OB 下深分页计划质量 |',
    '',
    '---',
    '',
    '## §2 计划',
    '',
    '第一期打通现金流与项目损益，第二期提升人效与交付质量，第三期建立经营决策与复用能力。每期结束都以可验证的数据为准，不以功能上线数量为准。三个期次之间保持数据集层的稳定，只允许新增指标与视图，不允许改动既有的口径定义。切换期间新旧两条链路并行，以双跑的一致性作为放行条件。',
    '',
    '---',
    '',
    '确认后我下一轮直接调用文档工具生成 Word。本轮因工具额度用尽未能产出文件，请以上述正文为准。',
  ].join('\n');
  const chat = {
    title: '终端运营平台演进方案',
    messages: [{ role: 'assistant', content: body }],
  };

  const draft = findFinalDraft(chat);
  assert.ok(draft, 'a structured draft qualifies');
  assert.doesNotMatch(draft, /额度已经用完|没能调用/);
  assert.doesNotMatch(draft, /下一轮|未能产出文件/);
  assert.match(draft, /^# 终端运营平台演进方案/);
  assert.match(draft, /## §2 计划/);

  const parsed = parseDocumentMarkdown(draft);
  assert.equal(parsed.title, '终端运营平台演进方案');
  assert.equal(parsed.blocks.filter((block) => block.type === 'table').length, 1);
});

test('ignores chat replies that merely talk about the document', () => {
  const chat = {
    messages: [
      { role: 'assistant', content: '# 正式方案\n\n## 一\n正文\n\n## 二\n正文\n\n## 三\n正文\n' + '补充说明。'.repeat(120) },
      { role: 'assistant', content: 'PDF 又超时了，我把图一张张列出来，文件等文档服务恢复后再补。' },
      { role: 'assistant', content: '好的，收到。' },
    ],
  };
  // The newest structured document wins even though later replies exist.
  const draft = findFinalDraft(chat);
  assert.ok(draft);
  assert.match(draft, /^# 正式方案/);
});

test('does not treat a short answer or an outline as a final draft', () => {
  assert.equal(findFinalDraft({ messages: [{ role: 'assistant', content: '已生成。' }] }), null);
  // Many headings, almost no body: the skeleton a model emits right before it
  // fills the chapters in. Rendering it would hand over a near-empty file.
  const outline = ['# 终端运营平台演进方案', ''];
  for (let index = 1; index <= 10; index += 1) {
    outline.push(`## §${index} 章节`, '', '待补充。', '');
  }
  assert.equal(
    findFinalDraft({ messages: [{ role: 'assistant', content: outline.join('\n') }] }),
    null,
  );
});

test('re-attaches figures cited by shortened id in a reused draft', () => {
  const images = [
    { id: 'fab2f36f2c4ce563a9bad0c9', caption: '指标语义层' },
    { id: '0c6922d91d71f6618d84d8e9', caption: '弃用版本' },
  ];
  const markdown = ['# 标题', '', '## §3 演进四层（对应图 `fab2f36f…`）', '', '正文一段。', '', '## 末节', '', '引用不存在的 `deadbeef…` 应保持原样。'].join('\n');
  const withImages = attachReferencedImages(markdown, images);
  assert.match(withImages, /!\[指标语义层\]\(fab2f36f2c4ce563a9bad0c9\)/);
  assert.doesNotMatch(withImages, /0c6922d91d71f6618d84d8e9/);
  assert.match(withImages, /引用不存在的 `deadbeef…` 应保持原样/);

  const parsed = parseDocumentMarkdown(withImages);
  assert.equal(parsed.blocks.filter((block) => block.type === 'image').length, 1);
  // An ambiguous prefix must not be guessed into a figure.
  assert.equal(
    attachReferencedImages('引用 `fab2` 前缀', [{ id: 'fab2aaaabbbbccccddddeeee' }, { id: 'fab2ffffbbbbccccddddeeee' }]).includes('!['),
    false,
  );
});

test('keeps a reused draft renderable with images, tables and rules intact', () => {
  const buffer = buildDocx({
    title: '复用终稿',
    meta: '终稿 · 测试',
    blocks: [
      { type: 'heading', level: 2, text: '§1 证据' },
      { type: 'table', headers: ['#', '证据', '数值', '说明'], rows: [['1', '报表 SQL', '115 条', '说明列的句子明显更长']] },
      { type: 'hr' },
      { type: 'image', data: PNG, width: 1, height: 1, caption: '图注' },
    ],
  });
  const zip = openZip(buffer);
  const document = zip.readText('word/document.xml');
  assert.equal((document.match(/<w:tbl>/g) || []).length, 1);
  assert.equal((document.match(/<w:drawing>/g) || []).length, 1);
  assert.equal((document.match(/<w:pBdr>/g) || []).length, 1);
  assert.match(document, /w:footerReference/);
  assert.ok(zip.read('word/footer1.xml').length > 0);
});

test('strips harness talk from both ends and keeps the real closing items', () => {
  const source = [
    '本轮工具调用额度已经用完，我没能调用文档生成工具，所以还没有生成 docx。',
    '',
    '# 演进方案',
    '',
    '## §1 结论',
    '',
    '口径必须从业务库摘出。',
    '',
    '---',
    '',
    '## §7 待确认',
    '',
    '1. 成本口径：340 PM 还是 358 PM？',
    '2. 里程碑：是否只报到 M4？',
    '',
    '---',
    '',
    '确认后我下一轮直接调用文档工具生成 Word。本轮因工具额度用尽未能产出文件，请以上述正文为准。',
  ].join('\n');

  const cleaned = stripDraftPreamble(source);
  assert.match(cleaned, /^# 演进方案/, 'starts at the title, not the apology');
  assert.doesNotMatch(cleaned, /额度已经用完|没能调用/);
  assert.doesNotMatch(cleaned, /下一轮|未能产出文件|以上述正文为准/);
  // The business question the reader needs must survive the cleanup.
  assert.match(cleaned, /成本口径：340 PM 还是 358 PM/);
  assert.match(cleaned, /里程碑：是否只报到 M4/);
  assert.ok(cleaned.endsWith('2. 里程碑：是否只报到 M4？'));
});

test('leaves a draft without harness talk untouched', () => {
  const source = ['# 方案', '', '## 一', '', '正文。', '', '## 二', '', '正文。'].join('\n');
  assert.equal(stripDraftPreamble(source), source);
});
