import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDesktopUpdater } from '../shared/runtime.js';
import { checkForUpdate, selectAsset } from './update-service.js';
import { AppError } from '../shared/errors.js';
import updater from './desktop-updater.cjs';

const IDLE = {
  state: 'idle',
  percent: 0,
  received: 0,
  total: 0,
  version: '',
  error: '',
  startedAt: null,
  finishedAt: null,
};

let job = null;

function desktop() {
  return getDesktopUpdater();
}

export function installerStatus() {
  const hooks = desktop();
  if (!hooks) {
    return {
      ...IDLE,
      supported: false,
      reason: '仅桌面端支持应用内更新，网页版请下载安装包',
    };
  }
  if (!hooks.isPackaged) {
    return { ...(job || IDLE), supported: false, reason: '开发模式下不执行应用内更新' };
  }
  return { ...(job || IDLE), supported: true, reason: '' };
}

function setJob(patch) {
  job = { ...(job || IDLE), ...patch };
}

export async function startInstall() {
  const hooks = desktop();
  if (!hooks) throw new AppError(400, '仅桌面端支持应用内更新');
  if (!hooks.isPackaged) throw new AppError(400, '开发模式下不执行应用内更新');
  if (job && ['downloading', 'installing', 'restarting'].includes(job.state)) {
    throw new AppError(409, '更新正在进行中');
  }

  const info = await checkForUpdate({ force: true });
  if (info.error) throw new AppError(502, info.error);
  if (!info.hasUpdate) throw new AppError(400, '当前已是最新版本');

  const asset = selectAsset(info.assets, { platform: hooks.platform, arch: hooks.arch });
  if (!asset) {
    throw new AppError(404, `没有适用于 ${hooks.platform}-${hooks.arch} 的安装包，请手动下载`);
  }
  if (!asset.sha256) {
    throw new AppError(409, `v${info.latestVersion} 缺少校验值，无法应用内更新，请手动下载安装包`);
  }

  // Fail before the download when the install location cannot be replaced.
  if (hooks.platform === 'darwin') {
    try {
      await updater.assertWritableTarget(updater.appBundleFromExe(hooks.exePath));
    } catch (err) {
      throw new AppError(403, err?.message || '安装位置不可写，请手动安装更新');
    }
  }

  job = {
    ...IDLE,
    state: 'downloading',
    version: info.latestVersion,
    total: asset.size,
    startedAt: Date.now(),
  };

  // Runs detached: the HTTP response returns immediately and the UI polls /api/update/status.
  void runInstall({ hooks, asset, version: info.latestVersion }).catch((err) => {
    setJob({
      state: 'error',
      error: err?.name === 'AbortError' ? '下载超时，请重试' : err?.message || '更新失败',
      finishedAt: Date.now(),
    });
  });

  return installerStatus();
}

async function runInstall({ hooks, asset, version }) {
  const dest = path.join(hooks.stagingDir, asset.name);
  await fsp.mkdir(hooks.stagingDir, { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);

  try {
    await updater.downloadInstaller({
      url: asset.url,
      dest,
      sha256: asset.sha256,
      size: asset.size,
      signal: controller.signal,
      onProgress: ({ received, total }) => {
        setJob({
          received,
          total: total || asset.size || 0,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
        });
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  setJob({ state: 'installing', percent: 100 });
  await spawnInstall({ hooks, dest, version });

  setJob({ state: 'restarting', finishedAt: Date.now() });
  // Let the last status poll reach the renderer before the process exits.
  setTimeout(() => hooks.quit(), 1200);
}

async function spawnInstall({ hooks, dest, version }) {
  if (hooks.platform === 'darwin') {
    const targetApp = updater.appBundleFromExe(hooks.exePath);
    const stageRoot = path.join(hooks.stagingDir, `${version}-stage`);
    const stagedApp = await updater.stageMacBundle({
      dmgPath: dest,
      stagingRoot: stageRoot,
    });
    await updater.spawnMacSwap({
      targetApp,
      stagedApp,
      stageRoot,
      dmgPath: dest,
      pid: process.pid,
      logPath: hooks.logPath,
    });
    return;
  }
  if (hooks.platform === 'win32') {
    await updater.spawnWindowsInstaller({ installerPath: dest });
    return;
  }
  throw new Error(`暂不支持在 ${hooks.platform} 上自动安装`);
}
