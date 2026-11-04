import { IMAGE_QUALITIES, RATIO_SIZE, REFERENCE_ROLES } from '../config.js';
import { clamp } from '../shared/utils.js';

export function normalizeRefIds(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const value of list) {
    const id = String(value || '');
    if (!/^[a-f0-9]{16,40}$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 4) break;
  }
  return out;
}

export function normalizeRefRoles(raw, count) {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: count }, (_, index) => {
    const role = String(list[index] || '参考');
    return REFERENCE_ROLES.has(role) ? role : '参考';
  });
}

export function normalizeChatOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const aspectRatio =
    typeof source.aspectRatio === 'string' && RATIO_SIZE[source.aspectRatio]
      ? source.aspectRatio
      : null;
  const countInput = source.count;
  const rawCount =
    countInput === null || countInput === undefined || countInput === ''
      ? NaN
      : Number(countInput);
  const count = Number.isInteger(rawCount) ? clamp(rawCount, 1, 4) : null;
  const quality =
    typeof source.quality === 'string' && IMAGE_QUALITIES.includes(source.quality)
      ? source.quality
      : null;
  return { aspectRatio, count, quality };
}

export function normalizeQr(raw) {
  const source = typeof raw === 'string' ? { url: raw } : raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;
  let url;
  try {
    url = new URL(String(source.url || '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.href.length > 1024) return null;
  const position = ['bottom-right', 'bottom-left', 'bottom-center'].includes(source.position)
    ? source.position
    : 'bottom-right';
  const size = ['small', 'medium', 'large'].includes(source.size) ? source.size : 'medium';
  return { url: url.href, position, size };
}

export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，]/);
  const out = [];
  for (const value of list) {
    const tag = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
    if (!tag || /[\u0000-\u001f]/.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

export function parseTagsJson(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 8) : [];
  } catch {
    return [];
  }
}
