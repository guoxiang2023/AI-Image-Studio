import { DOCUMENT_MAX_BYTES, WORKSPACE_MAX_FILE_BYTES } from '../config.js';
import { fileExtension } from '../domain/workspace.js';
import { AppError } from '../shared/errors.js';
import { readWorkspaceBytes, resolveBrowsePath } from './workspace-service.js';

// A rendered HTML page is not a document: it loads stylesheets, images and fonts
// by relative path, and those requests have to be answered too. So the page and
// its page-local assets are served from directory-shaped URLs, resolved through
// the same guarded reader as every other workspace read — re-validated per call,
// bounded by the configured limits, and refusing symlinks, credentials and
// ignored directories.
//
// Nothing here executes the markup. The page is delivered with a locked-down CSP
// and framed without `allow-scripts`, so a workspace file cannot run code in the
// app's origin.

const HTML_EXTS = new Set(['html', 'htm']);

// Only inert, page-local assets. A `.js` file is deliberately absent: the CSP
// forbids scripts, so serving one would only add a way to pull code out of the
// workspace over HTTP.
const ASSET_TYPES = new Map(Object.entries({
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}));

// Markup and CSS are text and share the text ceiling; images and fonts are
// binary and take the document ceiling. Both are the configured limits, so a
// page cannot pull an unbounded file into memory through this route.
const TEXT_EXTS = new Set(['html', 'htm', 'css']);

// A preview has to look like the page, so its own stylesheets, CSS images and
// webfonts load. Scripts, frames, forms, media plugins and every network origin
// stay blocked. `sandbox allow-same-origin` (no `allow-scripts`) is what lets
// `'self'` match at all while still forbidding execution.
const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-same-origin',
].join('; ');

/**
 * `<meta http-equiv="refresh">` is not script, so the sandbox does not stop it:
 * a file could navigate its own frame to a remote page and turn the preview into
 * whatever it likes. Links still work, a silent redirect does not.
 */
function stripMetaRefresh(html) {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

/**
 * Reads one page or one page-local asset.
 *
 * Returns `{ notFound: true }` for an unsupported extension rather than throwing,
 * so a page that references a missing icon shows a broken image instead of an
 * error page inside the frame. Every other refusal propagates: an oversized file
 * is a 413 and a rebound root is a 409, exactly as on the preview route.
 */
export async function readHtmlAsset(workspace, relative) {
  // The path is validated before the extension is considered. Checking the
  // extension first would answer 404 for `.env` and turn a refusal into "not
  // found", which hides that the file exists but is off limits.
  let target;
  let info;
  try {
    ({ target, info } = await resolveBrowsePath(workspace, String(relative || ''), false));
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return { notFound: true };
    throw error;
  }

  const ext = fileExtension(relative);
  const mediaType = ASSET_TYPES.get(ext);
  if (!mediaType) return { notFound: true };

  const limit = TEXT_EXTS.has(ext) ? WORKSPACE_MAX_FILE_BYTES : DOCUMENT_MAX_BYTES;
  const raw = await readWorkspaceBytes(target, info, limit);
  const html = HTML_EXTS.has(ext);
  return {
    buffer: html ? Buffer.from(stripMetaRefresh(raw.toString('utf8')), 'utf8') : raw,
    mediaType,
    headers: html
      ? {
          'Content-Security-Policy': PAGE_CSP,
          'X-Frame-Options': 'SAMEORIGIN',
          'Cross-Origin-Resource-Policy': 'same-origin',
        }
      : { 'Cross-Origin-Resource-Policy': 'same-origin' },
  };
}
