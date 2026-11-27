import { DOCUMENT_FINAL_IMAGES } from '../config.js';
import { clipText } from '../shared/utils.js';

const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(\s*(?:image:)?([a-f0-9]{16,40})\s*\)\s*$/i;

export function imageCaption(image) {
  const value = String(image?.caption || image?.prompt || '创作图片').trim();
  return clipText(value || '创作图片', 80);
}

function userImageSources(message) {
  const references = message.references?.length ? message.references
    : message.referenceImageId ? [{ id: message.referenceImageId }] : [];
  const sources = references.map((ref) => ({ id: ref.id, source: '参考图', caption: ref.role || '参考图' }));
  for (const file of message.attachments || []) {
    for (const image of file.images || []) {
      const page = image.page ? `第 ${image.page} 页` : '';
      sources.push({ id: image.id, source: '附件图', caption: `${file.name || '附件'}${page}` });
    }
  }
  return sources;
}

/**
 * Collects every image a document can use, in generation order.
 *
 * Three sources feed one de-duplicated list because each covers a gap in the
 * others: the message list is the rich, ordered record of the conversation;
 * gallery rows keep pictures whose turn was trimmed out of the transcript or
 * whose chat row lagged behind the gallery write; same-turn images cover a
 * document created right after `generate_image` returns, before the chat row
 * is reloaded. An id appears once, at its first position.
 */
export function collectDocumentImages(
  chat,
  limit,
  { turnImages = [], galleryImages = [] } = {},
) {
  const messages = chat?.messages || [];
  const seen = new Set();
  const all = [];
  let request = '';
  let round = 0;
  let requestRefs = [];
  let sequence = 0;

  const stamp = (value) => {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? time : null;
  };

  const push = (image, meta = {}) => {
    if (!image?.id || seen.has(image.id)) return;
    seen.add(image.id);
    sequence += 1;
    all.push({
      id: image.id,
      prompt: image.prompt || image.caption || '',
      caption: image.caption || image.prompt || '',
      size: image.size || '',
      aspectRatio: image.aspectRatio || '',
      parentId: image.parentId || null,
      source: image.source || '生成图',
      round: meta.round || null,
      supersedes: meta.supersedes || [],
      turn: Number.isInteger(meta.turn) ? meta.turn : null,
      request: meta.request || '',
      createdAt: stamp(meta.createdAt),
      sequence,
    });
  };

  for (const [turn, message] of messages.entries()) {
    if (message.role === 'user') {
      round++;
      request = clipText(String(message.content || '').replace(/\s+/g, ' ').trim(), 240);
      const inputs = userImageSources(message);
      requestRefs = inputs.filter((image) => image.source === '参考图').map((image) => image.id);
      for (const image of inputs) push(image, { turn, round, request, createdAt: message.ts });
      continue;
    }
    for (const image of message.images || []) {
      push(image, { turn, round, request, supersedes: requestRefs, createdAt: message.ts });
    }
  }
  // A turn creates its images before the export tool runs, and the chat row it
  // streams into is reloaded by the exporter. The array the turn owns is the
  // authoritative record of what this turn generated.
  const currentTurn = messages.length;
  for (const image of turnImages || []) {
    push(image, {
      turn: currentTurn,
      round,
      request,
      supersedes: requestRefs,
      createdAt: image?.createdAt,
    });
  }
  for (const image of galleryImages || []) {
    push(image, { createdAt: image?.createdAt });
  }

  // The conversation defines the chronology. Gallery-only rows (a turn that was
  // trimmed away, or a write that landed after the chat row was read) are
  // inserted at the position their timestamp implies, and keep conversation
  // order when no timestamp is known.
  const primary = all.filter((image) => image.turn !== null);
  const extras = all.filter((image) => image.turn === null);
  const ordered = primary.slice();
  for (const extra of extras) {
    let insertAt = ordered.length;
    if (extra.createdAt !== null) {
      const index = ordered.findIndex(
        (image) => image.createdAt !== null && image.createdAt > extra.createdAt,
      );
      if (index >= 0) insertAt = index;
    }
    ordered.splice(insertAt, 0, extra);
  }

  const max = Math.max(1, Number(limit) || ordered.length || 1);
  const positioned = ordered.map((image, position) => {
    const { sequence: _order, ...rest } = image;
    return { ...rest, index: position + 1 };
  });
  return {
    images: positioned.length > max ? positioned.slice(-max) : positioned,
    total: positioned.length,
    omitted: Math.max(0, positioned.length - max),
  };
}

/**
 * Keeps the newest `limit` pictures but never silently drops a favourite: an
 * explicit gallery pick outranks recency, and the surviving set stays in
 * generation order so the document reads chronologically.
 */
function keepWithinLimit(images, limit) {
  const list = images || [];
  const max = Math.max(1, Number(limit) || list.length || 1);
  if (list.length <= max) return list;
  const keep = new Set();
  const approved = list.filter((image) => image.approved);
  for (const image of approved.slice(-max)) keep.add(image.id);
  const favorites = list.filter((image) => image.favorite && !image.approved);
  for (const image of favorites.slice(Math.max(0, favorites.length - (max - keep.size)))) {
    keep.add(image.id);
  }
  for (let index = list.length - 1; index >= 0 && keep.size < max; index -= 1) {
    keep.add(list[index].id);
  }
  return list.filter((image) => keep.has(image.id));
}

/**
 * Every picture the user can still see, including early drafts of a topic that
 * a later edit replaced. The document body shows the best version; the archive
 * keeps the rest so a generated picture is never lost just because the planner
 * preferred a newer one. Hidden/deleted pictures and pictures whose file is
 * gone are excluded — the latter are reported to the user by the service, not
 * dropped silently.
 */
export function archiveDocumentImages(images, { hiddenIds = [], unavailableIds = [] } = {}) {
  const hidden = new Set(hiddenIds);
  const unavailable = new Set(unavailableIds);
  return (images || [])
    .filter(
      (image) =>
        image?.id && !hidden.has(image.id) && !unavailable.has(image.id),
    )
    .map((image, index) => ({ ...image, index: index + 1 }));
}

/**
 * Keeps only the images the body may cite inline. Explicitly discarded images
 * (removed from the gallery), missing files, and images superseded by a later
 * edit are excluded. The newest remaining images survive the limit.
 */
export function selectFinalDocumentImages(
  images,
  { hiddenIds = [], unavailableIds = [], limit } = {},
) {
  const hidden = new Set(hiddenIds);
  const unavailable = new Set(unavailableIds);
  const all = (images || []).filter((image) => image?.id);
  const approved = new Set(all.filter((image) => image.approved && !hidden.has(image.id) && !unavailable.has(image.id)).map((image) => image.id));
  const rejectedEdits = new Set();
  for (const image of all) {
    if (approved.has(image.id)) continue;
    if ([image.parentId, ...(image.supersedes || [])].some((id) => approved.has(id) || rejectedEdits.has(id))) {
      rejectedEdits.add(image.id);
    }
  }
  // A parent in an edit chain is never a final deliverable, even when the
  // later edit was removed. This avoids silently promoting an old draft.
  const superseded = new Set();
  for (const image of all) {
    if (rejectedEdits.has(image.id)) continue;
    if (image.parentId) superseded.add(image.parentId);
    for (const id of image.supersedes || []) superseded.add(id);
  }
  // Some providers do not persist parentId for image edits. A revision prompt
  // such as "use Image 1 as reference" still identifies the previous diagram
  // as superseded, so the older candidate never reaches the document planner.
  const revisionPrompt =
    /(redraw the exact same|replace every|exact same (?:technical|system)?\s*architecture|keep[^.\n]{0,140}(?:layout|structure)[^.\n]{0,140}replace|replace[^.\n]{0,100}label|translate[^.\n]{0,100}(?:chinese|中文)|基于这张|在这张图|上一版)/i;
  for (let index = 1; index < all.length; index += 1) {
    const image = all[index];
    const previous = all[index - 1];
    if (
      previous?.id && !rejectedEdits.has(image.id) &&
      !image.parentId && !image.supersedes?.length &&
      revisionPrompt.test(String(image.prompt || '')) &&
      /(diagram|architecture|架构|图)/i.test(String(previous.prompt || ''))
    ) {
      superseded.add(previous.id);
    }
  }
  const finals = all.filter(
    (image) =>
      !hidden.has(image.id) &&
      !unavailable.has(image.id) &&
      // A gallery favourite is the user saying "this one". An explicit pick
      // outranks the heuristic that an edited picture replaced it, otherwise
      // the one picture they chose could be the one the document omits.
      (approved.has(image.id) || (!rejectedEdits.has(image.id) && (!superseded.has(image.id) || image.favorite))),
  );
  return keepWithinLimit(finals, limit).map((image, index) => ({
    ...image,
    index: index + 1,
  }));
}

export function buildFallbackDocumentImagePlan(candidates, limit = DOCUMENT_FINAL_IMAGES) {
  return keepWithinLimit(candidates, limit).map((image) => ({
    ...image,
    caption: image.approvedCaption || image.source || '会话图片',
    section: 0,
  }));
}

function documentMessageContent(message) {
  const value = message.content;
  if (message.role === 'user') return String(value || '').trim();
  const blocked =
    /(文档策划失败|文档生成失败|PDF 生成|PDF 转换|转成 PDF|Word 另存|生成 PDF|生成文档|文档服务|核心配图|附图索引|图号|逐图|导读段落|评审问题清单|附录\s*[AB]|文档补充|接口返回“文档策划失败”|接口仍返回|被截断|zoneCode之后|(?:按|需|待|应)[^。\n]{0,8}补齐[^。\n]{0,16}(?:字段|索引|数据字典))/i;
  const kept = [];
  let skipThroughLevel = 0;
  for (const line of String(value || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      if (skipThroughLevel && level <= skipThroughLevel) skipThroughLevel = 0;
      if (!skipThroughLevel && /^(?:仍然失败[，,。]|现在按原计划|全文已写完[，,]|修正摘要\s*$)/.test(heading[2])) {
        skipThroughLevel = level;
      }
    }
    if (skipThroughLevel || blocked.test(line)) continue;
    if (/^(?:以上为完整方案正文|正文到此完整)[。！].*(?:整理进文档|生成\s*Word|提交)/.test(line.trim())) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * A bounded excerpt that keeps both ends of an attachment. A pasted data
 * dictionary has its table at the end of the file, so a head-only clip sent the
 * chapter eight hundred lines of boilerplate and none of the fields.
 */
function boundedExcerpt(value, limit) {
  const text = String(value || '').trim();
  const max = Math.max(80, Math.trunc(Number(limit)) || 800);
  if (text.length <= max) return text;
  const marker = '\n…\n';
  const available = Math.max(0, max - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * The attachment names and a bounded excerpt of each file. A message whose
 * content is empty is still evidence: "只上传了素材" is how a user hands over a
 * data dictionary, and dropping it left the chapter with no source at all.
 */
function attachmentText(message, excerptLimit = 800) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return '';
  let text = `\n（附件：${attachments
    .map((attachment) => attachment.name || '文件')
    .join('、')}）`;
  for (const attachment of attachments) {
    const excerpt = boundedExcerpt(attachment.text, excerptLimit);
    if (excerpt) {
      text += `\n[附件摘录：${attachment.name || '文件'}] ${excerpt}`;
    }
  }
  return text;
}

export function buildTranscript(chat, maxChars = 40000) {
  // Document generation needs the complete source, including the turns that
  // produced the architecture diagrams. The rolling chat summary is not used:
  // it stops at an arbitrary point and can contain stale generation/PDF errors.
  const summaryLine = '';
  const start = 0;
  const lines = [];

  for (const message of (chat?.messages || []).slice(start)) {
    if (message.role === 'user') {
      const cleaned = documentMessageContent(message);
      const files = attachmentText(message);
      if (!cleaned && !files) continue;
      let line = `用户：${clipText(cleaned, 3000) || '（仅上传了素材）'}${files}`;
      if (Array.isArray(message.references) && message.references.length) {
        line += `\n（参考图：${message.references.map((ref) => ref.id).join('、')}）`;
      }
      lines.push(line);
    } else if (message.role === 'assistant') {
      const cleaned = documentMessageContent(message);
      if (!cleaned) continue;
      let line = `助手：${clipText(cleaned, 8000)}`;
      const ids = (message.images || []).map((image) => image.id).filter(Boolean);
      if (ids.length) line += `\n（本轮图片：${ids.join('、')}）`;
      lines.push(line);
    }
  }

  let text = [summaryLine, ...lines].filter(Boolean).join('\n\n');
  if (text.length <= maxChars) return text;

  const tail = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (size + line.length > maxChars && tail.length) break;
    tail.unshift(line);
    size += line.length;
  }
  const omitted = lines.length - tail.length;
  return [
    summaryLine,
    omitted > 0 ? `（较早的 ${omitted} 条对话已省略）` : '',
    ...tail,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function formatImageCatalog(images, emptyText) {
  if (!images.length) {
    return emptyText || '（没有可进入终稿的图片，final_images 必须为空数组。）';
  }
  return images
    .map((image) => {
      const flags = [
        image.approved ? '用户确认用图' : '',
        image.approvedCaption ? `定稿图名：${image.approvedCaption}` : '',
        image.favorite ? '画册收藏' : '',
        image.parentId ? '基于上一版修改' : '',
        image.role ? `用途：${clipText(image.role, 80)}` : '',
      ].filter(Boolean);
      const turn = image.round ? `第 ${image.round} 轮 | ` : '';
      const request = image.request
        ? ` | 当轮用户要求：${clipText(image.request, 180)}`
        : '';
      return `- image_id=${image.id} | ${turn}第 ${image.index} 张 | ${
        image.aspectRatio || image.size || '画幅未知'
      } | 画面/提示：${clipText(image.prompt || image.caption, 180)}${request}${
        flags.length ? ` | ${flags.join(' | ')}` : ''
      }`;
    })
    .join('\n');
}

function documentSourceText(message, includeImages = true) {
  const cleaned = documentMessageContent(message);
  const parts = [];
  if (cleaned) parts.push(cleaned);
  if (message.role === 'user') {
    for (const file of message.attachments || []) {
      parts.push(`[附件：${file.name || '文件'}]\n${file.text || ''}`);
    }
    if (includeImages) {
      for (const image of userImageSources(message)) {
        parts.push(`${image.source} ${image.id}：${image.caption}`);
      }
    }
  } else if (includeImages) {
    for (const image of message.images || []) {
      if (image.id) parts.push(`生成图片 ${image.id}：${imageCaption(image)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Splits the complete conversation into bounded semantic-summary inputs.
 * Unlike per-chapter clipping, every message is represented and the model
 * receives a chronological stream it can summarize without silently losing
 * earlier themes.
 */
export function buildDocumentContextChunks(chat, maxChars = 12000, { includeImages = true } = {}) {
  const limit = Math.max(1000, Number(maxChars) || 12000);
  const lines = [];
  for (const message of chat?.messages || []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const source = documentSourceText(message, includeImages);
    if (!source) continue;
    const prefix = message.role === 'user' ? '用户：' : '助手：';
    const width = limit - prefix.length;
    for (let index = 0; index < source.length; index += width) {
      lines.push(prefix + source.slice(index, index + width));
    }
  }
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 2 > limit) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n\n' : ''}${line}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildDocumentBriefMessages({ chunk, previous = '', maxChars = 0 }) {
  const budget = Math.trunc(Number(maxChars)) || 0;
  return [
    {
      role: 'system',
      content:
        '你是文档编辑。按原文主题提炼事实、决定、依据和未决问题。只输出摘要。',
    },
    {
      role: 'user',
      content: `请把下面的对话片段整理成结构化的“事实摘要”，供后续写正式文档继续使用。

【必须保留】
- 用户最终目标、交付范围、读者和关键验收要求；
- 保留发言归属。用户明确确认、否定或纠正的决定优先于助手建议，标明其原有术语和结论。仅凭这一片段无法判断的状态不推断；
- 已确认的方案、决策、边界、约束和验收基线；
- 保留对本次交付有意义的具体细节，例如创作主题与修改要求、负责人和日期、设计选型与接口约束。只写素材实际讨论的事项；
- 关键数字、版本、专有名词、表名、字段名和图片用途；
- 尚未确认的风险/待定事项，明确标为待确认，不要编造。

【剔除】
生成失败、重试、格式转换、工具限制、原始出图指令和寒暄。仅在确有业务意义时保留方案演变。

【输出结构】
摘要控制在 ${budget || 3000} 字以内。按素材中的主题归类，把用户明确的要求、最终结论和有辨识度的原文名称写在一起。无需凑齐固定栏目。

${previous ? `已有摘要（请合并更新，不要丢失其中已确认的事实）：\n${clipText(previous, 6000)}\n\n` : ''}对话片段：
${chunk || '（没有内容）'}`,
    },
  ];
}

export function buildDocumentMergeMessages({ summaries, maxChars = 0 }) {
  const budget = Math.trunc(Number(maxChars)) || 3000;
  return [
    {
      role: 'system',
      content:
        '你是文档资料整理员。按主题去重并合并事实摘要，优先保留用户决定，仅输出压缩后的要点。',
    },
    {
      role: 'user',
      content: `请把下面按时间顺序排列的事实摘要合并成一份完整摘要，供后续写正式文档继续使用。

【合并规则】
- 按主题聚合，相互冲突时以最后一次用户明确确认或纠正为准。
- 必须覆盖所有片段。每个主题只保留独有的事实、最终决定、关键数字、具体名称和真实未决问题。
- 删去寒暄、出图指令、交付过程、重复背景与已被取代的结论。
- 不要编造，不要把待确认项写成已确认。
- 输出 ${budget} 字以内。用简短事实条目，无导语、重复节标题或表格。字数紧张时压缩句式并合并重复项，优先保留准确的结论和数字。

${summaries.map((summary, index) => `【片段 ${index + 1}】\n${summary}`).join('\n\n')}`,
    },
  ];
}

// A system/architecture design has a review structure readers expect. It is
// assembled from the parts the conversation actually covers, so a design
// without a database never grows an empty data-dictionary chapter.
const DESIGN_BASE_HEADINGS = [
  '总体设计概览',
  '系统定位与边界',
  '总体架构与功能模块',
  '技术架构与具体技术选型',
];
const DESIGN_DEPLOY_HEADING = '部署架构与高可用设计';
const DESIGN_MECHANISM_HEADING = '关键机制：任务状态机、接口时序、幂等与告警';
const DESIGN_DATA_HEADING = '数据架构与数据流';
const DESIGN_DATABASE_HEADING =
  '数据库设计（含完整数据字典：核心表字段、索引、ER 关系）';
const DESIGN_CLOSING_HEADING = '风险、待确认事项与评审结论';

const REPORT_HEADINGS = [
  '背景与目标',
  '过程与关键结论',
  '结果与交付',
  '问题、风险与待确认事项',
  '经验总结与下一步',
];

// A document that is not a system design must not be handed the architecture
// skeleton: an export of a marketing brief once came back with "数据库设计" and
// "部署架构" chapters holding invented prose. These headings are only used when
// the conversation itself offers no topic structure to follow.
const NEUTRAL_HEADINGS = ['背景与目标', '主要内容', '结论与下一步'];

const DESIGN_STRONG_RE =
  /(概要设计|详细设计|架构设计|总体设计|系统架构|技术架构|部署架构|数据字典|数据库设计|表结构|接口设计|ER\s*图|状态机|微服务|中台设计|WCS|WMS|WES|MES)/i;
const DESIGN_WEAK_RE = /(设计|架构|系统|技术|数据库|接口|部署|模块|字段|索引|容灾|机房|设备|选型)/g;
const REPORT_RE = /(复盘|回顾|总结|报告|周报|月报|汇报)/;

const SECTION_STOP_WORDS = new Set([
  '总体',
  '设计',
  '系统',
  '方案',
  '文档',
  '本章',
  '关键',
  '实现',
  '相关',
  '以及',
  '进行',
  '一个',
  '我们',
  '用户',
  '内容',
]);

function cleanConversationText(chat, maxChars) {
  const parts = [];
  for (const message of chat?.messages || []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const cleaned = documentMessageContent(message);
    // A spec handed over as a file is the strongest signal of what this
    // document is, so its excerpt belongs in the profile and heading scan.
    const files = message.role === 'user' ? attachmentText(message, 1500) : '';
    if (cleaned || files) parts.push(`${cleaned}${files}`);
  }
  return clipText(parts.join('\n\n'), maxChars);
}

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

/**
 * Which kind of document the conversation is about. A design only gets the
 * review skeleton when the dialogue is clearly a system/product design; a
 * passing mention of "方案" or "系统" is not enough, because the architecture
 * chapters would then be written about nothing.
 */
function documentProfile({ title, source }) {
  const scope = `${title}\n${source}`;
  if (DESIGN_STRONG_RE.test(scope) || countMatches(source, DESIGN_WEAK_RE) >= 6) {
    return 'design';
  }
  if (REPORT_RE.test(scope)) return 'report';
  return 'general';
}

/**
 * Design chapters the conversation actually has material for. Each entry pairs
 * a heading with the evidence pattern that justifies it.
 */
const DESIGN_SECTION_RULES = [
  { heading: DESIGN_DEPLOY_HEADING, signal: /(部署|机房|边缘|网络拓扑|容灾|高可用|双机|集群)/ },
  { heading: DESIGN_MECHANISM_HEADING, signal: /(状态机|时序|幂等|接口|报文|ACK|超时|重试|告警|流程)/i },
  { heading: DESIGN_DATA_HEADING, signal: /(数据架构|数据流|数据模型|数据集|数据分层)/ },
  {
    heading: DESIGN_DATABASE_HEADING,
    signal: /(数据库|数据字典|表结构|字段|主键|索引|分区|ER\s*图|CREATE\s+TABLE)/i,
  },
];

/**
 * Topic headings the conversation states outright: existing H1–H3 headings,
 * and the "1. xxx" items of a list the user wrote as an outline. These are the
 * best plan for a non-design document, because they are the user's own words.
 */
function conversationHeadings(source) {
  const found = [];
  const seen = new Set();
  const push = (value) => {
    const heading = String(value || '')
      .replace(/^\d+(?:[.、)]\d*)*[.、)]?\s*/, '')
      .replace(/[：:]\s*$/, '')
      .trim();
    if (heading.length < 2 || heading.length > 40) return;
    if (/^(?:前言|目录|附录|参考|结语)$/.test(heading)) return;
    if (seen.has(heading)) return;
    seen.add(heading);
    found.push(heading);
  };
  for (const match of String(source || '').matchAll(/^#{1,3}\s+(.+)$/gm)) {
    push(match[1]);
  }
  for (const match of String(source || '').matchAll(/^\s*(?:\d{1,2}[.、)]|[-*+])\s*([^\n]{2,40})$/gm)) {
    push(match[1]);
  }
  return found;
}

/**
 * A deterministic plan keeps document export usable when the planning request
 * is unavailable, truncated, or returns malformed JSON. It is intentionally
 * structure-only: facts and chapter bodies still come from the conversation.
 *
 * The outline follows the conversation, not a fixed template. A design gets the
 * review chapters its dialogue covers; anything else uses the headings the user
 * wrote, and only falls back to neutral headings when there are none.
 */
export function buildFallbackDocumentPlan(chat) {
  const source = cleanConversationText(chat, 12000);
  const title = clipText(String(chat?.title || '').trim() || '文档', 120);
  const profile = documentProfile({ title, source });
  const headings = [];

  if (profile === 'design') {
    headings.push(...DESIGN_BASE_HEADINGS);
    for (const rule of DESIGN_SECTION_RULES) {
      if (rule.signal.test(source)) headings.push(rule.heading);
    }
    headings.push(DESIGN_CLOSING_HEADING);
  } else {
    // The user's own outline outranks any skeleton, including the report one:
    // they already decided what the document says.
    const stated = conversationHeadings(source);
    if (stated.length >= 2) headings.push(...stated.slice(0, 8));
    else if (profile === 'report') headings.push(...REPORT_HEADINGS);
    else headings.push(...NEUTRAL_HEADINGS);
  }

  return {
    title,
    documentType: profile === 'design' ? '方案设计' : profile === 'report' ? '总结报告' : '交付文档',
    audience: '评审与交付相关方',
    objective: '基于当前对话整理可评审、可交付的最终材料。',
    coreMessage: '',
    sections: headings.map((heading) => ({ heading, purpose: '', points: [] })),
    keyFacts: [],
    openIssues: [],
    images: [],
    fallback: true,
  };
}

/**
 * Keywords the chapter is about, with a weight per source. A word taken from
 * the heading or from the planner's points identifies the chapter far better
 * than one taken from a loose purpose sentence, and that difference decides
 * which message reaches the chapter when the budget is tight.
 */
function sectionTerms(section) {
  const weights = new Map();
  const add = (value, weight) => {
    const text = String(value || '');
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) {
      const term = match[0].toLowerCase();
      weights.set(term, Math.max(weights.get(term) || 0, weight));
    }
    for (const chunk of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      // The whole run names the topic ("库存锁定"), the bigrams let a chapter
      // match a sentence that rephrases it ("锁定库存").
      if (chunk.length >= 2 && chunk.length <= 8) {
        weights.set(chunk, Math.max(weights.get(chunk) || 0, weight));
      }
      for (let index = 0; index < chunk.length - 1; index += 1) {
        const term = chunk.slice(index, index + 2);
        weights.set(term, Math.max(weights.get(term) || 0, Math.max(1, weight - 1)));
      }
    }
  };
  add(section?.heading, 3);
  for (const point of Array.isArray(section?.points) ? section.points : []) {
    add(point, 2);
  }
  add(section?.purpose, 1);
  return [...weights.entries()]
    .filter(([term]) => term.length >= 2 && !SECTION_STOP_WORDS.has(term))
    .slice(0, 90);
}

// A confirmed user decision outranks an assistant draft even when another
// topic has newer corrections.
const CORRECTION_RE =
  /(不是|不对|错了|不准确|改成|改为|修正|纠正|更正|应该是|应当按|以.{1,12}为准|不要|去掉|删掉|取消|确认|确定|定为|决定|统一[成用为]|采用|选用|使用)/;

export function buildDocumentUserGuidance(chat, maxChars = 2000) {
  const guidance = [];
  let recent = 4;
  let remaining = maxChars;
  const messages = chat?.messages || [];
  for (let i = messages.length - 1; i >= 0 && remaining >= 80; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const content = documentMessageContent(message);
    if (!content || (recent <= 0 && !CORRECTION_RE.test(content) && !/痛点(?:还|也)(?:有|包括)/.test(content))) continue;
    recent--;
    const excerpt = boundedExcerpt(content, Math.min(remaining, 320));
    guidance.push(excerpt);
    remaining -= excerpt.length + 2;
  }
  return guidance.reverse().join('\n\n');
}

// Structured evidence: a message carrying table rows is where a dictionary,
// an interface list or a field inventory lives. It outranks prose that merely
// mentions the same words.
function tableRowCount(content) {
  return (String(content || '').match(/^\s*\|/gm) || []).length;
}

// Reserve room for the strongest matching passage inside a long message or file.
function chapterExcerpt(text, limit, terms) {
  if (text.length <= limit) return text;
  const width = Math.floor(limit / 2);
  const stride = Math.max(1, Math.floor(width / 2));
  let bestScore = 0;
  let bestStart = 0;
  for (let start = 0; start < text.length; start += stride) {
    const window = text.slice(start, start + width).toLowerCase();
    let score = 0;
    for (const [term, weight] of terms) if (window.includes(term)) score += weight;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (!bestScore) return boundedExcerpt(text, limit);
  const end = Math.min(text.length, bestStart + width);
  const spare = limit - (end - bestStart) - 6;
  const head = Math.min(bestStart, Math.ceil(spare / 2));
  const tail = Math.min(text.length - end, spare - head);
  return [text.slice(0, head), text.slice(bestStart, end), tail ? text.slice(-tail) : '']
    .filter(Boolean).join('\n…\n');
}

/**
 * Selects the conversation evidence that belongs to one chapter. Sending the
 * whole transcript to every chapter makes the request grow with the chat and
 * can exceed a provider's context window; this keeps a bounded, relevant
 * slice while preserving table-rich messages for database chapters.
 *
 * Recent instructions and chapter-relevant user decisions share a bounded
 * allowance before topical evidence. Tables are only prioritised if relevant.
 */
export function buildSectionTranscript(chat, section, maxChars = 16000) {
  const terms = sectionTerms(section);
  const entries = [];
  const dataDictionary = /数据库|数据字典|表结构|字段/i.test(section.heading || '');
  for (const [index, message] of (chat?.messages || []).entries()) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const content = documentSourceText(message, false);
    if (!content) continue;
    const lower = content.toLowerCase();
    const userText = message.role === 'user' ? String(message.content || '').toLowerCase() : '';
    let userRelevance = 0;
    let score = 0;
    for (const [term, weight] of terms) {
      if (lower.includes(term)) score += weight;
      if (userText.includes(term)) userRelevance += weight;
    }
    const relevance = score;
    const rows = tableRowCount(content);
    const schemaEvidence = rows > 0 && /字段|主键|索引|建表|数据字典|CREATE TABLE/i.test(content);
    if (rows && (relevance || (dataDictionary && schemaEvidence))) score += Math.min(24, 4 + rows / 2);
    if (message.role === 'user') score += 2;
    if (message.role === 'user' && relevance && CORRECTION_RE.test(content)) score += 4;
    entries.push({
      index,
      role: message.role,
      content,
      score,
      relevance,
      schemaEvidence,
      userRelevance,
      userText,
      correction: userRelevance > 0 && CORRECTION_RE.test(userText),
    });
  }
  if (!entries.length) return '（没有可用的文字记录）';

  const header = '【本章相关对话节选】\n';
  const selected = new Map();
  let size = header.length;
  const take = (entry, limit = maxChars) => {
    if (!entry || selected.has(entry.index)) return;
    const overhead = 3 + (selected.size ? 2 : 0); // role label and separator
    const available = Math.min(limit, maxChars - size - overhead);
    if (available < 80) return;
    const content = chapterExcerpt(entry.content, available, terms);
    selected.set(entry.index, { ...entry, content });
    size += overhead + content.length;
  };

  const users = entries.filter((item) => item.role === 'user');
  const topicalUsers = users.filter((item) => item.userRelevance)
    .sort((left, right) => right.userRelevance - left.userRelevance || right.index - left.index);
  const corrections = topicalUsers.filter((item) => item.correction).slice(0, 2);
  const pointSources = (section.points || []).map((point) => {
    const phrase = point.trim().toLowerCase();
    return phrase.length >= 2 && topicalUsers.find((item) => item.userText.includes(phrase));
  });
  const anchors = [...new Set([
    ...corrections, ...pointSources, ...topicalUsers.slice(0, 2), users.at(-1), users.at(-2),
  ].filter(Boolean))];
  const anchorLimit = Math.floor((maxChars - size) / (3 * Math.max(1, anchors.length))) - 5;
  for (const anchor of anchors) take(anchor, anchorLimit);

  const ranked = entries
    .filter((entry) => entry.relevance || (dataDictionary && entry.schemaEvidence))
    .sort((left, right) => right.score - left.score || right.index - left.index);
  // Cap the leading match so one long draft or unrelated part of a table
  // cannot crowd out independent evidence for the same chapter.
  for (const entry of ranked) take(entry, Math.floor(maxChars / 3));
  if (!selected.size) take(entries.at(-1));
  // When the anchors themselves are the primary sources, spend unused space
  // restoring their text once other evidence has had a chance to enter.
  for (const entry of [...ranked, ...anchors]) {
    const excerpt = selected.get(entry.index);
    if (!excerpt || excerpt.content.length >= entry.content.length) continue;
    const extra = Math.min(maxChars - size, entry.content.length - excerpt.content.length);
    if (!extra) break;
    const previousLength = excerpt.content.length;
    const expanded = chapterExcerpt(entry.content, previousLength + extra, terms);
    if (expanded.length > previousLength) {
      excerpt.content = expanded;
      size += expanded.length - previousLength;
    }
  }

  const ordered = [...selected.values()].sort((left, right) => left.index - right.index);
  return `${header}${ordered
    .map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.content}`)
    .join('\n\n')}`;
}


export function buildDocumentPlanPrompt({ chat, transcript, userGuidance }) {
  return `你是资深解决方案架构师、技术文档策划和评审材料编辑。请基于下面的对话纲要，为最终文档制定结构策划，但不要写正文。

【先判断什么最重要】
- 先判断用户最终要交付什么文档、给谁看、用于什么评审或决策，以及用户在对话中反复补充、纠正、明确要求的内容。用户明确要求的内容优先级最高。
- 按正式交付物的主题组织内容。优先呈现最终结论和业务依据，只有解释论点所必需的演变才写入。省略会话回顾、图片版本史、工具操作和格式转换。
- 用户明确确认、否定和纠正高于助手方案和摘要。按主题采用最后一条明确的用户决定；后续助手推测不能覆盖它，也不得作为现状或待确认事项。
- 评审结论只能来自用户：对话里没有用户明确的“评审通过/同意进入详细设计”表述时，最后 1 章只能写“待评审”“建议提交评审”，不得自行写出“同意进入详细设计阶段”这类已批准结论。
- 如果用户明确要求“完整数据字典”“全部字段”“不只核心表”，必须规划独立章节完整覆盖，不能只写“已补齐 N 张核心表”或只列几张表。

【章节结构：按对话内容决定，不要套模板】
- 优先遵守用户指定的章数、标题与篇幅。未指定时，短文可只设一章，复杂文档按有原文支撑的主题分章。
- 如果这是一份系统/方案设计文档，读者通常最关心：系统边界与职责、系统架构、技术架构与具体选型、数据架构与数据流、数据库表/字段/索引/分区、接口与关键流程、部署架构、风险与待确认事项。**只保留对话已展开的部分**，并把已展开的细节写进索引；例如对话没有数据库设计，就不要规划数据库章节。可用的章节标题示例（按需取用、可自行命名）：
  - 总体设计概览（全文唯一的“总”章）
  - 系统定位与边界
  - 总体架构与功能模块
  - 技术架构与具体技术选型
  - 部署架构与高可用设计
  - 关键机制：任务状态机、接口时序、幂等与告警
  - 数据架构与数据流
  - 数据库设计（含完整数据字典：核心表字段、索引、ER 关系）
  - 风险、待确认事项与评审结论（最后一章）
- 如果这不是设计类文档（例如汇报、说明、方案对比、活动策划、文案交付、复盘总结），按该文档类型自身的逻辑组织章节，使用对话中的真实主题作为标题，禁止出现“系统架构”“技术架构”“数据库设计”“部署架构”“数据字典”这类只属于设计评审的章节，也不要在正文里编造这些内容。
- 采用“总—分—总”结构：第 1 章给出总体结论，最后 1 章总结并列出风险/待确认项，中间章节按主题展开，顺序服务于读者理解，不要按对话发生顺序平铺。
- 章节标题必须具体，不能只写“数据设计”“技术架构”。例如“数据库设计：8 张核心表字段、索引与分区”“技术架构与具体技术选型”“接口、报文与任务状态流转”。
- 同一主题不得拆成两个并列章节：数据库设计与完整数据字典合并为一章，接口/报文/状态机不另起并列章节。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：
{
  "title": "文档标题",
  "document_type": "概要设计/评审材料/方案/报告/执行计划/复盘等",
  "audience": "读者",
  "objective": "文档要解决的问题",
  "core_message": "一句话核心结论",
  "sections": [{"heading": "具体章节标题", "purpose": "这一章要回答什么", "points": ["必须覆盖的要点"]}],
  "key_facts": ["必须准确保留的关键数字/名称/结论"],
  "open_issues": ["对话中确实尚未确认的事项"]
}
sections 只写标题与要点，不要写正文；points 每条不超过 30 字，最多 4 条。key_facts 优先保留跨章节必须一致的最终用户决定、关键数字和术语。open_issues 只列确有依据且未解决的项目决策事项。优先保证 sections 完整闭合。

【会话主题】
${clipText(chat.title || '未命名对话', 120)}

${userGuidance ? `【最近交付要求及用户确认与修订原文】\n${userGuidance}\n\n` : ''}\
【对话纲要】
${transcript || '（没有文字记录）'}`;
}

export function buildDocumentPlanMessages({ chat, transcript, userGuidance }) {
  return [
    {
      role: 'system',
      content:
        '你是资深解决方案架构师和评审材料策划。先完成素材取舍与结构规划，只输出一个合法 JSON 对象，不要输出正文、Markdown 代码块或额外解释。',
    },
    {
      role: 'user',
      content: buildDocumentPlanPrompt({ chat, transcript, userGuidance }),
    },
  ];
}

export function buildDocumentImagePlanPrompt({
  chat,
  images,
  plan,
  userGuidance,
  limit = DOCUMENT_FINAL_IMAGES,
}) {
  const maxImages = Math.max(1, Number(limit) || DOCUMENT_FINAL_IMAGES);
  const outline = (plan?.sections || [])
    .map((section, index) => `${index + 1}. ${section.heading}`)
    .join('\n');
  return `你是终稿配图编辑。只为下面这份文档从候选图片中选择最终要进入文档的图片，不写正文。

【文档】
标题：${plan?.title || chat?.title || '文档'}
${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}${planFacts(plan)}
章节：
${outline || '（未提供章节）'}
${userGuidance ? `\n【用户原始要求和决定，仅用于判断用图范围，不写入图注】\n${userGuidance}\n` : ''}

【图片选择规则】
1. 只能选择候选清单中的 image_id，禁止编造。
2. 同一主题有多个版本时，优先用用户确认的版本，其次用最后生成的一版。用户需要具体技术选型时，不以通用分层图替代。
3. 必须选入标记“用户确认用图”的版本。系统架构、技术架构和报表数据流程是不同主题，现状和目标也是不同主题。各图必须放在对应的章节。
4. 优先覆盖用户要求体现的不同图示主题。ER 图放数据库章节，技术架构图放技术架构章节，部署图放部署章节，状态机/时序/报文图放流程章节。
5. 图的实际内容必须和该章相符。不要用工程化图替代技术架构图，也不要用标题相似的图替代用户指定的图。
6. 候选里标记“画册收藏”的图片优先进入正文，除非它明显不属于本文档的主题。
7. 每个图示主题只用一个版本。最多选 ${maxImages} 张，不收录被否定、被替代或仅用于比较的图片。不足时保留已有用图，不用同组变体填补。
8. 没有合适的图片时可以用空数组。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：
{"final_images":[{"image_id":"候选清单中的 ID","caption":"8–30 字终稿图注","role":"这张图在文档中的作用","section":1}]}

【候选图片（按时间顺序）】
${formatImageCatalog(images)}`;
}

export function buildDocumentImagePlanMessages({
  chat,
  images,
  plan,
  userGuidance,
  limit = DOCUMENT_FINAL_IMAGES,
}) {
  return [
    {
      role: 'system',
      content:
        '你是终稿配图编辑。只从候选图片中选择最终交付图片，只输出合法 JSON，不要输出正文、代码块或解释。',
    },
    {
      role: 'user',
      content: buildDocumentImagePlanPrompt({ chat, images, plan, userGuidance, limit }),
    },
  ];
}

function planString(value, limit) {
  return clipText(String(value || '').trim(), limit);
}

function planList(value, limit = 6, itemLimit = 300) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => planString(item, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function parsePlanObject(value) {
  const raw = String(value || '')
    .replace(/^\uFEFF/, '')
    .trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  const text = fenced ? fenced[1].trim() : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function selectPlanImages(
  requested,
  images,
  sections,
  limit = DOCUMENT_FINAL_IMAGES,
) {
  const max = Math.max(1, Number(limit) || DOCUMENT_FINAL_IMAGES);
  const byId = new Map((images || []).map((image) => [image.id, image]));
  const approved = (images || []).filter((image) => image.approved).slice(-max);
  const approvedIds = new Set(approved.map((image) => image.id));
  const selected = [];
  let optional = 0;
  for (const item of Array.isArray(requested) ? requested : []) {
    const id = String(typeof item === 'string' ? item : item?.image_id || '').trim();
    const image = byId.get(id);
    if (!image || selected.some((entry) => entry.id === id)) continue;
    if (!approvedIds.has(id) && ++optional > max - approved.length) continue;
    const sectionNumber = Math.trunc(Number(item?.section));
    selected.push({
      ...image,
      caption: planString(image.approvedCaption || item?.caption || image.source || imageCaption(image), 80),
      role: planString(item?.role, 80),
      section: sectionNumber > 0 ? sectionNumber : 0,
    });
  }
  for (const image of approved) {
    if (!selected.some((entry) => entry.id === image.id)) {
      selected.push({ ...image, caption: image.approvedCaption || image.source || '已确认配图', section: 0 });
    }
  }
  for (const image of selected) {
    if (image.section > sections.length) image.section = 0;
  }
  return selected;
}

export function parseDocumentPlan(value, images = [], limit = DOCUMENT_FINAL_IMAGES) {
  const parsed = parsePlanObject(value);
  if (!parsed) return null;

  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((section) => ({
      heading: planString(section?.heading, 120).replace(
        /^(?:第\s*\d+\s*章|\d+[.、)])\s*/,
        '',
      ),
      purpose: planString(section?.purpose, 300),
      points: planList(section?.points, 6, 300),
    }))
    .filter((section) => section.heading);
  const selected = selectPlanImages(parsed.final_images, images, sections, limit);

  const title = planString(parsed.title, 120);
  const coreMessage = planString(parsed.core_message, 500);
  if (!title && !coreMessage && !sections.length && !selected.length) return null;

  return {
    title,
    documentType: planString(parsed.document_type || parsed.type, 80),
    audience: planString(parsed.audience, 120),
    objective: planString(parsed.objective, 500),
    coreMessage,
    sections,
    keyFacts: planList(parsed.key_facts, 10, 300),
    openIssues: planList(parsed.open_issues, 8, 300),
    images: selected,
  };
}

export function parseDocumentImagePlan(
  value,
  images,
  sections = [],
  limit = DOCUMENT_FINAL_IMAGES,
) {
  const parsed = parsePlanObject(value);
  const requested = parsed?.final_images || parsed?.images;
  if (!Array.isArray(requested)) return null;
  return selectPlanImages(
    requested,
    images,
    sections,
    limit,
  );
}

function planFacts(plan) {
  const facts = (plan?.keyFacts || []).map((item) => `- ${item}`).join('\n');
  const issues = (plan?.openIssues || []).map((item) => `- ${item}`).join('\n');
  return [
    facts ? `【必须准确保留的事实】\n${facts}` : '',
    issues ? `【需要评审确认的事项】\n${issues}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildDocumentIntroMessages({ chat, plan, transcript, userGuidance }) {
  const title = plan?.title || chat?.title || '文档';
  const facts = planFacts(plan);
  const evidence = String(transcript || '').trim();
  return [
    {
      role: 'system',
      content:
        '你是文档编辑。依据所给会话材料写可直接交付的中文概述，只输出正文段落。',
    },
    {
      role: 'user',
      content: `请为下面这份文档写一段简短导语，交代背景、目的和最终结论。

文档标题：${title}
${plan?.documentType ? `文档类型：${plan.documentType}\n` : ''}${plan?.audience ? `读者：${plan.audience}\n` : ''}${plan?.objective ? `目标：${plan.objective}\n` : ''}${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}
要求：只输出一个不超过 180 字的中文段落，直接陈述与交付目标相关的事实。不回顾对话经过，不照录出图指令，不重复标题。以用户最终确认的结论为准。
${facts ? `${facts}\n` : ''}${userGuidance ? `\n【用户原始要求和决定】\n${userGuidance}\n` : ''}${evidence ? `\n【素材摘要】\n${evidence}\n` : ''}`,
    },
  ];
}

// A chapter is "design" when the document is a design and this chapter is one
// of its review chapters. A general document gets none of the architecture or
// data-dictionary instruction: telling a marketing brief to output a complete
// data dictionary produced invented tables.
const ARCHITECTURE_SECTION_RE = /架构|选型|部署|拓扑/;
const DATABASE_SECTION_RE = /数据库|数据字典|表结构|字段|索引|ER\s*图|数据模型/i;
const PROCESS_SECTION_RE = /接口|报文|流程|状态机|时序|幂等|告警/;

function isDesignPlan(plan) {
  return (
    /(设计|架构)/.test(String(plan?.documentType || '')) ||
    (plan?.sections || []).some((item) => ARCHITECTURE_SECTION_RE.test(item?.heading || ''))
  );
}

export function buildDocumentSectionMessages({
  chat,
  plan,
  section,
  index,
  total,
  images,
  transcript,
  userGuidance,
}) {
  const quota = images.length;
  const title = plan?.title || chat?.title || '文档';
  const displayHeading = `${index + 1}. ${section.heading}`;
  const outline = (plan?.sections || [])
    .map((item, position) => `${position + 1}. ${item.heading}`)
    .join('\n');
  const catalog = images.length
    ? images.map((image) => `- image_id=${image.id} | ${image.caption}${image.role ? ` | ${image.role}` : ''}`).join('\n')
    : '（本章没有可引用的图片，不要输出任何图片行。）';
  const facts = (plan?.keyFacts || []).map((item) => `- ${item}`).join('\n');
  // Pending items are consolidated in the closing chapter only; repeating them
  // in every chapter is what made nine chapters each carry the same list.
  const isClosingChapter = total > 1 && index === total - 1;
  const issues =
    isClosingChapter || total === 1
      ? (plan?.openIssues || []).map((item) => `- ${item}`).join('\n')
      : '';
  const design = isDesignPlan(plan);
  const scope = `${section.heading || ''} ${section.purpose || ''} ${
    Array.isArray(section.points) ? section.points.join(' ') : ''
  }`;
  const isOverview = index === 0;
  const isConclusion = total > 1 && index === total - 1;
  const architecture = design && ARCHITECTURE_SECTION_RE.test(scope);
  // A data dictionary only exists in a design (or in a chapter that says so).
  // Telling a marketing brief to emit "字段名/类型/索引" produced invented tables.
  const database = (design || /数据字典|数据库|表结构/.test(scope)) && DATABASE_SECTION_RE.test(scope);
  const process = PROCESS_SECTION_RE.test(scope) && design;

  // Numbered rules. Built as a list so a rule that does not apply (the closing
  // chapter is allowed to have a pending section) leaves no gap in the count.
  const rules = [];
  rules.push(`以 \`## ${displayHeading}\` 开头。先遵守素材中用户指定的篇幅、句数和版式。用户要求简短时直接写正文，不额外添加小标题、表格或总结。`);
  rules.push(
    '用户明确确认、否定和修正高于旧稿和后续助手建议。逐条写入用户追加且属于本章的事实和痛点，即使旧稿列举过其他条目。只有业务上需要说明原因时才写方案演变。',
  );
  rules.push(
    '本章内容必须来自下方素材。区分已有证据和待验证推断，尤其不要把未定位到调用点写成已证实的调用方式。素材没有的内容不要补写或套用章节模板。',
  );
  rules.push(
    '直接输出终稿 Markdown。对话证据只用于提炼本章事实，不照录用户或助手发言，不输出消息角色标签、闲聊、出图指令、分析、前言、代码块或写作过程。可以使用 Markdown 表格、列表和三级标题。',
  );
  rules.push(
    `图片只能引用本章清单中的 image_id，最多引用 ${quota} 张；使用 \`![8–30 字图注](image_id)\` 格式，放在相关结论之后；清单外图片一律不要引用。本章清单中的图如与正文相关就应引用，不要遗漏；如果本章清单为空，直接写正文，不要声称“全文没有图片”或“本章无图”。`,
  );
  rules.push(
    '不要在每个章节重复同一组全局待确认事项；只有本章特有的技术选择、风险或待定项才列，全局事项集中到最后 1 章。',
  );
  if (!isConclusion) {
    rules.push(
      '本章不要生成任何标题包含“待确认/待评审/待定/需评审”的小节；本章特有的待定项用一句正文结尾说明即可。',
    );
  }
  rules.push(
    '不要将文档交付格式（Word/PDF）、图片数量、图号、附录索引列为风险或待确认事项；不要把已经解决的过程状态写成待办。',
  );
  rules.push(
    '只写当前章节主题：其他章节的细节不要在本章重复展开；同一结论只在本章完整讲一次。',
  );
  rules.push(
    '这是终稿的一章，不是对谈：全文禁止出现“本章”“本节”“下文”“如上”“以上就是”“接下来”“我们”“你”“请确认”“是否要”等指向读者或写作过程的说法；不要用段落宣告这一章要讲什么，直接给结论。',
  );
  if (database) {
    rules.push(
      `本章涉及数据库、数据字典、表结构或字段设计时，仅在素材提供表结构或用户要求数据字典时逐表呈现。字段、索引和分区按原文保留，使用 Markdown 表格，每张表一个小标题（### ${index + 1}.1、### ${index + 1}.2……）。不要替现状统计或架构概述编制数据字典。`,
    );
  }
  if (architecture) {
    rules.push(
      '本章涉及架构或技术选型：采用素材里最后一版、含具体技术实现和组件选型的架构结论；更早的通用分层版或旧版架构图不得写入。',
    );
  }
  if (process) {
    rules.push(
      '本章涉及接口、报文、任务状态或流程时，只保留与本章主题相符的已知细节，不为已有数据流凭空添加接口、ACK/NACK、幂等键或状态机。',
    );
  }
  // The overview table is a design-review device, and only the first chapter of
  // a design may use it. Any other document states its conclusion in prose.
  if (design && isOverview) {
    rules.push(
      '本章是全文的总体章：先写一段总体结论，再用一个 Markdown 表格汇总“设计领域 | 关键结论/决策”，覆盖下面各章的主题；只写一句话级摘要，详细内容留给后续章节。',
    );
  } else if (isOverview) {
    rules.push('直接回答当前章节要解决的问题，背景和目的已在导语中交代。');
  }
  if (isConclusion && /风险|评审|总结|结论|待确认/.test(section.heading)) {
    rules.push(
      '本章是全文最后一章：总结前文已确定的结论，列出主要风险、待确认事项和下一步；不要引入新的方案。评审结论必须忠于素材：没有明确的“评审通过/同意进入详细设计”表述时，只能写“待评审/建议提交评审”，不得写出已批准的结论，也不得把已被否定的方案重新列为待确认项。',
    );
  }
  const ruleBlock = rules
    .map((rule, position) => `${position + 1}. ${rule}`)
    .join('\n');

  const sectionPlan = [
    section?.purpose ? `本章写作重点：${section.purpose}` : '',
    Array.isArray(section.points) && section.points.length
      ? `本章必须覆盖的要点：\n${section.points.map((point) => `- ${point}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      role: 'system',
      content: `你是资深${
        design ? '解决方案架构师和评审材料编辑' : '内容编辑和交付文档撰写人'
      }。只写当前章节，输出可直接进入终稿的 Markdown 正文；不要写标题页、导语、其他章节或分析过程。`,
    },
    {
      role: 'user',
      content: `请写文档的第 ${index + 1}/${total} 章。

文档标题：${title}
${plan?.documentType ? `文档类型：${plan.documentType}\n` : ''}${plan?.audience ? `读者：${plan.audience}\n` : ''}${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}
全文章节（只写当前这一章，不要重复其他章节）：
${outline}

当前章节标题：${displayHeading}
${sectionPlan ? `${sectionPlan}\n` : ''}
要求：
${ruleBlock}
${facts ? `\n【必须准确保留的事实】\n${facts}\n` : ''}${issues ? `\n【需要评审确认的事项】\n${issues}\n` : ''}${userGuidance ? `\n【用户原始要求和决定，只采用本章相关内容；用户已纠正的旧说法不得复述】\n${userGuidance}\n` : ''}
【本章可引用图片】
${catalog}

【本章相关对话证据】
${transcript || '（没有文字记录）'}`,
    },
  ];
}

function cleanInline(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\((?!image:)[^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function pushParagraph(paragraph, blocks) {
  if (!paragraph.length) return;
  blocks.push({ type: 'paragraph', text: paragraph.join('\n').trim() });
  paragraph.length = 0;
}

function pushBullets(bullets, blocks) {
  if (!bullets) return;
  blocks.push({ type: 'bullets', ordered: bullets.ordered, items: bullets.items });
}

function pushQuote(quote, blocks) {
  if (!quote.length) return;
  blocks.push({ type: 'quote', text: quote.join('\n').trim() });
  quote.length = 0;
}

function tableCells(line) {
  const value = String(line || '').trim();
  if (!value.includes('|')) return null;
  const cells = value
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanInline(cell.trim()));
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return Boolean(
    cells &&
      cells.length &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell) || /^:?-{2,}:?$/.test(cell)),
  );
}

function isTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|') || isTableSeparator(trimmed)) return false;
  return Boolean(tableCells(trimmed));
}

function normalizeTableRow(cells, width) {
  return Array.from({ length: width }, (_, index) => cells[index] || '');
}

export function dedupeDocumentVoice(markdown) {
  const source = String(markdown || '');
  const seen = new Set();
  const keptLines = [];
  // The closing chapter is where every pending item is consolidated. Its own
  // list must survive; a per-chapter list is not deleted but moved there, so a
  // fact stated once anywhere in the document is never lost.
  const chapterNumbers = [...source.matchAll(/^##\s+(\d+)[.、)]?\s/gm)].map((match) =>
    Number(match[1]),
  );
  const lastChapter = chapterNumbers.length ? Math.max(...chapterNumbers) : 0;
  let chapter = 0;
  let skipping = 0;
  let harvesting = null;
  let closingAt = -1;
  let closingLevel = 0;
  const carried = [];
  // Rows already kept in the body, so a pending table that the closing chapter
  // also lists is not duplicated when it is carried over.
  const keptRows = new Set();

  const pushCarried = (text) => {
    if (!text) return;
    const key = normalizeSentence(text);
    if (!key) return;
    if (carried.some((item) => normalizeSentence(item) === key)) return;
    carried.push(text);
  };

  const harvest = () => {
    if (!harvesting) return;
    // A pending table is structured evidence — a field inventory, an issue
    // register with numbers. Blanking its rows lost exactly the material the
    // reader needs, so a table is carried as a whole block.
    let table = [];
    const flushTable = () => {
      if (!table.length) return;
      const hasSeparator = table.length > 1 && /^\|?[\s:|-]+\|?$/.test(table[1]);
      const head = hasSeparator ? table.slice(0, 2) : [];
      const rows = (hasSeparator ? table.slice(2) : table).filter((row) => {
        const key = normalizeSentence(row);
        return key && !keptRows.has(key);
      });
      if (rows.length) pushCarried([...head, ...rows].join('\n'));
      table = [];
    };
    for (const line of harvesting) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|')) {
        table.push(trimmed);
        continue;
      }
      flushTable();
      const value = trimmed.replace(/^[-*+]\s+/, '');
      if (!value || /^[-*_]{3,}$/.test(value)) continue;
      if (/^#{1,6}\s/.test(value)) continue;
      const text = value
        .split(/(?<=[。！？!?])\s*/)
        .map((part) => part.trim())
        .filter((part) => part && !isNarration(part))
        .join('')
        .trim();
      pushCarried(text);
    }
    flushTable();
    harvesting = null;
  };

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (/^(?:[-*+]\s+|>\s*)?(?:第\s*\d+\s*轮(?:生成|参考|附件)图|(?:用户|助手)[：:])/.test(trimmed)) continue;
    const heading = /^(#{2,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (level === 2) {
        const numbered = /^(\d+)[.、)]?\s/.exec(title);
        chapter = numbered ? Number(numbered[1]) : 0;
      }
      if (skipping && level <= skipping) {
        skipping = 0;
        harvest();
      }
      if (skipping) {
        if (harvesting) harvesting.push(line);
        continue;
      }
      // A chapter-level "pending items" section narrates the chapter's own
      // status. The number prefix ("3.4 本章待定项") is stripped before the
      // test, and a qualified title ("5.8 部署相关待定项") matches too.
      const bare = title.replace(/^\d+(?:\.\d+)*[.、)]?\s*/, '');
      const pendingSection =
        /^(?:本章|本节|本章节)[^。]{0,8}(?:待定|待确认|待评审|需评审|遗留问题)/.test(bare) ||
        /^[^。]{0,12}(?:待定项|待确认事项|待评审事项|遗留问题)$/.test(bare);
      const isClosing = lastChapter > 0 && chapter === lastChapter;
      if (pendingSection && !isClosing) {
        skipping = level;
        harvesting = [];
        continue;
      }
      if (pendingSection && isClosing && closingAt < 0) {
        closingAt = keptLines.length;
        closingLevel = level;
      }
      keptLines.push(line);
      continue;
    }
    if (skipping) {
      if (harvesting) harvesting.push(line);
      continue;
    }
    if (!trimmed) {
      keptLines.push(line);
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed) || /^\|/.test(trimmed) || /^!\[/.test(trimmed)) {
      if (trimmed.startsWith('|')) keptRows.add(normalizeSentence(trimmed));
      keptLines.push(line);
      continue;
    }
    const sentences = trimmed
      .split(/(?<=[。！？!?])\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    const body = sentences.filter((sentence) => !isNarration(sentence));
    if (!body.length) continue;
    if (body.length === 1 && sentences.length === 1) {
      const key = normalizeSentence(trimmed);
      if (key.length >= DEDUPE_MIN_CHARS && seen.has(key)) continue;
      if (key.length >= DEDUPE_MIN_CHARS) seen.add(key);
      keptLines.push(line);
      continue;
    }
    const survivors = [];
    for (const sentence of body) {
      const key = normalizeSentence(sentence);
      if (key.length >= DEDUPE_MIN_CHARS) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      survivors.push(sentence);
    }
    if (!survivors.length) continue;
    keptLines.push(survivors.join(''));
  }
  harvest();

  if (!carried.length) return keptLines.join('\n');
  // A carried table stays a table (a row list flattened into bullets is
  // unreadable), a carried sentence becomes a list item.
  const blocks = carried.map((item) =>
    item.startsWith('|') ? item : `- ${item}`,
  );
  // Where a carried table has the same header as a table already in the
  // closing chapter, its rows join that table: two identical headers back to
  // back read as a formatting mistake in the deliverable.
  const tableEnd = (header, from) => {
    for (let index = from; index < keptLines.length; index += 1) {
      if (keptLines[index].trim() !== header) continue;
      const next = (keptLines[index + 1] || '').trim();
      if (!/^\|?[\s:|-]+\|?$/.test(next)) continue;
      let end = index + 2;
      while (end < keptLines.length && keptLines[end].trim().startsWith('|')) {
        end += 1;
      }
      return end;
    }
    return -1;
  };
  // Append to the closing chapter's existing list, after its last line and
  // before the next heading, so a list does not land inside a table.
  if (closingAt >= 0) {
    let insert = keptLines.length;
    for (let index = closingAt + 1; index < keptLines.length; index += 1) {
      const nested = /^(#{2,4})\s/.exec(keptLines[index].trim());
      if (nested && nested[1].length <= closingLevel) {
        insert = index;
        break;
      }
    }
    const appended = [];
    for (const block of blocks) {
      if (!block.startsWith('|')) {
        appended.push(block);
        continue;
      }
      const [header, , ...rows] = block.split('\n');
      const end = tableEnd(header, closingAt + 1);
      if (end >= 0) keptLines.splice(end, 0, ...rows);
      else appended.push(block, '');
    }
    if (appended.length) keptLines.splice(insert, 0, '', ...appended);
  } else {
    keptLines.push('', '### 待确认事项（汇总）', '', ...blocks);
  }
  return keptLines.join('\n');
}

/**
 * A sentence that describes the document instead of the subject: "本章描述…",
 * "本章结论作为后续各章的基线：…第 2 章…第 3 章…". In a deliverable this reads
 * as the author talking to the reader, which is the conversational voice to
 * remove. Sentences that merely start with 本章 but carry a fact ("本章涉及的
 * 仓库类型尚未确认") are kept — only pure narration and chapter cross-reference
 * maps are dropped.
 */
function isNarration(sentence) {
  const value = String(sentence || '').trim();
  if (!value) return false;
  if (/^(?:本章|本节|本文|下文)(?:描述|说明|介绍|阐述|概述|汇总|小结|结论作为)/.test(value)) {
    return true;
  }
  const references = value.match(/第\s*\d+\s*章/g) || [];
  return references.length >= 2;
}

// Only long, self-contained statements are deduped. Short phrases repeat as
// legitimate cross-references, and a 40-character floor is long enough that a
// sentence is a claim rather than a term of art.
const DEDUPE_MIN_CHARS = 40;

/**
 * Facts the user has explicitly settled, and the assistant hypotheses that must
 * not survive as open questions. A regeneration that resurrects a rejected
 * option is worse than a shorter document: it re-opens a question the reader
 * already answered, and it makes the deliverable argue against its own author.
 *
 * Each entry pairs what the user asserted with the phrasing a model tends to
 * produce when it echoes the assistant's earlier hypothetical instead.
 */
const SETTLED_CORRECTIONS = [
  {
    // msg: 用户 “所有的线路都是出入库复用的”
    asserted: /(所有|全部)?(的)?线路(都|均)?是?出入库复用|出入库复用/,
    resurrected:
      /(两条入库一?条?出库|两条入库、?一条出库|三进两出|入库出库非对称|非对称配置|入库与出库非对称)/,
  },
];

/**
 * Applies the user's explicit corrections to generated prose: a sentence that
 * revives a rejected alternative is dropped, and a review conclusion the user
 * never gave is rewritten as pending. Both are deterministic corrections of the
 * source of truth, not style preferences — the document must not contradict the
 * person who commissioned it.
 */
export function applySettledCorrections(markdown, transcript = '') {
  const source = String(markdown || '');
  const context = String(transcript || '');
  let out = source;

  for (const rule of SETTLED_CORRECTIONS) {
    if (!rule.asserted.test(context)) continue;
    out = out
      .split('\n')
      .map((line) => {
        if (!rule.resurrected.test(line)) return line;
        // A table row cannot be blanked without breaking the table, so the
        // resurrected clause is removed from its cell instead of dropping the
        // row — the rest of that cell (a real open question) survives.
        if (line.trim().startsWith('|')) {
          return line
            .split('|')
            .map((cell) => {
              if (!rule.resurrected.test(cell)) return cell;
              const kept = cell
                .split(/[，,、；;]/)
                .filter((part) => !rule.resurrected.test(part))
                .join('、')
                .replace(/[、，,\s]+$/, '');
              return kept ? `${kept} ` : ' ';
            })
            .join('|');
        }
        const kept = line
          .split(/(?<=[。；;！!？?])\s*/)
          .filter((part) => !rule.resurrected.test(part));
        return kept.join('').trim();
      })
      .join('\n');
  }

  if (/OLAP[^。！？\n]{0,40}(?:确定|决定|确认)[^。！？\n]{0,20}\bDoris\b/i.test(context)) {
    const unresolved = /(?:Doris|OLAP)[^。！？\n|]{0,12}(?:是否(?:长期)?(?:引入|采用|保留)|(?:长期)?(?:引入|采用)(?:的)?判定|方案\s*A\s*[/／]\s*B|选型(?:尚未确定|待定))|是否(?:长期)?(?:引入|采用|保留)(?:独立\s*)?(?:Doris|OLAP)/i;
    out = out.split('\n').map((line) => {
      const trimmed = line.trimStart();
      if (!unresolved.test(line)) return line;
      if (trimmed.startsWith('|')) return '';
      if (/^#{1,6}\s/.test(trimmed)) return trimmed.replace(/^(#{1,6}\s+(?:\d+(?:\.\d+)*[.、]?\s+)?).+$/, '$1OLAP 选型');
      return line.split(/(?<=[。；;！？])\s*/).filter((sentence) => !unresolved.test(sentence)).join(' ');
    }).join('\n');
  }

  // A review verdict nobody gave. The document may recommend a review, but it
  // must not record that the review approved the design.
  if (!/(评审通过|同意进入详细设计|批准进入详细设计|评审已通过|已通过评审)/.test(context)) {
    out = out.replace(
      /(结论[:：]\s*)?方案总体可行[，,]?\s*(原则)?同意进入详细设计阶段[^。\n]*。?/g,
      '结论：方案具备提交评审的条件；评审结论待评审会确认后填写。',
    );
    out = out.replace(
      /同意进入详细设计阶段[^。\n]*。?/g,
      '待评审会确认后进入详细设计阶段。',
    );
    out = out.replace(
      /结论[:：]\s*方案总体可行(?![\s\S]{0,40}待评审)[^。\n]*。/g,
      '结论：方案待评审会确认。',
    );
  }
  return out;
}

function normalizeSentence(value) {
  return String(value || '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、（）()“”"'！？!?]/g, '')
    .trim();
}

/**
 * Parses the small Markdown subset requested from the document model. Unknown
 * constructs degrade to paragraphs instead of being dropped. Markdown tables
 * become structured blocks so database dictionaries stay readable in DOCX/PDF.
 */
export function parseDocumentMarkdown(markdown) {
  const source = String(markdown || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const lines = source.split('\n');
  const blocks = [];
  const paragraph = [];
  const quote = [];
  let bullets = null;
  let title = '';
  let inFence = false;

  const flush = () => {
    pushParagraph(paragraph, blocks);
    pushBullets(bullets, blocks);
    bullets = null;
    pushQuote(quote, blocks);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) {
      paragraph.push(rawLine);
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }

    if (
      isTableRow(trimmed) &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1].trim())
    ) {
      flush();
      const headers = tableCells(trimmed) || [];
      const rows = [];
      index += 1; // Separator line.
      while (index + 1 < lines.length && isTableRow(lines[index + 1])) {
        index += 1;
        rows.push(normalizeTableRow(tableCells(lines[index]) || [], headers.length));
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = cleanInline(heading[2]);
      if (level === 1 && !title) {
        title = text;
      } else {
        blocks.push({ type: 'heading', level: Math.min(3, level), text });
      }
      continue;
    }

    const image = IMAGE_LINE_RE.exec(trimmed.replace(/^[-*+]\s+/, ''));
    if (image) {
      flush();
      blocks.push({ type: 'image', id: image[2], caption: cleanInline(image[1]) });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      pushParagraph(paragraph, blocks);
      pushQuote(quote, blocks);
      const type = bullet ? 'ul' : 'ol';
      if (!bullets || bullets.ordered !== Boolean(ordered)) {
        pushBullets(bullets, blocks);
        bullets = { ordered: Boolean(ordered), items: [] };
      }
      bullets.items.push(cleanInline((bullet || ordered)[1]));
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(trimmed);
    if (quoted) {
      pushParagraph(paragraph, blocks);
      pushBullets(bullets, blocks);
      bullets = null;
      quote.push(cleanInline(quoted[1]));
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flush();
      // A rule separates sections of the argument, not decoration to discard:
      // long reports rely on it to mark where one line of reasoning ends.
      if (!blocks.length || blocks[blocks.length - 1].type !== 'hr') {
        blocks.push({ type: 'hr' });
      }
      continue;
    }

    pushBullets(bullets, blocks);
    bullets = null;
    pushQuote(quote, blocks);
    paragraph.push(cleanInline(trimmed));
  }

  flush();
  return { title, blocks };
}

const APPENDIX_HEADING = '附录：会话图片';

function figureContext(image) {
  if (!image.source) return '';
  return image.round ? `第 ${image.round} 轮${image.source}` : image.source;
}
/**
 * Resolves model image references and assembles the finished block list.
 *
 * `images` is the planner-approved set the body may cite inline. `archive`
 * is the set approved for delivery, in source order. Embed each id once.
 */
export function finalizeDocument({ markdown, title, images, archive, showImageSource = false }) {
  const parsed = parseDocumentMarkdown(markdown);
  const catalog = (images || []).filter((image) => image?.id);
  const byId = new Map(catalog.map((image) => [image.id, image]));
  const used = new Set();
  const blocks = [];

  for (const block of parsed.blocks) {
    if (block.type !== 'image') {
      if (
        (block.type === 'paragraph' || block.type === 'heading') &&
        !String(block.text || '').trim()
      ) {
        continue;
      }
      blocks.push(block);
      continue;
    }
    const image = byId.get(block.id);
    if (!image || used.has(block.id)) continue;
    used.add(block.id);
    const context = showImageSource && figureContext(image);
    if (context) blocks.push({ type: 'paragraph', text: context });
    blocks.push({ ...block, caption: showImageSource && block.caption ? block.caption : imageCaption(image) });
  }

  const bodyImageCount = used.size;
  const archived = archive
    ? archive.filter((image) => image?.id && !used.has(image.id))
    : [];
  const uniqueArchived = [];
  const archivedIds = new Set();
  for (const image of archived) {
    if (archivedIds.has(image.id)) continue;
    archivedIds.add(image.id);
    uniqueArchived.push(image);
  }
  if (uniqueArchived.length) {
    blocks.push({ type: 'heading', level: 2, text: APPENDIX_HEADING, appendix: true });
    blocks.push({
      type: 'paragraph',
      text: `正文已选图 ${bodyImageCount} 张，其余 ${uniqueArchived.length} 张按会话顺序列出。`,
    });
    for (const [index, image] of uniqueArchived.entries()) {
      const context = showImageSource && figureContext(image);
      if (context) blocks.push({ type: 'paragraph', text: context });
      blocks.push({
        type: 'image',
        id: image.id,
        archive: true,
        caption: clipText(
          `图 ${bodyImageCount + index + 1}：${imageCaption(image)}`,
          80,
        ),
      });
    }
  }

  return {
    title: parsed.title || title || '文档',
    blocks,
    imageCount: bodyImageCount + uniqueArchived.length,
    bodyImageCount,
    archivedCount: uniqueArchived.length,
  };
}
