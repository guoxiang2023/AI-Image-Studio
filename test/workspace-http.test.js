import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

// The workspace surface is desktop-only and, until now, was covered only at the
// service layer. These tests drive the real HTTP routes: the capability gate,
// the binding lifecycle, and the refusals a desktop client hits when a chosen
// directory is deleted or is not a directory.

let dataDir;
let projectDir;
let projectRoot;
let base;
let server;
let runtime;
let chats;

const request = async (method, url, { body, cookie } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: {
      origin: base,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, payload, text, res };
};

let counter = 0;
/** A fresh account per test, so session listings never see another test's rows. */
async function signUp() {
  counter += 1;
  const res = await request('POST', '/api/auth/register', {
    body: { username: `ws-tester-${counter}`, password: 'password123', code: '' },
  });
  assert.equal(res.status, 201, res.text);
  const cookie = String(res.res.headers.getSetCookie?.()[0] || '').split(';')[0];
  return { cookie, userId: res.payload.user.id };
}

async function createSession(cookie) {
  const res = await request('POST', '/api/sessions', { body: {}, cookie });
  assert.equal(res.status, 201, res.text);
  return res.payload.id;
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-ws-http-'));
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'luma-ws-proj-'));
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'README.md'), '# Demo\nworkspace readme\n');
  await writeFile(path.join(projectDir, 'src', 'app.js'), 'export const a = 1;\n');
  await writeFile(path.join(projectDir, '.env'), 'SECRET=leak\n');
  projectRoot = await realpath(projectDir);

  // config.js resolves DATA_DIR at import time, so set it before any module
  // that reads it is loaded.
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_REGISTRATION = '1';

  const started = await import('../src/bootstrap/start-server.js');
  runtime = await import('../src/shared/runtime.js');
  chats = await import('../src/services/chat-service.js');
  server = await started.startServer({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  runtime.setDesktopWorkspace(false);
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test('an anonymous caller cannot read the capability or bind a directory', async () => {
  const status = await request('GET', '/api/workspace/status');
  assert.equal(status.status, 401);

  const bind = await request('PUT', '/api/sessions/0123456789abcdef/workspace', {
    body: { path: projectDir },
  });
  assert.equal(bind.status, 401);
});

test('the capability is decided by the server, not by the client', async () => {
  const { cookie, userId } = await signUp();
  runtime.setDesktopWorkspace(false);

  const off = await request('GET', '/api/workspace/status', { cookie });
  assert.equal(off.status, 200);
  assert.equal(off.payload.enabled, false, 'a web deployment has no local reads');

  const sessionId = await createSession(cookie);
  const refused = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: projectDir },
    cookie,
  });
  assert.equal(refused.status, 403, 'binding is refused while the capability is off');
  assert.match(refused.payload.error, /桌面端/);

  runtime.setDesktopWorkspace(true);
  const on = await request('GET', '/api/workspace/status', { cookie });
  assert.equal(on.payload.enabled, true);
});

test('a bound directory keeps its session in the sidebar; an unbound one does not', async () => {
  const { cookie, userId } = await signUp();
  runtime.setDesktopWorkspace(true);

  const sessionId = await createSession(cookie);
  // Created for a bind that has not happened yet: nothing worth listing.
  const beforeBind = await request('GET', '/api/sessions', { cookie });
  assert.deepEqual(beforeBind.payload, [], 'an empty, unbound session is not a conversation');

  const bound = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: projectDir },
    cookie,
  });
  assert.equal(bound.status, 200, bound.text);
  assert.equal(bound.payload.workspace.root, projectRoot);
  assert.equal(bound.payload.overview.files, 2, 'only text files are counted');
  assert.doesNotMatch(JSON.stringify(bound.payload.overview), /\.env/);

  const listed = await request('GET', '/api/sessions', { cookie });
  assert.deepEqual(
    listed.payload.map((row) => row.id),
    [sessionId],
    'the binding is what makes the session listable',
  );

  const loaded = await request('GET', `/api/sessions/${sessionId}`, { cookie });
  assert.equal(loaded.payload.workspace.root, projectRoot);

  const unbound = await request('DELETE', `/api/sessions/${sessionId}/workspace`, { cookie });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.payload.workspace, null);

  const afterUnbind = await request('GET', '/api/sessions', { cookie });
  assert.deepEqual(afterUnbind.payload, [], 'losing the binding and having no message hides it again');

  // The row itself still exists for storage-level readers, so history is not
  // destroyed just because the sidebar hides it. This also pins that the
  // sidebar view is a flag, not a destructive rewrite of the query.
  const stored = chats.loadChatForUser(userId, sessionId);
  assert.ok(stored, 'the unbound row survives for export and history');
  assert.equal(stored.workspaceJson, '');
  assert.equal(
    chats.listSessions(userId).length,
    0,
    'the conversation list hides it',
  );
});

test('every refusal is a 4xx with a message, never a crashed request', async () => {
  const { cookie, userId } = await signUp();
  runtime.setDesktopWorkspace(true);
  const sessionId = await createSession(cookie);

  const missing = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: path.join(projectDir, 'gone') },
    cookie,
  });
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /不存在|无权访问/);

  const notADirectory = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: path.join(projectDir, 'README.md') },
    cookie,
  });
  assert.equal(notADirectory.status, 400);

  const emptyPath = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: '' },
    cookie,
  });
  assert.equal(emptyPath.status, 400);

  const unknownSession = await request('PUT', '/api/sessions/0123456789abcdef/workspace', {
    body: { path: projectDir },
    cookie,
  });
  assert.equal(unknownSession.status, 404);
});

test('a directory deleted after binding is reported, not served from cache', async () => {
  const { cookie, userId } = await signUp();
  runtime.setDesktopWorkspace(true);
  const throwaway = await mkdtemp(path.join(os.tmpdir(), 'luma-ws-gone-'));
  await writeFile(path.join(throwaway, 'a.txt'), 'a\n');

  const sessionId = await createSession(cookie);
  const bound = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: throwaway },
    cookie,
  });
  assert.equal(bound.status, 200, bound.text);
  const workspace = bound.payload.workspace;

  const { listWorkspaceFiles } = await import('../src/services/workspace-service.js');
  // Reading fills the index cache; deleting the root must invalidate it rather
  // than let the next call report the old listing.
  assert.equal((await listWorkspaceFiles(workspace, { depth: 2, limit: 20 })).files, 1);

  await rm(throwaway, { recursive: true, force: true });
  await assert.rejects(
    () => listWorkspaceFiles(workspace, { depth: 2, limit: 20 }),
    /已不可用|不可读/,
  );

  const rebind = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: throwaway },
    cookie,
  });
  assert.equal(rebind.status, 400, 'a vanished directory cannot be bound again');
});

test('the discard endpoint only removes an unused row', async () => {
  const { cookie } = await signUp();
  runtime.setDesktopWorkspace(true);

  const sessionId = await createSession(cookie);
  // A plain create: empty, unbound, unarchived → removable.
  const discarded = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
  assert.equal(discarded.status, 200, discarded.text);
  assert.equal(discarded.payload.removed, true);
  const gone = await request('GET', `/api/sessions/${sessionId}`, { cookie });
  assert.equal(gone.status, 404);
});

test('discard refuses a row a bind reached, so a live binding is never lost', async () => {
  const { cookie } = await signUp();
  runtime.setDesktopWorkspace(true);
  const sessionId = await createSession(cookie);

  const bound = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: projectDir },
    cookie,
  });
  assert.equal(bound.status, 200, bound.text);

  // This is the race the guard exists for: a client that saw its bind fail
  // asks to clean up, but the server did persist the binding.
  const discarded = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.payload.removed, false, 'a bound row must survive the cleanup');
  const still = await request('GET', `/api/sessions/${sessionId}`, { cookie });
  assert.equal(still.status, 200);
  assert.equal(still.payload.workspace.root, projectRoot);
});

test('discard refuses a row that holds a message', async () => {
  const { cookie, userId } = await signUp();
  const sessionId = await createSession(cookie);

  // A turn persisted a message: the user has seen content in this session.
  const chat = chats.loadChatForUser(userId, sessionId);
  chat.messages.push({ role: 'user', content: 'hi', ts: Date.now() });
  chats.saveChat(chat);

  const discarded = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.payload.removed, false, 'a row with history is not disposable');
  const still = await request('GET', `/api/sessions/${sessionId}`, { cookie });
  assert.equal(still.status, 200);
});

test('discard refuses an archived row and is scoped to the owner', async () => {
  const { cookie } = await signUp();
  const sessionId = await createSession(cookie);
  await request('PATCH', `/api/sessions/${sessionId}`, { body: { archived: true }, cookie });

  const discarded = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
  assert.equal(discarded.payload.removed, false, 'archiving is an explicit user action');

  // Another account cannot discard it either.
  const other = await signUp();
  const foreign = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie: other.cookie });
  assert.equal(foreign.status, 404);
});

test('discard refuses a session whose turn is in flight', async () => {
  const { cookie } = await signUp();
  const sessionId = await createSession(cookie);

  // `handleChat` claims the id before it awaits turn preparation, so a chat can
  // be busy while it still has no persisted message. This is the exact row the
  // guard must protect: otherwise the delete lands under a generating turn.
  const { acquireTurn } = await import('../src/services/turn-lock.js');
  const release = acquireTurn(sessionId);
  try {
    const discarded = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
    assert.equal(discarded.status, 200);
    assert.equal(discarded.payload.removed, false, 'a busy chat is never discarded');
    const still = await request('GET', `/api/sessions/${sessionId}`, { cookie });
    assert.equal(still.status, 200);
  } finally {
    release();
  }

  // Once released, the same empty row is disposable again.
  const afterRelease = await request('POST', `/api/sessions/${sessionId}/discard`, { cookie });
  assert.equal(afterRelease.payload.removed, true);
});

test('credentials and path escapes stay outside the workspace', async () => {
  const { cookie, userId } = await signUp();
  runtime.setDesktopWorkspace(true);
  const sessionId = await createSession(cookie);
  const bound = await request('PUT', `/api/sessions/${sessionId}/workspace`, {
    body: { path: projectDir },
    cookie,
  });
  assert.equal(bound.status, 200, bound.text);

  const { listWorkspaceFiles, readWorkspaceFile } = await import('../src/services/workspace-service.js');
  const workspace = bound.payload.workspace;

  const listing = await listWorkspaceFiles(workspace, { depth: 4, limit: 100 });
  assert.doesNotMatch(listing.listing, /\.env/);

  await assert.rejects(() => readWorkspaceFile(workspace, { file: '.env' }), /凭据/);
  await assert.rejects(
    () => readWorkspaceFile(workspace, { file: '../etc/passwd' }),
    /超出工作目录|相对路径/,
  );
});
