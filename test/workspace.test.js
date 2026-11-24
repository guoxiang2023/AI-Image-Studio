import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { setDesktopWorkspace } from '../src/shared/runtime.js';

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'luma-ws-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Demo\nOverview of the demo project\n');
  await writeFile(
    path.join(root, 'src', 'app.js'),
    ['const a = 1;', 'const b = 2;', 'export function greet() {', "  return 'hi';", '}', ''].join('\n'),
  );
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'const leaked = true;\n');
  await writeFile(path.join(root, '.env'), 'SECRET=top-secret\n');
  await writeFile(path.join(root, '.env.example'), 'API_KEY=please-fill-me\n');
  await writeFile(path.join(root, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  return root;
}

test('path normalization always returns an object, never a bare string', async () => {
  const { normalizeRelativePath } = await import('../src/domain/workspace.js');
  assert.deepEqual(normalizeRelativePath(''), { path: '' });
  assert.deepEqual(normalizeRelativePath('  '), { path: '' });
  assert.deepEqual(normalizeRelativePath('./src//a.js'), { path: 'src/a.js' });
  assert.deepEqual(normalizeRelativePath('src\\a.js'), { path: 'src/a.js' });
  assert.match(normalizeRelativePath('../a').error, /超出工作目录/);
  assert.match(normalizeRelativePath('/etc/passwd').error, /相对路径/);
});

test('workspace is a desktop-only capability', async () => {
  const { bindWorkspace, isWorkspaceEnabled } = await import('../src/services/workspace-service.js');
  const root = await makeProject();
  try {
    setDesktopWorkspace(false);
    assert.equal(isWorkspaceEnabled(), false);
    await assert.rejects(() => bindWorkspace(root), /桌面端/);

    setDesktopWorkspace(true);
    const bound = await bindWorkspace(root);
    assert.equal(bound.root, await import('node:fs/promises').then((fs) => fs.realpath(root)));
  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
  }
});

test('index skips ignored dirs, secrets and binary files', async () => {
  setDesktopWorkspace(true);
  const root = await makeProject();
  try {
    const { bindWorkspace, workspaceOverview } = await import('../src/services/workspace-service.js');
    const bound = await bindWorkspace(root);
    const overview = await workspaceOverview(bound);
    assert.equal(overview.files, 3, 'README.md, src/app.js and the .env template are readable');
    assert.ok(overview.languages.some((line) => line.startsWith('md')));
  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
  }
});

test('read_workspace returns line ranges and refuses escapes', async () => {
  setDesktopWorkspace(true);
  const root = await makeProject();
  try {
    const { bindWorkspace, readWorkspaceFile, searchWorkspace } = await import(
      '../src/services/workspace-service.js'
    );
    const bound = await bindWorkspace(root);

    const page = await readWorkspaceFile(bound, { file: 'src/app.js', startLine: 3, maxLines: 2 });
    assert.equal(page.startLine, 3);
    assert.match(page.content, /^3\| export function greet/);
    assert.match(page.content, /4\|/);
    assert.equal(page.totalLines, 6);

    await assert.rejects(() => readWorkspaceFile(bound, { file: '../outside.txt' }), /超出工作目录/);
    await assert.rejects(() => readWorkspaceFile(bound, { file: '/etc/passwd' }), /相对路径/);
    await assert.rejects(() => readWorkspaceFile(bound, { file: '.env' }), /凭据/);
    const template = await readWorkspaceFile(bound, { file: '.env.example' });
    assert.match(template.content, /API_KEY=please-fill-me/);

    const found = await searchWorkspace(bound, { query: 'greet' });
    assert.equal(found.matches, 1);
    assert.match(found.results, /src\/app\.js:3\|/);

    const hidden = await searchWorkspace(bound, { query: 'leaked' });
    assert.equal(hidden.matches, 0, 'node_modules stays out of the index');
  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlink pointing outside the workspace is rejected', async () => {
  setDesktopWorkspace(true);
  const root = await makeProject();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'luma-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'not yours\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));
    const { bindWorkspace, readWorkspaceFile } = await import('../src/services/workspace-service.js');
    const bound = await bindWorkspace(root);
    // Rejected before the canonical check even runs: a file that is itself a
    // symlink is never opened, whichever way it points.
    await assert.rejects(
      () => readWorkspaceFile(bound, { file: 'src/link.txt' }),
      /不跟随符号链接/,
    );
  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// The index lives for a minute. In that window a file that was scanned as
// regular can be swapped for a symlink pointing outside the root, so a search
// that trusted the cached path would read a stranger's file. Both the explicit
// read and the search walk must re-validate every entry they touch.
test('a cached entry swapped for an escaping symlink is never read', async () => {
  setDesktopWorkspace(true);
  const root = await makeProject();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'luma-outside2-'));
  try {
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'greet LEAKED-FROM-OUTSIDE\n');

    const { bindWorkspace, searchWorkspace, readWorkspaceFile } = await import(
      '../src/services/workspace-service.js'
    );
    const bound = await bindWorkspace(root);

    // First pass builds the index while src/app.js is still a regular file.
    const before = await searchWorkspace(bound, { query: 'greet' });
    assert.equal(before.matches, 1);
    assert.match(before.results, /src\/app\.js/);

    // Swap it for a link that leaves the workspace, without letting the TTL expire.
    const target = path.join(root, 'src', 'app.js');
    await unlink(target);
    await symlink(secret, target);

    const afterSearch = await searchWorkspace(bound, { query: 'greet' });
    assert.equal(afterSearch.matches, 0, 'cached entry must not be followed out of the root');
    assert.doesNotMatch(afterSearch.results || '', /LEAKED-FROM-OUTSIDE/);

    await assert.rejects(
      () => readWorkspaceFile(bound, { file: 'src/app.js' }),
      /符号链接|超出工作目录范围/,
    );
  } finally {
    setDesktopWorkspace(false);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
