import { els } from './dom.js';
import { state } from './state.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function icon(name, className = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export function scrollBottom() {
  requestAnimationFrame(() => {
    els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
  });
}

export function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function updateSendButton() {
  if (state.streaming) {
    els.sendBtn.classList.add('stop');
    els.sendBtn.disabled = false;
    els.sendBtn.setAttribute('aria-label', '停止生成');
    return;
  }
  els.sendBtn.classList.remove('stop');
  els.sendBtn.disabled = !(
    els.input.value.trim() ||
    state.references.length ||
    state.attachments.length
  );
  els.sendBtn.setAttribute('aria-label', '发送');
}

export function updateComposerPlaceholder() {
  els.input.placeholder = state.references.length
    ? '描述要怎么改这些图，例如“把背景换成夜景”…'
    : state.attachments.length
      ? '说明想让 AI 怎么处理这些文件…'
      : '描述画面，或粘贴参考图、上传文档开始…';
}

export function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

export function renderModels() {
  const cfg = state.config;
  if (!cfg) {
    els.modelPill.textContent = '未连接';
    els.modelPill.classList.add('warn');
    return;
  }
  const missing = !cfg.llm.apiKeySet || !cfg.image.apiKeySet;
  els.modelPill.classList.toggle('warn', missing);
  els.modelPill.textContent = missing ? '未配置模型' : cfg.image.name || cfg.image.model;
  els.modelPill.title = `对话：${cfg.llm.name || cfg.llm.model || '未配置'} · 图片：${
    cfg.image.name || cfg.image.model || '未配置'
  }`;
}

export function showChatView() {
  state.view = 'chat';
  els.galleryView.hidden = true;
  els.documentsView.hidden = true;
  els.chatScroll.hidden = false;
  els.composerWrap.hidden = Boolean(state.chatArchived);
  els.archiveBanner.hidden = !state.chatArchived;
  els.topbarLabel.textContent = state.chatArchived ? 'ARCHIVED' : 'SESSION';
  els.galleryNav.classList.remove('active');
  els.documentsNav.classList.remove('active');
  els.chatTitle.textContent = state.chatTitle || '新对话';
}

export function setTitle(title) {
  const next = title || '新对话';
  state.chatTitle = next;
  if (state.view === 'chat') els.chatTitle.textContent = next;
}
