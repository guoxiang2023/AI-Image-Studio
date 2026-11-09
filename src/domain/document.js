import { clipText } from '../shared/utils.js';

const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(\s*(?:image:)?([a-f0-9]{16,40})\s*\)\s*$/i;

export function imageCaption(image) {
  const value = String(image?.caption || image?.prompt || '创作图片').trim();
  return clipText(value || '创作图片', 80);
}

/**
 * Collects every generated image in conversation order. Older images beyond
 * the limit are dropped first because later iterations are usually the ones a
 * deliverable document should show.
 */
export function collectDocumentImages(chat, limit) {
  const seen = new Set();
  const all = [];
  let request = '';
  let requestRefs = [];
  for (const [turn, message] of (chat?.messages || []).entries()) {
    if (message.role === 'user') {
      request = clipText(String(message.content || '').replace(/\s+/g, ' ').trim(), 240);
      requestRefs = (message.references || []).map((ref) => ref.id).filter(Boolean);
      continue;
    }
    for (const image of message.images || []) {
      if (!image?.id || seen.has(image.id)) continue;
      seen.add(image.id);
      all.push({
        id: image.id,
        prompt: image.prompt || image.caption || '',
        caption: image.caption || image.prompt || '',
        size: image.size || '',
        aspectRatio: image.aspectRatio || '',
        parentId: image.parentId || null,
        supersedes: requestRefs,
        turn,
        request,
        index: all.length + 1,
      });
    }
  }
  const max = Math.max(1, Number(limit) || all.length || 1);
  return {
    images: all.length > max ? all.slice(-max) : all,
    total: all.length,
    omitted: Math.max(0, all.length - max),
  };
}

/**
 * Keeps only deliverable images. Explicitly discarded images (removed from the
 * gallery), missing files, and images superseded by a later edit are excluded.
 * The newest remaining images survive the limit.
 */
export function selectFinalDocumentImages(
  images,
  { hiddenIds = [], unavailableIds = [], limit } = {},
) {
  const hidden = new Set(hiddenIds);
  const unavailable = new Set(unavailableIds);
  const all = (images || []).filter((image) => image?.id);
  // A parent in an edit chain is never a final deliverable, even when the
  // later edit was removed. This avoids silently promoting an old draft.
  const superseded = new Set();
  for (const image of all) {
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
      previous?.id &&
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
      !superseded.has(image.id),
  );
  const max = Math.max(1, Number(limit) || finals.length || 1);
  const kept = finals.length > max ? finals.slice(-max) : finals;
  return kept.map((image, index) => ({ ...image, index: index + 1 }));
}

function stripDocumentProcess(value) {
  const blocked =
    /(文档策划失败|文档生成失败|PDF 生成|PDF 转换|转成 PDF|Word 另存|生成 PDF|生成文档|文档服务|核心配图|附图索引|图号|逐图|导读段落|评审问题清单|附录\s*[AB]|文档补充|接口返回“文档策划失败”|接口仍返回|被截断|zoneCode之后|(?:按|需|待|应)[^。\n]{0,8}补齐[^。\n]{0,16}(?:字段|索引|数据字典))/i;
  return String(value || '')
    .split('\n')
    .filter((line) => !blocked.test(line))
    .join('\n')
    .trim();
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
      const cleaned = stripDocumentProcess(message.content);
      if (!cleaned) continue;
      let line = `用户：${clipText(cleaned, 3000) || '（仅上传了素材）'}`;
      if (Array.isArray(message.attachments) && message.attachments.length) {
        line += `\n（附件：${message.attachments
          .map((attachment) => attachment.name || '文件')
          .join('、')}）`;
        for (const attachment of message.attachments.slice(0, 4)) {
          const excerpt = String(attachment.text || '').trim();
          if (excerpt) {
            line += `\n[附件摘录：${attachment.name || '文件'}] ${clipText(excerpt, 800)}`;
          }
        }
      }
      if (Array.isArray(message.references) && message.references.length) {
        line += `\n（参考图：${message.references.map((ref) => ref.id).join('、')}）`;
      }
      lines.push(line);
    } else if (message.role === 'assistant') {
      const cleaned = stripDocumentProcess(message.content);
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

function formatImageCatalog(images) {
  if (!images.length) return '（没有可进入终稿的图片，final_images 必须为空数组。）';
  return images
    .map((image) => {
      const flags = [
        image.favorite ? '画册收藏' : '',
        image.parentId ? '基于上一版修改' : '',
        image.role ? `用途：${clipText(image.role, 80)}` : '',
      ].filter(Boolean);
      const turn = Number.isInteger(image.turn) ? `第 ${image.turn + 1} 轮 | ` : '';
      const request = image.request
        ? ` | 生成前用户要求：${clipText(image.request, 180)}`
        : '';
      return `- image_id=${image.id} | ${turn}第 ${image.index} 张 | ${
        image.aspectRatio || image.size || '画幅未知'
      } | 画面/提示：${clipText(image.prompt || image.caption, 180)}${request}${
        flags.length ? ` | ${flags.join(' | ')}` : ''
      }`;
    })
    .join('\n');
}

export function buildDocumentPlanDigest(chat, maxChars = 16000) {
  const lines = [];
  for (const message of chat?.messages || []) {
    const content = String(message.content || '').trim();
    if (!content) continue;
    if (message.role === 'user') {
      const cleaned = stripDocumentProcess(content);
      if (cleaned) lines.push(`用户：${clipText(cleaned, 700)}`);
      continue;
    }
    if (message.role !== 'assistant') continue;
    const cleaned = stripDocumentProcess(content);
    if (!cleaned) continue;
    const headings = [...cleaned.matchAll(/^#{1,6}\s+(.+)$/gm)]
      .map((match) => match[1].trim())
      .slice(0, 24);
    lines.push(
      `助手：${clipText(cleaned, 450)}${
        headings.length ? `\n（标题/表：${headings.join(' / ')}）` : ''
      }`,
    );
  }
  const text = `【对话纲要】\n${lines.join('\n\n')}`;
  if (text.length <= maxChars) return text;
  return `【对话纲要（节选）】\n${clipText(lines.slice(-40).join('\n\n'), maxChars)}`;
}

function documentMessageText(message) {
  const cleaned = stripDocumentProcess(message?.content);
  if (!cleaned) return '';
  let line = `${message.role === 'user' ? '用户' : '助手'}：${cleaned}`;
  if (message.role === 'user') {
    if (Array.isArray(message.attachments) && message.attachments.length) {
      line += `\n（附件：${message.attachments
        .map((attachment) => attachment.name || '文件')
        .join('、')}）`;
      for (const attachment of message.attachments.slice(0, 4)) {
        const excerpt = String(attachment.text || '').trim();
        if (excerpt) {
          line += `\n[附件摘录：${attachment.name || '文件'}] ${clipText(excerpt, 800)}`;
        }
      }
    }
    if (Array.isArray(message.references) && message.references.length) {
      line += `\n（参考图：${message.references.map((ref) => ref.id).join('、')}）`;
    }
    return line;
  }
  const ids = (message.images || []).map((image) => image.id).filter(Boolean);
  if (ids.length) line += `\n（本轮图片：${ids.join('、')}）`;
  return line;
}

/**
 * Splits the complete conversation into bounded semantic-summary inputs.
 * Unlike per-chapter clipping, every message is represented and the model
 * receives a chronological stream it can summarize without silently losing
 * earlier themes.
 */
export function buildDocumentContextChunks(chat, maxChars = 12000) {
  const limit = Math.max(1000, Number(maxChars) || 12000);
  const lines = [];
  for (const message of chat?.messages || []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const line = documentMessageText(message);
    if (!line) continue;
    if (line.length <= limit) {
      lines.push(line);
      continue;
    }
    for (let index = 0; index < line.length; index += limit) {
      lines.push(line.slice(index, index + limit));
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

export function buildDocumentBriefMessages({ chunk, previous = '' }) {
  return [
    {
      role: 'system',
      content:
        '你是技术文档资料整理员。把对话片段整理成可供后续大纲和章节写作使用的事实摘要，只输出摘要，不写解释。',
    },
    {
      role: 'user',
      content: `请把下面的对话片段整理成结构化的“事实摘要”，供后续写正式文档继续使用。

【必须保留】
- 用户最终目标、交付物、读者和使用场景；
- 以对话中最后一次确认的最终状态为准；早期“待补齐/被截断/未完成/生成失败”如果后续已经完成，写成已完成，不保留旧状态；
- 已确认的方案、决策、边界、约束和验收基线；
- 系统/技术架构、组件选型、关键技术实现；
- 数据架构、数据库表名、字段名、索引、分区、数据流向；
- 接口、报文、状态机、ACK/NACK、超时重试和幂等；
- 部署、机房、边缘节点、网络与容灾；
- 关键数字、版本、专有名词、表名、字段名和图片用途；
- 尚未确认的风险/待定事项，明确标为待确认，不要编造。

【剔除】
生成失败、重试、PDF/Word 转换、工具限制、写作过程、被否方案、重复试验、寒暄。

【输出结构】
摘要控制在 3000 字以内；宁可省略重复细节，也要保留主题、已确认方案、架构/数据/接口/部署结论以及关键表名和字段名。
【主题与目标】
【已确认方案与决策】
【系统与技术架构】
【数据与数据库】
【接口与流程】
【部署与容灾】
【关键数字与图片】
【风险与待确认】

${previous ? `已有摘要（请合并更新，不要丢失其中已确认的事实）：\n${clipText(previous, 6000)}\n\n` : ''}对话片段：
${chunk || '（没有内容）'}`,
    },
  ];
}

export function buildDocumentMergeMessages({ summaries }) {
  return [
    {
      role: 'system',
      content:
        '你是技术文档资料整理员。把多段事实摘要合并成一份完整摘要，只输出摘要，不遗漏任何已确认事实。',
    },
    {
      role: 'user',
      content: `请把下面按时间顺序排列的事实摘要合并成一份完整摘要，供后续写正式文档继续使用。

【合并规则】
- 以最后一次确认的最终状态为准；早期“待补齐/被截断/未完成”如果后续已完成，写成已完成，不保留旧状态。
- 必须覆盖所有片段；合并后仍保留用户目标、已确认方案、架构/数据/接口/部署结论、关键数字、表名和字段名、风险与待确认事项。
- 同一事实只保留一次；冲突时采用后出现的最终决定，并保留必要的取舍理由。
- 不要编造，不要把待确认项写成已确认。
- 输出 3000 字以内，使用原来的分节结构；不要写解释或合并过程。

${summaries.map((summary, index) => `【片段 ${index + 1}】\n${summary}`).join('\n\n')}`,
    },
  ];
}

const DESIGN_HEADINGS = [
  '总体设计概览',
  '系统定位与边界',
  '总体架构与功能模块',
  '技术架构与具体技术选型',
  '部署架构与高可用设计',
  '关键机制：任务状态机、接口时序、幂等与告警',
  '数据架构与数据流',
  '数据库设计（含完整数据字典：核心表字段、索引、ER 关系）',
  '风险、待确认事项与评审结论',
];

const REPORT_HEADINGS = [
  '背景与目标',
  '过程与关键结论',
  '结果与交付',
  '问题、风险与待确认事项',
  '经验总结与下一步',
];

const GENERIC_HEADINGS = [
  '背景与目标',
  '方案与关键内容',
  '实施与交付',
  '风险与约束',
  '结论与下一步',
];

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
    const cleaned = stripDocumentProcess(message.content);
    if (cleaned) parts.push(cleaned);
  }
  return clipText(parts.join('\n\n'), maxChars);
}

/**
 * A deterministic plan keeps document export usable when the planning request
 * is unavailable, truncated, or returns malformed JSON. It is intentionally
 * structure-only: facts and chapter bodies still come from the conversation.
 */
export function buildFallbackDocumentPlan(chat) {
  const source = cleanConversationText(chat, 8000);
  const title = clipText(String(chat?.title || '').trim() || '文档', 120);
  const design =
    /(设计|架构|系统|方案|技术|数据库|接口|部署)/.test(source) ||
    /(设计|架构|系统|WCS|WMS|WES|数据库)/i.test(title);
  const report = /(复盘|回顾|总结|报告)/.test(`${title}\n${source}`);
  const headings = design
    ? DESIGN_HEADINGS
    : report
      ? REPORT_HEADINGS
      : GENERIC_HEADINGS;
  return {
    title,
    documentType: design ? '方案设计' : report ? '总结报告' : '交付文档',
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

function sectionTerms(section) {
  const source = [
    section?.heading || '',
    section?.purpose || '',
    ...(Array.isArray(section?.points) ? section.points : []),
  ].join(' ');
  const terms = new Set();
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) {
    terms.add(match[0].toLowerCase());
  }
  for (const chunk of source.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (chunk.length <= 6) terms.add(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const term = chunk.slice(index, index + 2);
      if (term.length >= 2) terms.add(term);
    }
  }
  return [...terms]
    .filter((term) => term.length >= 2 && !SECTION_STOP_WORDS.has(term))
    .slice(0, 80);
}

/**
 * Selects the conversation evidence that belongs to one chapter. Sending the
 * whole transcript to every chapter makes the request grow with the chat and
 * can exceed a provider's context window; this keeps a bounded, relevant
 * slice while preserving table-rich messages for database chapters.
 */
export function buildSectionTranscript(chat, section, maxChars = 16000) {
  const terms = sectionTerms(section);
  const entries = [];
  const totalMessages = Array.isArray(chat?.messages) ? chat.messages.length : 0;
  for (const [index, message] of (chat?.messages || []).entries()) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    let content = stripDocumentProcess(message.content);
    if (!content) continue;
    if (message.role === 'user' && Array.isArray(message.attachments)) {
      for (const attachment of message.attachments.slice(0, 4)) {
        const excerpt = String(attachment.text || '').trim();
        if (excerpt) {
          content += `\n[附件：${attachment.name || '文件'}] ${clipText(excerpt, 600)}`;
        }
      }
    }
    const lower = content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score += 1;
    }
    const tableRows = (content.match(/\n\s*\|/g) || []).length;
    if (tableRows) score += Math.min(20, 4 + tableRows / 2);
    if (/字段|主键|索引|建表|数据字典|CREATE TABLE/i.test(content)) score += 3;
    if (message.role === 'user') score += 2;
    if (index >= totalMessages - 3) score += 5;
    entries.push({
      index,
      role: message.role,
      content: clipText(content, 14000),
      score,
    });
  }
  if (!entries.length) return '（没有可用的文字记录）';

  const selected = new Map();
  let size = 0;
  // Requirements and the latest turn usually anchor the chapter even when its
  // keywords do not literally appear there. They must still obey the total
  // budget, otherwise two long user turns can exceed the context limit by
  // themselves and make the reduced-context retry ineffective.
  const forcedUsers = entries
    .filter((item) => item.role === 'user')
    .slice(-2)
    .reverse();
  for (const entry of forcedUsers) {
    const remaining = maxChars - size;
    if (remaining < 240) break;
    const content =
      entry.content.length > remaining
        ? clipText(entry.content, remaining)
        : entry.content;
    selected.set(entry.index, { ...entry, content });
    size += content.length;
  }
  const ranked = [...entries].sort(
    (left, right) => right.score - left.score || right.index - left.index,
  );
  for (const entry of ranked) {
    if (selected.has(entry.index)) continue;
    const remaining = maxChars - size;
    if (remaining < 240) break;
    const content =
      entry.content.length > remaining
        ? clipText(entry.content, remaining)
        : entry.content;
    selected.set(entry.index, { ...entry, content });
    size += content.length;
  }
  const ordered = [...selected.values()].sort((left, right) => left.index - right.index);
  return `【本章相关对话节选】\n${ordered
    .map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.content}`)
    .join('\n\n')}`;
}

export function fallbackDocumentImages(images, sections = []) {
  const candidate = (images || []).filter((image) => image?.id).slice(-8);
  return candidate.map((image, index) => ({
    ...image,
    caption: clipText(image.caption || image.prompt || '文档配图', 30),
    role: '',
    section: sections.length ? (index % sections.length) + 1 : 0,
    index: index + 1,
  }));
}

export function buildDocumentPlanPrompt({ chat, transcript }) {
  return `你是资深解决方案架构师、技术文档策划和评审材料编辑。请基于下面的对话纲要，为最终文档制定结构策划，但不要写正文。

【先判断什么最重要】
- 先判断用户最终要交付什么文档、给谁看、用于什么评审或决策，以及用户在对话中反复补充、纠正、明确要求的内容。用户明确要求的内容优先级最高。
- 区分“最终方案”和“过程”：生成失败、重试、格式转换、工具限制、写作过程、被否方案、重复试验、寒暄等过程信息，绝不能写进终稿。
- 对设计类文档，用户通常最关心：系统边界与职责、系统架构、技术架构与具体选型、数据架构与数据流、数据库表/字段/索引/分区、接口与关键流程、部署架构、风险与待确认事项。对话中已经详细展开的内容必须保留细节，不能只留一句概括。
- 如果用户明确要求“完整数据字典”“全部字段”“不只核心表”，必须规划独立章节完整覆盖，不能只写“已补齐 N 张核心表”或只列几张表。

【结构要求】
- 规划 7–10 个章节，采用“总—分—总”结构。
- 第 1 章固定为“总体设计概览”：先用一段话给出总体结论，再用一个 Markdown 表格汇总“设计领域 | 关键结论/决策”，覆盖系统定位、系统架构、技术架构、数据与数据库、接口流程、部署；只写摘要，详细内容留给后续章节。
- 中间章节按主题逐项展开，顺序服务于评审阅读，不要按对话发生顺序平铺。
- 最后 1 章为“结论与评审建议”或“风险、待确认事项与评审建议”，总结前文、列风险和待确认项，不引入新方案。
- 章节标题必须具体，不能只写“数据设计”“技术架构”。例如“数据库设计：8 张核心表字段、索引与分区”“技术架构与具体技术选型”“接口、报文与任务状态流转”。
- sections 数组只写 heading，不写正文。
- 对设计类文档，优先采用以下 9 章骨架（可按内容合并，但不得把同一主题拆成两个并列章节）：
  1. 总体设计概览
  2. 系统定位与边界
  3. 总体架构与功能模块
  4. 技术架构与具体技术选型
  5. 部署架构与高可用设计
  6. 关键机制：任务状态机、接口时序、幂等与告警
  7. 数据架构与数据流
  8. 数据库设计（含完整数据字典：8 张核心表字段、索引、ER 关系）
  9. 风险、待确认事项与评审结论
- 数据库设计与完整数据字典必须合并为一章；接口/报文/状态机不要另起并列章节；不要出现两个数据库/数据字典章节或两个接口章节。
- open_issues 只列项目设计/实施决策，不要列 Word/PDF 交付格式、图片数量、图号、附录索引；如果对话已经展开完整数据字典字段，不要再把“补齐数据字典”列为待确认事项。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：
{
  "title": "文档标题",
  "document_type": "概要设计/评审材料/方案/报告/执行计划/复盘等",
  "audience": "读者",
  "objective": "文档要解决的问题",
  "core_message": "一句话核心结论",
  "sections": [{"heading": "具体章节标题"}],
  "key_facts": [],
  "open_issues": []
}
sections 只写 9 个左右的标题，不要写 purpose、points 或正文；key_facts 只在有必须保留的关键数字/表名时填写，open_issues 没有就留空。整个 JSON 控制在 500 tokens 以内，优先保证 sections 完整闭合。

【会话主题】
${clipText(chat.title || '未命名对话', 120)}

【对话纲要】
${transcript || '（没有文字记录）'}`;
}

export function buildDocumentPlanMessages({ chat, transcript }) {
  return [
    {
      role: 'system',
      content:
        '你是资深解决方案架构师和评审材料策划。先完成素材取舍与结构规划，只输出一个合法 JSON 对象，不要输出正文、Markdown 代码块或额外解释。',
    },
    {
      role: 'user',
      content: buildDocumentPlanPrompt({ chat, transcript }),
    },
  ];
}

export function buildDocumentImagePlanPrompt({ chat, images, plan }) {
  const outline = (plan?.sections || [])
    .map((section, index) => `${index + 1}. ${section.heading}`)
    .join('\n');
  return `你是终稿配图编辑。只为下面这份文档从候选图片中选择最终要进入文档的图片，不写正文。

【文档】
标题：${plan?.title || chat?.title || '文档'}
${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}章节：
${outline || '（未提供章节）'}

【图片选择规则】
1. 只能选择候选清单中的 image_id，禁止编造。
2. 候选按生成时间排列。同一主题存在多个版本时，只选最后生成、最新的一版；后出现的修订版优先。
3. 结合“生成前用户要求”判断：如果用户先要求画技术架构图，后指出“具体技术实现没有”，必须选后一张填实技术选型/具体组件的版本，不能选之前的通用分层版。
4. 系统架构、技术架构、数据架构、数据流、ER 图、部署图、状态机、时序图、报文图是不同主题，不要互相替代。ER 图放数据库章节，技术架构图放技术架构章节，部署图放部署章节，状态机/时序/报文图放接口或流程章节。
5. 部署架构图必须是“中心机房 / 边缘节点 / 设备网与现场总线”的分区部署图；多库区网络拓扑不能替代部署架构图，二者可以同时选。
6. 只选最终交付用图，不选被用户否定、被后续修订替代、仅用于比较的试验稿。通常选 4–12 张，最多 12 张；没有合适图片就用空数组。
7. 设计类文档只要候选中有对应主题，至少覆盖：系统架构图、最新技术架构图、数据架构/数据流图、数据库 ER 图、部署架构图；状态机、接口时序、报文格式图按需选择。告警、容灾、多库区拓扑等细节图不要挤掉上述重点图。
8. 图注写这张终稿图在文档中的作用（8–30 字），不要写“第几次尝试”，也不要给旧图安上不属于它的标题。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：
{"final_images":[{"image_id":"候选清单中的 ID","caption":"8–30 字终稿图注","role":"这张图在文档中的作用","section":1}]}

【候选图片（按时间顺序）】
${formatImageCatalog(images)}`;
}

export function buildDocumentImagePlanMessages({ chat, images, plan }) {
  return [
    {
      role: 'system',
      content:
        '你是终稿配图编辑。只从候选图片中选择最终交付图片，只输出合法 JSON，不要输出正文、代码块或解释。',
    },
    {
      role: 'user',
      content: buildDocumentImagePlanPrompt({ chat, images, plan }),
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

function selectPlanImages(requested, images, sections) {
  const byId = new Map((images || []).map((image) => [image.id, image]));
  const selected = [];
  for (const item of Array.isArray(requested) ? requested : []) {
    const id = String(typeof item === 'string' ? item : item?.image_id || '').trim();
    const image = byId.get(id);
    if (!image || selected.some((entry) => entry.id === id)) continue;
    const sectionNumber = Math.trunc(Number(item?.section));
    selected.push({
      ...image,
      caption: planString(item?.caption || image.caption || image.prompt || '创作图片', 80),
      role: planString(item?.role, 80),
      section: sectionNumber > 0 ? sectionNumber : 0,
    });
    if (selected.length >= 12) break;
  }
  for (const image of selected) {
    if (image.section > sections.length) image.section = 0;
  }
  return selected;
}

export function parseDocumentPlan(value, images = []) {
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
    .filter((section) => section.heading)
    .slice(0, 10);
  const selected = selectPlanImages(parsed.final_images, images, sections);

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

export function parseDocumentImagePlan(value, images, sections = []) {
  const parsed = parsePlanObject(value);
  if (!parsed) return null;
  return selectPlanImages(parsed.final_images || parsed.images, images, sections);
}

function formatPlanForPrompt(plan) {
  return JSON.stringify(
    {
      title: plan.title,
      document_type: plan.documentType,
      audience: plan.audience,
      objective: plan.objective,
      core_message: plan.coreMessage,
      sections: plan.sections,
      key_facts: plan.keyFacts,
      open_issues: plan.openIssues,
    },
    null,
    2,
  );
}

export function buildDocumentPrompt({ chat, images, transcript, plan }) {
  const catalog = formatImageCatalog(images);
  const planBlock = plan
    ? `\n【已确定的终稿策划（必须遵循）】\n${formatPlanForPrompt(plan)}\n`
    : '';

  return `请把下面这段图片创作对话写成一份可以直接提交评审或交付的中文终稿文档。

【交付标准：只写终稿】
1. 这份文档不是聊天记录，也不是草稿。不要出现“本轮”“接着改”“再试一次”等过程性叙述。
2. 只采用已经确认或最终采用的方案、结论、数据和图片；过程稿、被否方案、旧版本、重复尝试、废弃图片不得写入。如果必须说明取舍，只写最终决策及其理由。
3. 对话前后矛盾时，以最后一次明确决定为准；不要编造对话中没有的事实、数字、名称或图片。无法确认的事项只能放进“待确认”或“风险”并明确标注。
4. 文档要能让未参与对话的读者独立看懂：背景、目标、方案、依据、最终交付、风险和下一步要完整。

【动笔前检查】
先内部确认：文档类型、读者、使用场景、要回答的问题、核心结论、章节逻辑和素材取舍；检查通过后再写。分析过程不要输出。

【结构与内容】
1. 标题简洁、有主题感；开头写一段导语，交代背景、目的和最终结论。
2. 正文用 4–7 个二级章节，按“背景/目标 → 方案与分析 → 关键决策与依据 → 最终成果/交付 → 风险与下一步”组织；根据文档类型调整，不要机械套模板。
3. 每章 2–4 段，关键结论写清依据、影响和行动；避免空话、重复和只列口号。
4. 全文术语、数字、名称、时间范围保持一致；每个结论都能在前文找到依据，前后不矛盾。
5. 用户明确指定文档类型时，按该类文档的规范写；未指定时，按最适合评审/交付的结构写。

【图片】
1. 只能使用下方清单中的终稿图片，每张最多引用一次；没有合适图片可以不配图。
2. 图片必须放在相关结论之后，图注 8–30 字，说明这张终稿图证明了什么或交付了什么；不要写“第几次尝试”。
3. 清单外的 image_id 一律不得引用；不要为了凑数把同组变体全部写入。

【输出前自检】
删除聊天口吻、过程稿和未定稿表述；确认没有引用清单外图片；确认章节逻辑递进、结论与数据前后一致。只保留自检后的终稿。

【格式】
用 Markdown 输出：一级标题用 #，二级标题用 ##，段落直接写，列表用 -。不要用表格、代码块、分隔线。直接输出文档正文，不要前言、不要解释，也不要用 \`\`\` 包裹。
${planBlock}
【会话主题】
${clipText(chat.title || '未命名对话', 120)}

【可引用的终稿图片】
${catalog}

【对话记录】
${transcript || '（没有文字记录）'}`;
}

export function buildDocumentMessages({ chat, images, transcript, plan }) {
  return [
    {
      role: 'system',
      content:
        '你是资深内容策划、评审材料编辑和交付文档撰写人。写作前先完成内部结构与素材校验；只输出可直接评审的终稿 Markdown，不输出分析、聊天记录或额外解释。',
    },
    {
      role: 'user',
      content: buildDocumentPrompt({ chat, images, transcript, plan }),
    },
  ];
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

export function buildDocumentIntroMessages({ chat, plan, transcript }) {
  const title = plan?.title || chat?.title || '文档';
  const facts = planFacts(plan);
  return [
    {
      role: 'system',
      content:
        '你是资深评审材料编辑。只写文档导语，不写标题、章节标题、正文其他章节、分析或解释。',
    },
    {
      role: 'user',
      content: `请为下面这份文档写 1–2 段导语。

文档标题：${title}
${plan?.documentType ? `文档类型：${plan.documentType}\n` : ''}${plan?.audience ? `读者：${plan.audience}\n` : ''}${plan?.objective ? `目标：${plan.objective}\n` : ''}${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}
要求：中文，Markdown 裸段落，不要用标题、列表、代码块或引号包裹；只概括背景、目的和最终结论，不要写章节内容，不要重复标题，不要编造事实。不要提及图片数量、图号、附图索引、PDF/Word 转换、生成失败、重试、模型或本次生成过程；不要把早期“待补齐/被截断/未完成”写成待办，以最终已确认状态为准；只写文档本身的背景、目的和最终结论。
${facts ? `${facts}\n` : ''}`,
    },
  ];
}

export function buildDocumentSectionMessages({
  chat,
  plan,
  section,
  index,
  total,
  images,
  transcript,
}) {
  const title = plan?.title || chat?.title || '文档';
  const displayHeading = `${index + 1}. ${section.heading}`;
  const outline = (plan?.sections || [])
    .map((item, position) => `${position + 1}. ${item.heading}`)
    .join('\n');
  const catalog = formatImageCatalog(images);
  const facts = planFacts(plan);
  const isOverview = index === 0;
  const isConclusion = index === total - 1 && total > 1;
  const roleRules = [
    isOverview
      ? '本章是全文“总”的部分：先写一段总体设计结论，再用一个 Markdown 表格汇总“设计领域 | 关键结论/决策”，覆盖系统定位、系统架构、技术架构、数据与数据库、接口流程、部署；只写摘要，详细内容留给后续章节。'
      : '',
    isConclusion
      ? '本章是全文“总”的部分：总结前文已确定的方案，列出评审结论、主要风险、待确认事项和下一步；不要引入新的架构或方案。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        '你是资深评审材料编辑和解决方案架构师。只写当前章节，输出可直接进入终稿的 Markdown 正文；不要写标题页、导语、其他章节或分析过程。',
    },
    {
      role: 'user',
      content: `请写文档的第 ${index + 1}/${total} 章。

文档标题：${title}
${plan?.documentType ? `文档类型：${plan.documentType}\n` : ''}${plan?.audience ? `读者：${plan.audience}\n` : ''}${plan?.coreMessage ? `核心结论：${plan.coreMessage}\n` : ''}
全文章节（只写当前这一章，不要重复其他章节）：
${outline}

当前章节标题：${displayHeading}
全文已入稿图片：${plan?.images?.length || 0} 张；本章可引用图片：${images.length} 张。
要求：
1. 以 \`## ${displayHeading}\` 开头，正文长度按内容需要，不要为了控制篇幅删掉用户明确要求的细节。
2. 只采用最终确认的事实、结论、表结构、字段和数据，剔除过程稿、被否方案、重复尝试；绝不写生成失败、重试、格式转换、PDF/Word 转换、图片数量、图号、附图索引、工具限制等过程信息。
3. 如果本章涉及数据库、数据字典、表结构或字段设计：必须逐表完整输出表名、用途、主键、字段（字段名/类型/长度/必填/默认/说明）、索引和分区；使用 Markdown 表格，每张表一个小标题（### ${index + 1}.1、### ${index + 1}.2……）；对话中已经给出的字段必须全部保留，不能只写“已补齐 N 张表”或只写表名；对话没有给出的字段不要编造，可标注“待确认”。
4. 如果本章涉及技术架构：必须采用对话中最后一版、包含具体技术实现和组件选型的技术架构图与文字选型；不得使用更早的通用分层版或旧版架构图。
5. 如果本章涉及接口、报文、任务状态或流程：保留接口清单、报文关键字段、状态码、ACK/NACK、超时重试、幂等键和异常分支；不要只写“有接口”或“按状态机流转”。
6. 直接输出 Markdown，不要输出分析、前言、代码块或额外解释；不要在正文里解释写作过程。可以使用 Markdown 表格、列表和三级标题。
7. 图片只能引用本章清单中的 image_id，最多引用 3 张；使用 \`![8–30 字图注](image_id)\` 格式，放在相关结论之后；清单外图片一律不要引用。如果本章清单为空，不要输出图片，也不要声称“全文没有图片”或“本章无图”，直接写正文。
8. 不要在每个章节重复同一组全局待确认事项；只有本章特有的技术选择、风险或待定项才列，全局事项集中到最后 1 章。
9. 除最后 1 章外，绝对不要生成任何标题包含“待确认/待评审/待定/需评审”的小节；本章特有的待定项用一句正文结尾说明即可。
10. 不要将文档交付格式（Word/PDF）、图片数量、图号、附录索引列为风险或待确认事项。
11. 如果对话或前文已经完整给出数据字典字段，不要再把“补齐数据字典/补齐字段/字段清单被截断”列为待确认事项；不要把已经解决的过程状态写成待办。
12. 只写当前章节主题：总体架构章不要展开具体技术选型、部署分区、数据库字段或接口报文；这些细节留给后续专章。各章不要互相抢内容或重复同一套说明。
${roleRules ? `${roleRules}\n` : ''}${facts ? `${facts}\n` : ''}
【本章可引用图片】
${catalog}

【对话事实摘要与本章相关片段】
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

/**
 * Resolves model image references against the approved final-image catalog and
 * drops unknown or duplicate IDs. Unreferenced images are intentionally not
 * appended, so a document never gains unselected variants or process shots.
 */
export function finalizeDocument({ markdown, title, images }) {
  const parsed = parseDocumentMarkdown(markdown);
  const byId = new Map(images.map((image) => [image.id, image]));
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
    blocks.push({ ...block, caption: block.caption || imageCaption(image) });
  }

  return {
    title: parsed.title || title || '文档',
    blocks,
    imageCount: used.size,
  };
}
