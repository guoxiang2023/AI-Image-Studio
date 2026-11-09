import {
  el,
  els,
  state,
  toast,
  updateComposerPlaceholder,
  updateSendButton,
} from '../core/index.js';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
  });
}

export async function uploadDocument(file) {
  if (!file) return;
  if (!isDocumentFile(file)) {
    toast('只支持 txt / Word / Excel / PPT / PDF 等文档');
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast('文件不能超过 10MB');
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
  if (documentExt(file.name) === 'pdf') toast('正在读取 PDF 文字…');
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
