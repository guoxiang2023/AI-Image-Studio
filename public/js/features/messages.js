import {
  autoGrow,
  el,
  els,
  icon,
  scrollBottom,
  state,
  toast,
  updateSendButton,
} from '../core/index.js';
import { openCompare } from './compare.js';
import { openLightbox, openPromptModal } from './overlays.js';
import { setPrimaryReference } from './reference.js';
import { renderMarkdown } from '../core/markdown.js';

function showEmptyState() {
  els.messages.innerHTML = '';
  els.messages.classList.add('is-empty');
  const wrap = el('div', 'empty');
  wrap.appendChild(el('div', 'hero-glow'));

  const mark = el('div', 'hero-mark');
  mark.appendChild(icon('spark'));
  wrap.appendChild(mark);

  wrap.appendChild(el('p', 'eyebrow', 'AI CREATIVE AGENT'));

  const h1 = el('h1');
  h1.appendChild(document.createTextNode('让想象，'));
  h1.appendChild(el('span', 'grad-text', '成为画面。'));
  wrap.appendChild(h1);

  wrap.appendChild(
    el('p', 'lead', '描述你想生成的画面，也可以直接和我聊天、问问题或一起打磨创意。'),
  );

  const examples = el('div', 'examples');
  const prompts = [
    '赛博朋克城市雨夜，霓虹灯倒映在积水里，电影感竖版海报',
    '一只橘猫坐在窗台上晒太阳，日系插画，柔和光线',
    '极简产品海报：白色背景上的香水瓶，柔和光影，大面积留白',
    '中国山水画风格，云雾中的孤舟与远山，横幅',
    '画一个电商平台的系统架构图，分层展示客户端、接入、业务服务、中间件和数据层',
    '解释一下摄影里的景深，并用一个简单例子说明',
  ];
  prompts.forEach((prompt, index) => {
    const btn = el('button', 'example');
    btn.appendChild(el('span', 'example-index', String(index + 1).padStart(2, '0')));
    btn.appendChild(el('span', 'example-text', prompt));
    btn.appendChild(el('span', 'example-arrow', '↗'));
    btn.addEventListener('click', () => {
      els.input.value = prompt;
      autoGrow();
      updateSendButton();
      els.input.focus();
    });
    examples.appendChild(btn);
  });

  wrap.appendChild(examples);
  els.messages.appendChild(wrap);
}

function updateComposer() {
  autoGrow();
  updateSendButton();
}

function createImageCard(img, context = {}) {
  const card = el('figure', 'image-card');
  const ratio = img.aspectRatio || '';
  if (['3:4', '2:3', '9:16'].includes(ratio)) card.classList.add('is-portrait');
  else if (['4:3', '3:2', '16:9'].includes(ratio)) card.classList.add('is-landscape');
  else if (img.size === '1024x1536') card.classList.add('is-portrait');
  else if (img.size === '1536x1024') card.classList.add('is-landscape');

  const image = el('img');
  image.src = img.url;
  image.alt = img.prompt || '生成图片';
  image.loading = 'lazy';
  image.addEventListener('click', () => openLightbox(img.url));
  card.appendChild(image);

  const info = el('div', 'image-info');

  const meta = el('div', 'image-meta');
  if (img.size) meta.appendChild(el('span', 'meta-chip', img.size.replace('x', ' × ')));
  if (img.aspectRatio) meta.appendChild(el('span', 'meta-chip', img.aspectRatio));
  if (img.quality) meta.appendChild(el('span', 'meta-chip', `quality ${img.quality}`));
  if (meta.children.length) info.appendChild(meta);

  if (img.prompt) {
    const prompt = el('div', 'image-prompt prompt-link', img.caption || img.prompt);
    prompt.title = `${img.prompt}\n\n点击查看最终提示词`;
    prompt.addEventListener('click', () => openPromptModal(img.prompt));
    info.appendChild(prompt);
  }

  const actions = el('div', 'image-actions');

  const download = el('a', 'chip-btn');
  download.href = img.url;
  download.download = `luma-${img.id}.${(img.url.split('.').pop() || 'png').split('?')[0]}`;
  download.appendChild(icon('download'));
  download.appendChild(el('span', '', '下载'));
  actions.appendChild(download);

  const edit = el('button', 'chip-btn');
  edit.appendChild(icon('wand'));
  edit.appendChild(el('span', '', '继续修改'));
  edit.addEventListener('click', () => {
    setPrimaryReference({ id: img.id, url: img.url });
    els.input.focus();
  });
  actions.appendChild(edit);

  if (img.groupId) {
    const compare = el('button', 'chip-btn');
    compare.appendChild(icon('compare'));
    compare.appendChild(el('span', '', '对比'));
    compare.addEventListener('click', () => {
      const siblings = context.getGroupImages ? context.getGroupImages(img) : [img];
      if (siblings.length < 2) {
        toast('这组只有一张图');
        return;
      }
      openCompare(siblings);
    });
    actions.appendChild(compare);
  }

  if (img.prompt) {
    const more = el('button', 'chip-btn');
    more.appendChild(icon('spark'));
    more.appendChild(el('span', '', '更多类似'));
    more.addEventListener('click', () => {
      setPrimaryReference({ id: img.id, url: img.url });
      els.input.value = '基于这张图，保持主体和风格，生成一个不同构图和细节的变化版本';
      updateComposer();
      els.input.focus();
    });
    actions.appendChild(more);

    const view = el('button', 'chip-btn');
    view.type = 'button';
    view.title = '查看最终提示词';
    view.appendChild(icon('tag'));
    view.appendChild(el('span', '', '查看提示词'));
    view.addEventListener('click', () => openPromptModal(img.prompt));
    actions.appendChild(view);

    const copy = el('button', 'chip-btn');
    copy.appendChild(icon('copy'));
    copy.appendChild(el('span', '', '复制提示词'));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(img.prompt);
        toast('提示词已复制');
      } catch {
        toast('复制失败');
      }
    });
    actions.appendChild(copy);
  }

  info.appendChild(actions);
  card.appendChild(info);
  return card;
}

function createUserMessage(message) {
  const wrap = el('div', 'msg user');
  const body = el('div', 'body');
  const bubble = el('div', 'user-bubble', message.content);
  const references = Array.isArray(message.references) && message.references.length
    ? message.references
    : message.referenceUrl
      ? [{ url: message.referenceUrl, role: '参考' }]
      : [];
  for (const ref of references) {
    const node = el('span', 'user-ref');
    if (ref.role && ref.role !== '参考') node.title = ref.role;
    const img = el('img');
    img.src = ref.url;
    img.alt = ref.role ? `参考图：${ref.role}` : '参考图';
    node.appendChild(img);
    bubble.appendChild(node);
  }
  body.appendChild(bubble);
  wrap.appendChild(body);

  const avatar = el('div', 'user-avatar');
  avatar.textContent = Array.from(state.user?.username || '?')[0]?.toUpperCase() || '?';
  avatar.title = state.user?.username || '用户';
  avatar.setAttribute('aria-hidden', 'true');
  wrap.appendChild(avatar);
  return wrap;
}

function assistantAvatar() {
  const avatar = el('div', 'avatar');
  avatar.appendChild(icon('spark'));
  return avatar;
}

function createAssistantMessage(message) {
  const wrap = el('div', 'msg assistant');
  wrap.appendChild(assistantAvatar());
  const body = el('div', 'body');
  if (message.images?.length) {
    const grid = el('div', 'image-grid');
    const images = message.images;
    const getGroupImages = (target) =>
      images.filter((item) => item.groupId && item.groupId === target.groupId);
    for (const img of images) {
      grid.appendChild(createImageCard(img, { getGroupImages }));
    }
    body.appendChild(grid);
  }
  if (message.content) {
    const content = el('div', 'msg-content');
    renderMarkdown(content, message.content);
    body.appendChild(content);
  }
  wrap.appendChild(body);
  return wrap;
}

function prependSummaryNote() {
  els.messages.querySelector('.summary-note')?.remove();
  if (!state.summary || !state.summaryUpto) return;
  const details = el('details', 'summary-note');
  details.appendChild(el('summary', '', `较早的 ${state.summaryUpto} 条对话已压缩为摘要`));
  details.appendChild(el('p', '', state.summary));
  els.messages.prepend(details);
}

export function renderMessages() {
  els.messages.innerHTML = '';
  els.messages.classList.remove('is-empty');

  if (!state.messages.length) {
    showEmptyState();
    return;
  }

  for (const message of state.messages) {
    els.messages.appendChild(
      message.role === 'user' ? createUserMessage(message) : createAssistantMessage(message),
    );
  }
  prependSummaryNote();
  scrollBottom();
}

export function createAssistantShell() {
  const wrap = el('div', 'msg assistant');
  wrap.appendChild(assistantAvatar());
  const body = el('div', 'body');

  const status = el('div', 'status');
  const dots = el('span', 'dots');
  dots.innerHTML = '<i></i><i></i><i></i>';
  status.appendChild(dots);
  const statusText = el('span', 'status-text', '思考中…');
  status.appendChild(statusText);

  const content = el('div', 'msg-content');
  const grid = el('div', 'image-grid');
  const images = [];
  const getGroupImages = (target) =>
    images.filter((item) => item.groupId && item.groupId === target.groupId);
  let text = '';
  let frame = 0;

  const paint = () => {
    if (text) {
      content.hidden = false;
      renderMarkdown(content, text);
    } else {
      content.hidden = true;
      content.innerHTML = '';
    }
  };
  const schedulePaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
      scrollBottom();
    });
  };
  const cancelPaint = () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  };

  body.appendChild(grid);
  body.appendChild(status);
  body.appendChild(content);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollBottom();

  return {
    setStatus(value) {
      status.hidden = false;
      statusText.textContent = value;
      scrollBottom();
    },
    setText(value) {
      status.hidden = true;
      cancelPaint();
      text = value;
      paint();
      scrollBottom();
    },
    appendText(delta) {
      status.hidden = true;
      text += delta;
      schedulePaint();
    },
    resetText() {
      cancelPaint();
      text = '';
      paint();
      status.hidden = false;
      statusText.textContent = '整理结果…';
      scrollBottom();
    },
    addImage(img) {
      status.hidden = true;
      images.push(img);
      grid.appendChild(createImageCard(img, { getGroupImages }));
      scrollBottom();
    },
    setError(text) {
      cancelPaint();
      status.hidden = true;
      const box = el('div', 'msg-error', text);
      body.appendChild(box);
      scrollBottom();
    },
    finish() {
      cancelPaint();
      status.remove();
      if (!content.textContent && !grid.children.length && !body.querySelector('.msg-error')) {
        content.textContent = '（没有返回内容）';
      }
    },
  };
}

export { createUserMessage, prependSummaryNote };
