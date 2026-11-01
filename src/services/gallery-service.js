import {
  createGalleryFolder,
  deleteGalleryFolder,
  findGalleryFolder,
  findGalleryImage,
  hideGalleryImage,
  listGalleryFolders,
  listGalleryImages,
  moveGalleryImage,
  setGalleryImageFavorite,
  setGalleryImageTags,
} from '../data/repositories/gallery.js';
import { parseTagsJson, normalizeTags } from '../domain/chat-options.js';
import { AppError } from '../shared/errors.js';
import { newId } from '../shared/utils.js';

export function getGallery(userId) {
  const images = listGalleryImages(userId).map((row) => ({
    id: row.id,
    url: `/files/${row.id}.${row.ext}`,
    prompt: row.prompt,
    size: row.size,
    aspectRatio: row.aspect_ratio,
    createdAt: row.created_at,
    folderId: row.folder_id,
    chatId: row.chat_id,
    groupId: row.group_id,
    parentId: row.parent_id,
    model: row.model,
    quality: row.quality,
    caption: row.caption || '',
    favorite: Boolean(row.favorite),
    tags: parseTagsJson(row.tags_json),
  }));
  const folders = listGalleryFolders(userId).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }));
  return { images, folders };
}

export function createFolder(userId, body) {
  const name = String(body.name || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new AppError(400, '请输入文件夹名称');
  if ([...name].length > 30) throw new AppError(400, '文件夹名称最多 30 个字符');
  if (/[\u0000-\u001f]/.test(name)) throw new AppError(400, '文件夹名称包含非法字符');

  const folder = { id: newId(), userId, name, createdAt: Date.now() };
  try {
    createGalleryFolder(folder);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new AppError(409, '文件夹已存在');
    }
    throw err;
  }
  return { id: folder.id, name: folder.name, createdAt: folder.createdAt };
}

export function deleteFolder(userId, folderId) {
  const folder = findGalleryFolder(userId, folderId);
  if (!folder) throw new AppError(404, '文件夹不存在');
  deleteGalleryFolder(userId, folderId);
}

export function updateImage(userId, imageId, body) {
  const image = findGalleryImage(userId, imageId);
  if (!image) throw new AppError(404, '图片不存在');

  if ('folderId' in body) {
    const folderId = body.folderId ? String(body.folderId) : null;
    if (folderId && !findGalleryFolder(userId, folderId)) {
      throw new AppError(400, '文件夹不存在');
    }
    moveGalleryImage(userId, imageId, folderId);
  }
  if ('favorite' in body) {
    setGalleryImageFavorite(userId, imageId, Boolean(body.favorite));
  }
  if ('tags' in body) {
    setGalleryImageTags(userId, imageId, JSON.stringify(normalizeTags(body.tags)));
  }
}

export function hideImage(userId, imageId) {
  const image = findGalleryImage(userId, imageId);
  if (!image) throw new AppError(404, '图片不存在');
  hideGalleryImage(userId, imageId);
}
