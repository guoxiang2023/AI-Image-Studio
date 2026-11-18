import { api, el, els, toast } from '../core/index.js';
import { renderMarkdown } from '../core/markdown.js';

let current = null;
let pending = null;
let notified = false;
let install = null;
let pollTimer = null;

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

const INSTALL_LABELS = {
  downloading: '正在下载',
  installing: '正在安装',
  restarting: '正在重启',
};

function renderInstall(state) {
  const data = state || { supported: false };
  const busy = ['downloading', 'installing', 'restarting'].includes(data.state);
  els.updateInstallWrap.hidden = !data.supported;
  els.updateInstall.hidden = !data.supported || data.state === 'restarting';
  els.updateInstall.disabled = busy;
  els.updateInstall.textContent = busy
    ? INSTALL_LABELS[data.state] || '更新中…'
    : '立即更新并重启';

  els.updateProgressPercent.textContent = `${Math.min(100, Math.round(data.percent || 0))}%`;
  els.updateProgressBar.style.width = `${Math.min(100, data.percent || 0)}%`;
  els.updateProgressBar.classList.toggle('is-error', data.state === 'error');

  const size = data.total
    ? `${formatSize(data.received) || '0 B'} / ${formatSize(data.total)}`
    : '';
  els.updateProgressText.textContent = data.error
    ? data.error
    : data.state === 'restarting'
      ? '安装完成，应用正在重启…'
      : busy
        ? `${INSTALL_LABELS[data.state]}${size ? ` · ${size}` : ''}`
        : data.supported
          ? '更新会下载安装包并自动重启应用；会话与数据保存在本地，不会丢失。'
          : data.reason || '';

  if (busy) {
    els.closeUpdate.disabled = true;
    els.cancelUpdate.disabled = true;
  } else {
    els.closeUpdate.disabled = false;
    els.cancelUpdate.disabled = false;
  }
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
  renderInstall(hasUpdate ? install : { supported: false });
  // Reopening the modal mid-update must keep tracking the running job.
  if (hasUpdate && ['downloading', 'installing'].includes(install?.state)) pollInstall();
}

async function refreshInstallStatus() {
  try {
    install = await api('/api/update/status');
  } catch {
    install = { supported: false, reason: '无法获取更新状态' };
  }
  return install;
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function pollInstall() {
  stopPolling();
  pollTimer = setTimeout(async () => {
    const state = await refreshInstallStatus();
    renderInstall(state);
    if (state.state === 'downloading' || state.state === 'installing') {
      pollInstall();
      return;
    }
    if (state.state === 'restarting') {
      els.updateProgressText.textContent = '安装完成，应用正在重启…';
      return;
    }
    if (state.state === 'error') toast(state.error || '更新失败');
  }, 600);
}

export async function startInstall() {
  els.updateInstall.disabled = true;
  els.updateProgressText.textContent = '正在准备更新…';
  try {
    install = await api('/api/update/install', { method: 'POST' });
    renderInstall(install);
    pollInstall();
  } catch (error) {
    install = { ...(install || {}), state: 'error', error: error?.message || '更新失败' };
    renderInstall(install);
    toast(install.error);
  }
}

export function openUpdateModal() {
  els.updateModal.hidden = false;
  renderUpdate(current || { currentVersion: '', latestVersion: null });
  void checkForUpdates({ force: true, showModal: true });
}

export function closeUpdateModal() {
  if (['downloading', 'installing', 'restarting'].includes(install?.state)) return;
  stopPolling();
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
    .then(async (info) => {
      current = info;
      applyVersion(info);
      if (info.hasUpdate) install = await refreshInstallStatus();
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
