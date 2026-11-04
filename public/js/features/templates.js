import {
  autoGrow,
  el,
  els,
  state,
  toast,
  updateSendButton,
} from '../core/index.js';
import { renderParams } from './params.js';
import { send } from './chat.js';
import { STYLE_CATEGORIES, STYLE_PRESETS, findPreset } from './presets.js';

const CREATIVE_TEMPLATES = [
  {
    id: 'poster',
    title: '海报',
    desc: '主视觉 + 标题文字',
    aspect: '3:4',
    subject: '新品香水放在白色台面上，背景是柔和的米色渐变',
    style: '极简产品海报，棚拍柔光，大面积留白，细衬线标题',
    text: 'NEW / 2026',
    hint: '适合活动、产品发布和社交媒体竖版海报。',
  },
  {
    id: 'product',
    title: '产品图',
    desc: '棚拍质感与材质',
    aspect: '4:3',
    subject: '一台银色便携咖啡机，放在深灰色石材台面上',
    style: '高端产品摄影，侧逆光，金属与磨砂材质对比，浅景深，细节锐利',
    text: '',
    hint: '适合电商主图、产品详情页和广告素材。',
  },
  {
    id: 'portrait',
    title: '人像',
    desc: '真实质感与电影光',
    aspect: '3:4',
    subject: '一位穿深色大衣的年轻女性站在雨后的街道上',
    style: '电影感人像，85mm，柔和侧光，浅景深，真实皮肤质感，环境反射',
    text: '',
    hint: '适合角色概念、写真和故事人物。',
  },
  {
    id: 'illustration',
    title: '插画',
    desc: '媒介、笔触与色板',
    aspect: '16:9',
    subject: '一只橘猫坐在窗台上晒太阳',
    style: '日系水彩插画，柔和暖光，纸张纹理，低饱和暖色板',
    text: '',
    hint: '适合封面、文章配图和轻松的场景插画。',
  },
  {
    id: 'infographic',
    title: '信息图',
    desc: '结构、层级与标签',
    aspect: '9:16',
    subject: '三步骤的咖啡冲煮流程图',
    style: '现代信息图，网格排版，简洁图标，中文标签清晰，留白充足',
    text: '研磨 / 注水 / 完成',
    hint: '适合教程、流程说明和知识卡片。',
  },
  {
    id: 'comic',
    title: '漫画分镜',
    desc: '两格叙事与镜头',
    aspect: '3:4',
    subject: '两名探险家在雨林里发现发光的神庙',
    style: '电影感漫画分镜，粗线条，强烈明暗，两格构图，环境细节丰富',
    text: '第一格：发现；第二格：靠近',
    hint: '适合故事板、分镜草稿和短篇漫画。',
  },
];

const OPERATIONS_TEMPLATES = [
  {
    id: 'member-benefits',
    title: '会员权益',
    desc: '权益列表 + 领取按钮',
    aspect: '3:4',
    subject: '一张会员权益宣传海报，中心是简洁的会员徽章与四个权益图标，背景为暖白色纸张质感',
    style:
      '现代会员权益海报设计，暖白与金橙配色，圆角卡片，线性图标统一，标题大、权益条目清晰成列，底部有领取按钮，商业运营质感，文字排版整齐',
    text: '会员权益\n积分翻倍\n专属折扣\n优先客服\n立即领取',
    hint: '适合会员日、权益升级、站内弹窗和社群推送。',
  },
  {
    id: 'member-day',
    title: '会员日促销',
    desc: '折扣数字 + 时间 + 领取',
    aspect: '3:4',
    subject: '一张限时会员日促销海报，中央是大号折扣券和活动日期，周围有简洁的星形与礼盒装饰',
    style:
      '电商促销海报，红金高对比配色，大号价格与折扣数字，信息层级清晰，紧凑但留白，手机端可读，商业运营质感',
    text: '会员日限时\n满 300 减 50\n11.08 - 11.10\n立即领取',
    hint: '适合会员日、限时折扣、优惠券发放和社群转化。',
  },
  {
    id: 'new-arrival',
    title: '新品上市',
    desc: '产品主视觉 + 三个卖点',
    aspect: '4:3',
    subject: '一件新产品悬浮在柔和浅色背景中，周围有三个简洁卖点标签和材质细节',
    style:
      '新品上市宣传图，干净商业摄影，中心构图，三个卖点标签，品牌感留白，浅色高级质感，文字清晰',
    text: '新品上市\n轻盈保湿\n24h 持久\n立即体验',
    hint: '适合新品发布、详情页头图和电商主图。',
  },
  {
    id: 'event-notice',
    title: '活动通知',
    desc: '时间地点 + 报名按钮',
    aspect: '9:16',
    subject: '一张社群活动通知海报，顶部是活动标题，中部是时间和地点信息，底部是报名按钮，背景为简洁几何图形',
    style:
      '现代扁平活动海报，高对比标题，信息层级分明，几何色块，留白充足，适合朋友圈和社群转发，文字清晰',
    text: '周末会员日\n11.08 14:00\n城市客厅\n点击报名',
    hint: '适合线下活动、社群报名、直播预告和门店通知。',
  },
  {
    id: 'product-order',
    title: '产品订购',
    desc: '实物 / 虚拟商品 + 价格 + 订购',
    aspect: '3:4',
    subject: '一张产品订购宣传海报，中心是产品主视觉或会员权益卡片，周围是产品名称、价格、核心卖点和订购按钮，背景简洁明亮',
    style:
      '现代电商产品订购海报，中心构图，产品清晰，价格与卖点层级分明，底部醒目的订购按钮，浅色高级背景，留白充足，中文排版整齐，商业运营质感',
    text: '产品订购\n核心卖点\n¥ 99 起\n立即订购',
    hint: '适合实物商品、会员和增值业务（如中国移动任我选会员）的订购海报、社群转化和短信落地页。',
  },
];

const TEMPLATES = [...CREATIVE_TEMPLATES, ...OPERATIONS_TEMPLATES];

function renderTemplateCards(container, templates) {
  if (!container) return;
  container.innerHTML = '';
  for (const template of templates) {
    const card = el(
      'button',
      `template-card${state.templateId === template.id ? ' active' : ''}`,
    );
    card.type = 'button';
    card.setAttribute('aria-pressed', String(state.templateId === template.id));
    card.appendChild(el('span', 'template-card-title', template.title));
    card.appendChild(el('span', 'template-card-desc', template.desc));
    card.addEventListener('click', () => selectTemplate(template.id));
    container.appendChild(card);
  }
}

function renderTemplates() {
  renderTemplateCards(els.templateGrid, CREATIVE_TEMPLATES);
  renderTemplateCards(els.opsTemplateGrid, OPERATIONS_TEMPLATES);
  renderPresets();
}

function renderPresetFilters() {
  if (!els.presetFilters) return;
  els.presetFilters.innerHTML = '';
  const filters = [
    { id: 'all', label: '全部', count: STYLE_PRESETS.length },
    ...STYLE_CATEGORIES.map((category) => ({
      id: category,
      label: category,
      count: STYLE_PRESETS.filter((preset) => preset.category === category).length,
    })),
  ];
  for (const filter of filters) {
    const active = state.presetCategory === filter.id;
    const button = el(
      'button',
      `preset-filter${active ? ' active' : ''}`,
      `${filter.label} ${filter.count}`,
    );
    button.type = 'button';
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      if (state.presetCategory === filter.id) return;
      state.presetCategory = filter.id;
      renderPresets();
    });
    els.presetFilters.appendChild(button);
  }
}

function renderPresets() {
  if (!els.presetGrid) return;
  if (state.presetCategory !== 'all' && !STYLE_CATEGORIES.includes(state.presetCategory)) {
    state.presetCategory = 'all';
  }
  renderPresetFilters();
  els.presetGrid.innerHTML = '';
  const presets =
    state.presetCategory === 'all'
      ? STYLE_PRESETS
      : STYLE_PRESETS.filter((preset) => preset.category === state.presetCategory);
  for (const preset of presets) {
    const active = state.presetId === preset.id;
    const card = el('button', `template-card preset-card${active ? ' active' : ''}`);
    card.type = 'button';
    card.title = `${preset.title} · ${preset.category} · 点击套用`;
    card.setAttribute('aria-pressed', String(active));
    const image = el('img', 'preset-thumb');
    image.src = preset.image;
    image.alt = `${preset.title} 风格预览`;
    image.loading = 'lazy';
    card.appendChild(image);
    const body = el('span', 'preset-body');
    body.appendChild(el('span', 'preset-title', preset.title));
    body.appendChild(el('span', 'preset-desc', preset.desc));
    body.appendChild(el('span', 'preset-meta', `${preset.category} · ${preset.aspect}`));
    card.appendChild(body);
    card.addEventListener('click', () => selectPreset(preset.id));
    els.presetGrid.appendChild(card);
  }
}

const DEFAULT_TEMPLATE_HINT =
  '先选一个模板作为起点，或直接填写主体；再选风格灵感叠加。';

const QR_POSITION_LABELS = {
  'bottom-right': '右下角',
  'bottom-left': '左下角',
  'bottom-center': '底部居中',
};

function currentTemplate() {
  return TEMPLATES.find((item) => item.id === state.templateId) || null;
}

function isOperationsTemplate(template) {
  return Boolean(template) && OPERATIONS_TEMPLATES.some((item) => item.id === template.id);
}

function renderQrChip() {
  if (!els.qrChip) return;
  els.qrChip.hidden = !state.qr;
  if (!state.qr) {
    els.qrChipLabel.textContent = '二维码';
    els.qrChip.title = '点击移除二维码';
    return;
  }
  let host = '';
  try {
    host = new URL(state.qr.url).host;
  } catch {
    host = '';
  }
  els.qrChipLabel.textContent = host ? `二维码 · ${host}` : '二维码';
  els.qrChip.title = `点击移除二维码：${state.qr.url}`;
}

function syncQrForm() {
  if (!els.qrForm) return;
  els.qrForm.hidden = !isOperationsTemplate(currentTemplate());
}

function resetQrFields() {
  if (!els.qrUrl) return;
  els.qrUrl.value = '';
  els.qrPosition.value = 'bottom-right';
  els.qrSize.value = 'medium';
}

export function clearActiveQr() {
  state.qr = null;
  resetQrFields();
  renderQrChip();
}

function syncTemplateSelection() {
  if (!els.templateSelectionText) return;
  const template = TEMPLATES.find((item) => item.id === state.templateId) || null;
  const preset = findPreset(state.presetId);
  const parts = [];
  if (template) parts.push(`模板：${template.title}`);
  if (preset) parts.push(`风格：${preset.title}`);
  els.templateSelectionText.textContent = parts.length ? parts.join(' + ') : '自由创作';
  if (els.clearPresetSelection) els.clearPresetSelection.hidden = !preset;
}

function syncTemplateAspectChips() {
  if (!els.templateAspectChips || !els.templateAspect) return;
  const current = els.templateAspect.value || '';
  for (const chip of els.templateAspectChips.querySelectorAll('[data-aspect]')) {
    const active = (chip.dataset.aspect || '') === current;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
}

function syncTemplateHint() {
  syncTemplateSelection();
  syncTemplateAspectChips();
  const template = TEMPLATES.find((item) => item.id === state.templateId) || null;
  const preset = findPreset(state.presetId);
  if (template && preset) {
    els.templateHint.textContent = `模板「${template.title}」+ 风格「${preset.title}」：${preset.desc}。`;
  } else if (preset) {
    els.templateHint.textContent = `风格「${preset.title}」：${preset.desc}。`;
  } else if (template) {
    els.templateHint.textContent = template.hint;
  } else {
    els.templateHint.textContent = DEFAULT_TEMPLATE_HINT;
  }
}

function selectTemplate(id) {
  const template = TEMPLATES.find((item) => item.id === id) || TEMPLATES[0];
  state.templateId = template.id;
  state.presetId = null;
  els.templateSubject.value = template.subject;
  els.templateStyle.value = template.style;
  els.templateText.value = template.text;
  els.templateAspect.value = template.aspect;
  if (!isOperationsTemplate(template)) clearActiveQr();
  syncQrForm();
  syncTemplateHint();
  renderTemplates();
}

function selectPreset(id) {
  const preset = findPreset(id);
  if (!preset) return;
  state.presetId = preset.id;
  els.templateStyle.value = preset.style;
  els.templateAspect.value = preset.aspect;
  syncTemplateHint();
  renderTemplates();
}

export function clearPresetSelection() {
  if (!state.presetId) return;
  state.presetId = null;
  const template = TEMPLATES.find((item) => item.id === state.templateId) || null;
  if (template) {
    els.templateStyle.value = template.style;
    els.templateAspect.value = template.aspect;
  } else {
    els.templateStyle.value = '';
    els.templateAspect.value = '';
    state.options.aspectRatio = null;
    renderParams();
  }
  syncTemplateHint();
  renderTemplates();
}

export function clearTemplateSelection() {
  state.templateId = null;
  state.presetId = null;
  state.presetCategory = 'all';
  els.templateSubject.value = '';
  els.templateStyle.value = '';
  els.templateText.value = '';
  els.templateAspect.value = '';
  state.options.aspectRatio = null;
  clearActiveQr();
  syncQrForm();
  renderParams();
  syncTemplateHint();
  renderTemplates();
}

export function openTemplates() {
  els.templateModal.hidden = false;
  if (state.templateId && !TEMPLATES.some((template) => template.id === state.templateId)) {
    state.templateId = null;
  }
  if (state.presetId && !findPreset(state.presetId)) {
    state.presetId = null;
  }
  if (state.presetCategory !== 'all' && !STYLE_CATEGORIES.includes(state.presetCategory)) {
    state.presetCategory = 'all';
  }
  if (state.qr && !els.qrUrl.value) {
    els.qrUrl.value = state.qr.url;
    els.qrPosition.value = state.qr.position;
    els.qrSize.value = state.qr.size;
  }
  syncQrForm();
  renderQrChip();
  syncTemplateHint();
  renderTemplates();
  els.templateSubject.focus();
}

export function closeTemplates() {
  els.templateModal.hidden = true;
}

function submitTemplate() {
  if (state.streaming) {
    toast('请先等待当前生成完成');
    return;
  }
  const preset = findPreset(state.presetId);
  const template = TEMPLATES.find((item) => item.id === state.templateId) || null;
  const subject = els.templateSubject.value.trim();
  if (!subject) {
    toast('请填写主体');
    els.templateSubject.focus();
    return;
  }
  const style = els.templateStyle.value.trim();
  const text = els.templateText.value.trim();
  const aspect = els.templateAspect.value;
  const qrInput = isOperationsTemplate(template) ? els.qrUrl.value.trim() : '';
  if (qrInput) {
    let parsed;
    try {
      parsed = new URL(qrInput);
    } catch {
      toast('二维码链接需要完整地址，例如 https://example.com/benefit');
      els.qrUrl.focus();
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      toast('二维码链接只支持 http 或 https 地址');
      els.qrUrl.focus();
      return;
    }
    state.qr = {
      url: parsed.href,
      position: els.qrPosition.value,
      size: els.qrSize.value,
    };
  } else {
    state.qr = null;
  }
  renderQrChip();
  const type = template?.title || preset?.category || '自由创作';
  const qrLine = state.qr
    ? `二维码：出图后由系统合成到${QR_POSITION_LABELS[state.qr.position] || '右下角'}；画面中不要绘制二维码、条形码或水印，并在该区域预留干净空间。`
    : '';
  const lines = [
    '请按下面的 brief 创作一张图片：',
    `类型：${type}`,
    `主体：${subject}`,
    style ? `场景/风格：${style}` : '',
    text ? `画面文字：${text}` : '',
    aspect ? `画幅：${aspect}` : '',
    qrLine,
    '要求：主体和文字必须忠实，画面干净，不要添加未要求的元素。',
  ].filter(Boolean);
  if (aspect) {
    state.options.aspectRatio = aspect;
    renderParams();
  }
  closeTemplates();
  els.input.value = lines.join('\n');
  autoGrow();
  updateSendButton();
  els.input.focus();
  send();
}

export function selectTemplateAspect(aspect) {
  els.templateAspect.value = aspect || '';
  syncTemplateAspectChips();
}

export { submitTemplate };
