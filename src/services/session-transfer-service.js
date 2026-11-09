import { readFile } from 'node:fs/promises';
import { createChatDocument, serializeChat } from '../domain/chat.js';
import { insertChat } from '../data/repositories/chats.js';
import { findImageFile, saveImageBuffer } from '../media/image-storage.js';
import { createZip } from '../media/zip-writer.js';
import { openZip } from '../media/zip-reader.js';
import { AppError } from '../shared/errors.js';
import { clipText, now } from '../shared/utils.js';
import { loadChatForUser } from './chat-service.js';

const FORMAT = 'luma-session';
const VERSION = 1;
const ID_RE = /^[a-f0-9]{16,40}$/;
const IMAGE_EXT_RE = /^(png|jpe?g|webp)$/;
const MAX_IMAGES = 500;
const MAX_MESSAGES = 1000;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_ATTACHMENT_CHARS = 200_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 96 * 1024 * 1024;

export const SESSION_IMPORT_MAX_BYTES = MAX_TOTAL_IMAGE_BYTES;

function addImageId(map, id, url) {
  const value = String(id || '');
  if (!ID_RE.test(value) || map.has(value)) return;
  map.set(value, { id: value, url: String(url || '') });
}

function collectImageIds(chat) {
  const map = new Map();
  for (const message of chat.messages || []) {
    for (const image of message.images || []) {
      addImageId(map, image.id, image.url);
    }
    for (const reference of message.references || []) {
      addImageId(map, reference.id, reference.url);
    }
    if (message.referenceImageId) {
      addImageId(map, message.referenceImageId, message.referenceUrl);
    }
  }
  if (chat.lastImageId) addImageId(map, chat.lastImageId, '');
  return map;
}

function safeExportName(title) {
  const name = String(title || 'Luma 会话')
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E]/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .replace(/[. ]+$/, '');
  return `${name || 'Luma 会话'}.luma-session.zip`;
}

/**
 * Builds a portable ZIP with a manifest and only the image files still
 * referenced by the session. Missing images are omitted; import drops their
 * dangling references instead of creating broken cards.
 */
export async function buildSessionExport(user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) throw new AppError(404, '会话不存在');
  if (!Array.isArray(chat.messages) || !chat.messages.length) {
    throw new AppError(400, '会话还没有内容，无法导出');
  }

  const imageIds = collectImageIds(chat);
  if (imageIds.size > MAX_IMAGES) {
    throw new AppError(413, `会话图片过多（最多 ${MAX_IMAGES} 张）`);
  }

  const images = [];
  let totalBytes = 0;
  for (const item of imageIds.values()) {
    const file = await findImageFile(user.id, item.id);
    if (!file) continue;
    const data = await readFile(file.path);
    if (!data.length) continue;
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new AppError(413, '会话图片过大，无法导出（上限 96MB）');
    }
    images.push({
      id: item.id,
      ext: file.ext,
      data,
    });
  }

  const manifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt: now(),
    session: {
      title: chat.title || '',
      messages: chat.messages,
      lastImageId: chat.lastImageId || null,
    },
    images: images.map((image) => ({
      id: image.id,
      ext: image.ext,
      file: `images/${image.id}.${image.ext}`,
    })),
  };

  const entries = [
    {
      name: 'manifest.json',
      data: JSON.stringify(manifest, null, 2),
    },
    ...images.map((image) => ({
      name: `images/${image.id}.${image.ext}`,
      data: image.data,
      compress: false,
    })),
  ];

  return {
    buffer: createZip(entries),
    filename: safeExportName(chat.title),
    images: images.length,
  };
}

function imageSignatureOk(data, ext) {
  if (ext === 'png') {
    return data.length >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a;
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (ext === 'webp') {
    return data.length >= 12 &&
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function mappedImage(map, id) {
  return map.get(String(id || '')) || null;
}

function normalizeImages(rawImages, imageMap) {
  const images = [];
  for (const raw of Array.isArray(rawImages) ? rawImages : []) {
    if (!raw || typeof raw !== 'object') continue;
    const mapped = mappedImage(imageMap, raw.id);
    if (!mapped || images.some((image) => image.id === mapped.id)) continue;
    const parent = mappedImage(imageMap, raw.parentId);
    images.push({
      id: mapped.id,
      url: mapped.url,
      prompt: clipText(String(raw.prompt || ''), 20_000),
      caption: clipText(String(raw.caption || ''), 500),
      size: clipText(String(raw.size || ''), 40),
      aspectRatio: clipText(String(raw.aspectRatio || ''), 20),
      groupId: clipText(String(raw.groupId || ''), 80),
      parentId: parent?.id || null,
      model: clipText(String(raw.model || ''), 120),
      quality: clipText(String(raw.quality || ''), 30),
    });
  }
  return images;
}

function normalizeReferences(rawReferences, imageMap) {
  const references = [];
  for (const raw of Array.isArray(rawReferences) ? rawReferences : []) {
    if (!raw || typeof raw !== 'object') continue;
    const mapped = mappedImage(imageMap, raw.id);
    if (!mapped || references.some((reference) => reference.id === mapped.id)) continue;
    references.push({
      id: mapped.id,
      url: mapped.url,
      role: clipText(String(raw.role || '参考'), 20),
    });
  }
  return references;
}

function normalizeAttachments(rawAttachments) {
  const attachments = [];
  for (const raw of Array.isArray(rawAttachments) ? rawAttachments : []) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_ATTACHMENT_CHARS) : '';
    const size = Number(raw.size);
    const chars = Number(raw.chars);
    attachments.push({
      id: clipText(String(raw.id || ''), 80),
      name: clipText(String(raw.name || '附件'), 200),
      ext: clipText(String(raw.ext || ''), 20),
      kind: clipText(String(raw.kind || ''), 50),
      size: Number.isFinite(size) ? Math.max(0, size) : 0,
      chars: Number.isFinite(chars) ? Math.max(0, chars) : text.length,
      text,
      truncated: Boolean(raw.truncated),
    });
  }
  return attachments;
}

function normalizeMessages(rawMessages, imageMap) {
  const messages = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
    if (!role) continue;

    const content = typeof raw.content === 'string'
      ? clipText(raw.content, MAX_MESSAGE_CHARS)
      : '';
    const images = normalizeImages(raw.images, imageMap);
    const message = {
      role,
      content,
      ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : now(),
    };
    if (images.length) message.images = images;

    if (role === 'user') {
      const references = normalizeReferences(raw.references, imageMap);
      if (references.length) {
        message.references = references;
        message.referenceImageId = references[0].id;
        message.referenceUrl = references[0].url;
      } else {
        const reference = mappedImage(imageMap, raw.referenceImageId);
        if (reference) {
          message.referenceImageId = reference.id;
          message.referenceUrl = reference.url;
        }
      }
      const attachments = normalizeAttachments(raw.attachments);
      if (attachments.length) message.attachments = attachments;
    }

    if (role === 'assistant' && !message.content && !message.images?.length) continue;
    messages.push(message);
    if (messages.length > MAX_MESSAGES) {
      throw new AppError(400, `会话消息过多（最多 ${MAX_MESSAGES} 条）`);
    }
  }
  return messages;
}

/**
 * Imports a session archive with new image IDs so it can safely coexist with
 * the current account's files. Messages are rebuilt from a small whitelist of
 * fields; manifest extras never get copied into the database.
 */
export async function importSessionArchive(user, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError(400, '会话文件为空');
  }
  if (buffer.length > SESSION_IMPORT_MAX_BYTES) {
    throw new AppError(413, '会话文件过大（上限 96MB）');
  }

  let zip;
  try {
    zip = openZip(buffer);
  } catch {
    throw new AppError(400, '会话文件无效或已损坏');
  }

  const manifestText = zip.readText('manifest.json');
  if (!manifestText) throw new AppError(400, '会话文件缺少 manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new AppError(400, '会话文件内容损坏');
  }
  if (
    !manifest ||
    manifest.format !== FORMAT ||
    Number(manifest.version) !== VERSION ||
    !manifest.session ||
    !Array.isArray(manifest.session.messages)
  ) {
    throw new AppError(400, '不是可导入的 Luma 会话文件');
  }
  if (!manifest.session.messages.length) {
    throw new AppError(400, '会话文件没有可导入的消息');
  }
  if (manifest.session.messages.length > MAX_MESSAGES) {
    throw new AppError(400, `会话消息过多（最多 ${MAX_MESSAGES} 条）`);
  }

  const rawImages = Array.isArray(manifest.images) ? manifest.images : [];
  if (rawImages.length > MAX_IMAGES) {
    throw new AppError(400, `会话图片过多（最多 ${MAX_IMAGES} 张）`);
  }

  const imageMap = new Map();
  let totalImageBytes = 0;
  for (const raw of rawImages) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '');
    const ext = String(raw.ext || '').toLowerCase();
    if (!ID_RE.test(id) || !IMAGE_EXT_RE.test(ext) || imageMap.has(id)) continue;
    const entry = `images/${id}.${ext}`;
    if (!zip.has(entry)) continue;
    const data = zip.read(entry);
    if (!data?.length) continue;
    totalImageBytes += data.length;
    if (data.length > MAX_IMAGE_BYTES || totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new AppError(413, '会话图片过大（上限 96MB）');
    }
    if (!imageSignatureOk(data, ext)) {
      throw new AppError(400, '会话文件中的图片格式无效');
    }
    const saved = await saveImageBuffer(user.id, data, ext === 'jpeg' ? 'jpg' : ext);
    imageMap.set(id, { id: saved.id, url: saved.url });
  }

  const messages = normalizeMessages(manifest.session.messages, imageMap);
  if (!messages.length) throw new AppError(400, '会话文件没有可导入的消息');

  let lastImageId = mappedImage(imageMap, manifest.session.lastImageId)?.id || null;
  if (!lastImageId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const images = messages[index].images;
      if (images?.length) {
        lastImageId = images[images.length - 1].id;
        break;
      }
    }
  }

  const title = clipText(
    String(manifest.session.title || '')
      .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  ) || '导入的会话';

  const chat = createChatDocument(user.id);
  chat.title = title;
  chat.messages = messages;
  chat.lastImageId = lastImageId;
  insertChat(serializeChat(chat));

  return {
    id: chat.id,
    title: chat.title,
    messages: messages.length,
    images: imageMap.size,
  };
}
