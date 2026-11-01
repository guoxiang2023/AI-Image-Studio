const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn(`[desktop] ad-hoc codesign failed: ${error.message}`);
  }
};
