import { unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_CHARS,
  IMAGE_EXT_BY_TYPE,
  OCR_PAGE_LIMIT,
  PDF_MAX_IMAGES,
} from '../../config.js';
import { json, readBody } from '../responses.js';
import { saveImageBuffer, userImageDir } from '../../media/image-storage.js';
import {
  ZIP_EXTS,
  documentExt,
  documentUnsupportedMessage,
  extractDocumentTextAsync,
  isSupportedDocumentExt,
} from '../../media/document-text.js';
import { extractPdfImages, rasterizePagesForOcr } from '../../media/pdf-images.js';
import { recognizeText } from '../../media/ocr.js';
import { isDwgBuffer, renderDwg } from '../../media/dwg-image.js';
import { saveDocument } from '../../media/document-storage.js';
import { AppError } from '../../shared/errors.js';

const PDF_IMAGE_LIMIT = PDF_MAX_IMAGES;

const DOCUMENT_EXT_BY_TYPE = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/pdf': 'pdf',
};

export async function handleUpload(req, res, user) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_EXT_BY_TYPE[contentType];
  if (!ext) return json(res, 415, { error: '只支持 PNG / JPEG / WebP 图片' });
  const buffer = await readBody(req, 25 * 1024 * 1024);
  if (!buffer.length) return json(res, 400, { error: '空文件' });
  const image = await saveImageBuffer(user.id, buffer, ext);
  return json(res, 200, { imageId: image.id, url: image.url });
}

function decodeFileName(header) {
  const raw = String(header || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function discardImages(userId, stored) {
  for (const image of stored) {
    try {
      await unlink(path.join(userImageDir(userId), `${image.id}.${image.ext}`));
    } catch {
      /* already gone; nothing to clean */
    }
  }
}

// Extracted bitmaps are kept next to uploaded images so they can be used as
// reference images straight away; they are not registered in the gallery
// because they are derived from the user's document, not created by the model.
// On any failure the already-written files are removed so a rejected upload
// never leaves orphans behind.
async function storePdfImages(userId, buffer) {
  let found = [];
  try {
    found = await extractPdfImages(buffer, { maxImages: PDF_IMAGE_LIMIT });
  } catch {
    return [];
  }
  return saveFoundImages(userId, found);
}

async function saveFoundImages(userId, found) {
  const stored = [];
  try {
    for (const image of found) {
      // Rendered sheet pages are palette PNGs (lossless line art); embedded
      // photos are JPEGs. Keep each in its native format.
      const ext = image.type === 'page' ? 'png' : 'jpeg';
      const saved = await saveImageBuffer(userId, image.buffer, ext);
      stored.push({
        id: saved.id,
        url: saved.url,
        ext: ext === 'jpeg' ? 'jpg' : ext,
        page: image.page,
        type: image.type,
        width: image.width,
        height: image.height,
      });
    }
  } catch {
    await discardImages(userId, stored);
    return [];
  }
  return stored;
}

// A scanned PDF has no text layer at all, so the only way to read it is to draw
// each page and run OCR. Pages are rendered before OCR so the same bitmaps can
// also serve as reference images, which is what the upload did before OCR
// existed: an unreadable scan still has to be usable as a picture.
async function ocrScannedPdf(userId, buffer, { saveImages = true } = {}) {
  let rendered;
  try {
    rendered = await rasterizePagesForOcr(buffer, { maxPages: OCR_PAGE_LIMIT });
  } catch {
    return { text: '', images: [] };
  }
  const images = saveImages
    ? await saveFoundImages(
        userId,
        rendered.pages.map((page) => ({
          page: page.page,
          type: 'page',
          width: page.width,
          height: page.height,
          buffer: page.buffer,
        })),
      )
    : [];

  const parts = [];
  let collected = 0;
  let backend = null;
  for (const page of rendered.pages) {
    if (collected > DOCUMENT_MAX_CHARS) break;
    let text = '';
    try {
      const result = await recognizeText(page.buffer);
      text = result.text;
      if (text) backend = result.backend;
    } catch {
      // A single page failing OCR must not throw away the pages that worked.
      continue;
    }
    if (!text) continue;
    collected += text.length;
    parts.push(
      rendered.pages.length > 1 ? `## 第 ${page.page} 页\n${text}` : text,
    );
  }
  const note =
    rendered.totalPages > rendered.pages.length
      ? `\n\n…（PDF 共 ${rendered.totalPages} 页，已识别前 ${rendered.pages.length} 页）`
      : '';
  return {
    text: parts.length ? `${parts.join('\n\n')}${note}` : '',
    images,
    backend,
  };
}

// The rendered sheet is the only picture a DWG yields, and it is derived from
// the user's drawing rather than created by the model, so it lives beside
// uploaded images without entering the gallery.
async function storeDwgImage(userId, drawing) {
  const saved = await saveImageBuffer(userId, drawing.buffer, 'png');
  return [
    {
      id: saved.id,
      url: saved.url,
      ext: 'png',
      page: 1,
      type: 'page',
      width: drawing.width,
      height: drawing.height,
    },
  ];
}

export async function handleDocumentUpload(req, res, user) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  const name = decodeFileName(req.headers['x-file-name']);
  const ext = documentExt(name) || DOCUMENT_EXT_BY_TYPE[contentType] || '';
  if (!ext || !isSupportedDocumentExt(ext)) {
    throw new AppError(415, documentUnsupportedMessage(ext));
  }

  const buffer = await readBody(req, DOCUMENT_MAX_BYTES);
  if (!buffer.length) throw new AppError(400, '空文件');
  if (ZIP_EXTS.has(ext) && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
  }
  if (ext === 'pdf' && !buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
  }
  if (ext === 'dwg' && !isDwgBuffer(buffer)) {
    throw new AppError(400, '文件内容与扩展名不匹配，请确认文件没有损坏');
  }

  // A CAD file is all vectors, so it produces one rendered reference image
  // instead of text or embedded bitmaps.
  if (ext === 'dwg') {
    const drawing = await renderDwg(buffer, { name });
    const images = await storeDwgImage(user.id, drawing);
    const document = await saveDocument(user.id, buffer, {
      name: name || `附件.${ext}`,
      ext,
      text: drawing.text,
      kind: drawing.kind,
      chars: drawing.text.length,
      images,
    });
    return json(res, 200, {
      id: document.id,
      name: document.name,
      ext: document.ext,
      kind: document.kind,
      size: document.size,
      chars: document.chars,
      truncated: false,
      images,
    });
  }

  const parsed = await extractDocumentTextAsync(buffer, ext);
  let text = parsed.text;
  let images = ext === 'pdf' ? await storePdfImages(user.id, buffer) : [];
  let kind = parsed.kind;
  let chars = parsed.chars;
  let truncated = parsed.truncated;
  let ocr = null;
  // A PDF with no text layer is nearly always a scan. OCR it so the model gets
  // readable text instead of only pictures; the pages stay usable as reference
  // images either way.
  if (ext === 'pdf' && !text.trim()) {
    const scanned = await ocrScannedPdf(user.id, buffer, { saveImages: !images.length });
    if (scanned.text) {
      text = scanned.text;
      kind = 'PDF 扫描件';
      chars = scanned.text.length;
      truncated = false;
      ocr = scanned.backend;
    }
    if (!images.length) images = scanned.images;
  }
  if (!text && !images.length) {
    throw new AppError(415, 'PDF 中没有可提取的文字或图片，请确认扫描件没有损坏');
  }
  const rendered = images.filter((image) => image.type === 'page').length;
  const placeholder = rendered
    ? `（该 PDF 没有可提取的文字，已把 ${rendered} 页渲染成图片，可直接用作参考图）`
    : `（该 PDF 没有可提取的文字，已提取 ${images.length} 张内嵌图片，可直接用作参考图）`;
  const document = await saveDocument(user.id, buffer, {
    name: name || `附件.${ext}`,
    ext,
    text: text || placeholder,
    kind,
    chars,
    images,
  });
  return json(res, 200, {
    id: document.id,
    name: document.name,
    ext: document.ext,
    kind: document.kind,
    size: document.size,
    chars: document.chars,
    truncated,
    ocr,
    images,
  });
}