import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MIME, RATIO_SIZE, USERS_DIR, VALID_SIZES } from '../config.js';
import { inferAspectRatio, padPngToRatio, pngSize } from './png.js';
import { newId } from '../shared/utils.js';

export function userImageDir(userId) {
  return path.join(USERS_DIR, userId, 'images');
}

export async function saveImageBuffer(userId, buffer, ext = 'png') {
  const dir = userImageDir(userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = newId();
  const e = ext === 'jpeg' ? 'jpg' : ext;
  await writeFile(path.join(dir, `${id}.${e}`), buffer, { mode: 0o600 });
  return { id, url: `/files/${id}.${e}` };
}

export async function findImageFile(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(id || '')) return null;
  const dir = userImageDir(userId);
  for (const ext of ['png', 'jpg', 'webp', 'svg']) {
    const filePath = path.join(dir, `${id}.${ext}`);
    try {
      const st = await stat(filePath);
      if (st.isFile()) return { path: filePath, ext, mime: MIME[ext] };
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function itemToBuffer(item, signal) {
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const res = await fetch(item.url, { signal });
    if (!res.ok) throw new Error(`下载生成图片失败 (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('图片模型没有返回图片数据');
}

export function resolveSize(aspectRatio, size) {
  if (size && VALID_SIZES.has(size)) return size;
  return RATIO_SIZE[aspectRatio] || '1024x1024';
}

export function finalizeRaster(buffer, aspectRatio) {
  if (!aspectRatio) return buffer;
  return padPngToRatio(buffer, aspectRatio) || buffer;
}

export function actualImageSize(buffer, fallback) {
  const dims = pngSize(buffer);
  return dims ? `${dims.width}x${dims.height}` : fallback;
}

export async function probeImageSize(filePath, ext) {
  try {
    if (ext === 'png') {
      const fh = await open(filePath, 'r');
      try {
        const head = Buffer.alloc(24);
        await fh.read(head, 0, 24, 0);
        if (head.toString('ascii', 1, 4) === 'PNG') {
          return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
        }
      } finally {
        await fh.close();
      }
    }
    if (ext === 'jpg') {
      const buf = await readFile(filePath);
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function sizeFromDimensions(width, height) {
  if (!width || !height) return '1024x1024';
  if (height > width * 1.15) return '1024x1536';
  if (width > height * 1.15) return '1536x1024';
  return '1024x1024';
}

export { inferAspectRatio };
