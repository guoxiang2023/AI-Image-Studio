import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import updater from '../src/services/desktop-updater.cjs';
import { selectAsset } from '../src/services/update-service.js';

const {
  assertAllowedUrl,
  downloadInstaller,
  windowsInstallerArgs,
  appBundleFromExe,
  assertWritableTarget,
  macSwapScript,
} = updater;

function streamResponse(chunks, headers = {}) {
  // Constructed Response has an empty `.url`, so the redirect check is skipped.
  return new Response(Readable.toWeb(Readable.from(chunks)), { headers });
}

test('selects the installer matching platform and arch', () => {
  const assets = [
    { name: 'Luma-1.0.8-mac-arm64.dmg', url: 'u1' },
    { name: 'Luma-1.0.8-mac-x64.dmg', url: 'u2' },
    { name: 'Luma-1.0.8-win-x64.exe', url: 'u3' },
  ];
  assert.equal(selectAsset(assets, { platform: 'darwin', arch: 'arm64' }).url, 'u1');
  assert.equal(selectAsset(assets, { platform: 'darwin', arch: 'x64' }).url, 'u2');
  assert.equal(selectAsset(assets, { platform: 'win32', arch: 'x64' }).url, 'u3');
  // Windows on ARM falls back to the x64 emulated build.
  assert.equal(selectAsset(assets, { platform: 'win32', arch: 'arm64' }).url, 'u3');
  assert.equal(selectAsset(assets, { platform: 'linux', arch: 'x64' }), null);
  assert.equal(selectAsset(assets, { platform: 'win32', arch: 'x64' }), assets[2]);
});

test('rejects installer URLs outside GitHub over plain HTTP', () => {
  assert.equal(assertAllowedUrl('https://github.com/a/b').hostname, 'github.com');
  assert.throws(() => assertAllowedUrl('http://github.com/a/b'), /HTTPS/);
  assert.throws(() => assertAllowedUrl('https://evil.example.com/a.dmg'), /不受信任/);
  assert.throws(() => assertAllowedUrl('not a url'), /无效/);
});

test('downloads, hashes and reports progress', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luma-update-test-'));
  const dest = path.join(dir, 'pkg.dmg');
  const payload = [Buffer.from('hello '), Buffer.from('world')];
  const bytes = Buffer.concat(payload);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const progress = [];

  try {
    const result = await downloadInstaller({
      url: 'https://github.com/o/r/releases/download/v1/pkg.dmg',
      dest,
      sha256,
      size: bytes.length,
      fetchImpl: async () => streamResponse(payload, { 'content-length': String(bytes.length) }),
      onProgress: (p) => progress.push(p),
    });
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, sha256);
    assert.equal((await readFile(dest)).toString(), 'hello world');
    assert.ok(progress.length >= 1);
    assert.equal(progress.at(-1).received, bytes.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deletes the installer when the checksum does not match', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luma-update-test-'));
  const dest = path.join(dir, 'pkg.exe');
  try {
    await assert.rejects(
      downloadInstaller({
        url: 'https://github.com/o/r/releases/download/v1/pkg.exe',
        dest,
        sha256: 'a'.repeat(64),
        fetchImpl: async () => streamResponse([Buffer.from('tampered')]),
      }),
      /SHA-256/,
    );
    await assert.rejects(stat(dest), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deletes the installer when the reported size does not match', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luma-update-test-'));
  const dest = path.join(dir, 'pkg.exe');
  try {
    await assert.rejects(
      downloadInstaller({
        url: 'https://github.com/o/r/releases/download/v1/pkg.exe',
        dest,
        size: 999,
        retries: 0,
        fetchImpl: async () => streamResponse([Buffer.from('short')]),
      }),
      /大小不符/,
    );
    await assert.rejects(stat(dest), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('silent NSIS update relaunches the app', () => {
  assert.deepEqual(windowsInstallerArgs(), ['/S', '--updated', '--force-run']);
});

test('resolves the .app bundle from the executable path', () => {
  assert.equal(
    appBundleFromExe('/Applications/Luma.app/Contents/MacOS/Luma'),
    '/Applications/Luma.app',
  );
  assert.throws(
    () => appBundleFromExe('/Users/me/Luma/AppTranslocation/123/Luma.app/Contents/MacOS/Luma'),
    /只读位置/,
  );
});

test('resumes a partial download with a Range request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luma-update-test-'));
  const dest = path.join(dir, 'pkg.exe');
  const body = Buffer.from('0123456789');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const requests = [];
  const { writeFile } = await import('node:fs/promises');
  // A previous run left 4 bytes on disk after the connection dropped.
  await writeFile(`${dest}.part`, body.subarray(0, 4));

  try {
    const result = await downloadInstaller({
      url: 'https://github.com/o/r/releases/download/v1/pkg.exe',
      dest,
      sha256,
      size: 10,
      retries: 0,
      fetchImpl: async (url, init) => {
        requests.push(init?.headers?.Range || '');
        return new Response(Readable.toWeb(Readable.from([body.subarray(4)])), {
          status: 206,
          headers: { 'content-length': '6', 'content-range': 'bytes 4-9/10' },
        });
      },
    });

    assert.deepEqual(requests, ['bytes=4-']);
    assert.equal(result.bytes, 10);
    assert.equal((await readFile(dest)).toString(), '0123456789');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries a transient connection failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'luma-update-test-'));
  const dest = path.join(dir, 'pkg.exe');
  const body = Buffer.from('payload');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  let calls = 0;

  try {
    const result = await downloadInstaller({
      url: 'https://github.com/o/r/releases/download/v1/pkg.exe',
      dest,
      sha256,
      size: body.length,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
          });
        }
        return streamResponse([body], { 'content-length': String(body.length) });
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.bytes, body.length);
    assert.equal((await readFile(dest)).toString(), 'payload');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an install location that cannot be replaced', async () => {
  const probe = async () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  await assert.rejects(
    assertWritableTarget('/Applications/Luma.app', { accessImpl: probe }),
    /没有写入权限/,
  );
  const ok = async () => {};
  assert.equal(await assertWritableTarget('/Applications/Luma.app', { accessImpl: ok }), '/Applications');
});

test('swap script never escalates nor strips quarantine', () => {
  const script = macSwapScript({
    targetApp: '/Applications/Luma.app',
    stagedApp: '/tmp/stage/staged/Luma.app',
    stageRoot: '/tmp/stage',
    dmgPath: '/tmp/stage/Luma.dmg',
    pid: 42,
    logPath: '/tmp/stage/updater.log',
  });
  assert.doesNotMatch(script, /administrator privileges/);
  assert.doesNotMatch(script, /osascript/);
  assert.doesNotMatch(script, /com\.apple\.quarantine/);
  // Rollback must restore the previous bundle when the swap fails.
  assert.match(script, /mv "\$backup" "\$target"/);
  assert.match(script, /previous version restored/);
});
