import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Two tabs on the same conversation used to run turns concurrently, and the
// slower one overwrote the other's persisted answer. These tests pin the
// single-flight contract and its release paths.

function fakeReq(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = Readable.from([raw]);
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function fakeRes() {
  return {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    statusCode: null,
    headers: {},
    chunks: [],
    listeners: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      this.headersSent = true;
      Object.assign(this.headers, headers || {});
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
      return this;
    },
    on(event, fn) {
      (this.listeners[event] ||= []).push(fn);
      return this;
    },
    off(event, fn) {
      this.listeners[event] = (this.listeners[event] || []).filter((fn2) => fn2 !== fn);
      return this;
    },
    body() {
      return this.chunks.join('');
    },
  };
}

function sseResponse(text = '好的') {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Only the FIRST model call blocks on the gate; every later call answers
 * immediately.
 *
 * This is what keeps a broken lock from hanging the suite: with no lock, the
 * second turn reaches the handler too, gets an instant 200, and the 409
 * assertion fails loudly instead of waiting on a promise nobody releases.
 */
function gatedFirstCall() {
  const gate = {};
  gate.reached = new Promise((resolve) => {
    gate.markReached = resolve;
  });
  gate.release = new Promise((resolve) => {
    gate.markReleased = resolve;
  });
  let calls = 0;
  gate.handler = async () => {
    calls += 1;
    if (calls === 1) {
      gate.markReached();
      await gate.release;
    }
    return sseResponse();
  };
  return gate;
}

async function setup(t, handler) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-lock-'));
  process.env.DATA_DIR = dataDir;
  const [{ initDb, closeDb }, chatService, chatRoute, turnLock] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/services/chat-service.js'),
    import('../src/http/routes/chat.js'),
    import('../src/services/turn-lock.js'),
  ]);
  initDb(dataDir);
  const userId = 'lock-user';
  const chat = chatService.newChatForUser(userId);
  chatService.saveChat(chat);

  const stored = chatService.loadChatForUser(userId, chat.id);
  // Minimal settings so the turn does not fail on a missing API key.
  const { saveUserSettings } = await import('../src/services/model-settings-service.js');
  const [{ setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  setSecretBox(createSecretBox(Buffer.alloc(32, 9)));
  saveUserSettings(userId, {
    llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub' },
    image: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub' },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    // A leaked lock would fail the next test in this process, not just this
    // file: fail loudly here instead of letting it masquerade as flakiness.
    assert.equal(turnLock.activeTurnCount(), 0, 'the lock was released');
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { userId, chat: stored, chatRoute, chatService, turnLock };
}

test('a second concurrent turn on the same chat is rejected with 409', async (t) => {
  const gate = gatedFirstCall();
  const { userId, chat, chatRoute } = await setup(t, gate.handler);

  const body = { sessionId: chat.id, message: '第一个' };
  const firstRes = fakeRes();
  const first = chatRoute.handleChat(fakeReq(body), firstRes, { id: userId });

  try {
    // Wait for the first stream to actually start; no sleep, no guessing.
    await gate.reached;

    const secondRes = fakeRes();
    await chatRoute.handleChat(fakeReq({ sessionId: chat.id, message: '第二个' }), secondRes, {
      id: userId,
    });

    assert.equal(secondRes.statusCode, 409, 'the second turn is refused');
    const payload = JSON.parse(secondRes.body());
    assert.match(payload.error, /正在生成回复/);
    assert.equal(secondRes.headersSent, true, 'a real JSON response was sent');
    assert.doesNotMatch(secondRes.body(), /^data: /, 'no stream was opened');
  } finally {
    // Always free the first stream: a missing lock must fail the assertion
    // above, not stall the test run.
    gate.markReleased();
  }

  await first;
  assert.equal(firstRes.statusCode, 200, 'the first turn completed normally');
});

test('the lock is released after a turn finishes', async (t) => {
  const { userId, chat, chatRoute, turnLock } = await setup(t, async () => sseResponse());

  assert.equal(turnLock.activeTurnCount(), 0);
  const res = fakeRes();
  await chatRoute.handleChat(fakeReq({ sessionId: chat.id, message: '第一轮' }), res, {
    id: userId,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(turnLock.activeTurnCount(), 0, 'released after a successful turn');

  // A following turn on the same chat must be accepted.
  const res2 = fakeRes();
  await chatRoute.handleChat(fakeReq({ sessionId: chat.id, message: '第二轮' }), res2, {
    id: userId,
  });
  assert.equal(res2.statusCode, 200, 'the chat is usable again');
});

test('the lock is released when the turn throws', async (t) => {
  // A failure before the stream opens must not leave the chat claimed forever.
  const { userId, chat, chatRoute, turnLock } = await setup(t, async () => {
    throw new Error('upstream exploded');
  });

  const res = fakeRes();
  // runPreparedTurn may surface the error after headers; either way the lock
  // must be gone.
  await chatRoute
    .handleChat(fakeReq({ sessionId: chat.id, message: '会失败的' }), res, { id: userId })
    .catch(() => {});
  assert.equal(turnLock.activeTurnCount(), 0, 'released after a failed turn');

  const res2 = fakeRes();
  await chatRoute
    .handleChat(fakeReq({ sessionId: chat.id, message: '再来' }), res2, { id: userId })
    .catch(() => {});
  assert.notEqual(res2.statusCode, 409, 'the chat is not permanently locked');
});

test('two separate new chats each get their own lock', async (t) => {
  // No sessionId means no shared chat, so there is nothing to contend on: two
  // first messages create two documents and both must run.
  const { userId, chatRoute, turnLock } = await setup(t, async () => sseResponse());

  const a = fakeRes();
  const b = fakeRes();
  await Promise.all([
    chatRoute.handleChat(fakeReq({ message: '新会话 A' }), a, { id: userId }),
    chatRoute.handleChat(fakeReq({ message: '新会话 B' }), b, { id: userId }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(turnLock.activeTurnCount(), 0);
});

test('a new chat is locked from its first turn, before the id is announced', async (t) => {
  // prepareChatTurn persists the new chat and runPreparedTurn announces its id
  // in the opening session event. A second tab that learns that id must not be
  // able to start a concurrent turn on it — otherwise the first turn's draft is
  // overwritten exactly as with an existing session.
  const gate = gatedFirstCall();
  const { userId, chatRoute, chatService, turnLock } = await setup(t, gate.handler);

  const firstRes = fakeRes();
  const first = chatRoute.handleChat(fakeReq({ message: '新会话的第一句' }), firstRes, {
    id: userId,
  });

  let chatId = null;
  try {
    await gate.reached;

    // The id is visible to any other tab as soon as the turn exists in storage.
    const chats = chatService.listSessions(userId);
    chatId = chats[0]?.id || null;
    assert.ok(chatId, 'the new chat was persisted');

    const secondRes = fakeRes();
    await chatRoute.handleChat(fakeReq({ sessionId: chatId, message: '第二个标签页' }), secondRes, {
      id: userId,
    });

    assert.equal(secondRes.statusCode, 409, 'the first turn of a new chat is protected');
    assert.match(JSON.parse(secondRes.body()).error, /正在生成回复/);
  } finally {
    gate.markReleased();
  }

  await first;
  assert.equal(firstRes.statusCode, 200);
  assert.equal(turnLock.activeTurnCount(), 0, 'released when the new chat turn ends');
});

test('a stale sessionId does not leave the newly created chat unlocked', async (t) => {
  // loadChatForUser returns null for an id that no longer resolves, so the turn
  // runs on a fresh chat. The lock must move to that chat: keeping the old claim
  // meant the real conversation had no protection at all.
  const gate = gatedFirstCall();
  const { userId, chatRoute, chatService, turnLock } = await setup(t, gate.handler);

  const staleId = 'f'.repeat(16); // well-formed, but never existed
  const firstRes = fakeRes();
  const first = chatRoute.handleChat(
    fakeReq({ sessionId: staleId, message: '会话已失效后重发' }),
    firstRes,
    { id: userId },
  );

  try {
    await gate.reached;

    const chats = chatService.listSessions(userId);
    const real = chats.find((c) => c.id !== staleId);
    assert.ok(real, 'a replacement chat was created');

    const secondRes = fakeRes();
    await chatRoute.handleChat(
      fakeReq({ sessionId: real.id, message: '第二个标签页' }),
      secondRes,
      { id: userId },
    );
    assert.equal(secondRes.statusCode, 409, 'the replacement chat is locked');
  } finally {
    gate.markReleased();
  }

  await first;
  assert.equal(turnLock.activeTurnCount(), 0, 'the stale claim and the real claim both released');
});

test('a stale sessionId does not stay locked after the turn', async (t) => {
  // The claim on the abandoned id must be dropped when the real chat takes over;
  // otherwise that id stays busy for the life of the process.
  const { userId, chatRoute, turnLock } = await setup(t, async () => sseResponse());

  const staleId = 'e'.repeat(16);
  const res = fakeRes();
  await chatRoute.handleChat(
    fakeReq({ sessionId: staleId, message: '失效会话' }),
    res,
    { id: userId },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(turnLock.activeTurnCount(), 0, 'nothing is left claimed');

  // The abandoned id must be claimable again (proving it was released, not
  // merely never recorded).
  const { acquireTurn } = await import('../src/services/turn-lock.js');
  const release = acquireTurn(staleId);
  release();
});

test('a new chat does not appear until reference I/O has finished', async (t) => {
  // The race this guards: prepareChatTurn used to insert the new chat BEFORE
  // awaiting the reference-image lookup. Its id was then visible to
  // /api/sessions while the first turn still had I/O pending, so a second tab
  // could load it, run a whole turn, and the first turn would save its stale
  // empty snapshot over the result.
  //
  // ESM bindings are read-only, so the await point cannot be wrapped from a
  // test. The ordering is therefore asserted structurally: every await inside
  // prepareChatTurn must precede the chat creation.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../src/services/chat-turn-service.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('export async function prepareChatTurn');
  assert.ok(start >= 0, 'prepareChatTurn exists');
  const end = source.indexOf('export async function runPreparedTurn', start);
  const body = source.slice(start, end);

  const creation = body.indexOf('newChatForUser(user.id)');
  assert.ok(creation >= 0, 'the turn creates a chat');

  // Any await after the creation is a window in which the row is already
  // listed but the caller has not claimed it yet.
  const after = body.slice(creation);
  const awaitsAfter = [...after.matchAll(/\bawait\b/g)].length;
  assert.equal(
    awaitsAfter,
    0,
    `no await may follow chat creation; found ${awaitsAfter}`,
  );
});

test('a failing turn without a signal still emits done instead of crashing', async (t) => {
  // Every real caller passes an AbortSignal, but runPreparedTurn must not depend
  // on it to settle: the catch block used to read signal.aborted directly, so a
  // missing one threw from inside the handler and swallowed both the error and
  // the `done` event. Driven directly here — handleChat always supplies a
  // signal, so it cannot reach this path.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-nosig-'));
  process.env.DATA_DIR = dataDir;
  const [{ initDb, closeDb }, chatService, turnService] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/services/chat-service.js'),
    import('../src/services/chat-turn-service.js'),
  ]);
  initDb(dataDir);
  const [{ setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  setSecretBox(createSecretBox(Buffer.alloc(32, 11)));
  const { saveUserSettings } = await import('../src/services/model-settings-service.js');
  saveUserSettings('u', {
    llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub' },
    image: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub' },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('upstream exploded');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const chat = chatService.newChatForUser('u');
  chatService.saveChat(chat);

  try {
    const prepared = await turnService.prepareChatTurn({ id: 'u' }, {
      sessionId: chat.id,
      message: '会失败的',
    });
    const events = [];
    // Deliberately no signal.
    await turnService.runPreparedTurn({
      user: { id: 'u' },
      prepared,
      emit: (event) => events.push(event),
    });

    assert.ok(events.some((e) => e.type === 'done'), 'the turn always reports completion');
    assert.ok(events.some((e) => e.type === 'error'), 'the failure is reported');
    assert.equal(events.find((e) => e.type === 'done').aborted, false, 'not marked as aborted');
  } finally {
    globalThis.fetch = originalFetch;
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});
