// Compiles the macOS Vision OCR helper. The binary is not committed: it is
// architecture specific, and both macOS runners in the release matrix have the
// Swift toolchain, so each job builds the slice it ships.
//
// Windows and Linux have no Vision, so no helper is built there and the app
// falls back to tesseract.js (see src/media/ocr.js).
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, 'ocr-helper.swift');
const OUT_DIR = path.join(__dirname, '..', 'build', 'ocr');

function targetsForCurrentRun() {
  const requested = process.argv.slice(2);
  const both = { arch: 'x64', target: 'x86_64-apple-macos11.0' };
  const arm = { arch: 'arm64', target: 'arm64-apple-macos11.0' };
  if (requested.includes('--both') || requested.includes('--universal')) return [both, arm];
  if (requested.includes('--arm64')) return [arm];
  if (requested.includes('--x64')) return [both];
  // electron-builder passes the arch it is packaging through the environment.
  const fromBuilder = process.env.npm_config_arch || '';
  if (fromBuilder === 'arm64') return [arm];
  if (fromBuilder === 'x64') return [both];
  return process.arch === 'arm64' ? [arm] : [both];
}

function main() {
  // extraResources points at this directory on every platform, so it must exist
  // even when there is nothing to compile (electron-builder fails on a missing
  // source path).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.platform !== 'darwin') {
    console.log('[ocr] 非 macOS，跳过 Vision 组件编译（将使用 tesseract.js）');
    return;
  }
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`[ocr] 找不到 ${SOURCE}`);
  }

  const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(
      '[ocr] 需要 Xcode 命令行工具来编译 OCR 组件，请运行 xcode-select --install',
    );
  }

  for (const { arch, target } of targetsForCurrentRun()) {
    const out = path.join(OUT_DIR, `ocr-helper-${arch}`);
    execFileSync(
      'xcrun',
      ['--sdk', 'macosx', 'swiftc', '-O', '-target', target, '-o', out, SOURCE],
      { stdio: 'inherit' },
    );
    console.log(`[ocr] 已编译 ${path.relative(process.cwd(), out)} (${target})`);
  }
}

main();