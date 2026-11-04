import { RATIO_SIZE } from '../config.js';
import { normalizeQr, normalizeRefIds } from '../domain/chat-options.js';
import { findImageFile } from '../media/image-storage.js';
import { runTool } from './tools-service.js';
import { loadSettings } from './model-settings-service.js';
import {
  findStyleReference,
  materializeStyleReference,
  publicStyleReferences,
} from '../studio/style-references.js';
import { clamp, clipText, newId } from '../shared/utils.js';
import { AppError } from '../shared/errors.js';

const ASPECTS = new Set(Object.keys(RATIO_SIZE));

function clean(value, max) {
  return clipText(String(value || '').trim(), max).trim();
}

function splitPoints(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 80)).filter(Boolean).slice(0, 8);
  return String(value || '')
    .split(/\r?\n|[；;]/)
    .map((item) => clean(item, 80))
    .filter(Boolean)
    .slice(0, 8);
}

function buildPrompt({ mode, kind, content, style, extra }) {
  const title = clean(content.title, 120);
  if (!title) throw new AppError(400, '请填写主标题');
  const subtitle = clean(content.subtitle, 180);
  const points = splitPoints(content.points);
  const subject = clean(content.subject, 240);
  const cta = clean(content.cta, 60);
  const legal = clean(content.legal, 220);
  const note = clean(extra, 700);

  const lines = [];
  if (mode === 'generate') {
    lines.push(
      `Use Image 1 only as a visual style reference for a new ${kind || 'marketing'} visual.`,
      'Borrow its art direction, illustration or photo treatment, material texture, color palette, lighting, decorative language, and typography mood.',
      'Create a new composition and layout; do not copy the reference subject, exact layout, wording, logos, or product imagery unless explicitly requested below.',
    );
  } else {
    lines.push(
      `Use Image 1 as a layout and art-direction reference for a ${kind || 'marketing'} visual.`,
      'Preserve its composition, spatial layout, typography hierarchy, color palette, lighting, material texture, and decorative language.',
      'Do not preserve or relabel the reference campaign subject. Remove its original product, food, beverage, packaging, people, logos, and branded objects; keep them only when the new content explicitly asks for them.',
      'Replace the central subject with one that fits the new title and supporting content. Do not paste theme icons or new copy onto the old product.',
      'Rebuild the visual with the new content below; replace all original text, logos, and product-specific copy. Do not copy the reference wording.',
    );
  }

  lines.push('', 'Content to render:');
  lines.push(`- Main title: "${title}"`);
  if (subject) lines.push(`- Main visual subject: "${subject}"`);
  if (subtitle) lines.push(`- Subtitle: "${subtitle}"`);
  if (points.length) lines.push(`- Supporting points: ${points.map((p) => `"${p}"`).join(', ')}`);
  if (cta) lines.push(`- Call to action: "${cta}"`);
  if (legal) lines.push(`- Legal/footnote: "${legal}"`);

  lines.push(
    '',
    'Text rules: keep every Chinese character exactly as written above; use sharp, legible, correctly spelled typography; no extra words, watermarks, logos, or invented copy.',
    'Keep the composition breathable and make the main title the strongest visual element.',
    'Fill the entire canvas edge to edge; do not add black bars, letterboxing, frames, or empty borders.',
  );
  if (note) lines.push(`Additional direction: ${note}`);
  if (style?.use) lines.push(`Reference use case: ${style.use}.`);
  if (style?.width && style?.height) {
    lines.push(
      `Target canvas shape: ${style.width}×${style.height} (${(style.width / style.height).toFixed(2)}:1). Match this aspect ratio without letterboxing.`,
    );
  }
  return lines.join('\n');
}

function normalizeAspect(value) {
  const aspect = String(value || '').trim();
  return ASPECTS.has(aspect) ? aspect : null;
}

export function listStyleReferences() {
  return publicStyleReferences();
}

export async function importStyleReference(userId, styleId) {
  const ref = findStyleReference(styleId);
  if (!ref) throw new AppError(404, '参考风格不存在');
  const image = await materializeStyleReference(userId, styleId);
  if (!image) throw new AppError(404, '参考风格不存在');
  return { imageId: image.id, url: image.url, reference: ref };
}

export async function generateStyleMaterial(user, body = {}) {
  const settings = loadSettings(user.id);
  if (!settings.image.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置图片模型 API Key');
  }

  const mode = body.mode === 'generate' ? 'generate' : 'edit';
  const styleId = String(body.styleId || '').trim();
  let referenceImageId = normalizeRefIds(body.referenceImageId)[0] || null;
  let style = styleId ? findStyleReference(styleId) : null;

  if (styleId && !style) throw new AppError(404, '参考风格不存在');
  if (style) {
    const image = await materializeStyleReference(user.id, styleId);
    if (!image) throw new AppError(404, '参考风格不存在');
    referenceImageId = image.id;
  }
  if (!referenceImageId) {
    throw new AppError(400, '请选择参考风格或上传参考图');
  }
  const referenceFile = await findImageFile(user.id, referenceImageId);
  if (!referenceFile) throw new AppError(404, '参考图不存在，请重新上传');
  if (referenceFile.ext === 'svg') {
    throw new AppError(400, '参考图需要是位图，请上传 PNG / JPEG / WebP');
  }

  const content = body.content && typeof body.content === 'object' ? body.content : {};
  const kind = clean(body.kind || style?.category || 'marketing', 40);
  const prompt = buildPrompt({
    mode,
    kind,
    content,
    style,
    extra: body.extra,
  });
  const requestedAspect = normalizeAspect(body.aspectRatio);
  const aspectRatio =
    mode === 'generate'
      ? requestedAspect || style?.defaultAspect || '16:9'
      : requestedAspect || null;
  const count = clamp(Number(body.count) || 1, 1, 4);
  const qr = normalizeQr(body.qr || (body.qrUrl ? { url: body.qrUrl } : null));
  const role = mode === 'generate' ? '风格' : '版式';

  const ctx = {
    user,
    chat: { id: null, lastImageId: referenceImageId },
    models: settings,
    references: [{ id: referenceImageId, role }],
    refIds: [referenceImageId],
    options: {
      aspectRatio,
      quality: settings.image.quality,
      count,
      qr,
    },
    turnId: newId(),
    countBudget: count,
    userText: prompt,
    emit: () => {},
    signal: undefined,
    turnImages: [],
  };

  const args = {
    prompt,
    reference_image_ids: [referenceImageId],
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(mode === 'generate' ? { count } : {}),
  };
  const result = await runTool(mode === 'generate' ? 'generate_image' : 'edit_image', args, ctx);
  if (result?.error) throw new AppError(400, result.error);
  if (!result?.images?.length) throw new Error('图片模型没有返回图片');
  return {
    images: result.images,
    mode,
    role,
    style: style ? { id: style.id, name: style.name } : null,
    prompt,
    aspectRatio,
  };
}
