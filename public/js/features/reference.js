import {
  els,
  state,
  toast,
  updateComposerPlaceholder,
  updateSendButton,
} from '../core/index.js';
import { isDocumentFile, uploadDocument } from './attachments.js';

const MAX_REFERENCES = 4;
const REFERENCE_ROLE_OPTIONS = ['参考', '角色', '风格', '构图', '版式', '产品'];

export function setPrimaryReference(ref) {
  if (!ref?.id) return;
  state.references = [{ ...ref, role: ref.role || '参考' }];
  renderReference();
  updateComposerPlaceholder();
  updateSendButton();
}

export function addReference(ref) {
  if (!ref?.id) return;
  if (state.references.some((item) => item.id === ref.id)) return;
  if (state.references.length >= MAX_REFERENCES) {
    toast(`最多 ${MAX_REFERENCES} 张参考图`);
    return;
  }
  state.references.push({ ...ref, role: ref.role || '参考' });
  renderReference();
  updateComposerPlaceholder();
  updateSendButton();
}

export function removeReference(index) {
  state.references.splice(index, 1);
  renderReference();
  updateComposerPlaceholder();
  updateSendButton();
}

export function clearReference() {
  state.references = [];
  renderReference();
  updateComposerPlaceholder();
  updateSendButton();
}

export function renderReference() {
  els.refSlot.innerHTML = '';
  if (!state.references.length) {
    els.refSlot.hidden = true;
    return;
  }
  els.refSlot.hidden = false;
  state.references.forEach((ref, index) => {
    const chip = document.createElement('div');
    chip.className = 'ref-chip';
    chip.title = index === 0 ? '主参考图' : `参考图 ${index + 1}`;
    const img = document.createElement('img');
    img.src = ref.url;
    img.alt = `参考图 ${index + 1}`;
    chip.appendChild(img);

    const role = document.createElement('select');
    role.className = 'ref-role';
    role.setAttribute('aria-label', `参考图 ${index + 1} 用途`);
    for (const name of REFERENCE_ROLE_OPTIONS) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      role.appendChild(option);
    }
    role.value = ref.role || '参考';
    role.addEventListener('change', () => {
      ref.role = role.value;
    });
    chip.appendChild(role);

    const remove = document.createElement('button');
    remove.className = 'ref-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除参考图';
    remove.setAttribute('aria-label', `移除参考图 ${index + 1}`);
    remove.addEventListener('click', () => removeReference(index));
    chip.appendChild(remove);
    els.refSlot.appendChild(chip);
  });
}

export async function uploadOne(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('图片不能超过 25MB');
    return;
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast('只支持 PNG / JPEG / WebP 图片');
    return;
  }
  if (state.references.length >= MAX_REFERENCES) {
    toast(`最多 ${MAX_REFERENCES} 张参考图`);
    return;
  }
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    addReference({ id: data.imageId, url: data.url });
    els.input.focus();
  } catch (error) {
    toast(error.message);
  }
}

export async function uploadFiles(files) {
  const list = Array.from(files || []);
  try {
    for (const file of list) {
      if (isDocumentFile(file)) {
        await uploadDocument(file);
      } else {
        await uploadOne(file);
      }
    }
  } finally {
    els.fileInput.value = '';
  }
}

export async function handlePaste(event) {
  if (
    els.appShell.hidden ||
    state.view !== 'chat' ||
    !els.settingsModal.hidden ||
    !els.folderModal.hidden ||
    !els.templateModal.hidden ||
    !els.tagModal.hidden ||
    !els.compareModal.hidden ||
    !els.lightbox.hidden
  ) {
    return;
  }

  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const items = clipboard.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (!file.type.startsWith('image/') && !isDocumentFile(file)) continue;
      event.preventDefault();
      if (isDocumentFile(file)) await uploadDocument(file);
      else await uploadOne(file);
      return;
    }
  }

  const files = clipboard.files;
  if (files && files.length) {
    const file = Array.from(files).find(
      (entry) => entry.type.startsWith('image/') || isDocumentFile(entry),
    );
    if (file) {
      event.preventDefault();
      if (isDocumentFile(file)) await uploadDocument(file);
      else await uploadOne(file);
    }
  }
}
