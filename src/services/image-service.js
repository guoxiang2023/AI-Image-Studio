import { insertGalleryImage } from '../data/repositories/gallery.js';

export function recordGalleryImage(ctx, img, prompt, size, aspectRatio, meta = {}) {
  try {
    insertGalleryImage({
      id: img.id,
      userId: ctx.user.id,
      ext: 'png',
      prompt,
      size,
      aspectRatio: aspectRatio || null,
      chatId: ctx.chat?.id || null,
      createdAt: Date.now(),
      groupId: meta.groupId || null,
      parentId: meta.parentId || null,
      model: meta.model || null,
      quality: meta.quality || null,
      caption: meta.caption || '',
    });
  } catch (err) {
    console.warn('画册登记失败:', err.message);
  }
}
