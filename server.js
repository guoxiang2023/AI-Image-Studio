import { startServer } from './src/bootstrap/start-server.js';
import { ALLOW_REGISTRATION, REGISTRATION_CODE } from './src/config.js';

async function main() {
  const runtime = await startServer();
  console.log(`画境 已启动：http://${runtime.host}:${runtime.port}`);
  console.log(
    `数据目录：${runtime.dataDir} · 注册：${ALLOW_REGISTRATION ? '开放' : '关闭'}${
      REGISTRATION_CODE ? '（需邀请码）' : ''
    }`,
  );

  const shutdown = () => {
    runtime.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
