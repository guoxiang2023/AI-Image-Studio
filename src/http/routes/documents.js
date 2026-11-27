import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { json, readJsonBody } from '../responses.js';
import { loadChatForUser } from '../../services/chat-service.js';
import { generateSelectedDocument, listSessionDocumentImages } from '../../services/document-service.js';
import {
  deleteUserDocument,
  getUserDocument,
  listUserDocuments,
  userDocumentPath,
} from '../../services/document-library-service.js';

const FORMAT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function contentDisposition(filename, format, inline) {
  const ext = FORMAT_MIME[format] ? format : 'docx';
  const fallback = `document.${ext}`;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveDocumentFile(res, user, id, { inline = false } = {}) {
  const document = getUserDocument(user.id, id);
  if (!document) return json(res, 404, { error: '文档不存在' });
  if (inline && document.format !== 'pdf') {
    return json(res, 415, { error: '只有 PDF 可以在浏览器中打开' });
  }
  const mime = FORMAT_MIME[document.format] || FORMAT_MIME.docx;
  const filePath = userDocumentPath(user.id, document);
  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: '文档文件已失效' });
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': fileStat.size,
    'Content-Disposition': contentDisposition(
      document.filename,
      document.format,
      inline,
    ),
    'Cache-Control': 'private, no-store',
  });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

export async function handleSessionDocumentImages(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  return json(res, 200, { images: await listSessionDocumentImages(user, chat) });
}

export async function handleGenerateSelectedDocument(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  const body = await readJsonBody(req);
  if (!['docx', 'pdf'].includes(body?.format) || !Array.isArray(body.imageIds) ||
      !body.imageIds.every((id) => typeof id === 'string' && /^[a-f0-9]{16,40}$/.test(id))) {
    return json(res, 400, { error: '请选择 Word 或 PDF，并提供会话图片列表' });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    const result = await generateSelectedDocument({ user, chat, format: body.format, imageIds: body.imageIds, signal: controller.signal });
    return json(res, 201, result);
  } finally {
    res.off('close', abort);
  }
}

export function handleListDocuments(req, res, user) {
  return json(res, 200, { documents: listUserDocuments(user.id) });
}

export async function handleDocument(req, res, user, id) {
  const document = getUserDocument(user.id, id);
  if (!document) return json(res, 404, { error: '文档不存在' });
  if (req.method === 'GET') return json(res, 200, document);
  if (req.method === 'DELETE') {
    await deleteUserDocument(user.id, id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method Not Allowed' });
}

export function handleDocumentDownload(req, res, user, id) {
  return serveDocumentFile(res, user, id, { inline: false });
}

export function handleDocumentFile(req, res, user, id) {
  return serveDocumentFile(res, user, id, { inline: true });
}
