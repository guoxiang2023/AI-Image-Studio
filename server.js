import { startServer } from './src/bootstrap/start-server.js';
import { ALLOW_REGISTRATION, REGISTRATION_CODE } from './src/config.js';

async function main() {
  const runtime = await startServer();
  console.log(`Luma 已启动：http://${runtime.host}:${runtime.port}`);
  console.log(
    `数据目录：${runtime.dataDir} · 注册：${ALLOW_REGISTRATION ? '开放' : '关闭'}${
      REGISTRATION_CODE ? '（需邀请码）' : ''
    }`,
  );

  const shutdown = async () => {
    try {
      await runtime.close();
    } catch (error) {
      console.error('关闭失败:', error);
      process.exitCode = 1;
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
