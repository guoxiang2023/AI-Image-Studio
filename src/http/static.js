import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { MIME, PUBLIC_DIR } from '../config.js';
import { json } from './responses.js';
import { userImageDir } from '../media/image-storage.js';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export async function serveStatic(res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not file');
  } catch {
    if (path.extname(pathname)) return json(res, 404, { error: 'not found' });
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

export async function serveImageFile(res, userId, name) {
  if (!/^[a-f0-9]{16,40}\.(png|jpg|webp|svg)$/.test(name)) {
    return json(res, 404, { error: 'not found' });
  }
  const filePath = path.join(userImageDir(userId), name);
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': MIME[name.split('.').pop()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}
