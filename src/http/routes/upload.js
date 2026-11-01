import { IMAGE_EXT_BY_TYPE } from '../../config.js';
import { json, readBody } from '../responses.js';
import { saveImageBuffer } from '../../media/image-storage.js';

export async function handleUpload(req, res, user) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_EXT_BY_TYPE[contentType];
  if (!ext) return json(res, 415, { error: '只支持 PNG / JPEG / WebP 图片' });
  const buffer = await readBody(req, 25 * 1024 * 1024);
  if (!buffer.length) return json(res, 400, { error: '空文件' });
  const image = await saveImageBuffer(user.id, buffer, ext);
  return json(res, 200, { imageId: image.id, url: image.url });
}
