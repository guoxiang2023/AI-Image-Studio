const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Release installers are downloaded from GitHub; anything else is rejected so a
// compromised settings value cannot point the updater at an arbitrary host.
const ALLOWED_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
];

function assertAllowedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('安装包地址无效');
  }
  if (url.protocol !== 'https:') throw new Error('安装包地址必须使用 HTTPS');
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error(`安装包来源不受信任：${url.hostname}`);
  }
  return url;
}

// Streams the file so a 170MB installer is never held in memory.
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

// Streams the installer to a .part file, resuming with Range when possible, so a
// dropped connection on a 170 MB download costs one retry instead of the whole file.
async function downloadInstaller({
  url,
  dest,
  sha256 = '',
  size = 0,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  retries = 4,
}) {
  assertAllowedUrl(url);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partPath = `${dest}.part`;
  const expected = Number(size) || 0;

  const attempt = async () => {
    let offset = 0;
    try {
      offset = (await fsp.stat(partPath)).size;
    } catch {
      offset = 0;
    }
    if (expected && offset > expected) {
      await fsp.rm(partPath, { force: true });
      offset = 0;
    }
    if (expected && offset === expected) return;

    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal, headers });
    } catch (err) {
      const cause = err?.cause?.code || err?.cause?.message || err?.message || '未知错误';
      throw Object.assign(new Error(`无法连接下载服务器：${cause}`), { retryable: true });
    }
    if (!res.ok || !res.body) {
      const retryable = res.status >= 500 || res.status === 429;
      throw Object.assign(new Error(`下载安装包失败 (HTTP ${res.status})`), { retryable });
    }
    if (res.url) {
      let finalUrl;
      try {
        finalUrl = new URL(res.url);
      } catch {
        throw new Error('下载地址无效');
      }
      if (finalUrl.protocol !== 'https:' || !ALLOWED_HOSTS.includes(finalUrl.hostname)) {
        throw new Error(`下载被重定向到不受信任的地址：${finalUrl.hostname}`);
      }
    }

    let start = offset;
    if (offset > 0 && res.status === 206) {
      const range = /^bytes\s+(\d+)-/i.exec(res.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== offset) start = 0;
    } else if (offset > 0) {
      // Server ignored the Range header and is resending everything.
      start = 0;
    }

    const serverLen = Number(res.headers.get('content-length')) || 0;
    const total = (start > 0 ? start : 0) + serverLen || expected;
    if (expected && serverLen && total !== expected) {
      // The server is serving a different file than the release advertised.
      throw new Error(`安装包大小不符：期望 ${expected} 字节，服务器返回 ${total} 字节`);
    }
    // Awaiting each write means bytes already received are on disk, so a retry
    // resumes from the real offset instead of restarting the whole file.
    const file = await fsp.open(partPath, start > 0 ? 'a' : 'w', 0o600);
    let received = start;
    let lastEmit = 0;
    try {
      for await (const chunk of res.body) {
        await file.write(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 120) {
          lastEmit = now;
          onProgress({ received, total: total || received });
        }
      }
    } catch (err) {
      await file.close().catch(() => {});
      // A timeout must stop the retry loop instead of resuming forever.
      if (err?.name === 'AbortError') throw err;
      throw Object.assign(new Error(`下载中断：${err?.message || '连接被关闭'}`), { retryable: true });
    }
    await file.close();
    onProgress({ received, total: total || received });

    const written = (await fsp.stat(partPath)).size;
    if (expected && written < expected) {
      // With a declared length the stream throws on truncation; without one the
      // server simply ended early, so retrying would only repeat the same bytes.
      throw Object.assign(
        new Error(`安装包大小不符：期望 ${expected} 字节，实际 ${written} 字节`),
        { retryable: !serverLen },
      );
    }
  };

  for (let i = 0; i <= retries; i += 1) {
    try {
      await attempt();
      break;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('下载超时，请重试');
      if (!err?.retryable || i === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 800 * 2 ** i)));
    }
  }

  const bytes = (await fsp.stat(partPath)).size;
  if (expected && bytes !== expected) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw new Error(`安装包大小不符：期望 ${expected} 字节，实际 ${bytes} 字节`);
  }
  const actual = await sha256OfFile(partPath);
  if (sha256 && actual !== String(sha256).toLowerCase()) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw new Error('安装包校验失败（SHA-256 不匹配），已删除下载文件');
  }
  await fsp.rm(dest, { force: true }).catch(() => {});
  await fsp.rename(partPath, dest);
  onProgress({ received: bytes, total: bytes });
  return { path: dest, bytes, sha256: actual };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (buf) => {
      stdout += buf;
    });
    child.stderr?.on('data', (buf) => {
      stderr += buf;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${path.basename(command)} 失败 (${code})：${stderr.trim() || stdout.trim()}`));
    });
  });
}

function appBundleFromExe(exePath) {
  const bundle = path.dirname(path.dirname(path.dirname(exePath)));
  if (!bundle.endsWith('.app')) throw new Error('无法定位应用安装位置');
  if (bundle.includes('/AppTranslocation/')) {
    throw new Error('应用正从只读位置运行，请先把它拖入「应用程序」文件夹后再更新');
  }
  return bundle;
}

// Replacing a bundle means moving its parent directory entry, so the parent must
// be writable. Checked before downloading so an unwritable install fails fast
// instead of after a 170MB transfer.
async function assertWritableTarget(bundlePath, { accessImpl = fsp.access } = {}) {
  const parent = path.dirname(bundlePath);
  try {
    await accessImpl(parent, fs.constants.W_OK);
  } catch {
    throw new Error(`没有写入权限：${parent}。请把 Luma 移到「应用程序」后手动安装更新`);
  }
  return parent;
}

// Mounts the DMG read-only and copies the bundle to the target volume so the
// replacement is a same-volume rename rather than a cross-volume copy.
// Nothing quarantines the download: the app fetches it with fetch(), not with
// LSFileQuarantineEnabled, so no com.apple.quarantine flag is added and the
// staged copy needs no xattr stripping.
async function stageMacBundle({ dmgPath, stagingRoot, runImpl = run }) {
  const mount = path.join(stagingRoot, 'mnt');
  await fsp.mkdir(mount, { recursive: true });
  await runImpl('hdiutil', [
    'attach',
    dmgPath,
    '-nobrowse',
    '-readonly',
    '-noautoopen',
    '-mountpoint',
    mount,
  ]);
  try {
    const entries = await fsp.readdir(mount);
    const appName = entries.find((name) => name.endsWith('.app'));
    if (!appName) throw new Error('安装包中未找到应用');
    const stagedApp = path.join(stagingRoot, 'staged', appName);
    await fsp.mkdir(path.dirname(stagedApp), { recursive: true });
    await runImpl('ditto', [path.join(mount, appName), stagedApp]);
    return stagedApp;
  } finally {
    await runImpl('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Runs outside the app: waits for this process, swaps the bundle, relaunches.
// It never escalates: if the install location is not writable the caller must
// have refused the update before we got here.
function macSwapScript({ targetApp, stagedApp, stageRoot, dmgPath, pid, logPath, relaunch = true }) {
  return `#!/bin/bash
set -u
target=${shellQuote(targetApp)}
staged=${shellQuote(stagedApp)}
stage_root=${shellQuote(stageRoot || '')}
dmg=${shellQuote(dmgPath || '')}
pid=${shellQuote(String(pid))}
log=${shellQuote(logPath)}
relaunch=${shellQuote(relaunch ? '1' : '0')}

fail() {
  echo "$1" >>"$log"
  exit "$2"
}

for _ in $(seq 1 300); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.4
done
sleep 0.6

if [ -n "$stage_root" ] && [ ! -d "$staged" ]; then
  fail "staged bundle missing: $staged" 10
fi

backup="$target.old.$$"
mv "$target" "$backup" 2>>"$log" || fail "cannot move $target aside; install manually" 11

if /usr/bin/ditto "$staged" "$target" 2>>"$log"; then
  rm -rf "$backup" 2>>"$log"
else
  # Restore the previous bundle so the user is never left without a working app.
  rm -rf "$target" 2>>"$log"
  mv "$backup" "$target" 2>>"$log" || fail "rollback failed; backup kept at $backup" 14
  fail "install failed, previous version restored" 13
fi

if [ -n "$stage_root" ]; then
  rm -rf "$stage_root" 2>/dev/null || true
fi
if [ -n "$dmg" ]; then
  rm -f "$dmg" 2>/dev/null || true
fi
if [ "$relaunch" = "1" ]; then
  /usr/bin/open "$target" >>"$log" 2>&1 || fail "installed but relaunch failed" 15
fi
echo "done" >>"$log"
rm -f "$0" 2>/dev/null || true
`;
}

async function spawnMacSwap({
  targetApp,
  stagedApp,
  stageRoot,
  dmgPath,
  pid,
  logPath,
  spawnImpl = spawn,
  relaunch = true,
}) {
  const scriptPath = path.join(os.tmpdir(), `luma-update-${Date.now()}-${process.pid}.sh`);
  const script = macSwapScript({
    targetApp,
    stagedApp,
    stageRoot,
    dmgPath,
    pid,
    logPath,
    relaunch,
  });
  await fsp.writeFile(scriptPath, script, { mode: 0o700 });
  const child = spawnImpl('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
  return { scriptPath };
}

// --force-run makes the NSIS installer relaunch the app after a silent install.
// The install directory is deliberately not passed: /D cannot be quoted, and the
// installer already reads the previous InstallLocation from the registry.
function windowsInstallerArgs() {
  return ['/S', '--updated', '--force-run'];
}

async function spawnWindowsInstaller({ installerPath, spawnImpl = spawn }) {
  const args = windowsInstallerArgs();
  const child = spawnImpl(installerPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { args };
}

module.exports = {
  ALLOWED_HOSTS,
  assertAllowedUrl,
  sha256OfFile,
  downloadInstaller,
  stageMacBundle,
  macSwapScript,
  spawnMacSwap,
  appBundleFromExe,
  assertWritableTarget,
  windowsInstallerArgs,
  spawnWindowsInstaller,
  run,
};
