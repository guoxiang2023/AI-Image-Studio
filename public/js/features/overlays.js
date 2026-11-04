import { els, toast } from '../core/index.js';

let activePrompt = '';
let lightboxItems = [];
let lightboxIndex = 0;

function renderLightbox() {
  const item = lightboxItems[lightboxIndex];
  els.lightboxImg.src = item?.url || '';
  els.lightboxImg.alt = item?.alt || item?.prompt || '查看图片';
  const multiple = lightboxItems.length > 1;
  els.lightboxPrev.hidden = !multiple;
  els.lightboxNext.hidden = !multiple;
  els.lightboxCount.hidden = !multiple;
  els.lightboxCount.textContent = multiple ? `${lightboxIndex + 1} / ${lightboxItems.length}` : '';
}

export function openLightbox(url, { images = null, index = 0 } = {}) {
  const list = Array.isArray(images) && images.length ? images : [{ url }];
  const start = Number.isInteger(index) ? Math.min(Math.max(index, 0), list.length - 1) : 0;
  lightboxItems = list.map((item) => (typeof item === 'string' ? { url: item } : item));
  lightboxIndex = start;
  els.lightbox.hidden = false;
  renderLightbox();
}

export function stepLightbox(delta) {
  if (lightboxItems.length < 2) return;
  lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
  renderLightbox();
}

export function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = '';
  lightboxItems = [];
  lightboxIndex = 0;
}

export function openSidebar() {
  els.sidebar.classList.add('open');
  els.sidebarScrim.classList.add('show');
}

export function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.sidebarScrim.classList.remove('show');
}

export function openPromptModal(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  activePrompt = text;
  els.promptText.textContent = text;
  els.promptModal.hidden = false;
}

export function closePromptModal() {
  els.promptModal.hidden = true;
  els.promptText.textContent = '';
  activePrompt = '';
}

export async function copyActivePrompt() {
  if (!activePrompt) return;
  try {
    await navigator.clipboard.writeText(activePrompt);
    toast('提示词已复制');
  } catch {
    toast('复制失败');
  }
}
