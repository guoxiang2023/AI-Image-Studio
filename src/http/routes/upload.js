import { DOCUMENT_MAX_BYTES, IMAGE_EXT_BY_TYPE } from '../../config.js';
import { json, readBody } from '../responses.js';
import { saveImageBuffer } from '../../media/image-storage.js';
import {
  ZIP_EXTS,
  documentExt,
  documentUnsupportedMessage,
  extractDocumentTextAsync,
  isSupportedDocumentExt,
} from '../../media/document-text.js';
import { saveDocument } from '../../media/document-storage.js';
import { AppError } from '../../shared/errors.js';

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

  const parsed = await extractDocumentTextAsync(buffer, ext);
  const document = await saveDocument(user.id, buffer, {
    name: name || `附件.${ext}`,
    ext,
    text: parsed.text,
    kind: parsed.kind,
    chars: parsed.chars,
  });
  return json(res, 200, {
    id: document.id,
    name: document.name,
    ext: document.ext,
    kind: document.kind,
    size: document.size,
    chars: document.chars,
    truncated: parsed.truncated,
  });
}
