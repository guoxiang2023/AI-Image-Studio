import sharp from 'sharp';
import { AppError } from '../shared/errors.js';

const DWG_SIGNATURES = [
  'AC1012', // R13
  'AC1014', // R14
  'AC1015', // 2000
  'AC1018', // 2004
  'AC1021', // 2007
  'AC1024', // 2010
  'AC1027', // 2013
  'AC1032', // 2018
];

const MAX_EDGE = 2048;
const MAX_PIXELS = 40 * 1000 * 1000;

// AutoCAD INSUNITS: the drawing is meaningless without it, because 12000 square
// units is either 1.2 hectares or 7.7 square metres depending on the unit.
const INSUNITS = {
  0: { name: '无单位', toMetre: null },
  1: { name: '英寸', toMetre: 0.0254 },
  2: { name: '英尺', toMetre: 0.3048 },
  4: { name: '毫米', toMetre: 0.001 },
  5: { name: '厘米', toMetre: 0.01 },
  6: { name: '米', toMetre: 1 },
  8: { name: '微英寸', toMetre: 2.54e-8 },
  9: { name: '密尔', toMetre: 2.54e-5 },
  10: { name: '码', toMetre: 0.9144 },
  13: { name: '微米', toMetre: 1e-6 },
  14: { name: '分米', toMetre: 0.1 },
};

// DXF group codes that carry a closed flag on a polyline.
const LW_CLOSED = 0x200;
const POLYLINE_CLOSED = 0x1;

const CJK_FONT =
  'PingFang SC, Hiragino Sans GB, Heiti SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif';

export function isDwgBuffer(buffer) {
  if (!buffer || buffer.length < 6) return false;
  const header = buffer.subarray(0, 6).toString('latin1');
  return DWG_SIGNATURES.some((sig) => header.startsWith(sig));
}

// The package "exports" map points at dist/index.js, whose WASM lookup is
// relative to import.meta.url, so a bare specifier is both correct and
// cwd-independent. Resolving node_modules by hand would break as soon as the
// app is launched from Finder, where the working directory is "/".
let converterPromise = null;

function loadConverter() {
  if (converterPromise) return converterPromise;
  converterPromise = import('dwgdxf').catch(() => {
    throw new AppError(500, 'CAD 解析组件不可用');
  });
  return converterPromise;
}

/**
 * Parse the subset of DXF this module needs: header variables and the entity
 * records in the ENTITIES section, as flat code/value pairs.
 *
 * DXF is a plain text stream of alternating group code / value lines, which is
 * why the MIT converter's output can be read without a full DXF library.
 */
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const header = new Map();
  const entities = [];
  // DXF is a stream of (group code, value) pairs. Only a `0/SECTION` opens a
  // section, so the section name is read from the `2` pair that immediately
  // follows it; that keeps later `2` codes (block names, layer names) from
  // being mistaken for a section switch.
  let section = '';
  let expectingSectionName = false;
  let currentHeader = null;
  let currentEntity = null;

  const closeEntity = () => {
    if (currentEntity) entities.push(currentEntity);
    currentEntity = null;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '0') {
      if (value === 'SECTION') {
        closeEntity();
        section = '';
        currentHeader = null;
        expectingSectionName = true;
        continue;
      }
      if (value === 'ENDSEC') {
        closeEntity();
        section = '';
        currentHeader = null;
        expectingSectionName = false;
        continue;
      }
      if (section === 'ENTITIES') {
        closeEntity();
        currentEntity = { type: value, pairs: [] };
        continue;
      }
      continue;
    }

    if (expectingSectionName && code === '2') {
      section = value;
      expectingSectionName = false;
      continue;
    }

    if (section === 'HEADER') {
      if (code === '9') {
        currentHeader = { name: value, pairs: [] };
        header.set(value, currentHeader);
      } else if (currentHeader) {
        currentHeader.pairs.push([code, value]);
      }
      continue;
    }

    if (section === 'ENTITIES' && currentEntity) {
      currentEntity.pairs.push([code, value]);
    }
  }
  closeEntity();

  return { header, entities };
}

function headerValue(header, name) {
  const entry = header.get(name);
  if (!entry) return null;
  const pair = entry.pairs.find(([code]) => code === '70' || code === '3' || code === '1');
  if (!pair) return null;
  const numeric = Number(pair[1]);
  return Number.isFinite(numeric) && pair[0] === '70' ? numeric : pair[1];
}

// Group codes differ per entity: a polyline stores every vertex as 10/20, but a
// LINE keeps its two ends in 10/20 and 11/21, and TEXT/INSERT/DIMENSION carry a
// single insertion point. Reading only 10/20 leaves every LINE and label with one
// point, which the renderer then discards.
function entityPoints(entity) {
  const points = [];
  let pending = null;
  for (const [code, value] of entity.pairs) {
    if (code === '10') {
      pending = { x: Number(value), y: 0, bulge: 0 };
      points.push(pending);
    } else if (code === '11') {
      // Second endpoint of a LINE; anything else has no 11.
      if (entity.type === 'LINE') {
        pending = { x: Number(value), y: 0, bulge: 0 };
        points.push(pending);
      }
    } else if (code === '20' || code === '21') {
      if (pending) pending.y = Number(value);
    } else if (code === '42' && pending) {
      pending.bulge = Number(value) || 0;
    }
  }
  return points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function entityFlag(entity) {
  const pair = entity.pairs.find(([code]) => code === '70');
  return pair ? Number(pair[1]) : 0;
}

// A closed polyline is the parcel outline in every site plan; its shoelace area
// and edge lengths are the numbers a designer needs.
function polygonShape(points, { closed = false, curved = false } = {}) {
  if (!closed || curved) return null;
  if (points.length < 3) return null;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const area = Math.abs(twiceArea / 2);
  if (!area) return null;
  const edges = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    perimeter += length;
    edges.push(length);
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    area,
    perimeter,
    edges,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

export function analyzeEntities(entities) {
  const counts = new Map();
  const outlines = [];
  for (const entity of entities) {
    const type = String(entity.type || 'UNKNOWN');
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type !== 'LWPOLYLINE' && type !== 'POLYLINE') continue;
    const points = entityPoints(entity);
    const flag = entityFlag(entity);
    const shape = polygonShape(points, {
      closed:
        type === 'LWPOLYLINE'
          ? (flag & LW_CLOSED) === LW_CLOSED || (flag & 1) === 1
          : (flag & POLYLINE_CLOSED) === POLYLINE_CLOSED,
      // A bulged segment is an arc: its chord length is not the drawn length,
      // so it cannot be dimensioned as a straight parcel edge.
      curved: points.some((p) => p.bulge !== 0),
    });
    if (shape) outlines.push({ points, ...shape });
  }
  outlines.sort((a, b) => b.area - a.area);
  return {
    counts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    outlines,
    modelEntities: entities.length,
  };
}

function unitInfo(insunits, outline) {
  const code = Number(insunits ?? 0);
  const known = INSUNITS[code];
  const declared = known
    ? { code, ...known, inferred: false }
    : { code, name: `单位代码 ${code}`, toMetre: null, inferred: false };

  if (!outline || !known?.toMetre) return declared;

  const declaredArea = outline.area * known.toMetre ** 2;
  // A site plan that comes out under 100 m2 is almost certainly drawn in a
  // larger unit than the header claims.
  if (declaredArea >= 100) return declared;

  const metre = INSUNITS[6];
  const metreArea = outline.area * metre.toMetre ** 2;
  if (metreArea < 100) return declared;
  return {
    code: 6,
    ...metre,
    inferred: true,
    declaredName: known.name,
    declaredCode: code,
  };
}

function formatArea(areaUnits, unit) {
  if (!unit.toMetre) return `${areaUnits.toFixed(1)} 平方单位`;
  const m2 = areaUnits * unit.toMetre ** 2;
  if (m2 >= 10000) {
    return `${(m2 / 10000).toFixed(2)} 公顷（${Math.round(m2).toLocaleString()} m²）`;
  }
  return `${m2.toFixed(1)} m²`;
}

function formatLength(units, unit) {
  if (!unit.toMetre) return `${units.toFixed(2)} 单位`;
  const m = units * unit.toMetre;
  return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(0)} cm`;
}

/**
 * The annotated sheet may only replace the drawing when the file holds nothing
 * else. A site plan with buildings, roads or annotations would lose all of them,
 * so mixed content keeps the full vector export.
 */
export function sheetBoundary(analysis) {
  const onlyBoundary =
    analysis?.modelEntities === 1 &&
    Array.isArray(analysis.outlines) &&
    analysis.outlines.length === 1;
  return onlyBoundary ? analysis.outlines[0] : null;
}

function dimensionSvg(outline, unit, transform) {
  const parts = [];
  for (let i = 0; i < outline.points.length; i += 1) {
    const a = outline.points[i];
    const b = outline.points[(i + 1) % outline.points.length];
    const length = outline.edges[i];
    if (!length) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const norm = Math.hypot(dx, dy) || 1;
    const offset = Math.max(transform.scale * 2.2, 6);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    const px = transform.x((a.x + b.x) / 2 + (-(dy / norm) * offset) / transform.scale);
    const py = transform.y((a.y + b.y) / 2 + ((dx / norm) * offset) / transform.scale);
    parts.push(
      `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" font-size="11" text-anchor="middle" fill="#1a1a1a" transform="rotate(${angle.toFixed(1)} ${px.toFixed(1)} ${py.toFixed(1)})">${formatLength(length, unit)}</text>`,
    );
  }
  return parts.join('\n');
}

function northArrowSvg(x, y) {
  return `<g transform="translate(${x} ${y})">
    <circle cx="0" cy="0" r="21" fill="none" stroke="#333" stroke-width="1"/>
    <path d="M0,-17 L5.5,8 L0,3.5 L-5.5,8 Z" fill="#333"/>
    <text x="0" y="-25" font-size="11" text-anchor="middle" fill="#333">N</text>
  </g>`;
}

function buildSheetSvg(outline, unit, source) {
  const W = 1600;
  const H = 1200;
  const pad = 90;
  const titleH = 200;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2 - titleH;

  const minX = Math.min(...outline.points.map((p) => p.x));
  const maxX = Math.max(...outline.points.map((p) => p.x));
  const minY = Math.min(...outline.points.map((p) => p.y));
  const maxY = Math.max(...outline.points.map((p) => p.y));
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min(innerW / spanX, innerH / spanY);

  // Model space y grows upward; SVG y grows downward.
  const cx = pad + (innerW - spanX * scale) / 2;
  const cy = pad + (innerH - spanY * scale) / 2;
  const transform = {
    scale,
    x: (v) => cx + (v - minX) * scale,
    y: (v) => cy + (maxY - v) * scale,
  };

  const closed = `${outline.points
    .map((p, i) => `${i ? 'L' : 'M'}${transform.x(p.x).toFixed(2)},${transform.y(p.y).toFixed(2)}`)
    .join(' ')} Z`;

  const rows = [
    ['用地面积', formatArea(outline.area, unit)],
    ['用地周长', formatLength(outline.perimeter, unit)],
    ['外接尺寸', `${formatLength(outline.width, unit)} × ${formatLength(outline.height, unit)}`],
    ['顶点数', `${outline.points.length}`],
    [
      '图纸单位',
      unit.inferred
        ? `${unit.name}（图头写 ${unit.declaredName}，按几何判定为${unit.name}）`
        : `${unit.name}（INSUNITS=${unit.code}）`,
    ],
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#222" stroke-width="2"/>
  <text x="${pad}" y="${pad - 34}" font-size="26" font-family="${CJK_FONT}" fill="#111">${
    source ? `${source} · 用地红线图` : '用地红线图'
  }</text>
  <line x1="${pad}" y1="${pad - 20}" x2="${W - pad}" y2="${pad - 20}" stroke="#999" stroke-width="1"/>
  <path d="${closed}" fill="#f2f6fb" stroke="#0b4f9c" stroke-width="2.4"/>
  ${outline.points
    .map(
      (p) =>
        `<circle cx="${transform.x(p.x).toFixed(1)}" cy="${transform.y(p.y).toFixed(1)}" r="3" fill="#0b4f9c"/>`,
    )
    .join('\n  ')}
  ${dimensionSvg(outline, unit, transform)}
  ${northArrowSvg(W - 90, pad + 10)}
  <line x1="24" y1="${H - titleH - 24}" x2="${W - 24}" y2="${H - titleH - 24}" stroke="#222" stroke-width="1.5"/>
  ${rows
    .map(([label, value], i) => {
      const y = H - titleH + 34 + i * 32;
      return `<text x="${pad}" y="${y}" font-size="16" font-family="${CJK_FONT}" fill="#555">${label}</text>
  <text x="${pad + 130}" y="${y}" font-size="16" font-family="${CJK_FONT}" fill="#111">${value}</text>`;
    })
    .join('\n  ')}
  <text x="${W - pad}" y="${H - titleH + 34}" font-size="13" font-family="${CJK_FONT}" fill="#777" text-anchor="end">面积与尺寸由 CAD 实体计算，非估计值</text>
</svg>`;
}

// Entities that carry no geometry of their own still mark a location. Drawing
// them keeps a plan readable instead of silently dropping its labels and blocks.
const POINT_LIKE = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'INSERT', 'POINT', 'DIMENSION']);

// Fallback picture: plot every entity the file contains so a mixed drawing keeps
// its buildings, roads and annotations instead of collapsing to one outline.
export function buildEntitySvg(entities) {
  const segments = [];
  for (const entity of entities) {
    const points = entityPoints(entity);
    if (points.length < 2) {
      if (entity.type === 'CIRCLE') {
        const pair = (c) => entity.pairs.find(([code]) => code === c)?.[1];
        const cx = Number(pair('10'));
        const cy = Number(pair('20'));
        const r = Number(pair('40'));
        if ([cx, cy, r].every(Number.isFinite) && r > 0) {
          segments.push({ type: 'circle', cx, cy, r });
          continue;
        }
      }
      // A label or block reference is one insertion point: mark it rather than
      // dropping it, so roads and buildings do not vanish from the sheet.
      if (POINT_LIKE.has(entity.type)) {
        const pair = (c) => entity.pairs.find(([code]) => code === c)?.[1];
        const x = Number(pair('10'));
        const y = Number(pair('20'));
        if (Number.isFinite(x) && Number.isFinite(y)) {
          segments.push({ type: 'point', x, y });
        }
      }
      continue;
    }
    segments.push({ type: 'path', points });
  }
  if (!segments.length) return null;

  const xs = [];
  const ys = [];
  for (const seg of segments) {
    if (seg.type === 'circle') {
      xs.push(seg.cx - seg.r, seg.cx + seg.r);
      ys.push(seg.cy - seg.r, seg.cy + seg.r);
    } else if (seg.type === 'point') {
      xs.push(seg.x);
      ys.push(seg.y);
    } else {
      for (const p of seg.points) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const W = 1600;
  const H = 1200;
  const pad = 60;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const cx = pad + ((W - pad * 2) - spanX * scale) / 2;
  const cy = pad + ((H - pad * 2) - spanY * scale) / 2;
  const tx = (v) => cx + (v - minX) * scale;
  const ty = (v) => cy + (maxY - v) * scale;

  const body = segments
    .map((seg) => {
      if (seg.type === 'circle') {
        return `<circle cx="${tx(seg.cx).toFixed(2)}" cy="${ty(seg.cy).toFixed(2)}" r="${(seg.r * scale).toFixed(2)}" fill="none" stroke="#0b4f9c" stroke-width="1.4"/>`;
      }
      if (seg.type === 'point') {
        const r = 2.4;
        return `<circle cx="${tx(seg.x).toFixed(2)}" cy="${ty(seg.y).toFixed(2)}" r="${r}" fill="#0b4f9c" opacity="0.55"/>`;
      }
      const d = seg.points
        .map((p, i) => `${i ? 'L' : 'M'}${tx(p.x).toFixed(2)},${ty(p.y).toFixed(2)}`)
        .join(' ');
      return `<path d="${d}" fill="none" stroke="#0b4f9c" stroke-width="1.4"/>`;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${body}
</svg>`;
}

function describeText(analysis, unit, { sheet }) {
  const total = analysis.counts.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '';
  const parts = [
    sheet
      ? '（该 DWG 是矢量 CAD 图纸，没有可直接读取的文字；已按实体几何绘制成用地红线图，可直接用作参考图）'
      : '（该 DWG 是矢量 CAD 图纸，没有可直接读取的文字；已按原图渲染全部实体，可直接用作参考图）',
    `实体：${analysis.counts.map(([type, n]) => `${type} ${n}`).join('、')}`,
  ];

  if (!sheet) {
    parts.push(`模型空间实体总数：${analysis.modelEntities}`);
    if (analysis.outlines.length) {
      parts.push(
        `其中有 ${analysis.outlines.length} 条闭合多段线，最大一条面积约 ${formatArea(analysis.outlines[0].area, unit)}`,
      );
    }
    return parts.join('\n');
  }

  const main = analysis.outlines[0];
  parts.push(
    unit.inferred
      ? `图纸单位：${unit.name}（图头标 ${unit.declaredName}，但按该单位算面积远小于场地尺度，已按${unit.name}读取）`
      : `图纸单位：${unit.name}`,
  );
  parts.push(
    `用地范围：面积 ${formatArea(main.area, unit)}，周长 ${formatLength(main.perimeter, unit)}，` +
      `外接尺寸 ${formatLength(main.width, unit)} × ${formatLength(main.height, unit)}，${main.points.length} 个顶点`,
  );
  parts.push(`各边长度：${main.edges.map((edge) => formatLength(edge, unit)).join('、')}`);
  return parts.join('\n');
}

async function svgToPng(svg) {
  const png = await sharp(Buffer.from(svg), { density: 144 })
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .png({ palette: true, colors: 128, compressionLevel: 9 })
    .toBuffer();
  return png.length ? png : null;
}

/**
 * Convert a DWG into a reference image plus a text description of the drawing.
 *
 * DWG is a binary proprietary format; the MIT `dwgdxf` converter turns it into
 * text DXF, which is then measured and drawn here. A CAD file is all vectors, so
 * an image model can only see it once it is rasterized.
 */
export async function renderDwg(buffer, { name = '' } = {}) {
  if (!isDwgBuffer(buffer)) {
    throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
  }
  const converter = await loadConverter();

  let dxfText;
  try {
    // convertDwgToDxf initialises the WASM runtime lazily on first use.
    const dxf = await converter.convertDwgToDxf(new Uint8Array(buffer));
    // The converter writes group codes as ASCII; entity data is single-byte, so
    // latin1 preserves every byte for the numeric fields this module reads.
    dxfText = Buffer.from(dxf).toString('latin1');
  } catch (err) {
    const detail = err?.message || '格式无法识别';
    throw new AppError(400, `CAD 文件无法解析：${detail}，请确认文件没有损坏或版本过旧`);
  }

  const { header, entities } = parseDxf(dxfText);
  if (!entities.length) {
    throw new AppError(415, 'CAD 模型空间里没有可渲染的图形');
  }

  const analysis = analyzeEntities(entities);
  const source = String(name || '').replace(/\.[^.]+$/, '').trim();
  const soleBoundary = sheetBoundary(analysis);
  const unit = unitInfo(headerValue(header, '$INSUNITS'), soleBoundary ?? analysis.outlines[0]);

  const svg = soleBoundary
    ? buildSheetSvg(soleBoundary, unit, source)
    : buildEntitySvg(entities);
  if (!svg) throw new AppError(415, 'CAD 图纸渲染失败');

  const png = await svgToPng(svg);
  if (!png) throw new AppError(415, 'CAD 图纸渲染失败');

  const meta = await sharp(png).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height || width * height > MAX_PIXELS) {
    throw new AppError(415, 'CAD 图纸尺寸异常');
  }

  return {
    text: describeText(analysis, unit, { sheet: Boolean(soleBoundary) }),
    kind: 'CAD 图纸',
    width,
    height,
    buffer: png,
    unit: unit.name,
    entities: analysis.counts,
    outlines: soleBoundary
      ? {
          area: soleBoundary.area,
          perimeter: soleBoundary.perimeter,
          width: soleBoundary.width,
          height: soleBoundary.height,
          vertices: soleBoundary.points.length,
          edges: soleBoundary.edges,
        }
      : null,
  };
}