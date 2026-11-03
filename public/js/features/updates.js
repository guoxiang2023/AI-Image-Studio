import { api, el, els, toast } from '../core/index.js';
import { renderMarkdown } from '../core/markdown.js';

let current = null;
let pending = null;
let notified = false;

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return value ? `${value} B` : '';
}

function applyVersion(info) {
  if (info?.currentVersion) els.versionText.textContent = `v${info.currentVersion}`;
  const hasUpdate = Boolean(info?.hasUpdate);
  els.updateDot.hidden = !hasUpdate;
  els.versionBtn.classList.toggle('has-update', hasUpdate);
  els.versionBtn.title = hasUpdate
    ? `发现新版本 v${info.latestVersion}`
    : info?.error
      ? '检查更新失败，点击重试'
      : '检查更新';
}

function renderAssets(assets) {
  els.updateAssets.innerHTML = '';
  if (!Array.isArray(assets) || !assets.length) {
    els.updateAssetsWrap.hidden = true;
    return;
  }
  for (const asset of assets) {
    const link = el('a', 'update-asset');
    link.href = asset.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(el('span', 'update-asset-name', asset.name));
    const size = formatSize(asset.size);
    if (size) link.appendChild(el('span', 'update-asset-size', size));
    els.updateAssets.appendChild(link);
  }
  els.updateAssetsWrap.hidden = false;
}

export function renderUpdate(info) {
  const data = info || {};
  const hasUpdate = Boolean(data.hasUpdate);
  const checking = !data.latestVersion && !data.error;
  els.updateCurrent.textContent = data.currentVersion ? `v${data.currentVersion}` : '—';
  els.updateLatest.textContent = data.latestVersion ? `v${data.latestVersion}` : '—';
  els.updateStatus.classList.toggle('is-update', hasUpdate);
  els.updateStatus.textContent = checking
    ? '正在检查…'
    : data.error
      ? '暂时无法检查更新'
      : hasUpdate
        ? `发现新版本 v${data.latestVersion}`
        : '当前已是最新版本';
  els.updateError.hidden = !data.error;
  els.updateError.textContent = data.error ? `检查失败：${data.error}` : '';

  const canDownload = hasUpdate && Boolean(data.releaseUrl);
  els.updateDownload.hidden = !canDownload;
  if (canDownload) els.updateDownload.href = data.releaseUrl;

  const notes = hasUpdate ? String(data.notes || '').trim() : '';
  renderMarkdown(els.updateNotes, notes);
  els.updateNotesWrap.hidden = !notes;
  renderAssets(hasUpdate ? data.assets : []);
}

export function openUpdateModal() {
  els.updateModal.hidden = false;
  renderUpdate(current || { currentVersion: '', latestVersion: null });
  void checkForUpdates({ force: true, showModal: true });
}

export function closeUpdateModal() {
  els.updateModal.hidden = true;
}

function setRecheckBusy(busy) {
  els.recheckUpdate.disabled = busy;
  els.recheckUpdate.textContent = busy ? '检查中…' : '重新检查';
}

export async function checkForUpdates({ force = false, showModal = false, notify = false } = {}) {
  if (pending) return pending;
  setRecheckBusy(true);
  if (showModal || !els.updateModal.hidden) {
    els.updateStatus.classList.remove('is-update');
    els.updateStatus.textContent = '正在检查…';
    els.updateError.hidden = true;
    els.updateError.textContent = '';
  }
  pending = api(`/api/version${force ? '?refresh=1' : ''}`)
    .then((info) => {
      current = info;
      applyVersion(info);
      if (showModal || !els.updateModal.hidden) renderUpdate(info);
      if (info.hasUpdate && !notified) {
        notified = true;
        toast(`发现新版本 v${info.latestVersion}`);
      } else if (notify && !info.hasUpdate && !info.error) {
        toast('当前已是最新版本');
      }
      return info;
    })
    .catch((error) => {
      const info = {
        ...(current || {}),
        hasUpdate: false,
        error: error?.message || '检查更新失败',
      };
      applyVersion(info);
      if (showModal || !els.updateModal.hidden) renderUpdate(info);
      return info;
    })
    .finally(() => {
      pending = null;
      setRecheckBusy(false);
    });
  return pending;
}
