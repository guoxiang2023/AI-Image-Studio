import { AppError } from '../shared/errors.js';
import { buildEntitySvg, isDwgBuffer } from './dwg-image.js';
import sharp from 'sharp';

// A CAD drawing in the workspace panel is read-only: no measurable area sheet,
// no description for the model, just the geometry so you can see what the file
// is. rasterizePagesForOcr-style edge applies — the panel is a few hundred
// pixels wide.
const PREVIEW_EDGE = 1600;
const MAX_PIXELS = 40 * 1000 * 1000;

// Non-graphical DXF sections. Their group codes contain text that would
// otherwise be plotted as stray points, and none of it is geometry.
const SKIP_SECTIONS = new Set(['HEADER', 'TABLES', 'BLOCKS', 'CLASSES', 'OBJECTS']);

/**
 * Reads the ENTITIES section of a DXF file.
 *
 * Mirrors the parser in dwg-image.js but accepts text drawn by any tool rather
 * than only the DXF the bundled converter emits: sections beyond ENTITIES are
 * skipped, and an optional leading BOM or blank line is tolerated.
 */
export function parseDxfEntities(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const entities = [];
  let section = '';
  let expectingName = false;
  let current = null;
  let skipSection = false;

  const close = () => {
    if (current) entities.push(current);
    current = null;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim();
    const value = lines[index + 1].trim();

    if (code === '0') {
      if (value === 'SECTION') {
        close();
        section = '';
        expectingName = true;
        skipSection = false;
        continue;
      }
      if (value === 'ENDSEC') {
        close();
        section = '';
        expectingName = false;
        skipSection = false;
        continue;
      }
      if (section === 'ENTITIES' && !skipSection) {
        close();
        current = { type: value, pairs: [] };
        continue;
      }
      continue;
    }

    if (expectingName && code === '2') {
      section = value.toUpperCase();
      skipSection = SKIP_SECTIONS.has(section);
      expectingName = false;
      continue;
    }

    if (section === 'ENTITIES' && !skipSection && current) current.pairs.push([code, value]);
  }
  close();
  return entities;
}

/**
 * DXF is a text stream of group-code pairs. Its only reliable signature is a
 * `0 / SECTION` marker followed by `2 / <name>`; a file that merely mentions
 * the word DXF must not be treated as a drawing.
 */
export function isDxfBuffer(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1').replace(/^\uFEFF/, '');
  return /(^|\n)[ \t]*0\r?\n[ \t]*SECTION\b/.test(head) &&
    /(^|\n)[ \t]*2\r?\n[ \t]*[A-Z]+\b/.test(head);
}

async function svgToPreview(svg) {
  // Line art compresses badly as JPEG and better as palette PNG; the route
  // declares image/png, so the encoder must actually emit PNG.
  const png = await sharp(Buffer.from(svg), { density: 96, limitInputPixels: MAX_PIXELS })
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (!png.length) throw new AppError(415, 'CAD 图纸渲染失败');
  return png;
}

async function dxfText(buffer, ext) {
  if (ext !== 'dwg') {
    if (!isDxfBuffer(buffer)) {
      throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
    }
    return buffer.toString('latin1');
  }
  if (!isDwgBuffer(buffer)) {
    throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
  }
  const converter = await import('dwgdxf').catch(() => {
    throw new AppError(500, 'CAD 解析组件不可用');
  });
  try {
    // The converter writes group codes as ASCII and entity data single-byte, so
    // latin1 preserves every byte for the numeric fields read here.
    return Buffer.from(await converter.convertDwgToDxf(new Uint8Array(buffer))).toString('latin1');
  } catch (err) {
    throw new AppError(400, `CAD 文件无法解析：${err?.message || '格式无法识别'}，请确认文件没有损坏`);
  }
}

/**
 * Renders a DWG or DXF file to a preview PNG.
 *
 * Returns the same shape as the PDF page path so the route can answer with
 * bytes; `entities` is reported only to explain an empty drawing.
 */
export async function cadPreview(buffer, { ext, name = '' }) {
  const text = await dxfText(buffer, ext);
  const entities = parseDxfEntities(text);
  if (!entities.length) {
    throw new AppError(415, 'CAD 图纸里没有可显示的图形（可能只有图层或图块定义）');
  }
  const svg = buildEntitySvg(entities);
  if (!svg) throw new AppError(415, 'CAD 图纸渲染失败');
  return { buffer: await svgToPreview(svg), mediaType: 'image/png', entities: entities.length, name };
}
