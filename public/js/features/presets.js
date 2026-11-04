// Preview assets and style traits are adapted from handraw-style by yang0.
// Source: https://github.com/yang0/handraw-style (MIT with attribution).
// Curated to sixteen styles so the picker stays fast and scannable.

export const STYLE_PRESETS = [
  {
    id: 'handraw-fa-001',
    title: '冷面涂鸦',
    category: '插画',
    desc: '松散黑线、少量点色、白色纸面、冷面幽默',
    aspect: '4:3',
    image: '/assets/presets/fa-001.webp',
    style:
      '冷面涂鸦（Playful Deadpan Doodle）：松散黑线、少量点色、白色纸面；轮廓优先于细节，形状简洁而有个性；表情克制或突然夸张，姿态有清楚喜剧节奏；避免统一可爱微笑。',
    sourceId: 'FA-001',
  },
  {
    id: 'handraw-fa-021',
    title: '水彩生活手记',
    category: '插画',
    desc: '细黑线、柔和水彩、单一红色强调、留白',
    aspect: '3:4',
    image: '/assets/presets/fa-021.webp',
    style:
      '水彩生活手记（Watercolor Handwritten Life Notes）：细黑线、细长简练造型、柔和水彩点染、单一红色强调、白底留白、轻微纸张质感。',
    sourceId: 'FA-021',
  },
  {
    id: 'handraw-fc-029',
    title: '轻盈扁平矢量',
    category: '平面',
    desc: '干净轮廓、低饱和平面色、大量空气感留白',
    aspect: '4:3',
    image: '/assets/presets/fc-029.webp',
    style:
      '轻盈扁平矢量（Clean Airy Flat Vector Illustration）：轮廓清晰的大面积平涂色块塑造形体；造型适度概括与圆润几何化，保留关键识别特征；每个区域最多两级平面明暗与清晰硬边阴影，通过色块明度、冷暖和面积对比表现空间层次；色彩明亮清爽、柔和通透，纯净平滑的画面质感；极简主义、简洁现代，具有轻盈的现代商业插画与编辑插画感。',
    sourceId: 'FC-029',
  },
  {
    id: 'handraw-fd-006',
    title: '透明水彩',
    category: '插画',
    desc: '极轻透明水彩、柔和晕染、湿边、白纸',
    aspect: '3:4',
    image: '/assets/presets/fd-006.webp',
    style:
      '透明水彩（Airy Transparent Watercolor）：极轻透明水彩、柔和晕染、湿边、大量白纸、低覆盖。',
    sourceId: 'FD-006',
  },
  {
    id: 'handraw-fd-021',
    title: '极简荒诞短漫',
    category: '漫画',
    desc: '极简造型、冷脸、短节奏反转',
    aspect: '3:4',
    image: '/assets/presets/fd-021.webp',
    style:
      '极简荒诞短漫（Minimal Absurd Short-Gag Cartoon）：荒诞短漫、冷笑话节奏、极简造型、清楚轮廓、眼口少量关键形状、冷脸或突然夸张。',
    sourceId: 'FD-021',
  },
  {
    id: 'handraw-fe-052',
    title: '新中式小墨人',
    category: '国风',
    desc: '水墨笔触、古典留白、简练造型',
    aspect: '3:4',
    image: '/assets/presets/fe-052.webp',
    style:
      '新中式水墨（New-Chinese Tiny Ink）：大留白、水墨晕染、简练造型、东方情绪、柔和墨色层次。',
    sourceId: 'FE-052',
  },
  {
    id: 'handraw-fe-061',
    title: '当代文人水墨',
    category: '国风',
    desc: '毛笔墨线、书法题字、宣纸留白、松弛笔压',
    aspect: '3:4',
    image: '/assets/presets/fe-061.webp',
    style:
      '当代文人水墨（Contemporary Literati Ink Cartoon）：白色或微暖纸面、大面积留白、毛笔与墨线快速勾勒、线条松弛粗细不一、枯湿自然、允许断笔和不闭合轮廓、少量朱红赭石石绿湖蓝点染、书法题字与朱红印章嵌入留白、拙朴松弛幽默。',
    sourceId: 'FE-061',
  },
  {
    id: 'handraw-ff-004',
    title: '70s 毛毡定格',
    category: '3D/手工',
    desc: '黏土与毛毡、暖棕姜黄、70年代定格动画',
    aspect: '3:4',
    image: '/assets/presets/ff-004.webp',
    style:
      '70s 毛毡定格（Retro 70s Tactile Wool & Clay Stop-Motion）：温润黏土与羊羔绒/颗粒毛圈布料触感、暖调复古暖棕与姜黄配色、朴拙夸张比例与五官、怀旧儿童剧集质感、微缩实体感。',
    sourceId: 'FF-004',
  },
  {
    id: 'handraw-ff-011',
    title: '粉彩针织',
    category: '3D/手工',
    desc: '粗针织纹理、粉彩配色、圆润微缩体块',
    aspect: '1:1',
    image: '/assets/presets/ff-011.webp',
    style:
      '粉彩针织（Chubby Pastel Knitted）：软棉线织物与哑光黏土复合3D质感、糖果粉彩高明度配色、圆润饱满的微缩实体造型感、柔和清澈的工作室柔光。',
    sourceId: 'FF-011',
  },
  {
    id: 'handraw-fh-041',
    title: '极简水墨红黑',
    category: '实验',
    desc: '焦墨飞白、红黑撞色、几何留白、现代构图',
    aspect: '4:3',
    image: '/assets/presets/fh-041.webp',
    style:
      '极简水墨红黑（Modern Minimalist Sumi-e & Red Gouache Illustration）：现代极简水墨与高对比度红黑插画风、粗粝松弛的宣纸焦墨飞白干笔、大块纯色水粉撞色平涂、现代几何构图与东方意境留白。',
    sourceId: 'FH-041',
  },
  {
    id: 'handraw-fi-003',
    title: '北欧自然光摄影',
    category: '摄影',
    desc: '自然光、低饱和、真实材质、柔和阴影',
    aspect: '4:3',
    image: '/assets/presets/fi-003.webp',
    style:
      '北欧自然光摄影（Nordic Natural-Light Photography）：自然光、低饱和、真实材质、柔和阴影、克制留白、温暖日常质感。',
    sourceId: 'FI-003',
  },
  {
    id: 'handraw-fi-010',
    title: '高定秀场摄影',
    category: '摄影',
    desc: '戏剧光、杂志大片、强轮廓、深阴影',
    aspect: '3:4',
    image: '/assets/presets/fi-010.webp',
    style:
      '戏剧光摄影（Dramatic Editorial Photography）：戏剧性硬光、强轮廓、深阴影、杂志大片质感、克制色彩、夸张造型感。',
    sourceId: 'FI-010',
  },
  {
    id: 'luma-product-001',
    title: '极简产品摄影',
    category: '摄影',
    desc: '棚拍柔光、真实材质、克制留白',
    aspect: '4:3',
    image: '/assets/presets/luma-product-001.jpg',
    style:
      '极简商业产品摄影（Minimal Commercial Product Photography）：大面积纯色或微纹理背景、柔和棚拍光、清晰材质与边缘高光、克制留白、自然投影、真实比例与细节，不添加包装文案或品牌标识。',
    sourceId: 'LUMA-001',
  },
  {
    id: 'luma-lifestyle-001',
    title: '暖调生活方式摄影',
    category: '摄影',
    desc: '自然窗光、真实材质、生活瞬间',
    aspect: '4:3',
    image: '/assets/presets/luma-lifestyle-001.jpg',
    style:
      '暖调生活方式摄影（Warm Lifestyle Photography）：自然窗光与柔和阴影、低饱和暖色、真实织物与陶瓷质感、轻微胶片颗粒、松弛日常氛围，避免摆拍感。',
    sourceId: 'LUMA-002',
  },
  {
    id: 'luma-portrait-001',
    title: '自然光人像',
    category: '摄影',
    desc: '自然皮肤、柔和侧光、克制背景',
    aspect: '3:4',
    image: '/assets/presets/luma-portrait-001.jpg',
    style:
      '自然光人像摄影（Natural-Light Portrait Photography）：柔和侧光与自然阴影、真实皮肤纹理、低饱和暖色、浅景深、简洁背景、克制修饰，保留毛孔与细碎发丝。',
    sourceId: 'LUMA-003',
  },
  {
    id: 'luma-editorial-001',
    title: '戏剧光时装',
    category: '摄影',
    desc: '硬光、深阴影、杂志大片',
    aspect: '3:4',
    image: '/assets/presets/luma-editorial-001.jpg',
    style:
      '戏剧光时装摄影（Dramatic Fashion Editorial Photography）：硬质主光、深阴影、强轮廓、克制的黑白灰配色、清晰面料纹理、杂志大片构图与高级感，避免柔和美颜。',
    sourceId: 'LUMA-004',
  },
];

export const STYLE_CATEGORIES = [...new Set(STYLE_PRESETS.map((preset) => preset.category))];

export function findPreset(id) {
  return STYLE_PRESETS.find((preset) => preset.id === id) || null;
}
