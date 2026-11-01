import { el, els, toast } from '../core/index.js';
import { openLightbox, openPromptModal } from './overlays.js';
import { setPrimaryReference } from './reference.js';

export function openCompare(images) {
  els.compareGrid.innerHTML = '';
  for (const image of images) {
    const item = el('figure', 'compare-item');
    const img = el('img');
    img.src = image.url;
    img.alt = image.prompt || '变体';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(image.url));
    item.appendChild(img);
    if (image.prompt || image.caption) {
      const prompt = el('p', 'compare-prompt prompt-link', image.caption || image.prompt);
      prompt.title = `${image.prompt || image.caption || ''}\n\n点击查看最终提示词`;
      prompt.addEventListener('click', () => openPromptModal(image.prompt));
      item.appendChild(prompt);
    }
    const meta = el('div', 'compare-meta');
    if (image.size) meta.appendChild(el('span', 'meta-chip', image.size.replace('x', ' × ')));
    if (image.aspectRatio) meta.appendChild(el('span', 'meta-chip', image.aspectRatio));
    if (meta.children.length) item.appendChild(meta);
    const select = el('button', 'primary compare-select', '选为当前');
    select.type = 'button';
    select.addEventListener('click', () => {
      setPrimaryReference({ id: image.id, url: image.url, role: '参考' });
      closeCompare();
      toast('已选为当前参考图');
    });
    item.appendChild(select);
    els.compareGrid.appendChild(item);
  }
  els.compareModal.hidden = false;
}

export function closeCompare() {
  els.compareModal.hidden = true;
  els.compareGrid.innerHTML = '';
}

