import http from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDb } from '../data/database.js';
import { deleteExpiredAuthSessions } from '../data/repositories/auth-sessions.js';
import { createSecretBox, hashPassword, randomToken } from '../auth/crypto.js';
import { DATA_DIR, HOST, PORT, USERS_DIR } from '../config.js';
import { createApp } from '../http/create-app.js';
import { setDummyPasswordHash, setSecretBox } from '../shared/runtime.js';

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

export async function startServer({ host = HOST, port = PORT } = {}) {
  try {
    process.umask(0o077);
  } catch {
    /* Windows has no useful umask */
  }

  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await mkdir(USERS_DIR, { recursive: true, mode: 0o700 });
  initDb(DATA_DIR);
  await chmod(path.join(DATA_DIR, 'app.db'), 0o600).catch(() => {});
  setSecretBox(createSecretBox(await loadSecretKey(DATA_DIR)));
  setDummyPasswordHash(await hashPassword(randomToken()));
  deleteExpiredAuthSessions();
  setInterval(() => {
    try {
      deleteExpiredAuthSessions();
    } catch {
      /* ignore cleanup errors */
    }
  }, 60 * 60 * 1000).unref();

  const server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    host,
    port: actualPort,
    dataDir: DATA_DIR,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
