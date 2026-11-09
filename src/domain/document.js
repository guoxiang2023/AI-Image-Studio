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
  for (const message of chat?.messages || []) {
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

export function buildTranscript(chat, maxChars = 18000) {
  const summary = String(chat?.summary || '').trim();
  const summaryLine = summary ? `【较早对话摘要】\n${clipText(summary, 4000)}` : '';
  const start = summary ? Math.max(0, chat?.summaryUpto || 0) : 0;
  const lines = [];

  for (const message of (chat?.messages || []).slice(start)) {
    if (message.role === 'user') {
      let line = `用户：${clipText(message.content, 1600) || '（仅上传了素材）'}`;
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
      let line = `助手：${clipText(message.content, 1600)}`;
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
      return `- image_id=${image.id} | 第 ${image.index} 张 | ${
        image.aspectRatio || image.size || '画幅未知'
      } | 画面/提示：${clipText(image.prompt || image.caption, 140)}${
        flags.length ? ` | ${flags.join(' | ')}` : ''
      }`;
    })
    .join('\n');
}

export function buildDocumentPlanPrompt({ chat, images, transcript }) {
  return `你是资深内容策划和评审材料编辑。请先分析下面的创作对话，为文档制定一份可直接执行的终稿策划，但不要写正文。

【策划目标】
- 判断用户真正需要的文档类型、读者、使用场景和评审目的。
- 提炼最终结论、关键事实和需要保留的决策依据；剔除过程稿、被否方案、重复尝试和过时信息。
- 只从“候选终稿图片”中选择真正要进入文档的图片；被用户移除、替换、否定的图片不得入选。
- 设计详细、完整、逻辑自洽的章节结构，确保文档可以直接提交评审。

【图片选择规则】
1. 只能选择下方候选清单中的 image_id，禁止编造。
2. 只选终稿图片：优先用户明确认可、最终采用、用于最终交付的图片。
3. 被编辑替换的旧版本、同组试验稿、仅用于比较的变体、用户表示不要的图片，不要选。
4. 如果用户没有明确说用哪张，选择最近一轮且未被后续修改替代的终稿；不要为了凑数把同组变体全部选上。
5. 通常选 1–6 张，最多 8 张；没有合适图片就用空数组。
6. 图片必须服务于正文结论；图注写终稿作用，不写“第几次尝试”。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：
{
  "title": "文档标题",
  "document_type": "评审材料/方案/报告/执行计划/复盘等",
  "audience": "读者",
  "objective": "文档要解决的问题",
  "core_message": "一句话核心结论",
  "sections": [
    {"heading": "二级标题", "purpose": "这一章要证明/说明什么", "points": ["要点1", "要点2"]}
  ],
  "final_images": [
    {"image_id": "候选清单中的 ID", "caption": "8–30 字终稿图注", "role": "这张图在文档中的作用"}
  ],
  "key_facts": ["必须准确保留的事实/数字/名称"],
  "open_issues": ["需要评审确认的风险或待定事项，没有就为空数组"]
}
章节 4–6 个，每个 points 2–3 条；每条一句话。必须覆盖背景/目标、方案与依据、最终交付、风险与下一步（按文档类型调整）。
输出要精简：不复述对话、不写正文、不解释字段；整个 JSON 尽量控制在 1500 tokens 以内。

【会话主题】
${clipText(chat.title || '未命名对话', 120)}

【候选终稿图片】
${formatImageCatalog(images)}

【对话记录】
${transcript || '（没有文字记录）'}`;
}

export function buildDocumentPlanMessages({ chat, images, transcript }) {
  return [
    {
      role: 'system',
      content:
        '你是资深内容策划和评审材料编辑。先完成素材取舍与结构规划，只输出一个合法 JSON 对象，不要输出正文、Markdown 代码块或额外解释。',
    },
    {
      role: 'user',
      content: buildDocumentPlanPrompt({ chat, images, transcript }),
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

export function parseDocumentPlan(value, images) {
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

  const byId = new Map(images.map((image) => [image.id, image]));
  const selected = [];
  const requested = Array.isArray(parsed.final_images) ? parsed.final_images : [];
  for (const item of requested) {
    const id = String(typeof item === 'string' ? item : item?.image_id || '').trim();
    const image = byId.get(id);
    if (!image || selected.some((entry) => entry.id === id)) continue;
    selected.push({
      ...image,
      caption: planString(item?.caption || image.caption || image.prompt || '创作图片', 80),
      role: planString(item?.role, 80),
    });
    if (selected.length >= 8) break;
  }

  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((section) => ({
      heading: planString(section?.heading, 120),
      purpose: planString(section?.purpose, 300),
      points: planList(section?.points, 6, 300),
    }))
    .filter((section) => section.heading)
    .slice(0, 8);

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
    keyFacts: planList(parsed.key_facts, 12, 300),
    openIssues: planList(parsed.open_issues, 12, 300),
    images: selected,
  };
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

/**
 * Parses the small Markdown subset requested from the document model. Unknown
 * constructs degrade to paragraphs instead of being dropped.
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

  for (const rawLine of lines) {
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

    if (trimmed.includes('|') && /^\|?[\s:|-]+\|?$/.test(trimmed)) {
      // Markdown table separator: keep the table rows as plain paragraphs.
      continue;
    }

    pushBullets(bullets, blocks);
    bullets = null;
    pushQuote(quote, blocks);
    const tableRow = /^\|(.+)\|$/.exec(trimmed);
    paragraph.push(cleanInline(tableRow ? tableRow[1].split('|').join(' · ') : trimmed));
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
    title: parsed.title || title || 'Luma 文档',
    blocks,
    imageCount: used.size,
  };
}
