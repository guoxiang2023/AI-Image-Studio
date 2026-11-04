import { api, el, els, toast } from '../core/index.js';
import { renderMarkdown } from '../core/markdown.js';

let current = null;
let pending = null;
let notified = false;
let desktopUpdate = { ready: false, busy: false, version: '' };

function desktopUpdater() {
  return typeof window !== 'undefined' ? window.lumaUpdater : null;
}

function resetDesktopUpdate(version) {
  const nextVersion = String(version || '');
  if (desktopUpdate.version !== nextVersion) {
    desktopUpdate = { ready: false, busy: false, version: nextVersion };
  }
}

function markUpdateReady(version) {
  desktopUpdate.ready = true;
  desktopUpdate.version = String(version || desktopUpdate.version || '');
  els.updateInstall.textContent = '重启并安装';
  els.updateInstall.disabled = false;
  els.updateStatus.classList.add('is-update');
  els.updateStatus.textContent = '更新已下载，重启后完成安装';
  els.updateDownload.hidden = true;
}

function showDesktopUpdateError(message) {
  desktopUpdate.ready = false;
  els.updateStatus.classList.remove('is-update');
  els.updateStatus.textContent = '自动更新失败';
  els.updateError.hidden = false;
  els.updateError.textContent = `自动更新失败：${message}`;
  els.updateInstall.textContent = '重试更新';
  els.updateInstall.disabled = false;
  els.updateDownload.hidden = false;
}

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
  const canAutoUpdate = hasUpdate && Boolean(desktopUpdater());
  if (canAutoUpdate) resetDesktopUpdate(data.latestVersion);
  els.updateDownload.hidden = !canDownload;
  if (canDownload) els.updateDownload.href = data.releaseUrl;
  els.updateInstall.hidden = !canAutoUpdate;
  if (canAutoUpdate) {
    els.updateInstall.disabled = desktopUpdate.busy;
    els.updateInstall.textContent = desktopUpdate.busy
      ? '下载中…'
      : desktopUpdate.ready
        ? '重启并安装'
        : '下载并安装';
    if (desktopUpdate.ready) {
      els.updateStatus.classList.add('is-update');
      els.updateStatus.textContent = '更新已下载，重启后完成安装';
      els.updateDownload.hidden = true;
    }
  }

  const notes = hasUpdate ? String(data.notes || '').trim() : '';
  renderMarkdown(els.updateNotes, notes);
  els.updateNotesWrap.hidden = !notes;
  renderAssets(hasUpdate ? data.assets : []);
}

export async function startDesktopUpdate() {
  const updater = desktopUpdater();
  if (!updater) return;

  if (desktopUpdate.ready) {
    els.updateInstall.disabled = true;
    els.updateInstall.textContent = '正在重启…';
    const result = await updater.install();
    if (result?.error) showDesktopUpdateError(result.error);
    return;
  }

  if (desktopUpdate.busy) return;
  desktopUpdate.busy = true;
  els.updateInstall.disabled = true;
  els.updateInstall.textContent = '准备中…';
  els.updateStatus.classList.add('is-update');
  els.updateStatus.textContent = '正在准备下载更新…';
  els.updateError.hidden = true;
  els.updateError.textContent = '';

  const unsubscribe = updater.onStatus?.((status) => {
    if (!status) return;
    if (status.type === 'progress') {
      const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
      els.updateStatus.textContent = `正在下载更新 ${percent}%`;
      els.updateInstall.textContent = `下载中 ${percent}%`;
    } else if (status.type === 'downloaded') {
      markUpdateReady(status.version);
    } else if (status.type === 'error') {
      showDesktopUpdateError(status.message || '下载更新失败');
    }
  });

  try {
    const result = await updater.download();
    if (result?.error) throw new Error(result.error);
    markUpdateReady(result?.version || current?.latestVersion);
  } catch (error) {
    showDesktopUpdateError(error?.message || '下载更新失败');
  } finally {
    desktopUpdate.busy = false;
    els.updateInstall.disabled = false;
    unsubscribe?.();
  }
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
