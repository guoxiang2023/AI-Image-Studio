import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { extractPdfImages } from '../src/media/pdf-images.js';

const MAX_REFERENCE_EDGE = 2048;

async function solidPng(width, height, color) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

async function makePdf({ withLargeImage, withTinyImage, width = 1200, height = 900 }) {
  const doc = new PDFDocument({ size: [1000, 900], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  if (withLargeImage) {
    doc.image(await solidPng(width, height, '#3366aa'), 0, 0, { width: 400, height: 300 });
  }
  if (withTinyImage) {
    doc.image(await solidPng(16, 16, '#aa3333'), 420, 20, { width: 16, height: 16 });
  }
  doc.end();
  return done;
}

// A hand-built PDF whose single bitmap is inlined in the content stream
// (BI / ID / EI) instead of living in a separate image XObject.
function inlineImagePdf(width = 400, height = 400, fill = 0x80) {
  const data = Buffer.alloc(width * height * 3, fill);
  const content = Buffer.concat([
    Buffer.from(
      `q\n${width} 0 0 ${height} 0 0 cm\nBI /W ${width} /H ${height} /CS /RGB /BPC 8 ID\n`,
      'latin1',
    ),
    data,
    Buffer.from('\nEI\nQ\n', 'latin1'),
  ]);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let offset = parts[0].length;
  for (let index = 0; index < objs.length; index += 1) {
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const body =
      index === 3
        ? Buffer.concat([Buffer.from(objs[3], 'latin1'), content, Buffer.from('\nendstream\n', 'latin1')])
        : Buffer.from(`${objs[index]}\n`, 'latin1');
    offsets.push(offset);
    parts.push(head, body, Buffer.from('endobj\n', 'latin1'));
    offset += head.length + body.length + 'endobj\n'.length;
  }
  const pad = (value) => String(value).padStart(10, '0');
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) xref += `${pad(entry)} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

// One image XObject painted four times at four positions.
function repeatedImagePdf(width = 600, height = 600, times = 4) {
  const rgb = Buffer.alloc(width * height * 3, 0x33);
  const placements = Array.from(
    { length: times },
    (_, index) => `q ${width} 0 0 ${height} ${20 + index} ${20 + index} cm /Im0 Do Q`,
  ).join('\n');
  const content = Buffer.from(`${placements}\n`, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 900] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n`,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let offset = parts[0].length;
  for (let index = 0; index < objs.length; index += 1) {
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    let body;
    if (index === 3) {
      body = Buffer.concat([Buffer.from(objs[3], 'latin1'), content, Buffer.from('\nendstream\n', 'latin1')]);
    } else if (index === 4) {
      body = Buffer.concat([Buffer.from(objs[4], 'latin1'), rgb, Buffer.from('\nendstream\n', 'latin1')]);
    } else {
      body = Buffer.from(`${objs[index]}\n`, 'latin1');
    }
    offsets.push(offset);
    parts.push(head, body, Buffer.from('endobj\n', 'latin1'));
    offset += head.length + body.length + 'endobj\n'.length;
  }
  const pad = (value) => String(value).padStart(10, '0');
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) xref += `${pad(entry)} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

test('extracts real bitmaps embedded in a PDF', async () => {
  const pdf = await makePdf({ withLargeImage: true, withTinyImage: false });
  const images = await extractPdfImages(pdf);
  assert.equal(images.length, 1);
  const [image] = images;
  assert.equal(image.page, 1);
  assert.equal(image.type, 'bitmap');
  assert.equal(image.width, 1200);
  assert.equal(image.height, 900);
  assert.ok(image.buffer.length > 0);
  // Decoded output keeps the source pixels, not the placement rectangle.
  const meta = await sharp(image.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 900);
});

test('ignores stencil-sized images that are not usable references', async () => {
  const pdf = await makePdf({ withLargeImage: false, withTinyImage: true });
  assert.deepEqual(await extractPdfImages(pdf), []);
});

// A vector sheet holds no bitmap at all, so the only way an image model can see
// it is a screenshot of the page.
test('rasterizes vector pages that carry no bitmap', async () => {
  const doc = new PDFDocument({ size: [600, 400], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (let i = 0; i < 120; i += 1) {
    doc.rect(10 + (i % 12) * 48, 10 + Math.floor(i / 12) * 36, 40, 28).stroke('#123456');
  }
  doc.end();

  const images = await extractPdfImages(await done);
  assert.equal(images.length, 1);
  const [page] = images;
  assert.equal(page.type, 'page');
  assert.equal(page.page, 1);
  assert.ok(page.buffer.length > 0);

  // Line art survives as pixels: the drawn rectangles must show up as ink.
  const meta = await sharp(page.buffer).metadata();
  assert.equal(meta.format, 'png');
  const { data, info } = await sharp(page.buffer)
    .flatten({ background: '#ffffff' })
    .resize({ width: 320 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Downscaling averages hairline strokes into near-white, so count anything
  // that is not pure white rather than insisting on fully black pixels.
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] < 250) ink += 1;
  }
  assert.ok(ink > 1000, `expected drawn geometry, got ${ink} ink pixels`);
});

test('a page with almost no geometry is not worth a screenshot', async () => {
  const doc = new PDFDocument({ size: [400, 300], margin: 20 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.moveTo(20, 20).lineTo(220, 140).stroke('#000');
  doc.end();
  assert.deepEqual(await extractPdfImages(await done), []);
});

test('shrinks images larger than the reference edge limit', async () => {
  const pdf = await makePdf({ withLargeImage: true, width: 3000, height: 2400 });
  const [image] = await extractPdfImages(pdf);
  assert.ok(image, 'expected an image');
  assert.equal(image.width, 3000);
  assert.equal(image.height, 2400);
  const meta = await sharp(image.buffer).metadata();
  assert.equal(Math.max(meta.width, meta.height), MAX_REFERENCE_EDGE);
  assert.equal(meta.width, 2048);
  assert.equal(meta.height, 1638);
});

// A page holding only a photo has no geometry worth drawing, so screenshotting
// it would just duplicate what the bitmap already shows.
test('a page with only a photo is not also rasterized', async () => {
  const pdf = await makePdf({ withLargeImage: true, withTinyImage: false });
  const images = await extractPdfImages(pdf);
  assert.equal(images.filter((item) => item.type === 'page').length, 0);
});

// The real CAD case: a sheet with a photo or logo dropped onto it. The bitmap is
// still the thing an edit targets, but the linework only exists as vectors, so
// dropping the page because "it already has a picture" loses the drawing.
test('a sheet with both a photo and linework yields the bitmap and the drawing', async () => {
  const photo = await solidPng(1200, 900, '#4466aa');
  const doc = new PDFDocument({ size: [800, 600], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.image(photo, 20, 20, { width: 400, height: 300 });
  for (let i = 0; i < 120; i += 1) {
    doc.rect(20 + (i % 10) * 60, 330 + Math.floor(i / 10) * 20, 50, 14).stroke('#123456');
  }
  doc.end();

  const images = await extractPdfImages(await done);
  const bitmaps = images.filter((item) => item.type === 'bitmap');
  const pages = images.filter((item) => item.type === 'page');
  assert.equal(bitmaps.length, 1, 'the embedded photo must survive');
  assert.equal(pages.length, 1, 'the linework must survive as a screenshot');
  assert.equal(pages[0].page, 1);

  // The screenshot must actually contain the drawn rows, not just the photo.
  // Downscale first: counting millions of pixels one by one is needlessly slow.
  const { data, info } = await sharp(pages[0].buffer)
    .flatten({ background: '#ffffff' })
    .resize({ width: 320 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] < 250) ink += 1;
  }
  assert.ok(ink > 1000, `expected drawn linework, got ${ink} ink pixels`);
});

test('linework is not starved by a page full of bitmaps', async () => {
  // One drawing page plus many photo pages: the drawing must still get a slot
  // instead of being pushed out by the bitmaps that arrive first.
  const doc = new PDFDocument({ size: [800, 600], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const photo = await solidPng(1200, 900, '#4466aa');
  const PAGES = 6;
  const DRAWING_PAGE = PAGES - 1;
  for (let p = 0; p < PAGES; p += 1) {
    if (p) doc.addPage({ size: [800, 600], margin: 0 });
    doc.image(photo, 10, 10, { width: 360, height: 270 });
    if (p === DRAWING_PAGE) {
      for (let i = 0; i < 120; i += 1) {
        doc.rect(10 + (i % 10) * 70, 300 + Math.floor(i / 10) * 20, 60, 12).stroke('#123456');
      }
    }
  }
  doc.end();

  const images = await extractPdfImages(await done, { maxImages: 4 });
  assert.equal(images.length <= 4, true);
  assert.ok(
    images.some((item) => item.type === 'page'),
    `expected a drawing page, got ${JSON.stringify(images.map((i) => i.type))}`,
  );
});

test('extracts bitmaps inlined in the content stream', async () => {
  const images = await extractPdfImages(inlineImagePdf(400, 400));
  assert.equal(images.length, 1);
  assert.equal(images[0].width, 400);
  assert.equal(images[0].height, 400);
});

test('counts a repeatedly painted XObject once', async () => {
  const images = await extractPdfImages(repeatedImagePdf(600, 600, 4));
  assert.equal(images.length, 1);
  assert.equal(images[0].width, 600);
});

// Pages 2 and 3 draw the SAME image XObject while page 1 draws a different one.
// pdfjs then hoists the shared picture into the document-wide image cache and
// hands page 3 a "g_" id that lives in commonObjs, resolved by cloning the copy
// page 2 still holds. Reading only page.objs — or cleaning page 2 up first —
// waits forever, which would stall the whole upload.
function sharedXObjectPdf(width = 600, height = 600) {
  const unique = Buffer.alloc(width * height * 3, 0xaa);
  const shared = Buffer.alloc(width * height * 3, 0x33);
  const content = (x) => Buffer.from(`q ${width} 0 0 ${height} ${x} ${x} cm /Im0 Do Q\n`, 'latin1');
  const pageDict = (contents, image) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 900] /Contents ${contents} 0 R /Resources << /XObject << /Im0 ${image} 0 R >> >> >>`;

  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let offset = parts[0].length;
  const emit = (num, body) => {
    const head = Buffer.from(`${num} 0 obj\n`, 'latin1');
    offsets.push(offset);
    parts.push(head, body, Buffer.from('endobj\n', 'latin1'));
    offset += head.length + body.length + 'endobj\n'.length;
  };
  const stream = (dict, data) =>
    Buffer.concat([Buffer.from(dict, 'latin1'), data, Buffer.from('\nendstream\n', 'latin1')]);
  const imageDict = (bytes) =>
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${bytes.length} >>\nstream\n`;

  const c1 = content(20);
  const c2 = content(30);
  const c3 = content(40);

  emit(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>\n', 'latin1'));
  emit(2, Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R 9 0 R] /Count 3 >>\n', 'latin1'));
  emit(3, Buffer.from(`${pageDict(4, 5)}\n`, 'latin1'));
  emit(4, stream(`<< /Length ${c1.length} >>\nstream\n`, c1));
  emit(5, stream(imageDict(unique), unique));
  emit(6, Buffer.from(`${pageDict(7, 8)}\n`, 'latin1'));
  emit(7, stream(`<< /Length ${c2.length} >>\nstream\n`, c2));
  emit(8, stream(imageDict(shared), shared));
  emit(9, Buffer.from(`${pageDict(10, 8)}\n`, 'latin1'));
  emit(10, stream(`<< /Length ${c3.length} >>\nstream\n`, c3));

  const pad = (value) => String(value).padStart(10, '0');
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) xref += `${pad(entry)} 00000 n \n`;
  xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

test(
  'resolves an image shared across pages without hanging',
  { timeout: 15000 },
  async () => {
    const started = Date.now();
    const images = await extractPdfImages(sharedXObjectPdf(600, 600));
    const elapsed = Date.now() - started;

    // Two distinct pictures: the unique one on page 1, the shared one once.
    assert.equal(images.length, 2);
    assert.deepEqual(
      images.map((image) => image.page),
      [1, 2],
    );
    for (const image of images) {
      assert.equal(image.width, 600);
      assert.ok(image.buffer.length > 0);
      assert.equal(image.ref, undefined, 'internal dedupe key must not leak');
    }

    // The real failure mode is not a wrong count but a wait that never ends:
    // looking the shared image up in the wrong store, or cleaning the source
    // page up first, costs the full per-image timeout before falling back.
    assert.ok(
      elapsed < 2500,
      `shared image lookup should be immediate, took ${elapsed}ms`,
    );
  },
);

test('rejects buffers that are not PDFs', async () => {
  await assert.rejects(() => extractPdfImages(Buffer.from('not a pdf')), /PDF/);
});