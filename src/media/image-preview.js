import sharp from 'sharp';

// The sidebar column is at most a few hundred CSS pixels wide. Decoding a
// 12000px screenshot at full size costs the renderer hundreds of MB, so
// anything past this edge is downscaled before it is sent; smaller images keep
// their original bytes and are never re-encoded.
const PREVIEW_MAX_EDGE = 1600;

// Vector art has no pixels of its own, so `sharp` honours the declared size
// only relative to a density. Rendering at 72dpi gives a 24px icon that is
// unreadable in the panel and a 20000px canvas that blows the pixel limit;
// asking for the density that lands the longest edge on the preview size solves
// both, and the cap keeps small icons crisp without inventing huge canvases.
const SVG_BASE_DPI = 72;
const SVG_MAX_DPI = 288;

/** Formats Chromium cannot display directly and that must be rasterized here. */
export const RASTER_ONLY_TYPES = new Map(Object.entries({
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}));

function svgDensity(buffer) {
  const head = buffer.subarray(0, 4096).toString('utf8');
  const width = Number(head.match(/\bwidth="\s*([\d.]+)/)?.[1]);
  const height = Number(head.match(/\bheight="\s*([\d.]+)/)?.[1]);
  const viewBox = head.match(/\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  const spanX = Number.isFinite(width) && width > 0 ? width : Number(viewBox?.[1]);
  const spanY = Number.isFinite(height) && height > 0 ? height : Number(viewBox?.[2]);
  const longest = Math.max(spanX || 0, spanY || 0);
  if (!longest) return SVG_MAX_DPI;
  return Math.min(SVG_MAX_DPI, Math.max(1, (PREVIEW_MAX_EDGE / longest) * SVG_BASE_DPI));
}

/**
 * Rasterizes vector or unreachable-by-the-browser formats (SVG, TIFF) for the
 * preview panel. A multi-page TIFF keeps only its first frame: the panel has one
 * image slot, and the alternative is showing nothing at all.
 */
async function rasterize(buffer, format) {
  if (format === 'svg') {
    // librsvg resolves no external references and runs no script: probing
    // `file://`, relative and http(s) `href`s produced blank or an empty fetch,
    // so a workspace file cannot pull bytes from elsewhere into the preview.
    return sharp(buffer, {
      density: svgDensity(buffer),
      limitInputPixels: 40 * 1000 * 1000,
    })
      .flatten({ background: '#ffffff' })
      .resize({
        width: PREVIEW_MAX_EDGE,
        height: PREVIEW_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 90 })
      .toBuffer();
  }
  return sharp(buffer, { pages: 1 })
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' })
    .resize({
      width: PREVIEW_MAX_EDGE,
      height: PREVIEW_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 88 })
    .toBuffer();
}

/**
 * Shrinks an image for the workspace sidebar.
 *
 * Returns `null` when the original bytes should be served unchanged: already
 * small enough, animated (a resized copy would drop the animation), or a format
 * sharp cannot decode (`ico` renders fine in Chromium on its own).
 */
export async function imagePreview(buffer, mediaType = '') {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return null;
  }
  if (!meta.width || !meta.height || meta.pages > 1) return null;
  if (Math.max(meta.width, meta.height) <= PREVIEW_MAX_EDGE) return null;

  try {
    const resized = await sharp(buffer)
      // A phone photo stores its rotation in EXIF instead of rotating pixels.
      // Resizing the stored pixels and dropping the tag shows sideways images,
      // so rotate first; the resize below then sees the display dimensions.
      .rotate()
      .resize({
        width: PREVIEW_MAX_EDGE,
        height: PREVIEW_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 88 })
      .toBuffer();
    return { buffer: resized, mediaType: 'image/webp' };
  } catch {
    return null;
  }
}

/**
 * Preview bytes for a format the browser cannot show on its own.
 *
 * Unlike `imagePreview`, this always re-encodes: there is no "serve as is" for
 * an SVG (an `<img src>` pointing at it would execute nothing but would also
 * inherit the page origin for any embedded script) or a TIFF.
 */
export async function rasterizedPreview(buffer, format) {
  const raster = await rasterize(buffer, format);
  return { buffer: raster, mediaType: 'image/webp' };
}
