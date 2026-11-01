const { spawnSync } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
const mirror = env.ELECTRON_MIRROR || '';
if (!mirror || /(^|\.)taobao\.org/i.test(mirror)) {
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
