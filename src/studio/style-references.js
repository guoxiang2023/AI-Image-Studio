import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { PUBLIC_DIR, USERS_DIR, MIME } from '../config.js';

/**
 * Curated art-direction references bundled with the app. They are examples of
 * the visual language the image model can borrow; generation never exposes the
 * public file path directly.
 */
export const STYLE_REFERENCES = [
  {
    id: 'banner-702x186',
    name: '活动专区 Banner',
    category: 'Banner',
    use: '横版活动入口、频道焦点图',
    file: 'banner-702x186.png',
    thumb: 'thumbs/banner-702x186.webp',
    width: 702,
    height: 186,
    ratio: '702×186',
    defaultAspect: '16:9',
  },
  {
    id: 'banner-313x162',
    name: '小尺寸 Banner',
    category: 'Banner',
    use: '信息流、弹窗入口、移动端卡片',
    file: 'banner-313x162.png',
    thumb: 'thumbs/banner-313x162.webp',
    width: 313,
    height: 162,
    ratio: '313×162',
    defaultAspect: '16:9',
  },
  {
    id: 'cover-900x383',
    name: '公众号封面',
    category: '封面',
    use: '文章头图、推送封面',
    file: 'cover-900x383.jpg',
    thumb: 'thumbs/cover-900x383.webp',
    width: 900,
    height: 383,
    ratio: '900×383',
    defaultAspect: '16:9',
  },
  {
    id: 'popup-574x676',
    name: '活动弹窗',
    category: '弹窗',
    use: '抽奖、会员权益、活动提醒',
    file: 'popup-574x676.png',
    thumb: 'thumbs/popup-574x676.webp',
    width: 574,
    height: 676,
    ratio: '574×676',
    defaultAspect: '3:4',
  },
  {
    id: 'poster-15',
    name: '15 元会员海报',
    category: '海报',
    use: '价格权益、会员订购',
    file: 'poster-15.png',
    thumb: 'thumbs/poster-15.webp',
    width: 750,
    height: 1400,
    ratio: '750×1400',
    defaultAspect: '3:4',
  },
  {
    id: 'poster-travel',
    name: '出行迎新海报',
    category: '海报',
    use: '校园、出行、跨场景权益',
    file: 'poster-travel.png',
    thumb: 'thumbs/poster-travel.webp',
    width: 750,
    height: 1384,
    ratio: '750×1384',
    defaultAspect: '3:4',
  },
  {
    id: 'poster-festival',
    name: '节日美食海报',
    category: '海报',
    use: '节庆促销、餐饮、本地生活',
    file: 'poster-festival.png',
    thumb: 'thumbs/poster-festival.webp',
    width: 750,
    height: 1334,
    ratio: '750×1334',
    defaultAspect: '3:4',
  },
  {
    id: 'feed-345x510',
    name: '信息流卡片',
    category: '信息流',
    use: '瀑布流、商品推荐、活动卡片',
    file: 'feed-345x510.png',
    thumb: 'thumbs/feed-345x510.webp',
    width: 345,
    height: 510,
    ratio: '345×510',
    defaultAspect: '2:3',
  },
  {
    id: 'page-products',
    name: '商品权益页',
    category: '长图',
    use: '商品宫格、权益兑换、活动页',
    file: 'page-products.png',
    thumb: 'thumbs/page-products.webp',
    width: 750,
    height: 1545,
    ratio: '750×1545',
    defaultAspect: '9:16',
  },
  {
    id: 'splash-1242x2208',
    name: '启动页',
    category: '启动页',
    use: 'APP 开屏、品牌活动',
    file: 'splash-1242x2208.png',
    thumb: 'thumbs/splash-1242x2208.webp',
    width: 1242,
    height: 2208,
    ratio: '1242×2208',
    defaultAspect: '9:16',
  },
];

export function findStyleReference(id) {
  return STYLE_REFERENCES.find((ref) => ref.id === id) || null;
}

export function publicStyleReferences() {
  return STYLE_REFERENCES.map((ref) => ({
    ...ref,
    imageUrl: `/style-references/${ref.file}`,
    thumbUrl: `/style-references/${ref.thumb}`,
  }));
}

/**
 * Copy a bundled reference into the user's image store once, with a stable
 * ID derived from the style id. The image tool can then treat it like any
 * uploaded reference without exposing PUBLIC_DIR paths.
 */
export async function materializeStyleReference(userId, styleId) {
  const ref = findStyleReference(styleId);
  if (!ref) return null;
  const ext = ref.file.endsWith('.jpg') ? 'jpg' : 'png';
  const id = createHash('sha256').update(`style:${styleId}`).digest('hex').slice(0, 24);
  const dir = path.join(USERS_DIR, userId, 'images');
  const filePath = path.join(dir, `${id}.${ext}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await stat(filePath);
  } catch {
    const buffer = await readFile(path.join(PUBLIC_DIR, 'style-references', ref.file));
    await writeFile(filePath, buffer, { mode: 0o600 });
  }
  return { id, url: `/files/${id}.${ext}`, ext, mime: MIME[ext], reference: ref };
}
