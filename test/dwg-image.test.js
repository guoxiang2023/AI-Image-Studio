import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { analyzeEntities, isDwgBuffer, renderDwg, sheetBoundary } from '../src/media/dwg-image.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The repository must not carry anyone's real drawing: it would ship private
// layer names and surveyed coordinates. The full conversion path is therefore
// exercised only when a local sample is present, and everything that can be
// tested without a binary DWG is built from synthetic group-code pairs.
const LOCAL_SAMPLE = process.env.LUMA_DWG_SAMPLE || path.join(HERE, '..', 'tmp', '园区.DWG');

async function localSample() {
  try {
    await access(LOCAL_SAMPLE);
    return readFile(LOCAL_SAMPLE);
  } catch {
    return null;
  }
}

// DXF group-code pairs, exactly as the parser hands them to the analysis.
function pairs(list) {
  return list.map(([code, value]) => [String(code), String(value)]);
}

function lwpolyline(points, { closed = true, bulge = 0, layer = 'PARCEL' } = {}) {
  const list = [
    [0, 'LWPOLYLINE'],
    [8, layer],
    // 0x200 is the closed bit the converter writes; bit 1 also closes.
    [70, closed ? 0x200 : 0],
  ];
  for (const [x, y] of points) {
    list.push([10, x], [20, y], [40, 0], [41, 0], [42, bulge]);
  }
  return { type: 'LWPOLYLINE', pairs: pairs(list) };
}

function line(x1, y1, x2, y2) {
  return {
    type: 'LINE',
    pairs: pairs([
      [0, 'LINE'],
      [8, 'ROAD'],
      [10, x1],
      [20, y1],
      [11, x2],
      [21, y2],
    ]),
  };
}

function textEntity(content) {
  return { type: 'TEXT', pairs: pairs([[0, 'TEXT'], [1, content]]) };
}

// A 100 x 100 synthetic parcel, deliberately not real survey data.
const SQUARE = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

test('recognizes a DWG by its signature', () => {
  assert.equal(isDwgBuffer(Buffer.from('AC1018xxxx', 'latin1')), true);
  assert.equal(isDwgBuffer(Buffer.from('AC1032xxxx', 'latin1')), true);
  assert.equal(isDwgBuffer(Buffer.from('%PDF-1.4\n')), false);
  assert.equal(isDwgBuffer(Buffer.alloc(0)), false);
});

test('rejects a truncated DWG instead of rendering nothing', async () => {
  // A real header with no drawing body: must fail loudly, not return a blank.
  const truncated = Buffer.concat([Buffer.from('AC1018', 'latin1'), Buffer.alloc(2048)]);
  await assert.rejects(() => renderDwg(truncated), /CAD 文件无法解析/);
});

test('rejects files that are not DWG at all', async () => {
  await assert.rejects(() => renderDwg(Buffer.from('%PDF-1.4\nnot a dwg')), /不匹配/);
});

test('measures a synthetic parcel from its geometry', () => {
  const analysis = analyzeEntities([lwpolyline(SQUARE)]);
  assert.equal(analysis.modelEntities, 1);
  assert.equal(analysis.outlines.length, 1);
  const [outline] = analysis.outlines;
  assert.ok(Math.abs(outline.area - 10000) < 1e-6);
  assert.ok(Math.abs(outline.perimeter - 400) < 1e-6);
  assert.equal(outline.points.length, 4);
  assert.equal(outline.edges.length, 4);
});

test('treats a lone closed straight boundary as the site outline', () => {
  const analysis = analyzeEntities([lwpolyline(SQUARE)]);
  assert.ok(sheetBoundary(analysis), 'sole closed outline drives the annotated sheet');
});

test('ignores an open polyline as a boundary candidate', () => {
  const analysis = analyzeEntities([lwpolyline(SQUARE, { closed: false })]);
  assert.equal(analysis.modelEntities, 1);
  assert.equal(analysis.outlines.length, 0, 'an open path cannot be an area');
  assert.equal(sheetBoundary(analysis), null);
});

test('ignores curved outlines because edge lengths would be wrong', () => {
  const analysis = analyzeEntities([lwpolyline(SQUARE, { bulge: 0.4 })]);
  assert.equal(analysis.outlines.length, 0, 'a bulged segment is an arc, not a chord');
});

test('one outline plus other entities is still not a lone boundary', () => {
  // Exactly ONE measurable outline, but the drawing also holds roads and labels.
  // Dropping the entity-count test would turn this into a single-outline sheet
  // and silently erase the rest of the plan.
  const analysis = analyzeEntities([
    lwpolyline(SQUARE),
    line(10, 10, 90, 10),
    line(10, 90, 90, 90),
    textEntity('ROAD'),
  ]);
  assert.equal(analysis.modelEntities, 4);
  assert.equal(analysis.outlines.length, 1, 'only the parcel is closed');
  assert.equal(sheetBoundary(analysis), null, 'roads and labels must keep the full export');
});

test('two boundaries are treated as a drawing, not a site plan', () => {
  const analysis = analyzeEntities([
    lwpolyline(SQUARE),
    lwpolyline([
      [10, 10],
      [30, 10],
      [30, 30],
      [10, 30],
    ]),
  ]);
  assert.equal(analysis.modelEntities, 2);
  assert.equal(analysis.outlines.length, 2);
  assert.equal(sheetBoundary(analysis), null);
});

test('a drawing without any closed outline never becomes a sheet', () => {
  const analysis = analyzeEntities([line(0, 0, 100, 0), line(100, 0, 100, 100)]);
  assert.equal(analysis.outlines.length, 0);
  assert.equal(sheetBoundary(analysis), null);
});

test('sorts multiple outlines by area', () => {
  const analysis = analyzeEntities([
    lwpolyline([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
    lwpolyline(SQUARE),
  ]);
  assert.ok(analysis.outlines[0].area > analysis.outlines[1].area);
});

test('converts a real DWG into a dimensioned sheet', async (t) => {
  const dwg = await localSample();
  if (!dwg) {
    t.skip('no local DWG sample; set LUMA_DWG_SAMPLE to a drawing to run this');
    return;
  }
  {
    const drawing = await renderDwg(dwg, { name: 'sample.DWG' });

    assert.equal(drawing.kind, 'CAD 图纸');
    assert.ok(Math.max(drawing.width, drawing.height) >= 2000);

    const meta = await sharp(drawing.buffer).metadata();
    assert.equal(meta.format, 'png');

    // Linework must be present, not a blank white sheet.
    const { data, info } = await sharp(drawing.buffer)
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rows = new Array(10).fill(0);
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[y * info.width + x] < 200) {
          rows[Math.min(9, Math.floor((y / info.height) * 10))] += 1;
        }
      }
    }
    assert.ok(rows.filter((n) => n > 0).length >= 6, `sparse sheet: ${rows.join(',')}`);
  }
});