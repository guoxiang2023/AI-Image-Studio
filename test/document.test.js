import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentImagePlanMessages,
  buildDocumentBriefMessages,
  buildDocumentContextChunks,
  buildDocumentMergeMessages,
  buildDocumentPlanMessages,
  buildFallbackDocumentPlan,
  buildSectionTranscript,
  buildDocumentSectionMessages,
  buildTranscript,
  applySettledCorrections,
  collectDocumentImages,
  dedupeDocumentVoice,
  finalizeDocument,
  parseDocumentImagePlan,
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
      { role: 'user', content: '请生成文档，保留完整数据字典' },
      {
        role: 'assistant',
        content:
          '这次已成功生成 PDF，5 张核心配图已排入。\n| 字段 | 类型 |\n| task_id | varchar |\n需要的话，我可以补充逐图导读和评审问题清单。',
      },
    ],
  }, 40000);
  assert.doesNotMatch(text, /PDF|核心配图|逐图|评审问题清单/);
  assert.match(text, /保留完整数据字典/);
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
  assert.equal(plan.fallback, true);
  assert.equal(plan.sections[0].heading, '总体设计概览');
  // The design skeleton only grows the chapters the conversation covers: this
  // dialogue has a data dictionary but no data-flow model, so it gets 数据库设计
  // and not 数据架构, and no 部署架构 at all.
  assert.ok(plan.sections.some((section) => /数据库设计/.test(section.heading)));
  assert.ok(!plan.sections.some((section) => /数据架构/.test(section.heading)));
  assert.ok(!plan.sections.some((section) => /部署架构/.test(section.heading)));
  assert.match(plan.sections.at(-1).heading, /风险、待确认事项/);

  const context = buildSectionTranscript(
    chat,
    { heading: '数据库设计：完整数据字典、字段、索引' },
    2000,
  );
  assert.match(context, /wcs_task/);
  assert.match(context, /task_id/);
  assert.ok(context.length <= 2100);
});

// A marketing brief once came back with "数据库设计" and "部署架构" chapters,
// because every non-design document was handed the same architecture skeleton.
test('a non-design document gets no architecture chapters', () => {
  const chat = {
    title: '夜跑活动宣传文案',
    messages: [
      { role: 'user', content: '帮我写一段夜跑活动的宣传文案，投放在小红书。' },
      { role: 'assistant', content: '夜色正好，一起跑起来。' },
      { role: 'user', content: '再活泼一点，加一句报名方式。' },
    ],
  };
  const plan = buildFallbackDocumentPlan(chat);
  assert.deepEqual(
    plan.sections.map((section) => section.heading),
    ['背景与目标', '主要内容', '结论与下一步'],
  );
  assert.doesNotMatch(
    plan.sections.map((section) => section.heading).join(' '),
    /架构|数据库|部署|数据字典/,
  );
});

// A design without a database or a deployment section must not invent those
// chapters; the user's own words decide which review chapters exist.
test('a design outline only covers the topics the dialogue has', () => {
  const chat = {
    title: '仓储调度系统设计',
    messages: [
      { role: 'user', content: '我们要设计一个仓储调度系统的总体架构。' },
      {
        role: 'assistant',
        content: '系统分为接入层、调度层、驱动层，技术选型用 Node.js 和 Redis。',
      },
      { role: 'user', content: '部署在两个机房，做双活。' },
    ],
  };
  const headings = buildFallbackDocumentPlan(chat).sections.map(
    (section) => section.heading,
  );
  assert.ok(headings.includes('部署架构与高可用设计'));
  assert.ok(!headings.some((heading) => /数据库设计/.test(heading)));
});

test('keeps the headings the user wrote for a general document', () => {
  const chat = {
    title: '活动复盘',
    messages: [
      {
        role: 'user',
        content: ['大纲：', '1. 活动目标达成', '2. 现场执行问题', '3. 下次改进'].join('\n'),
      },
      { role: 'assistant', content: '收到，我按这个大纲整理。' },
    ],
  };
  const headings = buildFallbackDocumentPlan(chat).sections.map(
    (section) => section.heading,
  );
  assert.deepEqual(headings, ['活动目标达成', '现场执行问题', '下次改进']);
});

test('chapter evidence includes attachments, latest corrections, and later field rows', () => {
  // An attachment-only turn is the source for a document pasted as a file.
  const attachmentChat = {
    messages: [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            id: 'a1',
            name: '库存锁定.docx',
            text: 'stock_lock_id 表示锁定流水号，lock_time 表示锁定时间。',
          },
        ],
      },
      { role: 'assistant', content: '收到，已解析附件。' },
      { role: 'user', content: '按附件写。' },
    ],
  };
  const attached = buildSectionTranscript(
    attachmentChat,
    { heading: '库存锁定' },
    4000,
  );
  assert.match(attached, /stock_lock_id/);

  // A later turn carrying the full field inventory must not lose to an earlier,
  // shorter excerpt — that is how a "complete data dictionary" chapter ended up
  // documenting three of thirty fields.
  const rows = Array.from({ length: 30 }, (_, index) => `| f${index} | varchar |`);
  const fieldChat = {
    messages: [
      {
        role: 'assistant',
        content: `第一版字段：\n| 字段 | 类型 |\n|---|---|\n| a | int |`,
      },
      { role: 'user', content: '不是这样，字段应该是 zone_code。' },
      {
        role: 'assistant',
        content: `完整字段：\n| 字段 | 类型 |\n|---|---|\n${rows.join('\n')}`,
      },
    ],
  };
  const evidence = buildSectionTranscript(
    fieldChat,
    { heading: '数据库设计', points: ['zone_code'] },
    3000,
  );
  assert.match(evidence, /\| f29 \|/, 'the newest field rows survive');
  assert.match(evidence, /zone_code/, 'the user correction is forced in');
});

test('a chapter can cite a contract clause from the middle of a long attachment', () => {
  const clause = '附件 C 约定验收后的付款期为 45 天。';
  const chat = { messages: [{ role: 'user', attachments: [{ name: '合同.txt',
    text: `${'通用说明。'.repeat(5000)}${clause}${'日常记录。'.repeat(5000)}`,
  }] }] };
  const context = buildSectionTranscript(chat, { heading: '付款期与验收' }, 4000);
  assert.ok(context.includes(clause));
  assert.ok(context.length <= 4000);
});

test('a chapter keeps a user correction and an older relevant table', () => {
  const chat = {
    messages: [
      {
        role: 'assistant',
        content: `早期方案：采用两条入库一条出库的非对称配置。\n${'补充说明。'.repeat(200)}`,
      },
      {
        role: 'assistant',
        content: `线路配置：\n| 字段 | 类型 |\n|---|---|\n| line_id | varchar |`,
      },
      { role: 'user', content: '不是这样，所有线路都是出入库复用的。' },
      { role: 'assistant', content: '明白了。' },
    ],
  };
  const evidence = buildSectionTranscript(
    chat,
    { heading: '线路配置' },
    1200,
  );
  assert.match(evidence, /所有线路都是出入库复用的/);
  assert.match(evidence, /line_id/, 'structured rows stay even before the correction');
});

test('an older topic decision stays in chapter evidence ahead of large unrelated tables', () => {
  const confirmed = 'OLAP 方案确定了使用 Doris 作为替代方案。';
  const rows = '| 订单编号 | 客户姓名 |\n'.repeat(300);
  const chat = { messages: [
    { role: 'user', content: confirmed },
    { role: 'assistant', content: 'OLAP 选型暂未决定。' },
    { role: 'assistant', content: rows },
    { role: 'user', content: '把封面改为灰色。' },
    { role: 'user', content: '开工。' },
  ] };
  const evidence = buildSectionTranscript(chat, { heading: '报表选型', points: ['OLAP'] }, 4000);
  assert.ok(evidence.includes(confirmed));
  assert.doesNotMatch(evidence, /客户姓名/);
});

test('chapter evidence preserves user-stated pain points and skips prior export troubleshooting sections', () => {
  const pain = '技术栈老旧，17 个工程存在重复建设。';
  const workflowRow = '| 痛点与报表性能 | reusedDraft=true |';
  const chat = { messages: [
    { role: 'user', content: pain },
    { role: 'assistant', content: `## 仍然失败，而且结果与上次一致\n${`${workflowRow}\n`.repeat(100)}\n## 现状基线\n交易与报表共库造成资源争用。` },
    { role: 'user', content: '现状痛点与性能根因还要展开。' },
    { role: 'user', content: '报表性能根因写细些。' },
    { role: 'user', content: '只使用当前会话里的图。' },
    { role: 'user', content: '文档里面痛点没有写出来。' },
  ] };
  const evidence = buildSectionTranscript(chat, { heading: '现状痛点与性能根因', points: ['技术栈老旧', '报表性能'] }, 4000);
  assert.ok(evidence.includes(pain));
  assert.match(evidence, /交易与报表共库造成资源争用/);
  assert.doesNotMatch(evidence, /reusedDraft|结果与上次一致/);
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
  assert.match(messages[1].content, /摘要控制在 3000 字以内/, 'default budget');
  const bounded = buildDocumentBriefMessages({ chunk: chunks[0], maxChars: 1500 });
  assert.match(bounded[1].content, /摘要控制在 1500 字以内/);
  const merge = buildDocumentMergeMessages({ summaries: ['片段一', '片段二'] });
  assert.match(merge[1].content, /必须覆盖所有片段/);
  assert.match(merge[1].content, /输出 3000 字以内/);
  const boundedMerge = buildDocumentMergeMessages({
    summaries: ['片段一', '片段二'],
    maxChars: 1200,
  });
  assert.match(boundedMerge[1].content, /输出 1200 字以内/);
  assert.match(boundedMerge[1].content, /片段 2/);
});

test('summary chunks cover attachment interiors, later files and image-only replies', () => {
  const chat = {
    messages: [
      { role: 'user', attachments: [
        { name: '需求.docx', text: `${'前期记录'.repeat(500)}锁定流程说明${'后期记录'.repeat(500)}` },
        ...['乙', '丙', '丁', '戊'].map((name) => ({ name, text: `资料${name}的决定` })),
      ] },
      { role: 'assistant', images: [{ id: ID_A, caption: '仓库布局定稿' }] },
    ],
  };
  const chunks = buildDocumentContextChunks(chat, 2000);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  const all = chunks.join('');
  for (const fact of ['需求.docx', '锁定流程说明', '资料戊的决定', '仓库布局定稿', ID_A]) {
    assert.ok(all.includes(fact), fact);
  }
});

test('oversized recent instructions leave room for older chapter evidence at both context sizes', () => {
  const chat = { messages: [
    { role: 'assistant', content: '签收字段 receipt_id 为仓库流水号，签收前必须核对。' },
    { role: 'user', content: `按门店排列。${'交接背景。'.repeat(1800)}` },
    { role: 'user', content: `${'运营说明。'.repeat(1800)}末尾写签收人。` },
  ] };
  for (const budget of [16000, 4000]) {
    const context = buildSectionTranscript(chat, { heading: '签收字段', points: ['receipt_id'] }, budget);
    assert.match(context, /receipt_id 为仓库流水号/);
    assert.match(context, /按门店排列/);
    assert.match(context, /末尾写签收人/);
    assert.ok(context.length <= budget);
  }
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
  assert.match(planMessages[1].content, /完整数据字典/);
  // The architecture skeleton is offered as material-driven examples, never as
  // a mandatory outline for every document.
  assert.match(planMessages[1].content, /只保留对话已展开的部分/);
  assert.match(planMessages[1].content, /禁止出现“系统架构”/);

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

  const prompt = buildDocumentImagePlanMessages({
    chat: { title: '图数上限' },
    images,
    plan: { title: '图数上限', sections: [{ heading: '背景' }] },
    limit: 30,
  });
  assert.match(prompt[1].content, /最多选 30 张/);
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
  });
  assert.match(messages[1].content, /最多引用 4 张/);
});

test('a design chapter gets the review rules it needs and nothing else', () => {
  const plan = {
    title: 'WCS 概要设计',
    documentType: '方案设计',
    sections: [
      { heading: '总体设计概览' },
      { heading: '数据库设计（含完整数据字典）' },
      { heading: '背景与目标' },
      { heading: '风险、待确认事项与评审结论' },
    ],
  };
  const overview = buildDocumentSectionMessages({
    chat: {},
    plan,
    section: { heading: '总体设计概览' },
    index: 0,
    total: 4,
    images: [],
    transcript: '用户：先做架构图。',
  });
  // The overview table is a design artefact and only the first chapter may use it.
  assert.match(overview[1].content, /设计领域 \| 关键结论\/决策/);
  assert.doesNotMatch(overview[1].content, /本章涉及数据库/);
  // A non-closing chapter must not open its own pending section; the closing one
  // is where that list belongs.
  assert.match(overview[1].content, /本章不要生成任何标题包含/);

  const database = buildDocumentSectionMessages({
    chat: {},
    plan,
    section: {
      heading: '数据库设计（含完整数据字典）',
      purpose: '给出完整数据字典',
      points: ['wcs_task 表', 'zone_code 字段'],
    },
    index: 1,
    total: 4,
    images: [],
    transcript: '用户：wcs_task 表有 zone_code。',
  });
  assert.match(database[1].content, /本章涉及数据库、数据字典/);
  assert.match(database[1].content, /本章写作重点：给出完整数据字典/);
  assert.match(database[1].content, /- wcs_task 表/);
  // Pending items belong to the closing chapter only.
  assert.doesNotMatch(database[1].content, /需要评审确认的事项/);
  // The chapter is written from its own evidence, not from a whole-document brief.
  assert.match(database[1].content, /【本章相关对话证据】/);
  assert.doesNotMatch(database[1].content, /【全篇事实摘要】/);
});

test('a non-design chapter is not told to produce architecture or a data dictionary', () => {
  const plan = {
    title: '夜跑活动宣传文案',
    documentType: '交付文档',
    sections: [
      { heading: '背景与目标' },
      { heading: '主要内容' },
      { heading: '结论与下一步' },
    ],
    openIssues: ['报名链接待定'],
  };
  const messages = buildDocumentSectionMessages({
    chat: {},
    plan,
    section: { heading: '主要内容', purpose: '给出三段文案' },
    index: 1,
    total: 3,
    images: [],
    transcript: '用户：写三段文案。',
  });
  const content = messages[1].content;
  assert.doesNotMatch(content, /本章涉及数据库、数据字典/);
  assert.doesNotMatch(content, /本章涉及架构或技术选型/);
  assert.doesNotMatch(content, /设计领域 \| 关键结论\/决策/);
  assert.match(content, /本章写作重点：给出三段文案/);
  assert.doesNotMatch(
    messages[0].content,
    /解决方案架构师/,
    'the persona follows the document type',
  );

  const closing = buildDocumentSectionMessages({
    chat: {},
    plan,
    section: { heading: '结论与下一步' },
    index: 2,
    total: 3,
    images: [],
    transcript: '用户：写三段文案。',
  });
  assert.match(closing[1].content, /报名链接待定/, 'pending items land in the closing chapter');
  assert.match(closing[1].content, /待评审|待确认/);
});

test('chapter request keeps a user turn for Anthropic Messages', () => {
  const plan = {
    title: '夜跑海报',
    documentType: '交付文档',
    sections: [{ heading: '主视觉方案' }, { heading: '结论与下一步' }],
  };
  const messages = buildDocumentSectionMessages({
    chat: { title: '夜跑海报' },
    plan,
    section: { heading: '主视觉方案', purpose: '确认最终主视觉' },
    index: 0,
    total: 2,
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
  assert.match(messages[1].content, /本章写作重点：确认最终主视觉/);

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



test('moves per-chapter pending items into the closing chapter instead of dropping them', () => {
  const source = [
    '# 方案',
    '',
    '## 1 总体设计',
    '',
    '本章描述系统的分层与边界，共分为四层结构。系统按四层划分，接入层负责协议适配，核心层负责调度。',
    '',
    '### 1.1 本章待定项',
    '',
    '设备清单尚未确认。',
    '',
    '## 2 技术架构',
    '',
    '### 2.1 部署相关待定项',
    '',
    '机房数量待定。',
    '',
    '## 3 风险与待确认事项',
    '',
    '### 3.1 待确认事项',
    '',
    '| 编号 | 事项 |',
    '|---|---|',
    '| C-01 | 仓库类型 |',
  ].join('\n');
  const cleaned = dedupeDocumentVoice(source);
  // The narration goes; the facts next to it stay.
  assert.doesNotMatch(cleaned, /本章描述系统的分层/);
  assert.match(cleaned, /接入层负责协议适配/, 'the factual sentence next to the narration stays');
  // A chapter's own pending list is not a chapter in the file any more...
  assert.doesNotMatch(cleaned, /### 1\.1 本章待定项/);
  assert.doesNotMatch(cleaned, /### 2\.1 部署相关待定项/);
  // ...but every item it held survives, exactly once, in the closing chapter.
  assert.equal(cleaned.match(/设备清单尚未确认。/g).length, 1, 'carried once');
  assert.equal(cleaned.match(/机房数量待定。/g).length, 1, 'carried once');
  assert.match(cleaned, /### 3\.1 待确认事项/, 'the closing chapter keeps its own list');
  assert.match(cleaned, /C-01/);
  // Carried items land inside the closing chapter, after its heading.
  const closing = cleaned.slice(cleaned.indexOf('## 3 风险与待确认事项'));
  assert.match(closing, /设备清单尚未确认。/);
  assert.match(closing, /机房数量待定。/);
});

test('adds a consolidated list when the document has no closing chapter', () => {
  const source = [
    '# 方案',
    '',
    '## 1 总体设计',
    '',
    '系统按四层划分，接入层负责协议适配，核心层负责调度。',
    '',
    '### 1.1 本章待定项',
    '',
    '设备清单尚未确认。',
    '',
    '## 2 技术架构',
    '',
    '系统按四层划分，接入层负责协议适配，核心层负责调度。',
  ].join('\n');
  const cleaned = dedupeDocumentVoice(source);
  assert.match(cleaned, /待确认事项（汇总）/);
  assert.equal(cleaned.match(/设备清单尚未确认。/g).length, 1);
});

test('keeps a fact that happens to start with 本章', () => {
  const source = [
    '# 方案',
    '',
    '## 2 边界',
    '',
    '本章涉及的仓库类型与设备清单尚未最终确认，功能清单需据此裁剪。',
  ].join('\n');
  assert.match(dedupeDocumentVoice(source), /本章涉及的仓库类型/);
});

// A per-chapter pending list is often a table (issue register, open fields).
// Blanking its rows lost the structured evidence, so the table moves to the
// closing chapter as a table instead of being flattened or dropped.
test('carries a pending table into the closing chapter as a table', () => {
  const source = [
    '# 方案',
    '',
    '## 1 总体设计',
    '',
    '系统按四层划分，接入层负责协议适配，核心层负责调度。',
    '',
    '### 1.1 本章待定项',
    '',
    '| 编号 | 事项 |',
    '|---|---|',
    '| C-01 | 仓库类型 |',
    '| C-02 | 设备型号 |',
    '',
    '## 2 风险与待确认事项',
    '',
    '### 2.1 待确认事项',
    '',
    '| 编号 | 事项 |',
    '|---|---|',
    '| C-09 | 现场网络 |',
  ].join('\n');
  const cleaned = dedupeDocumentVoice(source);
  assert.doesNotMatch(cleaned, /### 1\.1 本章待定项/);
  // Every row survives exactly once, and the carried rows stay a table.
  for (const id of ['C-01', 'C-02', 'C-09']) {
    assert.equal(cleaned.match(new RegExp(id, 'g')).length, 1, `${id} carried once`);
  }
  const closing = cleaned.slice(cleaned.indexOf('## 2 风险与待确认事项'));
  // Same header: the rows join the closing chapter's table instead of forming
  // a second one with an identical header.
  const tables = parseDocumentMarkdown(cleaned).blocks.filter(
    (block) => block.type === 'table',
  );
  assert.equal(tables.length, 1);
  assert.deepEqual(
    tables[0].rows.map((row) => row[0]),
    ['C-09', 'C-01', 'C-02'],
  );
  assert.match(closing, /^\| C-01 \| 仓库类型 \|$/m);
  assert.match(closing, /^\| C-02 \| 设备型号 \|$/m);
  // The closing chapter's own table is untouched.
  assert.match(closing, /^\| C-09 \| 现场网络 \|$/m);
});

// `↔` has no glyph in the CJK fonts the PDF renderer resolves, so it came out
// as a tofu box in the interface table ("I-06 | WCS � PLC"). The export must
// stay readable, so the unsupported glyph degrades to the two arrows the font
// does have.
test('renders a bidirectional arrow instead of a missing glyph', async (t) => {
  let buffer;
  try {
    buffer = await buildPdf({
      title: '箭头',
      meta: '',
      blocks: [
        { type: 'paragraph', text: '链路 A ↔ B 双向。' },
        {
          type: 'table',
          headers: ['编号', '方向'],
          rows: [['I-06', 'WCS ↔ PLC']],
        },
      ],
    });
  } catch (error) {
    if (error?.status === 500 && /中文字体/.test(error.message)) {
      t.skip('主机没有可用的中文字体');
      return;
    }
    throw error;
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join('');
  assert.doesNotMatch(text, /\uFFFD/, 'no replacement characters may reach the page');
  assert.match(text, /A ←→ B/);
  assert.match(text, /WCS ←→ PLC/);
});

// A regeneration must not re-open a question the user already answered. The
// assistant had offered "两条入库、一条出库" as a hypothetical, the user replied
// "所有的线路都是出入库复用的", and the next export still listed the rejected
// configuration as C-06. User corrections beat assistant suggestions.
test('drops a rejected option the assistant had only hypothesised', () => {
  const transcript = [
    'user: 为什么少一条出入库输送线，所有的线路都是出入库复用的',
    'assistant: 如果现场是「两条入库、一条出库」的非对称配置，请告诉我。',
  ].join('\n');
  const markdown = [
    '### 9.3 待确认事项',
    '',
    '| 编号 | 待确认事项 |',
    '|---|---|',
    '| C-05 | 平面布置三组两库还是六个独立库待确认 |',
    '| C-06 | RGV 与巷道输送线接口处标高一致性、两条入库一条出库非对称配置待确认 |',
  ].join('\n');
  const out = applySettledCorrections(markdown, transcript);
  assert.doesNotMatch(out, /两条入库/);
  assert.doesNotMatch(out, /非对称配置/);
  // The genuine open question sharing that cell survives.
  assert.match(out, /标高一致性/);
  assert.match(out, /平面布置三组两库/);
  assert.match(out, /^\| C-06 \| RGV/m, 'the row keeps its numbering');
});


// The observed failure: the document recorded "同意进入详细设计阶段" although no
// review had happened. A deliverable may recommend a review, never invent one.
test('rewrites a review verdict the conversation never gave', () => {
  const markdown = [
    '### 9.4 评审结论',
    '',
    '结论：方案总体可行，同意进入详细设计阶段，待确认事项按 9.3 清单闭环后冻结基线。',
  ].join('\n');
  const out = applySettledCorrections(markdown, 'user: 继续\nassistant: 正文如下。');
  assert.doesNotMatch(out, /同意进入详细设计/);
  assert.match(out, /待评审/);
  assert.match(out, /### 9\.4 评审结论/, 'the section heading stays');
});

test('keeps an approval the user actually gave', () => {
  const markdown = '结论：方案总体可行，同意进入详细设计阶段。';
  const out = applySettledCorrections(markdown, 'user: 评审通过了，同意进入详细设计阶段');
  assert.match(out, /同意进入详细设计阶段/);
});

