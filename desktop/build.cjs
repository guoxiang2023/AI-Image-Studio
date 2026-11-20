const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
// Default to a domestic mirror for local builds, but never override an explicit
// choice: CI runners reach GitHub directly and cannot always reach npmmirror.
// LUMA_ELECTRON_MIRROR=none keeps the default official download host.
const explicit = env.ELECTRON_MIRROR || '';
if (explicit === 'none') {
  delete env.ELECTRON_MIRROR;
} else if (!explicit) {
  env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}

// The Vision OCR helper is architecture specific, and electron-builder copies
// build/ocr into the app as extraResources, so it has to exist before packaging
// starts. The build flags decide which slice to compile.
const args = process.argv.slice(2);
const archFlags = args.filter((arg) => arg === '--x64' || arg === '--arm64' || arg === '--universal');
const ocrArgs = [];
if (archFlags.includes('--universal')) ocrArgs.push('--both');
else if (archFlags.length) ocrArgs.push(`--${archFlags[0].slice(2)}`);
try {
  execFileSync(process.execPath, [path.join(__dirname, 'build-ocr.cjs'), ...ocrArgs], {
    stdio: 'inherit',
  });
} catch (error) {
  // A missing toolchain must not silently ship a build whose OCR is broken.
  console.error(error.message);
  process.exit(1);
}

const cli = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);
const result = spawnSync(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  env,
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);