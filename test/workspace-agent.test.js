import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { closeDb, initDb } from '../src/data/database.js';
import { setDesktopWorkspace } from '../src/shared/runtime.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'luma-agent-ws-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Agent Project\nA project analysed by tools.\n');
  await writeFile(
    path.join(root, 'src', 'calc.js'),
    ['export function add(a, b) {', '  return a + b;', '}', ''].join('\n'),
  );
  return root;
}

// Two provider rounds: the model first asks for tools, then answers in text.
// This is the real cost/behaviour path, so it proves the tools are actually
// reachable from the agent loop rather than just present in the schema.
function createProvider(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const events = (Array.isArray(reply) ? reply : [reply]).map(
        (part) => `data: ${JSON.stringify(part)}\n\n`,
      );
      res.end(`${events.join('')}data: [DONE]\n\n`);
    });
  });
  return { server, seen };
}

test('the agent reads a bound workspace through tools', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-agent-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();

  const toolCall = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_search',
              type: 'function',
              function: { name: 'search_workspace', arguments: '{"query":"add"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const answer = { choices: [{ delta: { content: '加法实现在 src/calc.js。' } }] };
  const provider = createProvider([toolCall, answer]);
  const port = await listen(provider.server);

  try {
    const { runAgent } = await import('../src/services/agent-service.js');
    const { bindWorkspace } = await import('../src/services/workspace-service.js');
    const workspace = await bindWorkspace(await realpath(root));
    const events = [];
    const result = await runAgent({
      user: { id: 'a'.repeat(16) },
      chat: { id: 'b'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
        image: {},
      },
      options: {},
      workspace,
      turnId: 'turn-1',
      userText: '加法的实现在哪？',
      emit: (event) => events.push(event),
      signal: undefined,
      turnImages: [],
    });

    assert.match(result.text, /src\/calc\.js/);
    const system = provider.seen[0].messages[0].content;
    assert.match(system, /【工作目录】/, 'workspace block reaches the model');
    assert.match(system, /可读文本文件：2 个/);
    assert.match(system, /search_workspace/, 'tool names are advertised');

    const toolNames = provider.seen[0].tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes('read_workspace_file'));
    assert.ok(toolNames.includes('list_workspace_files'));

    const toolReply = provider.seen[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolReply, 'tool result is fed back to the model');
    const payload = JSON.parse(toolReply.content);
    assert.equal(payload.ok, true);
    assert.match(payload.results, /src\/calc\.js:1\|/);
  } finally {
    setDesktopWorkspace(false);
    await new Promise((resolve) => provider.server.close(resolve));
    closeDb();
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('without a bound workspace the tools refuse instead of reading the disk', async () => {
  const { runTool } = await import('../src/services/tools-service.js');
  const result = await runTool('read_workspace_file', { file: 'etc/passwd' }, {
    user: { id: 'a'.repeat(16) },
    workspace: null,
  });
  assert.match(result.error, /不支持工作目录|没有绑定工作目录/);
});

// The dangerous cross-process case: a chat row bound by the desktop app is then
// opened by a web/Docker deployment sharing the same DATA_DIR. Nothing may read
// the disk, and the model must not even be told a directory exists.
test('a desktop binding is inert in a process without the capability', async () => {
  const root = await makeProject();
  const boundJson = JSON.stringify({ root, name: path.basename(root) });
  try {
    setDesktopWorkspace(false);
    const { workspaceFromChat, workspaceToolError } = await import(
      '../src/services/workspace-service.js'
    );
    const { runTool } = await import('../src/services/tools-service.js');

    assert.equal(workspaceFromChat({ workspaceJson: boundJson }), null, 'binding is invisible');
    const tools = workspaceToolError({ workspace: { root, name: 'x' } });
    assert.match(tools.error, /不支持工作目录/);

    for (const name of ['list_workspace_files', 'read_workspace_file', 'search_workspace']) {
      const result = await runTool(name, { file: 'README.md', query: 'Agent' }, {
        user: { id: 'a'.repeat(16) },
        workspace: { root, name: path.basename(root) },
      });
      assert.match(result.error, /不支持工作目录/, `${name} must refuse without the capability`);
    }

    // describeWorkspace is the only path that would read the directory for the
    // prompt; without the capability it must produce no overview at all.
    const { describeWorkspace } = await import('../src/services/agent-service.js');
    assert.equal(await describeWorkspace({ root, name: 'x' }), '');

  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
  }
});

test('the prompt carries no workspace block without the capability', async () => {
  const root = await makeProject();
  const provider = createProvider([
    { choices: [{ delta: { content: '好的。' } }] },
  ]);
  const port = await listen(provider.server);
  try {
    setDesktopWorkspace(false);
    const { runAgent } = await import('../src/services/agent-service.js');
    const result = await runAgent({
      user: { id: 'a'.repeat(16) },
      chat: { id: 'b'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
        image: {},
      },
      options: {},
      // Even if a caller passes one, the prompt must stay clean.
      workspace: { root, name: path.basename(root) },
      turnId: 'turn-2',
      userText: '这个项目做什么？',
      emit: () => {},
      signal: undefined,
      turnImages: [],
    });
    assert.match(result.text, /好的/);
    const system = provider.seen[0].messages[0].content;
    // The static prompt has a 【工作目录】 rules section; what must be absent is
    // the dynamic block that names a real directory and its file count.
    assert.doesNotMatch(system, /可读文本文件：/);
    assert.doesNotMatch(system, /名称：/);
  } finally {
    setDesktopWorkspace(false);
    await new Promise((resolve) => provider.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

// --- a bound directory can disappear or become unreadable -------------------
// The binding outlives the directory: users move, rename and delete projects,
// and permissions change. Every path must degrade to a clear message instead of
// throwing or, worse, reporting the directory as empty.

test('a deleted workspace is reported, not served from the index cache', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-gone-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();
  const binding = { root, name: path.basename(root) };

  try {
    const ws = await import('../src/services/workspace-service.js');
    // Warm the index: the cache is what used to mask the deletion.
    const before = await ws.listWorkspaceFiles(binding, {});
    assert.ok(before.files > 0, 'the fixture is indexed');

    await rm(root, { recursive: true, force: true });

    await assert.rejects(
      () => ws.listWorkspaceFiles(binding, {}),
      (err) => err.status === 409,
      'a deleted root is a conflict, not an empty directory',
    );
    await assert.rejects(() => ws.workspaceOverview(binding), (err) => err.status === 409);
    await assert.rejects(
      () => ws.readWorkspaceFile(binding, { file: 'README.md' }),
      (err) => err.status === 409,
    );
    await assert.rejects(() => ws.searchWorkspace(binding, { query: 'Agent' }), (err) => err.status === 409);
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an unreadable workspace reports a permission error instead of an empty listing', async () => {
  // Reproduced live: with the index warm and the root chmod 000, the listing
  // used to return the cached file count, so the UI claimed the project was
  // readable when the process could no longer open it.
  if (process.platform === 'win32') return;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-perm-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();
  const binding = { root, name: path.basename(root) };

  try {
    const { chmod } = await import('node:fs/promises');
    const ws = await import('../src/services/workspace-service.js');
    await ws.listWorkspaceFiles(binding, {}); // warm the cache

    await chmod(root, 0o000);
    try {
      await assert.rejects(
        () => ws.listWorkspaceFiles(binding, {}),
        (err) => err.status === 409 && /不可读/.test(err.message),
        'permission loss is reported with the offending code',
      );
    } finally {
      await chmod(root, 0o700);
    }

    // And the failure must not be sticky: restoring access works immediately.
    const restored = await ws.listWorkspaceFiles(binding, {});
    assert.ok(restored.files > 0, 'the cache was not poisoned by the failure');
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the agent keeps the turn alive when the directory is gone', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-awgone-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();
  const binding = { root, name: path.basename(root) };

  try {
    const { describeWorkspace } = await import('../src/services/agent-service.js');
    const { runTool } = await import('../src/services/tools-service.js');
    const ctx = {
      user: { id: 'u' },
      chat: { id: 'c'.repeat(24) },
      turnId: 'turn-gone',
      workspace: binding,
      signal: undefined,
      emit: () => {},
    };

    // Sanity: the binding works before the deletion.
    assert.equal((await runTool('list_workspace_files', {}, ctx)).ok, true);

    await rm(root, { recursive: true, force: true });

    // The system block explains the situation rather than vanishing.
    const block = await describeWorkspace(binding);
    assert.match(block, /不可读|重新选择/);

    // Every tool reports an error object: the wrapper must not rethrow, or the
    // whole turn would die with a provider error.
    for (const [name, args] of [
      ['list_workspace_files', {}],
      ['read_workspace_file', { file: 'README.md' }],
      ['search_workspace', { query: 'Agent' }],
    ]) {
      const result = await runTool(name, args, ctx);
      assert.equal(typeof result.error, 'string', `${name} reports an error`);
    }
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a workspace that is unreadable before any scan reports an error', async () => {
  // Covers the cold path: no cached index exists yet, so the failure must come
  // from the scan itself rather than from the cache-liveness check.
  if (process.platform === 'win32') return;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-cold-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();

  try {
    const { chmod } = await import('node:fs/promises');
    const ws = await import('../src/services/workspace-service.js');
    // No warm-up: this is a first read against an unreadable root.
    await chmod(root, 0o000);
    try {
      await assert.rejects(
        () => ws.listWorkspaceFiles({ root, name: path.basename(root) }, {}),
        (err) => err.status === 409 && /不可读/.test(err.message),
        'the scan reports the root as unreadable instead of returning an empty listing',
      );
    } finally {
      await chmod(root, 0o700);
    }
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale save never changes the binding; setChatWorkspace owns it', async () => {
  // setChatWorkspace writes the column directly, but saveChat used to carry the
  // workspace value from whatever chat object a tab held in memory. Two silent
  // failures followed: an object loaded BEFORE an unbind resurrected the old
  // directory, and one loaded before a rebind overwrote the new one.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-bind-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const rootA = await makeProject();
  const rootB = await mkdtemp(path.join(os.tmpdir(), 'luma-agent-ws-b-'));
  await writeFile(path.join(rootB, 'only-b.txt'), 'b\n');

  try {
    const chatService = await import('../src/services/chat-service.js');
    const ws = await import('../src/services/workspace-service.js');
    const bindA = await ws.bindWorkspace(rootA);
    const bindB = await ws.bindWorkspace(rootB);

    const chat = chatService.newChatForUser('u');
    chatService.saveChat(chat);
    chatService.setChatWorkspace('u', chat.id, ws.serializeWorkspace(bindA));
    const current = () => ws.workspaceFromChat(chatService.loadChatForUser('u', chat.id));

    // Captured while A was bound: this is the dangerous object.
    const staleBound = chatService.loadChatForUser('u', chat.id);
    assert.equal(current()?.root, bindA.root, 'bound to A');

    // A plain save from that tab keeps A.
    chatService.saveChat(staleBound);
    assert.equal(current()?.root, bindA.root, 'a save does not disturb the binding');

    // Unbind, then the stale tab saves again: it must NOT resurrect A.
    chatService.setChatWorkspace('u', chat.id, '');
    assert.equal(current(), null, 'explicit unbind works');
    chatService.saveChat(staleBound);
    assert.equal(current(), null, 'a stale bound object must not revive the binding');

    // Rebind to B, then the stale A object saves: B must survive.
    chatService.setChatWorkspace('u', chat.id, ws.serializeWorkspace(bindB));
    assert.equal(current()?.root, bindB.root, 'rebound to B');
    chatService.saveChat(staleBound);
    assert.equal(current()?.root, bindB.root, 'a stale A object must not overwrite B');

    // Messages still persist, and the binding coexists with them.
    const fresh = chatService.loadChatForUser('u', chat.id);
    fresh.messages.push({ role: 'user', content: '你好', ts: Date.now() });
    chatService.saveChat(fresh);
    const after = chatService.loadChatForUser('u', chat.id);
    assert.equal(after.messages.length, 1, 'the message was saved');
    assert.equal(ws.workspaceFromChat(after)?.root, bindB.root, 'the binding survived the save');
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test('a root replaced by a regular file is reported, not queried', async () => {
  // realpath() succeeds for a regular file, so a bound directory that was
  // deleted and replaced by a file still "resolves". Every entry point must
  // reject it: otherwise a read reports the file inside it as missing (404),
  // sending the user after a file that was never the problem, and the listing
  // path could serve a stale index.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-fileroot-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);
  setDesktopWorkspace(true);
  const root = await makeProject();
  const binding = { root, name: path.basename(root) };

  try {
    const ws = await import('../src/services/workspace-service.js');
    // Warm the index first: this is the interesting case.
    assert.ok((await ws.listWorkspaceFiles(binding, {})).files > 0);

    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'now a regular file');

    const expectGone = (fn, label) =>
      assert.rejects(
        fn,
        (err) => err.status === 409 && /不是目录/.test(err.message),
        `${label} must report the root as no longer a directory`,
      );

    await expectGone(() => ws.listWorkspaceFiles(binding, {}), 'list');
    await expectGone(() => ws.readWorkspaceFile(binding, { file: 'README.md' }), 'read');
    await expectGone(() => ws.searchWorkspace(binding, { query: 'Agent' }), 'search');
    await expectGone(() => ws.workspaceOverview(binding), 'overview');

    // Restoring a real directory recovers immediately.
    await rm(root, { force: true });
    await mkdir(root);
    await writeFile(path.join(root, 'b.txt'), 'back\n');
    // The failed validation must have evicted the old index. Otherwise the TTL
    // serves the pre-failure listing: measured, restoring the directory still
    // reported README.md from the deleted tree while the disk held b.txt.
    const recovered = await ws.listWorkspaceFiles(binding, {});
    assert.match(recovered.listing, /b\.txt/, 'the fresh directory is listed');
    assert.doesNotMatch(recovered.listing, /README\.md/, 'the stale listing was evicted');
  } finally {
    setDesktopWorkspace(false);
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
