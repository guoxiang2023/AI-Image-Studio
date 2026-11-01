import { getDb } from '../database.js';

export function listGalleryImages(userId) {
  return getDb()
    .prepare('SELECT * FROM gallery_images WHERE user_id = ? AND hidden = 0 ORDER BY created_at DESC')
    .all(userId);
}

export function findGalleryImage(userId, id) {
  return getDb()
    .prepare('SELECT * FROM gallery_images WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

export function insertGalleryImage({
  id,
  userId,
  ext,
  prompt,
  size,
  aspectRatio,
  chatId,
  createdAt,
  groupId,
  parentId,
  model,
  quality,
  caption,
}) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO gallery_images
        (id, user_id, ext, prompt, size, aspect_ratio, chat_id, folder_id, created_at,
         group_id, parent_id, model, quality, caption)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      ext || 'png',
      prompt || '',
      size || null,
      aspectRatio || null,
      chatId || null,
      createdAt || Date.now(),
      groupId || null,
      parentId || null,
      model || null,
      quality || null,
      caption || '',
    );
}

export function setGalleryImageFavorite(userId, id, favorite) {
  getDb()
    .prepare('UPDATE gallery_images SET favorite = ? WHERE id = ? AND user_id = ?')
    .run(favorite ? 1 : 0, id, userId);
}

export function setGalleryImageTags(userId, id, tagsJson) {
  getDb()
    .prepare('UPDATE gallery_images SET tags_json = ? WHERE id = ? AND user_id = ?')
    .run(tagsJson, id, userId);
}

export function hideGalleryImage(userId, id) {
  getDb()
    .prepare('UPDATE gallery_images SET hidden = 1 WHERE id = ? AND user_id = ?')
    .run(id, userId);
}

export function moveGalleryImage(userId, id, folderId) {
  getDb()
    .prepare('UPDATE gallery_images SET folder_id = ? WHERE id = ? AND user_id = ?')
    .run(folderId, id, userId);
}

export function createGalleryFolder({ id, userId, name, createdAt }) {
  getDb()
    .prepare('INSERT INTO gallery_folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, name, createdAt || Date.now());
}

export function listGalleryFolders(userId) {
  return getDb()
    .prepare('SELECT * FROM gallery_folders WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC')
    .all(userId);
}

export function findGalleryFolder(userId, id) {
  return getDb()
    .prepare('SELECT * FROM gallery_folders WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

export function deleteGalleryFolder(userId, id) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    database
      .prepare('UPDATE gallery_images SET folder_id = NULL WHERE folder_id = ? AND user_id = ?')
      .run(id, userId);
    database
      .prepare('DELETE FROM gallery_folders WHERE id = ? AND user_id = ?')
      .run(id, userId);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}
