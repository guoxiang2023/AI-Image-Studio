import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { closeDb, getDb, initDb } from '../src/data/database.js';

const host = '127.0.0.1';
const hour = 60 * 60 * 1000;
let dataDir;
let startServer;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-lifecycle-'));
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_REGISTRATION = '1';
  process.env.REGISTRATION_CODE = '';
  ({ startServer } = await import('../src/bootstrap/start-server.js'));
});
after(() => rm(dataDir, { recursive: true, force: true }));

function cleanupClock(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const schedule = globalThis.setInterval;
  let calls = 0;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => schedule(() => {
    calls++;
    callback(...args);
  }, ms));
  return () => {
    const previous = calls;
    t.mock.timers.tick(hour);
    return calls - previous;
  };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'lifecycle-user', password: 'password123' }),
  });
  assert.equal(response.status, 201, await response.text());
  return response.headers.getSetCookie()[0].split(';')[0];
}

async function checkAccount(runtime, cookie) {
  const response = await fetch(`http://${host}:${runtime.port}/api/auth/me`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.username, 'lifecycle-user');
}

test('one runtime owns the database and cleanup timer through shutdown and restart', async (t) => {
  const tick = cleanupClock(t);
  const options = { host, port: 0 };
  const starting = startServer(options);
  await assert.rejects(startServer(options), /服务已/);
  const first = await starting;
  t.after(first.close);
  const originalDb = getDb();
  const base = `http://${host}:${first.port}`;
  const cookie = await register(base);
  await assert.rejects(startServer({ host, port: first.port }), /服务已/);
  await checkAccount(first, cookie);
  assert.equal(tick(), 1);

  // A provider request can outlive the client socket. Hold the provider response
  // until shutdown has disconnected the client to exercise that ordering.
  const provider = http.createServer();
  provider.listen(0, host);
  await once(provider, 'listening');
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const upstream = once(provider, 'request');
  const client = fetch(`${base}/api/models`, {
    method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://${host}:${provider.address().port}`, model: 'test', apiKey: 'test' }),
  });
  const [, reply] = await Promise.race([upstream, client.then(async (response) => {
    throw new Error(`Provider was not called: ${await response.text()}`);
  })]);
  try {
    const closed = first.close();
    assert.strictEqual(first.close(), closed);
    await assert.rejects(client);
    await assert.rejects(startServer(options), /服务已/);
    assert.strictEqual(getDb(), originalDb);
    assert.equal(tick(), 0);
  } finally {
    reply.end(JSON.stringify({ data: [{ id: 'test' }] }));
    await first.close();
  }
  assert.throws(() => originalDb.prepare('SELECT 1'));
  assert.throws(getDb, /未初始化/);

  const second = await startServer(options);
  t.after(second.close);
  await first.close();
  await checkAccount(second, cookie);
  assert.equal(tick(), 1);
  await second.close();
  assert.equal(tick(), 0);
  assert.throws(getDb, /未初始化/);
});

test('failed listen releases ownership and the same port can be reused in-process', async (t) => {
  const tick = cleanupClock(t);
  const occupied = http.createServer();
  occupied.listen(0, host);
  await once(occupied, 'listening');
  const options = { host, port: occupied.address().port };
  try {
    await assert.rejects(startServer(options), { code: 'EADDRINUSE' });
    assert.throws(getDb, /未初始化/);
    assert.equal(tick(), 0);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
  const recovered = await startServer(options);
  t.after(recovered.close);
  const health = await fetch(`http://${host}:${options.port}/api/health`);
  assert.deepEqual(await health.json(), { ok: true });
  await recovered.close();
  assert.equal(tick(), 0);
});

test('a failed start leaves an independently opened database usable', async () => {
  const owner = initDb(dataDir);
  try {
    await assert.rejects(startServer({ host, port: 0 }), /数据库已初始化/);
    assert.strictEqual(getDb(), owner);
    assert.equal(owner.prepare('SELECT 1 AS n').get().n, 1);
  } finally {
    closeDb();
  }
});
