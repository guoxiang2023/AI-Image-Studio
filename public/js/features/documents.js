import { api, el, els, formatTime, state, toast } from '../core/index.js';
import { backToChat } from './gallery.js';
import { closeParams } from './params.js';
import { closeSidebar } from './overlays.js';

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function formatLabel(format) {
  return format === 'docx' ? 'Word 文档' : 'PDF 文档';
}

function documentMeta(doc) {
  return [
    formatLabel(doc.format),
    formatTime(doc.createdAt),
    formatSize(doc.size),
    doc.imageCount ? `${doc.imageCount} 张图片` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function createDocumentCard(doc) {
  const card = el('article', 'document-card');
  const head = el('div', 'document-card-head');
  head.appendChild(
    el('span', `document-format ${doc.format}`, doc.format === 'pdf' ? 'PDF' : 'DOCX'),
  );
  const info = el('div', 'document-card-info');
  info.appendChild(el('h3', 'document-card-title', doc.title || 'Luma 文档'));
  info.appendChild(el('p', 'document-card-meta', documentMeta(doc)));
  if (doc.chatTitle) {
    info.appendChild(el('p', 'document-card-source', `来自会话：${doc.chatTitle}`));
  }
  head.appendChild(info);
  card.appendChild(head);

  const actions = el('div', 'document-card-actions');
  const view = el('button', 'ghost document-action', '查看');
  view.type = 'button';
  view.addEventListener('click', () => void openDocumentPreview(doc.id));
  const download = el('a', 'ghost document-action', '下载');
  download.href = `/api/documents/${doc.id}/download`;
  download.download = doc.filename || '';
  actions.appendChild(view);
  actions.appendChild(download);
  const remove = el('button', 'document-remove', '×');
  remove.type = 'button';
  remove.title = '删除文档';
  remove.setAttribute('aria-label', `删除文档 ${doc.title || ''}`);
  remove.addEventListener('click', () => void deleteDocument(doc));
  actions.appendChild(remove);
  card.appendChild(actions);
  return card;
}

export function renderDocuments() {
  const documents = state.documents || [];
  els.documentsTotal.textContent = documents.length ? `共 ${documents.length} 份` : '';
  els.documentsGrid.replaceChildren();
  els.documentsGrid.hidden = !documents.length;
  els.documentsEmpty.hidden = Boolean(documents.length);
  for (const doc of documents) {
    els.documentsGrid.appendChild(createDocumentCard(doc));
  }
}

export async function refreshDocuments() {
  try {
    const data = await api('/api/documents');
    state.documents = data.documents || [];
    renderDocuments();
  } catch (error) {
    toast(error.message);
  }
}

export async function openDocuments() {
  state.view = 'documents';
  els.chatScroll.hidden = true;
  els.composerWrap.hidden = true;
  els.archiveBanner.hidden = true;
  els.galleryView.hidden = true;
  els.documentsView.hidden = false;
  els.topbarLabel.textContent = 'DOCUMENTS';
  els.chatTitle.textContent = '我的文档';
  els.galleryNav.classList.remove('active');
  els.documentsNav.classList.add('active');
  closeParams();
  closeSidebar();
  await refreshDocuments();
}

function previewHeading(level, text) {
  const tag = level <= 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
  return el(tag, 'document-preview-heading', text || '');
}

function renderPreview(blocks) {
  els.documentModalBody.replaceChildren();
  for (const block of blocks || []) {
    if (block.type === 'heading') {
      els.documentModalBody.appendChild(previewHeading(block.level, block.text));
    } else if (block.type === 'paragraph') {
      els.documentModalBody.appendChild(el('p', 'document-preview-text', block.text || ''));
    } else if (block.type === 'bullets') {
      const list = el(block.ordered ? 'ol' : 'ul', 'document-preview-list');
      for (const item of block.items || []) list.appendChild(el('li', '', item));
      els.documentModalBody.appendChild(list);
    } else if (block.type === 'quote') {
      els.documentModalBody.appendChild(el('blockquote', 'document-preview-quote', block.text || ''));
    } else if (block.type === 'image' && block.url) {
      const figure = el('figure', 'document-preview-image');
      const img = el('img');
      img.src = block.url;
      img.alt = block.caption || '文档图片';
      img.loading = 'lazy';
      figure.appendChild(img);
      if (block.caption) figure.appendChild(el('figcaption', '', block.caption));
      els.documentModalBody.appendChild(figure);
    }
  }
}

export async function openDocumentPreview(id) {
  try {
    const doc = await api(`/api/documents/${id}`);
    els.documentModalTitle.textContent = doc.title || 'Luma 文档';
    els.documentModalMeta.textContent = [
      documentMeta(doc),
      doc.chatTitle ? `来自：${doc.chatTitle}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    els.documentDownload.href = `/api/documents/${id}/download`;
    els.documentDownload.download = doc.filename || '';
    const isPdf = doc.format === 'pdf';
    els.documentOpenPdf.hidden = !isPdf;
    if (isPdf) els.documentOpenPdf.href = `/api/documents/${id}/file`;
    renderPreview(doc.blocks || []);
    els.documentModal.hidden = false;
  } catch (error) {
    toast(error.message);
  }
}

export function closeDocumentPreview() {
  els.documentModal.hidden = true;
  els.documentModalBody.replaceChildren();
}

async function deleteDocument(doc) {
  if (!confirm(`确定删除文档「${doc.title || 'Luma 文档'}」？`)) return;
  try {
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    if (!els.documentModal.hidden) closeDocumentPreview();
    await refreshDocuments();
    toast('文档已删除');
  } catch (error) {
    toast(error.message);
  }
}

export function documentsGoBack() {
  backToChat();
}
