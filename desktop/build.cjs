const { spawnSync } = require('node:child_process');
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

const cli = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
