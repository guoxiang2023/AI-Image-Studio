import { unlink } from 'node:fs/promises';
import {
  deleteGeneratedDocument as deleteRow,
  getGeneratedDocument as getRow,
  insertGeneratedDocument,
  listGeneratedDocuments as listRows,
} from '../data/repositories/documents.js';
import {
  generatedDocumentPath,
  saveGeneratedDocumentFile,
} from '../media/document-storage.js';
import { newId, now } from '../shared/utils.js';

function publicRow(row) {
  return {
    id: row.id,
    chatId: row.chat_id || null,
    chatTitle: row.chat_title || '',
    title: row.title,
    filename: row.filename,
    format: row.format,
    size: row.size,
    imageCount: row.image_count || 0,
    createdAt: row.created_at,
  };
}

export async function saveGeneratedDocument({
  userId,
  chatId,
  title,
  filename,
  format,
  buffer,
  imageCount,
  preview,
}) {
  const id = newId();
  const createdAt = now();
  const safeFormat = format === 'docx' ? 'docx' : 'pdf';
  await saveGeneratedDocumentFile(userId, id, safeFormat, buffer);
  const document = {
    id,
    userId,
    chatId: chatId || null,
    title: title || '文档',
    filename: filename || `文档.${safeFormat}`,
    format: safeFormat,
    size: buffer.length,
    imageCount: imageCount || 0,
    previewJson: JSON.stringify(Array.isArray(preview) ? preview : []),
    createdAt,
  };
  try {
    insertGeneratedDocument(document);
  } catch (err) {
    try {
      await unlink(generatedDocumentPath(userId, id, safeFormat));
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return {
    id,
    chatId: document.chatId,
    title: document.title,
    filename: document.filename,
    format: document.format,
    size: document.size,
    imageCount: document.imageCount,
    createdAt: document.createdAt,
  };
}

export function listUserDocuments(userId) {
  return listRows(userId).map(publicRow);
}

export function getUserDocument(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(id || '')) return null;
  const row = getRow(userId, id);
  if (!row) return null;
  let blocks = [];
  try {
    blocks = JSON.parse(row.preview_json || '[]');
  } catch {
    blocks = [];
  }
  return { ...publicRow(row), blocks };
}

export async function deleteUserDocument(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(id || '')) return false;
  const row = getRow(userId, id);
  if (!row) return false;
  try {
    await unlink(generatedDocumentPath(userId, id, row.format));
  } catch {
    /* the DB row is still authoritative */
  }
  return deleteRow(userId, id);
}

export function userDocumentPath(userId, document) {
  return generatedDocumentPath(userId, document.id, document.format);
}
