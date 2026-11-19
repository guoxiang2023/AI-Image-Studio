import {
  el,
  els,
  state,
  toast,
  updateComposerPlaceholder,
  updateSendButton,
} from '../core/index.js';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const DOCUMENT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'xml',
  'yml',
  'yaml',
  'html',
  'htm',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'dwg',
]);

export function documentExt(name) {
  return String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

export function isDocumentFile(file) {
  return DOCUMENT_EXTS.has(documentExt(file?.name));
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export function addAttachment(document) {
  if (!document?.id) return;
  if (state.attachments.some((item) => item.id === document.id)) return;
  if (state.attachments.length >= MAX_ATTACHMENTS) {
    toast(`最多 ${MAX_ATTACHMENTS} 个附件`);
    return;
  }
  state.attachments.push({ ...document });
  renderAttachments();
  updateComposerPlaceholder();
  updateSendButton();
}

export function removeAttachment(index) {
  state.attachments.splice(index, 1);
  renderAttachments();
  updateComposerPlaceholder();
  updateSendButton();
}

export function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  updateComposerPlaceholder();
  updateSendButton();
}

export function renderAttachments() {
  if (!els.attachmentSlot) return;
  els.attachmentSlot.innerHTML = '';
  if (!state.attachments.length) {
    els.attachmentSlot.hidden = true;
    return;
  }
  els.attachmentSlot.hidden = false;
  state.attachments.forEach((attachment, index) => {
    const chip = el('div', 'file-chip');
    chip.title = `${attachment.name} · ${formatSize(attachment.size)} · ${
      attachment.chars || 0
    } 字符`;
    chip.appendChild(el('span', 'file-ext', String(attachment.ext || '').toUpperCase()));
    chip.appendChild(el('span', 'file-name', attachment.name || '附件'));

    const remove = el('button', 'file-remove', '×');
    remove.type = 'button';
    remove.title = '移除附件';
    remove.setAttribute('aria-label', `移除附件 ${attachment.name || index + 1}`);
    remove.addEventListener('click', () => removeAttachment(index));
    chip.appendChild(remove);
    els.attachmentSlot.appendChild(chip);
    renderPdfImages(attachment.images, attachment.ext);
  });
}

// A PDF can yield two kinds of picture: bitmaps stored in the file, and whole
// pages rendered to an image because a CAD sheet is vector-only. Both are
// offered as ready-to-use reference images, labelled so it is obvious which is
// an embedded photo and which is a screenshot of the drawing.
function pdfImageLabel(images, ext) {
  // A CAD file yields one rendered sheet, which is not a PDF page screenshot.
  if (ext === 'dwg') return 'CAD 图纸已渲染，可直接用作参考图';
  const pages = images.filter((image) => image.type === 'page').length;
  const bitmaps = images.length - pages;
  if (pages && bitmaps) return `PDF 图片 ${images.length} 张（${bitmaps} 内嵌 · ${pages} 页截图）`;
  if (pages) return `PDF 页截图 ${pages} 张`;
  return `PDF 内嵌图片 ${bitmaps} 张`;
}

function pdfImageHint(image, ext) {
  if (ext === 'dwg') {
    return `CAD 图纸 · ${image.width}×${image.height} · 点击用作参考图`;
  }
  return image.type === 'page'
    ? `第 ${image.page} 页截图 · ${image.width}×${image.height} · 点击用作参考图`
    : `第 ${image.page} 页内嵌图片 · ${image.width}×${image.height} · 点击用作参考图`;
}

function renderPdfImages(images, ext) {
  if (!Array.isArray(images) || !images.length) return;
  const strip = el('div', 'file-images');
  strip.appendChild(el('span', 'file-images-label', pdfImageLabel(images, ext)));
  images.forEach((image, index) => {
    const button = el('button', 'file-thumb');
    button.type = 'button';
    button.title = pdfImageHint(image, ext);
    const what =
      ext === 'dwg'
        ? 'CAD 图纸'
        : image.type === 'page'
          ? `第 ${image.page} 页截图`
          : `第 ${image.page} 页内嵌图片`;
    button.setAttribute('aria-label', `把${what}用作参考图`);
    const img = el('img');
    img.src = image.url;
    img.alt = ext === 'dwg' ? 'CAD 图纸' : `PDF 第 ${image.page} 页图片 ${index + 1}`;
    img.loading = 'lazy';
    button.appendChild(img);
    button.addEventListener('click', async () => {
      const { addReference } = await import('./reference.js');
      addReference({ id: image.id, url: image.url, role: '参考' });
      toast('已加入参考图，说明要怎么改');
    });
    strip.appendChild(button);
  });
  els.attachmentSlot.appendChild(strip);
}

export async function uploadDocument(file) {
  if (!file) return;
  if (!isDocumentFile(file)) {
    toast('只支持 txt / Word / Excel / PPT / PDF 等文档');
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast('文件不能超过 50MB');
    return;
  }
  if (state.attachments.length >= MAX_ATTACHMENTS) {
    toast(`最多 ${MAX_ATTACHMENTS} 个附件`);
    return;
  }
  if (state.attachments.some((item) => item.name === file.name && item.size === file.size)) {
    toast('这个文件已经添加');
    return;
  }
  const ext = documentExt(file.name);
  if (ext === 'pdf') toast('正在读取 PDF 文字…');
  if (ext === 'dwg') toast('正在渲染 CAD 图纸…');
  try {
    const res = await fetch('/api/upload/document', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    addAttachment(data);
    els.input.focus();
  } catch (error) {
    toast(error.message);
  }
}
