import { clipText } from '../shared/utils.js';
import { buildTranscript, formatImageCatalog } from './document.js';

// A deck is not a document with different line breaks. Each slide carries one
// claim, so the model is asked for pages rather than chapters: that keeps the
// output inside a slide's capacity instead of compressing paragraphs later.

export const PPTX_MAX_SLIDES = 16;
export const PPTX_MIN_SLIDES = 5;
export const PPTX_BULLET_LIMIT = 5;
export const PPTX_BULLET_CHARS = 90;

const LAYOUTS = new Set(['cover', 'section', 'bullets', 'image']);

function planString(value, limit) {
  return clipText(String(value || '').trim(), limit);
}

function textList(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => planString(item, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

export function buildPptxPrompt({ chat, transcript, targetSlides = 10, images = [] }) {
  return `你是资深方案汇报设计师，正在把一次对话整理成可以直接讲的演示文稿（PPT）。你的任务不是缩写文章，而是重新组织成"一页一个观点"的页面序列。

【核心要求】
- 每一页只承载一个论点。标题是这一页的结论，不是栏目名；要点是这个结论的证据或拆解。
- 不要照搬长文段落。长句改写成短句，每条要点控制在 40 字以内，一页 3-5 条。
- 只写最终结论和已确认的事实。生成失败、重试、被否方案、工具限制、写作过程绝不写进任何一页。
- 数字、表名、接口名、版本号等关键事实必须保留原样，不要四舍五入或改写。

【页面结构】
- 第 1 页固定为封面：title 是演示主题，subtitle 是一句话价值主张或范围说明。
- 需要分章时用 section 页过渡，section 页只有 title，不要要点。
- 中间为主题页，用 bullets；有配图依据时用 image。
- 最后 1 页是结论/下一步：给出明确行动项或决策请求，不要引入新内容。
- 结论页必须比前面的决策项更进一步：写清谁在什么时点做什么判断、不做的后果，不能把上一页的决策项换个说法再列一遍。若前面的页面已经把决策项列全，最后一页就合并进那一页，不要为凑页数重复。
- 总页数约 ${targetSlides} 页（${PPTX_MIN_SLIDES}-${PPTX_MAX_SLIDES} 页之间）。宁可少而清楚，不要多而重复。
- 同一个主题不要拆成两页；不要出现两页讲同一件事。

【layout 取值】
- cover：封面，必须有 title，可选 subtitle。
- section：章节过渡页，只有 title。
- bullets：要点页，title + bullets（3-5 条）。
- image：图文页，title + bullets（2-4 条），image_id 指向对话中已有的图片。

【输出要求】
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：
{
  "title": "演示标题",
  "subtitle": "一句话说明",
  "slides": [
    {"layout": "cover", "title": "季度复盘", "subtitle": "2026 Q4 · 产品与技术"},
    {"layout": "section", "title": "关键进展"},
    {"layout": "bullets", "title": "工作目录让分析不再靠粘贴", "bullets": ["绑定目录后按需读取", "符号链接与凭据文件自动跳过"]},
    {"layout": "image", "title": "整体架构", "bullets": ["前端 Vue3", "后端 Node"], "image_id": "abc123"}
  ]
}
- title 控制在 24 字以内；每条 bullets 控制在 40 字以内。
- image_id 只能使用下面图片清单里出现过的 id；没有合适的图就不要用 image 版式。清单是唯一可信来源，不要编造 id。
- 整个 JSON 控制在 1200 tokens 以内。

【会话主题】
${clipText(chat?.title || '未命名对话', 120)}

【可用图片清单】
${formatImageCatalog(images)}

【对话内容】
${transcript || '（没有文字记录）'}`;
}

export function buildPptxMessages({ chat, transcript, targetSlides, images = [] }) {
  return [
    {
      role: 'system',
      content:
        '你是资深方案汇报设计师。只输出一个 JSON 对象，不要 Markdown 代码块、不要解释、不要前后缀。',
    },
    { role: 'user', content: buildPptxPrompt({ chat, transcript, targetSlides, images }) },
  ];
}

/**
 * Builds the prompt's image catalog from the curated candidate set. Hidden,
 * superseded and missing images never reach the model, so it cannot pick an
 * image that the document pipeline already excluded.
 */
export function pptxImageCatalog(candidates = []) {
  return candidates.map((image, index) => ({ ...image, index: index + 1 }));
}

function parseObject(value) {
  const raw = String(value || '').replace(/^\uFEFF/, '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  const text = fenced ? fenced[1].trim() : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Normalizes one raw slide. Anything that cannot be rendered as a page is
 * dropped rather than turned into an empty slide, and the layout is forced to
 * a template that actually accepts the content it carries.
 */
export function normalizeSlide(raw, imageIds) {
  const layout = LAYOUTS.has(raw?.layout) ? raw.layout : 'bullets';
  const title = planString(raw?.title, 60);
  const bullets = textList(raw?.bullets, PPTX_BULLET_LIMIT, PPTX_BULLET_CHARS);
  const subtitle = planString(raw?.subtitle, 90);
  const imageId = typeof raw?.image_id === 'string' && imageIds?.has(raw.image_id) ? raw.image_id : null;

  if (!title && !bullets.length) return null;

  if (layout === 'cover') {
    return { layout: 'cover', title: title || '演示文稿', subtitle };
  }
  if (layout === 'section') {
    return title ? { layout: 'section', title } : null;
  }
  if (layout === 'image' && imageId) {
    return {
      layout: 'image',
      title: title || '图示',
      bullets: bullets.slice(0, 4),
      imageId,
    };
  }
  // Bullets are what the model most often gets right; fall back to them when a
  // page asked for an image that does not exist.
  return bullets.length
    ? { layout: 'bullets', title: title || '要点', bullets }
    : title
      ? { layout: 'section', title }
      : null;
}

/**
 * Parses the model's deck JSON into renderable slides. Returns null when there
 * is nothing usable, so the caller can fall back instead of shipping a stub.
 */
export function parsePptxPlan(value, { imageIds = new Set(), maxSlides = PPTX_MAX_SLIDES } = {}) {
  const parsed = parseObject(value);
  if (!parsed) return null;

  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : [];
  const slides = dedupeSlides(
    rawSlides.map((slide) => normalizeSlide(slide, imageIds)).filter(Boolean),
  ).slice(0, maxSlides);

  if (!slides.length) return null;

  // A deck needs an opening page; insert one if the model started mid-thought.
  if (slides[0].layout !== 'cover') {
    slides.unshift({
      layout: 'cover',
      title: planString(parsed.title, 60) || slides[0].title || '演示文稿',
      subtitle: planString(parsed.subtitle, 90),
    });
  }

  return {
    title: planString(parsed.title, 60) || slides[0].title || '演示文稿',
    slides,
  };
}

/**
 * Recovers the complete slides from a plan the model was cut off while writing.
 *
 * A max_tokens stop leaves valid JSON objects followed by a dangling tail, so
 * JSON.parse fails on the whole string and the entire plan used to be thrown
 * away — even though the first pages were perfectly good. Scanning for balanced
 * objects at slide depth keeps those pages.
 */
export function salvagePptxPlan(value, { imageIds = new Set(), maxSlides = PPTX_MAX_SLIDES } = {}) {
  const text = String(value || '');
  const start = text.indexOf('[');
  if (start < 0) return null;

  const slides = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          const raw = JSON.parse(text.slice(objectStart, index + 1));
          slides.push(normalizeSlide(raw, imageIds));
        } catch {
          // A malformed object is skipped; the next balanced one may still parse.
        }
        objectStart = -1;
        if (slides.length >= maxSlides) break;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }

  const usable = dedupeSlides(slides.filter(Boolean)).slice(0, maxSlides);
  // A run of cover/section pages carries no claim at all. Salvaging that would
  // produce a deck of empty dividers, which is worse than the deterministic
  // fallback, so require at least one page with substance.
  const hasContent = usable.some(
    (slide) => slide.layout === 'bullets' || slide.layout === 'image',
  );
  if (usable.length < 2 || !hasContent) return null;

  if (usable[0].layout !== 'cover') {
    usable.unshift({ layout: 'cover', title: usable[0].title || '演示文稿', subtitle: '' });
  }
  return { title: usable[0].title || '演示文稿', slides: usable, salvaged: true };
}

/**
 * Drops a page whose content repeats an earlier one.
 *
 * A model asked for "next steps" often restates the decision page it just
 * wrote, producing two slides with identical bullets. That reads as padding in
 * front of a client, and the duplicate carries no new claim.
 */
const COVERAGE_SIMILARITY = 0.7;

function bulletKey(text) {
  // Compare content, not phrasing: models restate a decision list with a
  // different lead-in ("请甲方…", "决策事项：…") between pages.
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[：:，,。.、；;（）()]/g, '')
    .replace(/^(?:请甲方|决策事项|下一步|后果)[：:]?/, '');
}

function bigrams(text) {
  const chars = [...bulletKey(text)];
  const set = new Set();
  if (chars.length < 2) {
    if (chars.length) set.add(chars[0]);
    return set;
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    set.add(chars[index] + chars[index + 1]);
  }
  return set;
}

// Digits carry the claim: 2026 vs 2027, 1.45 vs 2.45 亿元, 98.4% vs 89.4%.
// Two bullets that differ in any number are different facts, however similar
// the surrounding prose is, so they can never be treated as restatements.
const NUMBER_RE = /\d+(?:\.\d+)?/g;

// Status words invert or qualify a claim far more than they change its shape:
// "已封顶" vs "计划封顶" is the difference between done and planned.
const STATUS_WORDS = [
  '完成', '未完成', '已', '未', '计划', '拟', '预计', '在建', '封顶', '开工', '竣工',
  '延期', '滞后', '超期', '达成', '未达成', '通过', '未通过', '取消', '暂停',
];

function numbers(text) {
  return (String(text || '').match(NUMBER_RE) || []).map((value) => String(Number(value)));
}

function statuses(text) {
  const value = String(text || '');
  return STATUS_WORDS.filter((word) => value.includes(word)).sort();
}

/**
 * True when two bullets assert the same fact, not merely similar prose.
 *
 * The bigram score alone is too coarse to decide deletions: "2026年完成一期
 * 设备安装" and "2027年完成一期设备安装" score above 0.9. Numbers and status
 * words are compared exactly first, because losing a page that says 2.45 亿元
 * after a page that says 1.45 亿元 turns a report into a false statement.
 */
function sameFact(a, b) {
  const leftNumbers = numbers(a);
  const rightNumbers = numbers(b);
  if (leftNumbers.join(',') !== rightNumbers.join(',')) return false;
  const leftStatus = statuses(a);
  const rightStatus = statuses(b);
  if (leftStatus.join(',') !== rightStatus.join(',')) return false;
  return dice(bigrams(a), bigrams(b)) >= COVERAGE_SIMILARITY;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Removes pages, and bullets, that only restate what an earlier page said.
 *
 * An exact-match check is not enough: asked for a closing "next steps" page, a
 * model routinely re-lists the decision items with a new lead-in. Restated
 * bullets therefore count as already-said. A page that is mostly a re-list
 * keeps only its new bullets instead of being dropped wholesale, so a genuine
 * new claim is never lost to the cleanup. A page that is mostly new is left
 * alone — repeating a figure there is continuity, not padding.
 */
export function dedupeSlides(slides = []) {
  const seen = new Set();
  const seenBullets = [];
  const kept = [];
  for (const slide of slides) {
    const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
    // Only pages with real body text can be judged duplicates; two section
    // dividers sharing a title are a different (rarer) problem.
    if (!bullets.length) {
      kept.push(slide);
      continue;
    }
    const signature = `${slide.layout}|${bullets.join('\u0000').replace(/\s+/g, '')}`;
    if (seen.has(signature)) continue;

    // A bullet counts as already said only when the earlier one asserts the
    // same fact; similar wording over a different year or amount does not.
    const fresh = bullets.filter(
      (bullet) => !seenBullets.some((previous) => sameFact(bullet, previous)),
    );
    const mostlyRestated = fresh.length * 2 < bullets.length;

    if (mostlyRestated) {
      if (!fresh.length) continue;
      seenBullets.push(...fresh);
      kept.push({ ...slide, bullets: fresh });
      seen.add(signature);
      continue;
    }

    seenBullets.push(...bullets);
    seen.add(signature);
    kept.push(slide);
  }
  return kept;
}

// ---- deterministic fallback -------------------------------------------------

const SECTION_SPLIT = /^(?:第[一二三四五六七八九十\d]+[章节部分]|[一二三四五六七八九十]+[、.]|\d+[.、)])\s*/;
// Lines the fallback must drop: they are the request, not the answer.
const USER_LINE = /^用户[：:]/;

/**
 * Splits conversation text into slide-sized chunks without a model. This is
 * what runs when planning fails: the deck is plain but still says something
 * true, which is better than an error dialog.
 */
export function buildFallbackPptxPlan(chat, { maxSlides = 10 } = {}) {
  const title = clipText(String(chat?.title || '').trim() || '演示文稿', 60);
  const transcript = buildTranscript(chat, 12000);

  const sentences = transcript
    .split(/\n+/)
    // Check the speaker before stripping the label: user turns are requests
    // ("帮我做一份汇报 PPT"), not findings. Once the prefix was removed the
    // filter could no longer tell them apart and the prompt became slide one.
    .filter((line) => !USER_LINE.test(line.trim()))
    .map((line) =>
      line
        .replace(/^(?:助手|Assistant)[：:]\s*/i, '')
        .replace(/^[#>*\-\s]+/, '')
        .trim(),
    )
    .filter((line) => line && !SECTION_SPLIT.test(line) && line.length > 6);

  const bullets = [];
  const seen = new Set();
  for (const sentence of sentences) {
    for (const piece of sentence.split(/[。；;！!？?]/)) {
      const text = piece.trim();
      if (text.length < 6 || text.length > PPTX_BULLET_CHARS) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      bullets.push(text);
      if (bullets.length >= 24) break;
    }
    if (bullets.length >= 24) break;
  }

  const slides = [{ layout: 'cover', title, subtitle: '' }];
  if (!bullets.length) {
    slides.push({
      layout: 'bullets',
      title: '内容概要',
      bullets: ['当前对话没有足够的文字整理成演示文稿'],
    });
    return { title, slides, fallback: true };
  }

  // Three bullets per page: the fallback has no ranking signal, so it errs
  // toward pages that certainly fit rather than dense ones.
  const perSlide = 3;
  for (let index = 0; index < bullets.length; index += perSlide) {
    const chunk = bullets.slice(index, index + perSlide);
    slides.push({
      layout: 'bullets',
      title: index === 0 ? '主要内容' : `主要内容（续 ${index / perSlide + 1}）`,
      bullets: chunk,
    });
    if (slides.length >= maxSlides) break;
  }
  return { title, slides, fallback: true };
}

/** Converts a normalized plan into the media-layer slide shape. */
export function toPptxSlides(plan, imagesById = new Map()) {
  return (plan?.slides || []).map((slide) => {
    if (slide.layout !== 'image') return slide;
    const image = imagesById.get(slide.imageId);
    if (!image) return { ...slide, layout: 'bullets', image: undefined };
    return {
      ...slide,
      image: {
        data: image.data,
        width: image.width,
        height: image.height,
        caption: image.caption || '',
      },
    };
  });
}

/** Reads the pixel size straight out of a PNG header. */
function pngSize(buffer) {
  const data = Buffer.from(buffer || []);
  if (data.length > 24 && data.toString('ascii', 1, 4) === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // The provider may hand back JPEG; the deck only needs a sane box here and
  // the packager measures the real bitmap before placing it.
  return { width: 1536, height: 1024 };
}

/**
 * Turns a plan plus its rendered pages into full-bleed slides.
 *
 * A page with no usable bitmap falls back to its authored layout. That fallback
 * is taken from `fallbackSlides` — the already-resolved slide list — not from
 * the raw plan: an `image` page that fails to render must still carry the
 * picture the planner picked for it, and the raw plan only holds an id.
 */
export function toRasterSlides(plan, rendered = [], fallbackSlides = null) {
  const source = plan?.slides || [];
  return source.map((slide, index) => {
    const page = rendered.find((item) => item.index === index);
    if (!page?.buffer) return fallbackSlides?.[index] || slide;
    const meta = pngSize(page.buffer);
    // A rasterised page shows everything the bitmap contains, so the outline
    // still lists its bullets — the preview is what the user reads to decide
    // whether to open the file, and an empty one reads as a blank page.
    return {
      layout: 'fullbleed',
      title: slide.title || '',
      bullets: Array.isArray(slide.bullets) ? slide.bullets : [],
      image: {
        data: page.buffer,
        width: meta.width,
        height: meta.height,
        caption: slide.title || '',
      },
    };
  });
}

/**
 * A short, human-readable outline used by the client preview.
 *
 * A full-bleed page has no text frames in the file, but it still has an
 * outline: the bullets are in the rendered bitmap. Reporting them keeps the
 * in-app preview readable instead of showing a titled blank page.
 */
export function pptxPreview(plan) {
  return (plan?.slides || []).map((slide, index) => ({
    index: index + 1,
    layout: slide.layout,
    title: slide.title || '',
    bullets: slide.bullets || [],
    imageId: slide.imageId || null,
  }));
}