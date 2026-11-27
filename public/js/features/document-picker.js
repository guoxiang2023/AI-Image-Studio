import { api, el, els, icon, state, toast } from '../core/index.js';
import { openLightbox } from './overlays.js';

const FORMAT_LABEL = { docx: 'Word 文档', pdf: 'PDF 文档' };
const FORMAT_SHORT = { docx: 'DOCX', pdf: 'PDF' };

// Everything below describes the dialog currently on screen. `sessionId` is the
// session the listing was fetched for, so a response that returns after the
// session changed can never paint one conversation's pictures into another's
// picker.
let sessionId = null;
let images = [];
let selection = new Set();
let format = 'docx';
let loading = false;
let loadFailed = false;
let loadSeq = 0;
// Pictures whose file would not load in this dialog. They stay listed so the
// user sees what the conversation holds, but cannot be selected: the document
// could not embed them, and selecting one would fail after the long build.
let broken = new Set();
// Sessions with an export already running. A dialog reopened on the same
// session must not post a second document while the first is still building.
// This is the only source of the busy state, so closing and reopening the
// dialog cannot leave a stale flag behind.
const exporting = new Set();

function busy() {
  return Boolean(sessionId) && exporting.has(sessionId);
}

let dialogOpen = false;
let lastDocument = null;

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function submitLabel() {
  if (busy()) return '正在整理文档…';
  const name = format === 'pdf' ? 'PDF' : 'Word';
  return selection.size
    ? `生成 ${name} 文档（${selection.size} 张图片）`
    : '请先勾选图片';
}

function selectableImages() {
  return images.filter((image) => !broken.has(image.id));
}

function syncControls() {
  const total = images.length;
  const selectableTotal = selectableImages().length;
  const locked = loading || busy() || Boolean(lastDocument);
  // The denominator is every tile on screen, including one whose file failed
  // to load; that tile carries its own "图片不可用" label and 全选 skips it.
  els.documentPickerCount.textContent = total
    ? `已选 ${selection.size} / ${total} 张`
    : `已选 ${selection.size} 张`;
  els.documentPickerAll.disabled =
    locked || !selectableTotal || selection.size === selectableTotal;
  els.documentPickerClear.disabled = locked || selection.size === 0;
  els.documentPickerRetry.disabled = loading || busy();
  els.documentPickerSubmit.disabled = locked || loadFailed || selection.size === 0;
  els.documentPickerSubmit.textContent = submitLabel();
  for (const radio of els.documentPickerFormats.querySelectorAll('input')) {
    radio.disabled = locked;
    radio.checked = radio.value === format;
  }
}

// Keep the preview button outside the selection label so opening an image
// never changes whether it's included in the document.
function createCard(image, index) {
  const card = el('div', 'doc-pick');
  const tile = el('div', 'doc-pick-tile');
  const preview = el('button', 'doc-pick-zoom');
  preview.type = 'button';
  preview.setAttribute('aria-label', `放大查看${image.caption || `图片 ${index + 1}`}`);
  preview.title = '查看大图';
  preview.append(icon('expand'));
  preview.disabled = broken.has(image.id);
  preview.addEventListener('click', () => {
    const available = selectableImages();
    openLightbox(image.url, {
      images: available.map((item) => ({ url: item.url, alt: item.caption })),
      index: available.indexOf(image),
      opener: preview,
    });
  });

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'doc-pick-input';
  input.value = image.id;
  input.checked = selection.has(image.id);
  const origin = [image.source, image.round ? `第 ${image.round} 轮` : '']
    .filter(Boolean)
    .join('，');
  input.setAttribute(
    'aria-label',
    `图片 ${index + 1}：${image.caption || '未命名图片'}${origin ? `（${origin}）` : ''}`,
  );
  input.addEventListener('change', () => {
    if (input.checked) selection.add(image.id);
    else selection.delete(image.id);
    card.classList.toggle('is-selected', input.checked);
    syncControls();
  });
  card.classList.toggle('is-selected', input.checked);
  // A picture that already failed in this dialog stays unavailable after a
  // re-render instead of reappearing as if it could be picked.
  if (broken.has(image.id)) {
    card.classList.add('is-broken');
    input.disabled = true;
    input.checked = false;
    card.classList.remove('is-selected');
  }
  const pick = el('label', 'doc-pick-pick');
  pick.appendChild(input);

  const thumb = el('span', 'doc-pick-thumb');
  const img = el('img');
  img.src = image.url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // A file can vanish between listing and rendering. The server's listing is
  // the offer, but a picture that will not load cannot be embedded, so it drops
  // out of the selection instead of silently producing a broken document.
  img.addEventListener('error', () => {
    card.classList.add('is-broken');
    preview.disabled = true;
    input.disabled = true;
    broken.add(image.id);
    if (selection.delete(image.id)) syncControls();
    card.classList.remove('is-selected');
    input.checked = false;
  });
  thumb.appendChild(img);
  const check = el('span', 'doc-pick-check', '✓');
  check.setAttribute('aria-hidden', 'true');
  thumb.appendChild(check);
  pick.appendChild(thumb);
  card.appendChild(pick);
  card.appendChild(preview);

  const meta = el('span', 'doc-pick-meta');
  const caption = el('span', 'doc-pick-caption', image.caption || '未命名图片');
  caption.title = image.caption || '';
  meta.appendChild(caption);
  const tags = el('span', 'doc-pick-tags');
  if (image.source) tags.appendChild(el('span', 'doc-pick-tag', image.source));
  if (image.round) tags.appendChild(el('span', 'doc-pick-tag', `第 ${image.round} 轮`));
  if (tags.childElementCount) meta.appendChild(tags);
  card.appendChild(meta);
  tile.append(card);
  return tile;
}

function renderImages() {
  els.documentPickerGrid.replaceChildren();
  if (loading || loadFailed) {
    els.documentPickerGrid.hidden = true;
    els.documentPickerEmpty.hidden = true;
    return;
  }
  els.documentPickerEmpty.hidden = Boolean(images.length);
  els.documentPickerGrid.hidden = !images.length;
  images.forEach((image, index) => {
    els.documentPickerGrid.appendChild(createCard(image, index));
  });
}

function reset() {
  sessionId = state.sessionId;
  images = [];
  selection = new Set();
  broken = new Set();
  format = 'docx';
  loading = false;
  loadFailed = false;
  lastDocument = null;
  els.documentPickerGrid.replaceChildren();
  els.documentPickerGrid.hidden = true;
  els.documentPickerEmpty.hidden = true;
  els.documentPickerLoading.hidden = true;
  els.documentPickerError.hidden = true;
  els.documentPickerErrorText.textContent = '';
  els.documentPickerSubmitError.hidden = true;
  els.documentPickerSubmitError.textContent = '';
  els.documentPickerSuccess.hidden = true;
  els.documentPickerToolbar.hidden = false;
  els.documentPickerBody.removeAttribute('aria-busy');
  els.documentPickerSubmit.hidden = false;
  els.documentPickerNote.textContent = '未插入正文的勾选图片会按会话顺序放在文末附录。';
  els.cancelDocumentPicker.textContent = '取消';
  syncControls();
}

async function loadImages() {
  if (!sessionId) return;
  const seq = ++loadSeq;
  loading = true;
  loadFailed = false;
  els.documentPickerLoading.hidden = false;
  els.documentPickerError.hidden = true;
  els.documentPickerErrorText.textContent = '';
  renderImages();
  syncControls();
  try {
    const data = await api(`/api/sessions/${sessionId}/document-images`);
    if (seq !== loadSeq) return;
    const listed = Array.isArray(data?.images) ? data.images : [];
    images = listed.filter((image) => image && image.id && image.url);
    broken = new Set();
    // A retry replaces the listing; anything already ticked that is still
    // offered stays ticked instead of silently dropping.
    const offered = new Set(images.map((image) => image.id));
    selection = new Set([...selection].filter((id) => offered.has(id) && !broken.has(id)));
  } catch (error) {
    if (seq !== loadSeq) return;
    // Ticks are kept: a retry may restore the same pictures, and losing the
    // user's choices because a listing request failed would be a second,
    // avoidable cost on top of the error itself.
    images = [];
    loadFailed = true;
    els.documentPickerErrorText.textContent = error.message || '无法读取会话图片';
    els.documentPickerError.hidden = false;
  } finally {
    if (seq !== loadSeq) return;
    loading = false;
    els.documentPickerLoading.hidden = true;
    renderImages();
    syncControls();
  }
}

function showSuccess(doc) {
  // Un-hide the live region first: a status filled while still hidden is not
  // announced, so the result would arrive silently for screen-reader users.
  els.documentPickerSuccess.hidden = false;
  els.documentPickerSuccessFormat.textContent = FORMAT_SHORT[doc.format] || 'DOCX';
  els.documentPickerSuccessTitle.textContent = doc.title || '文档';
  const parts = [FORMAT_LABEL[doc.format] || '文档'];
  parts.push(doc.appendixImageCount
    ? `正文 ${doc.bodyImageCount} 张，文末附录 ${doc.appendixImageCount} 张`
    : `正文 ${doc.imageCount} 张图片`);
  if (doc.size) parts.push(formatBytes(doc.size));
  if (doc.issues?.length) parts.push('部分内容未完成');
  els.documentPickerSuccessMeta.textContent = parts.join(' · ');
  if (doc.issues?.length) els.documentPickerSuccess.title = doc.issues.join('；');
  else els.documentPickerSuccess.removeAttribute('title');
  els.documentPickerDownload.href = `/api/documents/${doc.id}/download`;
  els.documentPickerDownload.download = doc.filename || '';
  // The dialog becomes a result view: the listing and the format switch are
  // gone, so nothing can post the same selection a second time.
  els.documentPickerToolbar.hidden = true;
  els.documentPickerGrid.replaceChildren();
  els.documentPickerGrid.hidden = true;
  els.documentPickerEmpty.hidden = true;
  els.documentPickerLoading.hidden = true;
  els.documentPickerError.hidden = true;
  els.documentPickerSubmitError.hidden = true;
  els.documentPickerSubmit.hidden = true;
  els.documentPickerNote.textContent = '文档已保存到「我的文档」，可随时查看或下载。';
  els.cancelDocumentPicker.textContent = '关闭';
  // The submit button just disappeared; without this, focus would be lost to
  // the body and a keyboard user would have nowhere to continue from.
  els.documentPickerView.focus();
}

function hideDialog() {
  loadSeq += 1;
  loading = false;
  dialogOpen = false;
  els.documentPickerBody.removeAttribute('aria-busy');
  els.documentPickerModal.hidden = true;
  els.documentPickerLoading.hidden = true;
  els.documentPickerSuccess.hidden = true;
  els.documentPickerToolbar.hidden = false;
  els.documentPickerGrid.replaceChildren();
}

export function syncDocumentPickerButton() {
  const button = els.documentPickerBtn;
  const archivedButton = els.archivedDocumentBtn;
  const noSession = !state.sessionId;
  const blocked = noSession || state.streaming;
  if (button) {
    button.disabled = blocked;
    button.title = noSession
      ? '先在左侧打开一个会话'
      : state.streaming
        ? '等待当前回复完成后再导出文档'
        : '选择本会话的图片，导出 Word 或 PDF 文档';
  }
  // An archived conversation keeps its composer hidden, so the banner carries
  // the same entry point instead of the feature disappearing with the input box.
  if (archivedButton) {
    archivedButton.disabled = noSession || state.streaming;
    archivedButton.title = '选择本会话的图片，导出 Word 或 PDF 文档';
  }
}

export async function openDocumentPicker() {
  if (!state.sessionId) {
    toast('先打开一个会话');
    return;
  }
  if (state.streaming) {
    toast('请等待当前回复完成');
    return;
  }
  // A build for this session may still be running after the dialog was
  // dismissed: reopening is allowed so the user can wait for it and get the
  // result, but the controls stay locked until it lands.
  reset();
  dialogOpen = true;
  els.documentPickerSub.textContent = `${state.chatTitle || '当前会话'} · 勾选要写进文档的图片`;
  els.documentPickerModal.hidden = false;
  els.documentPickerModal.querySelector('.modal')?.focus();
  await loadImages();
}

export function closeDocumentPicker() {
  if (!dialogOpen) return;
  // Closing during a build is allowed: the request keeps running on the server,
  // the finished document still lands in 「我的文档」, and the toast reports it.
  // Trapping the dialog for a multi-minute generation would be worse.
  hideDialog();
  // Return focus to the control that actually opened the dialog: the composer
  // chip for a live session, the banner button while a session is archived.
  for (const opener of [els.documentPickerBtn, els.archivedDocumentBtn]) {
    if (!opener || opener.disabled) continue;
    if (opener.offsetParent === null) continue;
    opener.focus();
    break;
  }
}

/**
 * Dismissal forced by a session switch. The export keeps running for the
 * session that asked for it (aborting a multi-minute generation because the
 * user glanced at another conversation would throw away their request), but
 * its result is not painted into whatever dialog the user is looking at now.
 */
export function dismissDocumentPicker() {
  if (!dialogOpen) return;
  hideDialog();
}

export function selectAllDocumentImages() {
  const selectable = selectableImages();
  if (loading || busy() || !selectable.length) return;
  selection = new Set(selectable.map((image) => image.id));
  renderImages();
  syncControls();
}

export function clearDocumentSelection() {
  if (loading || busy()) return;
  selection = new Set();
  renderImages();
  syncControls();
}

export function setDocumentPickerFormat(value) {
  if (loading || busy()) return;
  format = value === 'pdf' ? 'pdf' : 'docx';
  syncControls();
}

export function retryDocumentImages() {
  if (loading || busy()) return;
  void loadImages();
}

export async function submitDocumentPicker() {
  // Three guards: `busy()` blocks a double click, the session check blocks a
  // request aimed at a conversation the dialog no longer shows, and a streaming
  // turn would change the very material the document is built from.
  if (loading || loadFailed || !dialogOpen || !sessionId || lastDocument) return;
  if (busy()) {
    toast('这个会话正在生成文档，请稍候');
    return;
  }
  if (state.streaming) {
    toast('请等待当前回复完成');
    return;
  }
  if (sessionId !== state.sessionId) {
    toast('会话已切换，请重新打开文档选图');
    return;
  }
  const target = sessionId;
  // Session order, not click order: the document reads like the conversation.
  const imageIds = selectableImages()
    .filter((image) => selection.has(image.id))
    .map((image) => image.id);
  if (!imageIds.length) return;
  // The response is painted only while a dialog is open on the session it was
  // built for. Reopening the same session while the build runs wants the
  // result; a dialog on any other session must never receive it.
  const current = () => dialogOpen && sessionId === target;
  exporting.add(target);
  lastDocument = null;
  els.documentPickerSubmitError.hidden = true;
  els.documentPickerSubmitError.textContent = '';
  els.documentPickerBody.setAttribute('aria-busy', 'true');
  syncControls();
  let saved = null;
  try {
    const data = await api(`/api/sessions/${target}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, imageIds }),
    });
    if (!data?.document?.id) throw new Error('服务端没有返回生成的文档');
    saved = data.document;
    if (current()) {
      lastDocument = saved;
      showSuccess(saved);
    }
    toast(
      saved.issues?.length
        ? `文档已生成：${saved.title || '文档'}（部分内容未完成，可下载查看）`
        : `文档已生成：${saved.title || '文档'}，可在「我的文档」查看`,
    );
  } catch (error) {
    // The selection is deliberately kept: the same picks can be retried
    // without hunting through the conversation again.
    if (current()) {
      els.documentPickerSubmitError.textContent = `${error.message || '生成失败'}（选择已保留，可重试）`;
      els.documentPickerSubmitError.hidden = false;
    }
    toast(error.message || '文档生成失败');
  } finally {
    // A dialog force-closed by a session switch still has to release its own
    // busy flag, or the next open on a different session would start locked.
    exporting.delete(target);
    if (dialogOpen) {
      els.documentPickerBody.removeAttribute('aria-busy');
      syncControls();
    }
  }
  if (saved) {
    // A failed library refresh must not read as a failed export.
    const { refreshDocuments } = await import('./documents.js');
    await refreshDocuments();
  }
}

export async function viewGeneratedDocument() {
  if (!lastDocument?.id) return;
  const id = lastDocument.id;
  const { openDocumentPreview } = await import('./documents.js');
  hideDialog();
  await openDocumentPreview(id);
}
