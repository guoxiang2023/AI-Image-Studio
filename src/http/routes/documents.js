import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { json } from '../responses.js';
import {
  deleteUserDocument,
  getUserDocument,
  listUserDocuments,
  userDocumentPath,
} from '../../services/document-library-service.js';

function contentDisposition(filename, format, inline) {
  const fallback =
    format === 'pdf' ? 'luma-document.pdf' : 'luma-document.docx';
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
  const filePath = userDocumentPath(user.id, document);
  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: '文档文件已失效' });
  }
  res.writeHead(200, {
    'Content-Type':
      document.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
