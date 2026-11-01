import {
  api,
  autoGrow,
  el,
  els,
  state,
  toast,
  updateSendButton,
} from '../core/index.js';
import { renderParams } from './params.js';
import { send } from './chat.js';
import {
  deleteImportedSkill,
  findSkill,
  setSkillId,
} from './skills.js';

const TEMPLATES = [
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

function renderTemplates() {
  els.templateGrid.innerHTML = '';
  for (const template of TEMPLATES) {
    const card = el(
      'button',
      `template-card${!state.skillId && state.templateId === template.id ? ' active' : ''}`,
    );
    card.type = 'button';
    card.appendChild(el('span', 'template-card-title', template.title));
    card.appendChild(el('span', 'template-card-desc', template.desc));
    card.addEventListener('click', () => selectTemplate(template.id));
    els.templateGrid.appendChild(card);
  }
  renderSkillCards();
}

function renderSkillCards() {
  if (!els.skillGrid) return;
  const skills = Array.isArray(state.skills) ? state.skills : [];
  els.skillGrid.innerHTML = '';
  if (els.skillCount) els.skillCount.textContent = skills.length ? `${skills.length} 个` : '';
  if (els.skillEmpty) els.skillEmpty.hidden = skills.length > 0;

  for (const skill of skills) {
    const card = el(
      'div',
      `template-card skill-card${state.skillId === skill.id ? ' active' : ''}`,
    );
    const main = el('button', 'skill-card-main');
    main.type = 'button';
    main.appendChild(el('span', 'template-card-title', skill.name));
    main.appendChild(
      el('span', 'template-card-desc', skill.description || '导入的图片创作 Skill'),
    );
    main.addEventListener('click', () => selectSkill(skill.id));

    const remove = el('button', 'skill-delete', '×');
    remove.type = 'button';
    remove.title = '删除 Skill';
    remove.setAttribute('aria-label', `删除 ${skill.name}`);
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`删除 Skill「${skill.name}」？`)) return;
      try {
        await deleteImportedSkill(skill.id);
        renderTemplates();
        toast('Skill 已删除');
      } catch (error) {
        toast(error.message);
      }
    });

    card.appendChild(main);
    card.appendChild(remove);
    els.skillGrid.appendChild(card);
  }
}

function selectTemplate(id) {
  const template = TEMPLATES.find((item) => item.id === id) || TEMPLATES[0];
  state.templateId = template.id;
  setSkillId(null);
  els.templateSubject.value = template.subject;
  els.templateStyle.value = template.style;
  els.templateText.value = template.text;
  els.templateAspect.value = template.aspect;
  els.templateHint.textContent = template.hint;
  renderTemplates();
}

function applySkillDefaults(skill) {
  const defaults = skill.defaults || {};
  if (defaults.aspectRatio) state.options.aspectRatio = defaults.aspectRatio;
  if (defaults.quality) state.options.quality = defaults.quality;
  if (defaults.count) state.options.count = defaults.count;
  renderParams();
}

function selectSkill(id, { preserveFields = false } = {}) {
  const skill = findSkill(id);
  if (!skill) return;
  const changed = state.skillId !== skill.id;
  state.templateId = null;
  setSkillId(skill.id);
  if (!preserveFields && changed) {
    els.templateSubject.value = '';
    els.templateStyle.value = '';
    els.templateText.value = '';
  }
  if (!preserveFields) {
    if (skill.defaults?.aspectRatio) {
      els.templateAspect.value = skill.defaults.aspectRatio;
    }
    applySkillDefaults(skill);
  } else if (skill.defaults?.aspectRatio && !els.templateAspect.value) {
    els.templateAspect.value = skill.defaults.aspectRatio;
  }
  els.templateHint.textContent = skill.description
    ? `已选择 Skill「${skill.name}」：${skill.description}`
    : `已选择 Skill「${skill.name}」，填写主体后开始创作。`;
  renderTemplates();
}

export function openTemplates() {
  els.templateModal.hidden = false;
  const skill = findSkill(state.skillId);
  if (skill) {
    selectSkill(skill.id, { preserveFields: true });
  } else {
    selectTemplate(state.templateId || TEMPLATES[0].id);
  }
  els.templateSubject.focus();
}

export function closeTemplates() {
  els.templateModal.hidden = true;
}

function compileSkillBrief(skill, values) {
  const tokens = {
    subject: values.subject,
    style: values.style,
    text: values.text,
    aspect: values.aspect,
  };
  const missing = new Set(Object.keys(tokens));
  let out = String(skill.template || '').trim();

  if (out) {
    for (const [key, value] of Object.entries(tokens)) {
      const token = `{{${key}}}`;
      if (!out.includes(token)) continue;
      out = out.split(token).join(value || '');
      missing.delete(key);
    }
    // A skill may use custom placeholders that the brief form cannot fill.
    // Fall back to the standard fields instead of leaking "{{...}}" into the prompt.
    if (/\{\{[^}]+\}\}/.test(out)) {
      out = `请使用 Skill「${skill.name}」创作一张图片：`;
      for (const key of Object.keys(tokens)) missing.add(key);
    }
  } else {
    out = `请使用 Skill「${skill.name}」创作一张图片：`;
  }

  const extras = [];
  const labels = {
    subject: '主体',
    style: '场景 / 风格',
    text: '画面文字',
    aspect: '画幅',
  };
  for (const key of Object.keys(tokens)) {
    if (!missing.has(key)) continue;
    const value = String(tokens[key] || '').trim();
    if (value) extras.push(`${labels[key]}：${value}`);
  }

  return [out, ...extras]
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/，\s*，/g, '，')
    .replace(/，\s*$/g, '')
    .trim();
}

async function importSkillFile(file) {
  if (!file) return;
  if (file.size > 64 * 1024) {
    toast('Skill 文件不能超过 64KB');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('JSON 解析失败，请检查文件格式');
    return;
  }
  try {
    const skill = await api('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.skills = [skill, ...(state.skills || []).filter((item) => item.id !== skill.id)];
    selectSkill(skill.id);
    renderTemplates();
    toast(`已导入 Skill：${skill.name}`);
  } catch (error) {
    toast(error.message);
  } finally {
    if (els.skillFileInput) els.skillFileInput.value = '';
  }
}

export function triggerSkillImport() {
  els.skillFileInput?.click();
}

export function handleSkillFileChange() {
  importSkillFile(els.skillFileInput?.files?.[0]);
}

function submitTemplate() {
  if (state.streaming) {
    toast('请先等待当前生成完成');
    return;
  }
  const skill = findSkill(state.skillId);
  const template = TEMPLATES.find((item) => item.id === state.templateId) || TEMPLATES[0];
  const subject = els.templateSubject.value.trim();
  if (!subject) {
    toast('请填写主体');
    els.templateSubject.focus();
    return;
  }
  const style = els.templateStyle.value.trim();
  const text = els.templateText.value.trim();
  const aspect = els.templateAspect.value;
  let lines;
  if (skill) {
    lines = [compileSkillBrief(skill, { subject, style, text, aspect })];
  } else {
    lines = [
      '请按下面的 brief 创作一张图片：',
      `类型：${template.title}`,
      `主体：${subject}`,
      style ? `场景/风格：${style}` : '',
      text ? `画面文字：${text}` : '',
      aspect ? `画幅：${aspect}` : '',
      '要求：主体和文字必须忠实，画面干净，不要添加未要求的元素。',
    ].filter(Boolean);
  }
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

export { submitTemplate };
