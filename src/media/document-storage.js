import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { USERS_DIR } from '../config.js';
import { newId, now } from '../shared/utils.js';

export function userDocumentDir(userId) {
  return path.join(USERS_DIR, userId, 'documents');
}

export function generatedDocumentDir(userId) {
  return path.join(userDocumentDir(userId), 'generated');
}

export function generatedDocumentPath(userId, id, format) {
  return path.join(generatedDocumentDir(userId), `${id}.${format}`);
}

function documentPath(userId, id, ext) {
  return path.join(userDocumentDir(userId), `${id}.${ext}`);
}

export function normalizeDocumentName(name, ext) {
  const raw = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = raw || `附件.${ext}`;
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

export async function saveDocument(userId, buffer, { name, ext, text, kind, chars }) {
  const dir = userDocumentDir(userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = newId();
  const safeName = normalizeDocumentName(name, ext);
  const meta = {
    id,
    name: safeName,
    ext,
    kind,
    size: buffer.length,
    chars,
    createdAt: now(),
  };
  await writeFile(documentPath(userId, id, ext), buffer, { mode: 0o600 });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  await writeFile(path.join(dir, `${id}.txt`), text, { mode: 0o600 });
  return meta;
}

export async function saveGeneratedDocumentFile(userId, id, format, buffer) {
  const dir = generatedDocumentDir(userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = generatedDocumentPath(userId, id, format);
  await writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

export async function findDocument(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(id || '')) return null;
  const dir = userDocumentDir(userId);
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (!meta || meta.id !== id) return null;
  try {
    const st = await stat(documentPath(userId, id, meta.ext));
    if (!st.isFile()) return null;
    const text = await readFile(path.join(dir, `${id}.txt`), 'utf8');
    return { ...meta, text };
  } catch {
    return null;
  }
}
