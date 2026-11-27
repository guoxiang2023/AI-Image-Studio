import sharp from 'sharp';
import { requestImage } from '../ai/llm.js';
import { IMAGE_TIMEOUT } from '../config.js';
import { recognizeText } from './ocr.js';
import { itemToBuffer } from './image-storage.js';
import { withTimeout } from '../shared/utils.js';

// A designed deck is rasterised page by page: the wording is decided by the
// planner, the picture is drawn by the image model. Text stays authored by us,
// so the only thing that can drift is how faithfully the model lettered it —
// which is exactly what the verification below measures.

const RENDER_ATTEMPTS = 2;
const SLIDE_IMAGE_SIZE = '1536x864';

const LAYOUT_BRIEF = {
  cover: '封面页：大标题居中偏上，标题下方一行副标题或说明，留白充足，不要正文要点。',
  section: '章节过渡页：只有一个大标题，居中偏上，背景干净，不要正文要点。',
  bullets: '内容页：顶部标题，标题下方一条装饰短线，中间是编号要点列表，每行一条，左对齐。',
  image: '图文页：左侧标题与要点列表，右侧配一张与内容相关的写实照片或示意图。',
};

// Units have interchangeable spellings, and OCR picks whichever the font glyphs
// resemble; treating them as distinct rejected correct pages.
//
// ㎡ is the worst case: the fused glyph comes back as m², m2 or mi. A bare "m"
// is deliberately absent — 16.00m is a road width on the same deck, and a
// token-level comparison cannot see the surrounding words that separate the
// two. The prompt asks for 平方米 instead, so that ambiguity never arises.
//
// No trailing \b: it does not match after a CJK character or the ㎡ symbol,
// which left "32000平方米" and "32000㎡" unnormalised.
const AREA_UNIT = /(\d)\s*(?:平方米|平方|平米|㎡|m²|m2|mi|M²|M2)/g;

const UNIT_ALIASES = [
  [AREA_UNIT, '$1㎡'],
  [/亿元/g, '亿元'],
  [/万元/g, '万元'],
  [/[％%]/g, '%'],
];

function canonicalNumber(value) {
  let text = String(value || '').replace(/\s+/g, '');
  for (const [pattern, replacement] of UNIT_ALIASES) text = text.replace(pattern, replacement);
  // Only a comma is a thousands separator here. A dot is a decimal point in
  // Chinese numerals, so treating it as grouping made 1.234亿元 and 1234亿元
  // compare equal — a thousandfold error that a client report cannot afford.
  // Stripping is also limited to well-formed 3-digit groups, so "12,34" stays.
  let previous;
  do {
    previous = text;
    text = text.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  } while (text !== previous);
  return text;
}

// A leading sign is part of the figure: 滞后-6天 and 滞后6天 are different
// claims, and dropping the sign made them compare equal.
const NUMBER_TOKEN =
  /[+-]?\d+(?:[.,]\d+)*\s*(?:%|％|亿元|万元|元|平方米|平方|平米|㎡|m²|m2|mi|m|天|个|层|亩)?/g;

function numericTokens(text) {
  return String(text || '').match(NUMBER_TOKEN) || [];
}

/**
 * Extracts the figures a page must show, in the order the page reads them.
 *
 * Order is the point. A set of numbers cannot tell "计划1.82亿元，实际1.79亿元"
 * from the same two figures swapped, and that swap is a materially false
 * statement in an investment report. Adjacent duplicates collapse because the
 * title and a bullet often quote the same figure, and the model may letter it
 * once.
 */
export function deckSlideFacts(slide) {
  const text = [slide?.title || '', slide?.subtitle || '', ...(slide?.bullets || [])].join('\n');
  const ordered = numericTokens(text).map(canonicalNumber);
  return ordered.filter((value, index) => value !== ordered[index - 1]);
}

function pageText(slide) {
  const lines = [`标题：${slide.title || ''}`];
  // The cover's value proposition lives in `subtitle`; leaving it out asked the
  // model to draw a cover with no subtitle at all.
  if (slide.subtitle) lines.push(`副标题：${slide.subtitle}`);
  for (const bullet of slide.bullets || []) lines.push(`要点：${bullet}`);
  return lines.join('\n');
}

/**
 * Builds the instruction for one page.
 *
 * The text block is passed verbatim and marked as immutable: a model that
 * paraphrases here produces a page whose figures no longer match the report,
 * and that is the failure this whole path is verified against.
 */
export function buildSlideImagePrompt(slide, { accent = '蓝色', style = '' } = {}) {
  const brief = LAYOUT_BRIEF[slide?.layout] || LAYOUT_BRIEF.bullets;
  return [
    '生成一张 16:9 的中文商务汇报幻灯片，设计铺满画布，直接作为成品页面使用。',
    `版式要求：${brief}`,
    '',
    '页面上必须逐字出现的文字（不得改写、不得增删、不得翻译）：',
    pageText(slide),
    '',
    `设计规范：白底，深灰正文，${accent}作为唯一强调色；字体为思源黑体或等价中文无衬线体；`,
    '标题加粗，字号明显大于正文；要点之间留有均匀间距；四周留出安全边距。',
    '不要添加页码、公司 logo、水印，也不要出现上述文字之外的任何文字。',
    '单位写法：面积一律写成「平方米」，不要用 ㎡ 这类合体符号（容易识别错误）；金额写成「亿元」「万元」。',
    style ? `风格：${style}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Compares what OCR read back against the figures the page was asked to show.
 *
 * Only numbers are checked: an image model may reflow or slightly reword a
 * bullet, and that is acceptable on a slide, but a wrong figure is a false
 * statement in a client report.
 *
 * Three properties are enforced, each from a real failure:
 *  - whole tokens, because "6天" occurs inside "16天";
 *  - signs, because 滞后-6天 is not 滞后6天;
 *  - reading order, because a set cannot see 计划/实际 swapped, and swapping two
 *    investment figures is exactly the error a client would act on.
 *
 * Order is matched as a greedy subsequence: every expected figure must appear,
 * in sequence. Extra tokens are tolerated — OCR repeats lines and splits glyphs,
 * and a stray repeat is not a wrong claim.
 */
export function verifySlideText(ocrText, facts) {
  const expected = facts.map(canonicalNumber);
  const seen = numericTokens(ocrText).map(canonicalNumber);

  const missing = expected.filter((fact) => !seen.includes(fact));
  if (missing.length) return { ok: false, missing, outOfOrder: false };

  let cursor = 0;
  const order = [];
  for (const fact of expected) {
    while (cursor < seen.length && seen[cursor] !== fact) cursor += 1;
    if (cursor >= seen.length) {
      // Every figure is present but not in the authored order.
      return { ok: false, missing: [], outOfOrder: true };
    }
    order.push(fact);
    cursor += 1;
  }
  return { ok: true, missing: [], outOfOrder: false };
}

async function renderOnePage(ctx, slide, options, { signal } = {}) {
  const prompt = buildSlideImagePrompt(slide, options);
  const facts = deckSlideFacts(slide);
  let lastProblem = null;

  for (let attempt = 1; attempt <= RENDER_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('已取消');
    const { data } = await requestImage(
      ctx.models.image,
      '/images/generations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.models.image.apiKey}`,
        },
        body: JSON.stringify({
          model: ctx.models.image.model,
          prompt,
          size: SLIDE_IMAGE_SIZE,
          n: 1,
          quality: options.quality,
        }),
      },
      withTimeout(signal, IMAGE_TIMEOUT),
    );

    let image;
    try {
      const buffer = await itemToBuffer(data[0], signal);
      const { format, width, height } = await sharp(buffer).metadata();
      if (!width || !height || (format !== 'png' && format !== 'jpeg')) {
        throw new Error('视觉稿图片必须是有效的 PNG 或 JPEG');
      }
      image = { buffer, width, height };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastProblem = err;
      continue;
    }
    if (image.width * 9 !== image.height * 16) {
      throw new Error(`视觉稿要求 16:9，图片模型返回了 ${image.width}×${image.height}`);
    }

    // No figures to check means nothing to verify; the page is as good as the
    // model's lettering, which the caller renders for a human to look at.
    if (!facts.length) return { ...image, verified: true, missing: [] };

    let read = '';
    try {
      const { text } = await recognizeText(image.buffer);
      read = text || '';
    } catch {
      // Fail closed: an unreadable page is an unverified page. Returning the
      // bitmap here would put text nobody checked in front of a client, and a
      // single wrong figure is the failure this whole path exists to prevent.
      lastProblem = new Error('无法校验页面文字（OCR 不可用）');
      continue;
    }

    const check = verifySlideText(read, facts);
    if (check.ok) return { ...image, verified: true, missing: [] };
    lastProblem = new Error(`数字与原文不一致：缺 ${check.missing.join('、')}`);
  }

  // Every attempt failed verification. Reporting the failure lets the caller
  // fall back to the editable page instead of embedding an unchecked image.
  throw lastProblem || new Error('幻灯片渲染失败');
}

export function needsImageRenderer(ctx) {
  return Boolean(ctx?.models?.image?.apiKey && ctx?.models?.image?.model);
}

/**
 * Renders every page of a planned deck to an image and returns them in order.
 *
 * Pages are rendered sequentially: the provider rate-limits bursts, and a
 * failed page must not take the whole deck with it. A page that never verifies
 * is reported so the caller can fall back to the editable deck for that page
 * instead of shipping a page with a wrong figure.
 */
export async function renderDeckImages(ctx, plan, { signal, quality = 'high', style = '', accent } = {}) {
  const slides = plan?.slides || [];
  const images = [];
  const failed = [];

  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index];
    if (signal?.aborted) throw new Error('已取消');
    ctx.emit({ type: 'status', text: `正在绘制第 ${index + 1}/${slides.length} 页…` });
    try {
      const rendered = await renderOnePage(
        ctx,
        { ...slide, index: index + 1 },
        { quality, style, accent },
        { signal },
      );
      images.push({ index, ...rendered });
    } catch (err) {
      if (signal?.aborted) throw err;
      failed.push({ index, error: err.message });
      images.push({ index, buffer: null, verified: false, missing: [] });
    }
  }

  return { images, failed };
}
