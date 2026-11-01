import { els, toast } from '../core/index.js';

let activePrompt = '';

export function openLightbox(url) {
  els.lightboxImg.src = url;
  els.lightbox.hidden = false;
}

export function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = '';
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
