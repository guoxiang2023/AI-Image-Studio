import { APP_VERSION, UPDATE_CACHE_MS, UPDATE_REPO, UPDATE_TIMEOUT } from '../config.js';
import { clipText, extractError, withTimeout } from '../shared/utils.js';

const REPO = String(UPDATE_REPO || '')
  .trim()
  .replace(/^https?:\/\/github\.com\//i, '')
  .replace(/\.git$/i, '')
  .replace(/^\/+|\/+$/g, '');
const ERROR_CACHE_MS = 60 * 1000;
let cache = null;

function parseVersion(value) {
  const match = String(value || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || '',
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function baseInfo() {
  return {
    currentVersion: APP_VERSION,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: REPO ? `https://github.com/${REPO}/releases` : '',
    releaseName: '',
    publishedAt: null,
    notes: '',
    assets: [],
    checkedAt: new Date().toISOString(),
  };
}

function cacheAge(data) {
  return data?.error ? ERROR_CACHE_MS : UPDATE_CACHE_MS;
}

export async function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < cacheAge(cache.data)) {
    return cache.data;
  }

  const data = baseInfo();
  if (!REPO) {
    data.error = '未配置更新仓库';
    cache = { at: now, data };
    return data;
  }

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Luma-Image-Agent',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: withTimeout(undefined, UPDATE_TIMEOUT),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`更新检查失败 (${res.status})：${extractError(text)}`);
    }

    let release;
    try {
      release = JSON.parse(text);
    } catch {
      throw new Error('更新接口返回了无法解析的内容');
    }

    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
    if (!parseVersion(latestVersion)) {
      throw new Error('无法解析最新版本号');
    }

    data.latestVersion = latestVersion;
    data.hasUpdate = compareVersions(latestVersion, APP_VERSION) > 0;
    data.releaseUrl = release.html_url || data.releaseUrl;
    data.releaseName = String(release.name || '').trim();
    data.publishedAt = release.published_at || null;
    data.notes = clipText(release.body || '', 5000);
    data.assets = Array.isArray(release.assets)
      ? release.assets
          .map((asset) => ({
            name: String(asset.name || ''),
            url: String(asset.browser_download_url || ''),
            size: Number(asset.size) || 0,
          }))
          .filter((asset) => asset.name && asset.url)
      : [];
  } catch (err) {
    data.error = err?.name === 'TimeoutError' ? '检查更新超时' : err?.message || '检查更新失败';
  }

  cache = { at: now, data };
  return data;
}
