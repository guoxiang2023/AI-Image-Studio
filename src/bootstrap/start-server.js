import http from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { closeDb, initDb } from '../data/database.js';
import { deleteExpiredAuthSessions } from '../data/repositories/auth-sessions.js';
import { createSecretBox, hashPassword, randomToken } from '../auth/crypto.js';
import { DATA_DIR, HOST, PORT, USERS_DIR } from '../config.js';
import { createApp } from '../http/create-app.js';
import { setDummyPasswordHash, setSecretBox } from '../shared/runtime.js';
import { shutdownOcr } from '../media/ocr.js';

async function loadSecretKey(dataDir) {
  const fromEnv = process.env.SECRET_KEY;
  if (fromEnv) {
    if (/^[0-9a-f]{64}$/i.test(fromEnv)) return Buffer.from(fromEnv, 'hex');
    const decoded = Buffer.from(fromEnv, 'base64');
    if (decoded.length === 32) return decoded;
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  const file = path.join(dataDir, 'secret.key');
  try {
    const key = await readFile(file);
    if (key.length !== 32) throw new Error('secret.key 长度必须为 32 字节');
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32);
    await writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

// Repositories share one SQLite connection. Hold ownership through startup and drain.
let runtimeActive = false;

export async function startServer({ host = HOST, port = PORT } = {}) {
  if (runtimeActive) throw new Error('服务已在启动、运行或关闭中');
  runtimeActive = true;

  try {
    process.umask(0o077);
  } catch {
    /* Windows has no useful umask */
  }

  let server;
  let cleanupTimer;
  let ownsDb = false;
  let closing;
  const requests = new Set();

  async function release() {
    clearInterval(cleanupTimer);
    try {
      if (server?.listening) {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      }
      // A closed socket can still have an async handler finalizing a chat or upload.
      await Promise.allSettled(requests);
      if (ownsDb) await shutdownOcr();
    } finally {
      if (ownsDb) {
        closeDb();
        setSecretBox(null);
        setDummyPasswordHash('');
      }
      runtimeActive = false;
    }
  }

  const close = () => (closing ??= release());

  try {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await mkdir(USERS_DIR, { recursive: true, mode: 0o700 });
    initDb(DATA_DIR);
    ownsDb = true;
    await chmod(path.join(DATA_DIR, 'app.db'), 0o600).catch(() => {});
    setSecretBox(createSecretBox(await loadSecretKey(DATA_DIR)));
    setDummyPasswordHash(await hashPassword(randomToken()));
    deleteExpiredAuthSessions();

    const app = createApp();
    server = http.createServer(async (req, res) => {
      let request;
      try {
        request = app(req, res);
        requests.add(request);
        await request;
      } catch (error) {
        // The HTTP adapter normally sends an error response. If it too fails,
        // terminate this response instead of rejecting the server listener.
        console.error('HTTP 请求处理失败:', error);
        res.destroy();
      } finally {
        requests.delete(request);
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    cleanupTimer = setInterval(() => {
      try {
        deleteExpiredAuthSessions();
      } catch {
        /* ignore cleanup errors */
      }
    }, 60 * 60 * 1000).unref();

    const actualPort = server.address()?.port ?? port;
    return { server, host, port: actualPort, dataDir: DATA_DIR, close };
  } catch (error) {
    await close();
    throw error;
  }
}
