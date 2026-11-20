import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { AppError } from '../shared/errors.js';

// CAD sheets and scanned drawings mix huge raster renders with hundreds of tiny
// stencil/mask images. Only real pictures are worth offering, so both edges must
// clear a floor and the decoded pixel cost is capped per image.
const MIN_EDGE = 320;
const MAX_EDGE = 2048;
const MAX_PIXELS = 40 * 1000 * 1000;
const MAX_IMAGES = 24;
const MAX_PAGES = 200;

// A page deserves a raster when it draws real geometry: that is exactly the CAD
// case, where a screenshot is the only thing an image model can look at.
const MIN_VECTOR_OPS = 40;
const PAGE_RENDER_EDGE = 2048;
const RENDER_CONCURRENCY = 4;

function isBitmapKind(kind) {
  // pdfjs ImageKind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP.
  return kind === 2 || kind === 3;
}

function channelCount(kind) {
  return kind === 3 ? 4 : 3;
}

async function toReference(image) {
  const channels = channelCount(image.kind);
  const expected = image.width * image.height * channels;
  const data = image.data;
  if (!data || data.length < expected) return null;
  const raw = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, expected);
  const jpeg = await sharp(raw, {
    raw: { width: image.width, height: image.height, channels },
  })
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return jpeg.length ? jpeg : null;
}

// Vector sheets are black line art on white, so a palette PNG stays lossless on
// the lines and still lands far smaller than JPEG at the same legibility.
async function pageToReference(canvas) {
  const png = canvas.toBuffer('image/png');
  const encoded = await sharp(png)
    .flatten({ background: '#ffffff' })
    .png({ palette: true, colors: 64, compressionLevel: 9 })
    .toBuffer();
  return encoded.length ? encoded : null;
}

// pdfjs keeps an image that the whole document shares (the global image cache
// hoists it out of a page) under a "g_" id in commonObjs; everything else lives
// in that page's own objs. It makes the same call in its own getObject().
function imageStore(page, name) {
  return name.startsWith('g_') ? page.commonObjs : page.objs;
}

/**
 * Resolve a decoded image by id.
 *
 * Both stores can stay unresolved forever: commonObjs only answers a shared
 * image once another page still holds the copy it clones from, and a page whose
 * data was already cleaned up never answers at all. A hang here would stall the
 * whole upload, so every wait is bounded and yields null instead.
 */
function resolveImage(page, name, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(null), timeoutMs);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || null);
    };
    const store = imageStore(page, name);
    if (!store) return done(null);
    try {
      // A second argument turns get into a callback; an already-decoded object
      // comes back synchronously as the return value.
      const sync = store.get(name, done);
      if (sync) done(sync);
    } catch {
      done(null);
    }
  });
}

// pdfjs reads these files straight off disk, so the value must be an absolute
// directory ending with a separator. Without it, any text drawn in a standard
// font (Helvetica, Times, ...) renders as blank glyphs and the page comes out
// white except for its line work.
function standardFontDir() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('pdfjs-dist/package.json');
    return `${path.dirname(pkg)}${path.sep}standard_fonts${path.sep}`;
  } catch {
    return null;
  }
}

function countGeometry(ops, pdfjs) {
  let vector = 0;
  for (const fn of ops.fnArray) {
    if (
      fn === pdfjs.OPS.constructPath ||
      fn === pdfjs.OPS.stroke ||
      fn === pdfjs.OPS.closeStroke ||
      fn === pdfjs.OPS.fill ||
      fn === pdfjs.OPS.eoFill ||
      fn === pdfjs.OPS.fillStroke ||
      fn === pdfjs.OPS.eoFillStroke ||
      fn === pdfjs.OPS.closeFillStroke ||
      fn === pdfjs.OPS.closeEOFillStroke
    ) {
      vector += 1;
    }
  }
  return vector;
}

async function collectBitmaps(page, ops, pdfjs, budget) {
  const found = [];
  const seen = new Set();
  for (let op = 0; op < ops.fnArray.length && found.length < budget; op += 1) {
    const fn = ops.fnArray[op];
    const args = ops.argsArray[op];

    // Bitmaps appear in three shapes: a named XObject, the same XObject
    // repeated at several positions, and data inlined in the content stream.
    let image = null;
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintJpegXObject) {
      const name = args?.[0];
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      image = await resolveImage(page, name);
    } else if (fn === pdfjs.OPS.paintImageXObjectRepeat) {
      const name = args?.[0];
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      image = await resolveImage(page, name);
    } else if (
      fn === pdfjs.OPS.paintInlineImageXObject ||
      fn === pdfjs.OPS.paintInlineImageXObjectGroup
    ) {
      image = args?.[0];
      if (!image || typeof image !== 'object' || seen.has(image)) continue;
      seen.add(image);
    } else {
      continue;
    }

    if (!image || !isBitmapKind(image.kind)) continue;
    const { width, height } = image;
    if (!width || !height) continue;
    if (Math.min(width, height) < MIN_EDGE) continue;
    if (width * height > MAX_PIXELS) continue;
    const jpeg = await toReference(image);
    if (!jpeg) continue;
    found.push({ width, height, ref: image.ref || null, buffer: jpeg });
  }
  return found;
}

// OCR needs the page as a lossless bitmap: `pageToReference` re-encodes to JPEG
// for image models, which blurs small type. This renders a page (or a run of
// pages) straight to PNG and hands each one to the OCR backend.
export async function rasterizePagesForOcr(buffer, { maxPages = 20, scale = 1 } = {}) {
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new AppError(400, '不是有效的 PDF 文件');
  }
  let pdfjs;
  let canvasModule;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    canvasModule = await import('@napi-rs/canvas');
  } catch {
    throw new AppError(500, 'PDF 解析组件不可用');
  }
  const canvasFactory = canvasFactoryFor(canvasModule);
  const fontDir = standardFontDir();
  const pages = [];
  let pdf;
  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      canvasFactory,
      ...(fontDir ? { standardFontDataUrl: fontDir } : {}),
    }).promise;
    const total = Math.min(pdf.numPages, maxPages);
    for (let index = 1; index <= total; index += 1) {
      const page = await pdf.getPage(index);
      try {
        const base = page.getViewport({ scale: 1 });
        const longest = Math.max(base.width, base.height);
        if (!longest) continue;
        const viewport = page.getViewport({
          scale: (PAGE_RENDER_EDGE * scale) / longest,
        });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        if (!width || !height) continue;
        const holder = canvasFactory.create(width, height);
        try {
          await page.render({
            canvasContext: holder.context,
            viewport,
            background: '#ffffff',
          }).promise;
          pages.push({ page: index, width, height, buffer: holder.canvas.toBuffer('image/png') });
        } finally {
          canvasFactory.destroy(holder);
        }
      } catch {
        // One unreadable page must not lose the rest of the document.
      } finally {
        try {
          page.cleanup();
        } catch {
          /* page may already be gone after a failed parse */
        }
      }
    }
    return { pages, totalPages: pdf.numPages };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'PDF 已加密或无法解析，请确认文件没有密码保护');
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {
      /* ignore cleanup errors */
    }
  }
}

async function rasterizePage(page, canvasFactory) {
  const base = page.getViewport({ scale: 1 });
  const longest = Math.max(base.width, base.height);
  if (!longest) return null;
  const viewport = page.getViewport({ scale: PAGE_RENDER_EDGE / longest });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (!width || !height) return null;

  const holder = canvasFactory.create(width, height);
  try {
    await page.render({
      canvasContext: holder.context,
      viewport,
      background: '#ffffff',
    }).promise;
    const buffer = await pageToReference(holder.canvas);
    if (!buffer) return null;
    return { width, height, buffer };
  } finally {
    canvasFactory.destroy(holder);
  }
}

function canvasFactoryFor(canvasModule) {
  return {
    create(width, height) {
      const canvas = canvasModule.createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(holder, width, height) {
      holder.canvas.width = width;
      holder.canvas.height = height;
    },
    destroy(holder) {
      holder.canvas.width = 0;
      holder.canvas.height = 0;
    },
  };
}

/**
 * Pull pictures out of a PDF so they can be used as reference images.
 *
 * Real bitmaps stored in the file (photos, rendered elevations) always win, then
 * pages that draw geometry are rasterized to fill the remaining budget. Rendered
 * CAD sheets are the only way an image model can look at a drawing, since the
 * file itself only holds vectors for them.
 *
 * Pages whose text layer is broken by missing ToUnicode maps still work here:
 * neither bitmap extraction nor rendering depends on the extracted text.
 */
export async function extractPdfImages(buffer, { maxImages = MAX_IMAGES } = {}) {
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new AppError(400, '不是有效的 PDF 文件');
  }
  let pdfjs;
  let canvasModule;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    canvasModule = await import('@napi-rs/canvas');
  } catch {
    throw new AppError(500, 'PDF 解析组件不可用');
  }

  const canvasFactory = canvasFactoryFor(canvasModule);
  const fontDir = standardFontDir();
  const bitmaps = [];
  const rasterPages = [];
  let pdf;

  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      canvasFactory,
      ...(fontDir ? { standardFontDataUrl: fontDir } : {}),
    }).promise;

    const total = Math.min(pdf.numPages, MAX_PAGES);
    // Pages stay loaded while scanning: a document-wide image is resolved by
    // cloning the copy another page still holds, so cleaning a page up early
    // would make that lookup wait forever.
    const opened = [];
    const seenRefs = new Set();
    try {
      for (let index = 1; index <= total; index += 1) {
        const page = await pdf.getPage(index);
        opened.push(page);
        try {
          const ops = await page.getOperatorList();
          const found = await collectBitmaps(page, ops, pdfjs, maxImages - bitmaps.length);
          for (const hit of found) {
            // A shared XObject is one picture drawn on several pages; keep the
            // first occurrence. Bitmaps without a ref are inline data and are
            // always distinct.
            if (hit.ref) {
              if (seenRefs.has(hit.ref)) continue;
              seenRefs.add(hit.ref);
            }
            bitmaps.push({ page: index, type: 'bitmap', ...hit });
          }
          // Geometry is judged on its own: a CAD sheet that also carries a
          // logo or a photo still has linework no bitmap can represent, so it
          // earns a raster even when a usable bitmap was extracted from it.
          if (countGeometry(ops, pdfjs) >= MIN_VECTOR_OPS) {
            rasterPages.push(index);
          }
        } catch {
          // A single unreadable page must not lose the rest of the document.
        }
      }
    } finally {
      for (const page of opened) {
        try {
          page.cleanup();
        } catch {
          /* page may already be gone after a failed parse */
        }
      }
    }

    // Bitmaps win the shallow slots: a photo inside the file is what an edit
    // actually targets. But a drawing set must not be swallowed by its own
    // logos, so half the budget is reserved for pages that carry geometry.
    const reserved = Math.min(
      rasterPages.length,
      Math.max(1, Math.floor(maxImages / 2)),
    );
    const images = bitmaps.slice(0, Math.max(1, maxImages - reserved));
    const room = maxImages - images.length;
    if (room > 0) {
      const rendered = await rasterizePages(
        pdf,
        rasterPages.slice(0, room),
        canvasFactory,
      );
      images.push(...rendered);
    }

    // ref is only the dedupe key for shared XObjects; it is not part of the
    // public shape and must not leak into stored metadata.
    return images
      .sort((left, right) => left.page - right.page)
      .map(({ ref, ...rest }) => rest);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'PDF 已加密或无法解析，请确认文件没有密码保护');
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {
      /* ignore cleanup errors */
    }
  }
}

// Rendering is CPU bound and independent per page, so a small pool keeps a
// 18-sheet drawing well inside a request timeout.
async function rasterizePages(pdf, pageNumbers, canvasFactory) {
  const out = [];
  if (!pageNumbers.length) return out;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pageNumbers.length) {
      const index = pageNumbers[cursor];
      cursor += 1;
      const page = await pdf.getPage(index);
      try {
        const rendered = await rasterizePage(page, canvasFactory);
        if (rendered) out.push({ page: index, type: 'page', ...rendered });
      } catch {
        // Skip a page that cannot be drawn; the rest still count.
      } finally {
        page.cleanup();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(RENDER_CONCURRENCY, pageNumbers.length) }, worker),
  );
  return out.sort((left, right) => left.page - right.page);
}