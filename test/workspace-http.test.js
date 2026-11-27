import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';

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

test('the workspace browser lists folders and previews only allowed files', async () => {
  const { cookie } = await signUp();
  const other = await signUp();
  runtime.setDesktopWorkspace(true);
  const sessionId = await createSession(cookie);
  const url = `/api/sessions/${sessionId}/workspace`;
  assert.equal((await request('GET', url)).status, 401);
  assert.equal((await request('GET', url, { cookie })).status, 409);
  const root = await mkdtemp(path.join(projectDir, 'browse-'));
  try {
    await mkdir(path.join(root, '子目录'));
    await mkdir(path.join(root, '空目录'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '子目录', '示例 #1.txt'), '<b>纯文本</b>\n');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(root, '图片.png'), png);
    await writeFile(path.join(root, '.env'), 'SECRET=hidden');
    await writeFile(path.join(root, '.git', 'config.txt'), 'hidden');
    await symlink(path.join(root, '子目录'), path.join(root, 'link'), 'dir');
    assert.equal((await request('PUT', url, { cookie, body: { path: root } })).status, 200);
    assert.equal((await request('GET', url, { cookie: other.cookie })).status, 404);

    const listed = await request('GET', url, { cookie });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(listed.payload.entries, [
      { name: '空目录', kind: 'directory' },
      { name: '子目录', kind: 'directory' },
      { name: '图片.png', kind: 'image' },
    ]);
    const get = (key, value) => request('GET', `${url}?${new URLSearchParams([[key, value]])}`, { cookie });
    assert.deepEqual((await get('directory', '空目录')).payload.entries, []);
    assert.deepEqual((await get('directory', '子目录')).payload.entries, [{ name: '示例 #1.txt', kind: 'text' }]);
    const preview = await get('file', '子目录/示例 #1.txt');
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.payload.content, /1\| <b>纯文本<\/b>/);
    const image = await fetch(`${base}${url}?${new URLSearchParams({ file: '图片.png' })}`, { headers: { cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    // A screenshot wider than the preview edge is downscaled, never served
    // whole: the renderer would decode hundreds of MB for a 300px column.
    const { default: sharp } = await import('sharp');
    const panorama = await sharp({ create: { width: 4000, height: 900, channels: 3, background: '#336699' } })
      .png().toBuffer();
    await writeFile(path.join(root, '长图.png'), panorama);
    const shrunk = await fetch(`${base}${url}?${new URLSearchParams({ file: '长图.png' })}`, { headers: { cookie } });
    assert.equal(shrunk.status, 200);
    assert.equal(shrunk.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await shrunk.arrayBuffer())).metadata();
    assert.equal(meta.width, 1600);
    assert.equal(meta.height, 360);

    // Phone photos store rotation in EXIF. Resizing the stored pixels and
    // dropping the tag turned a portrait photo sideways.
    const rotated = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#c04020' } })
      .jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
    await writeFile(path.join(root, '竖拍.jpg'), rotated);
    const oriented = await fetch(`${base}${url}?${new URLSearchParams({ file: '竖拍.jpg' })}`, { headers: { cookie } });
    assert.equal(oriented.status, 200);
    const exifMeta = await sharp(Buffer.from(await oriented.arrayBuffer())).metadata();
    assert.deepEqual([exifMeta.width, exifMeta.height], [800, 1600]);
    assert.equal((await get('file', '.env')).status, 403);
    assert.equal((await get('file', '.git/config.txt')).status, 403);
    assert.equal((await get('file', 'link/示例 #1.txt')).status, 403);
    assert.equal((await get('directory', '..')).status, 400);
    assert.equal((await request('DELETE', url, { cookie })).status, 200);
    assert.equal((await request('GET', url, { cookie })).status, 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace previews expose Office content and allow choosing a PDF page', async () => {
  const { createZip } = await import('../src/media/zip-writer.js');
  const { buildDocx } = await import('../src/media/docx.js');
  const { buildPptx } = await import('../src/media/pptx.js');
  const { default: PDFDocument } = await import('pdfkit');
  const { cookie } = await signUp();
  runtime.setDesktopWorkspace(true);
  const url = `/api/sessions/${await createSession(cookie)}/workspace`;
  const root = await mkdtemp(path.join(projectDir, 'documents-'));
  try {
    const pdf = new PDFDocument({ size: [240, 360], margin: 0 });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    const complete = new Promise((resolve, reject) => {
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
    });
    pdf.rect(0, 0, 240, 360).fill('red').fillColor('white').text('First page', 30, 45);
    pdf.addPage().rect(0, 0, 240, 360).fill('blue').fillColor('white').text('Second page', 30, 45);
    pdf.end();
    await Promise.all([
      writeFile(path.join(root, 'report.pdf'), await complete),
      writeFile(path.join(root, 'notes.docx'), buildDocx({ title: '会议纪要', blocks: [{ type: 'paragraph', text: '会议结论' }] })),
      writeFile(path.join(root, 'slides.pptx'), buildPptx({ title: '进展', slides: [{ layout: 'cover', title: '季度进展' }] }).buffer),
      writeFile(path.join(root, 'data.xlsx'), createZip([{
        name: 'xl/worksheets/sheet1.xml',
        data: '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
      }])),
    ]);
    assert.equal((await request('PUT', url, { cookie, body: { path: root } })).status, 200);
    for (const [file, expected] of [['notes.docx', /会议结论/], ['slides.pptx', /季度进展/], ['data.xlsx', /42/]]) {
      const result = await request('GET', `${url}?${new URLSearchParams({ file })}`, { cookie });
      assert.equal(result.status, 200, result.text);
      assert.match(result.payload.content, expected);
    }

    const page = (number) => fetch(`${base}${url}?file=report.pdf&page=${number}`, { headers: { cookie } });
    const { default: sharp } = await import('sharp');
    for (const [number, color] of [[1, [255, 0, 0]], [2, [0, 0, 255]]]) {
      const response = await page(number);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('x-preview-page'), String(number));
      assert.equal(response.headers.get('x-preview-total-pages'), '2');
      const raster = sharp(Buffer.from(await response.arrayBuffer()));
      const { data, info } = await raster.clone().removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      // The sidebar is a few hundred pixels wide; a page raster wider than the
      // preview edge is bandwidth the panel cannot show.
      assert.ok(info.width <= 1200 && info.height <= 1200, `preview raster ${info.width}x${info.height}`);
      const corner = [data[0], data[1], data[2]];
      assert.deepEqual(corner, color);
      // Standard-font text is drawn with glyph paths, so it only appears when
      // PDF.js is allowed to read its bundled fonts. A page reduced to its
      // background colour means the preview lost every word on the page.
      let ink = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] > 230) ink += 1;
      }
      assert.ok(ink > 100, `Page ${number} must render text, got ${ink} light pixels`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace previews cover vectors, CAD and the extra document containers', async () => {
  const { createZip } = await import('../src/media/zip-writer.js');
  const { default: sharp } = await import('sharp');
  const { cookie } = await signUp();
  runtime.setDesktopWorkspace(true);
  const url = `/api/sessions/${await createSession(cookie)}/workspace`;
  const root = await realpath(await mkdtemp(path.join(projectDir, 'formats-')));
  const get = (file) => request('GET', `${url}?${new URLSearchParams({ file })}`, { cookie });
  const bytes = async (file) => {
    const res = await fetch(`${base}${url}?${new URLSearchParams({ file })}`, { headers: { cookie } });
    return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  };
  assert.equal((await request('PUT', url, { cookie, body: { path: root } })).status, 200);
  try {
    // SVG: the browser cannot display it, so the route rasterizes. The declared
    // size is 1000x400 but the text must survive, not just the background.
    await writeFile(path.join(root, '图示.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400" viewBox="0 0 1000 400">
  <rect width="1000" height="400" fill="#ffffff"/>
  <rect x="40" y="40" width="300" height="240" fill="#1f6fb2"/>
</svg>`);
    const svg = await bytes('图示.svg');
    assert.equal(svg.res.status, 200);
    assert.equal(svg.res.headers.get('content-type'), 'image/webp');
    const svgMeta = await sharp(svg.buffer).metadata();
    // Vector art is rendered at the density that fills the preview edge, so the
    // panel gets a crisp drawing instead of a 1000px one scaled up by CSS.
    assert.deepEqual([svgMeta.width, svgMeta.height], [1600, 640], 'aspect ratio is kept');
    const svgPixels = await sharp(svg.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let blue = 0;
    for (let offset = 0; offset < svgPixels.data.length; offset += svgPixels.info.channels) {
      if (svgPixels.data[offset] < 80 && svgPixels.data[offset + 2] > 140) blue += 1;
    }
    assert.ok(blue > 5000, `SVG geometry must be drawn, got ${blue} blue pixels`);

    // An external reference resolves to nothing in librsvg: a workspace file must
    // never be able to pull bytes from disk or the network into a preview.
    await writeFile(path.join(root, '外部.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <rect width="200" height="200" fill="#ffffff"/>
  <image href="file:///etc/hosts" x="0" y="0" width="200" height="200"/>
</svg>`);
    const external = await bytes('外部.svg');
    assert.equal(external.res.status, 200, 'the file still previews, just without the reference');
    const externalPixels = await sharp(external.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(
      externalPixels.data.every((value) => value > 240),
      'an external href must render as blank, never as the referenced file',
    );

    // TIFF: no browser displays it, and a 2400px scan must come back downscaled.
    await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#2f7d4f' } })
      .tiff({ compression: 'lzw' })
      .toFile(path.join(root, '扫描件.tif'));
    const tif = await bytes('扫描件.tif');
    assert.equal(tif.res.status, 200);
    assert.equal(tif.res.headers.get('content-type'), 'image/webp');
    const tifMeta = await sharp(tif.buffer).metadata();
    assert.deepEqual([tifMeta.width, tifMeta.height], [1600, 800]);

    // A DXF is plain text with geometry; it previews as a picture, not as a
    // numbered text dump of group codes.
    const dxfPairs = [
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'LWPOLYLINE'], [8, 'PARCEL'], [70, '1'],
      [10, '0'], [20, '0'], [10, '120'], [20, '0'],
      [10, '120'], [20, '90'], [10, '0'], [20, '90'],
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    await writeFile(
      path.join(root, '平面图.dxf'),
      `${dxfPairs.map(([code, value]) => `${code}\r\n${value}`).join('\r\n')}\r\n`,
    );
    const dxf = await bytes('平面图.dxf');
    assert.equal(dxf.res.status, 200, dxf.buffer.toString().slice(0, 200));
    assert.equal(dxf.res.headers.get('content-type'), 'image/png');
    // The header alone is a promise; a browser sniffs the bytes and would show
    // WebP while the declared type stayed wrong. Check what was encoded.
    assert.equal((await sharp(dxf.buffer).metadata()).format, 'png');
    const dxfPixels = await sharp(dxf.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let lines = 0;
    for (let offset = 0; offset < dxfPixels.data.length; offset += dxfPixels.info.channels) {
      if (dxfPixels.data[offset] < 150) lines += 1;
    }
    assert.ok(lines > 500, `the DXF outline must be drawn, got ${lines} dark pixels`);

    // ODF/EPUB/RTF/EML/notebook all reduce to text through one preview kind.
    await writeFile(path.join(root, '报告.odt'), createZip([{
      name: 'content.xml',
      // A real writer emits indented XML. One `text:p` is one line, so the
      // newlines between tags are indentation and must not become blank lines;
      // a comment sits inline in the flow and is not body text.
      data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:p>季度目标</text:p>
      <text:p>核对预算<office:annotation><text:p>内部批注</text:p></office:annotation></text:p>
    </office:text>
  </office:body>
</office:document-content>`,
    }]));
    await writeFile(path.join(root, '手册.epub'), createZip([
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      {
        name: 'OEBPS/content.opf',
        data: '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>安装手册</dc:title></metadata><manifest>' +
          '<item id="c1" href="ch1.xhtml"/><item id="c2" href="ch2.xhtml"/><item id="nav" href="nav.xhtml"/></manifest>' +
          // Spine order, not file order, is how a reader sees the book.
          '<spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>',
      },
      {
        name: 'OEBPS/ch1.xhtml',
        data: '<html><head><style>p{color:red}</style></head><body><nav>目录页</nav><h1>第一章</h1><p>开箱清单</p></body></html>',
      },
      { name: 'OEBPS/ch2.xhtml', data: '<html><body><h1>第二章</h1><p>上电步骤</p></body></html>' },
      { name: 'OEBPS/nav.xhtml', data: '<html><body><nav>目录页</nav><p>不该出现</p></body></html>' },
    ]));
    // GBK bytes, because that is what a Chinese Word/WPS export writes.
    await writeFile(
      path.join(root, '说明.rtf'),
      Buffer.from(
        "{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}" +
        "\\pard\\f0 \\'cf\\'ee\\'c4\\'bf\\'c3\\'fb\\'b3\\'c6\\par" +
        "{\\*\\background\\shp{\\*\\shpinst{\\sp{\\sn fillColor}{\\sv 1}}}}" +
        "\\'d5\\'fd\\'ce\\'c4}",
        'latin1',
      ),
    );
    await writeFile(
      path.join(root, '邮件.eml'),
      [
        'From: =?utf-8?B?5byg5LiJ?= <zhang@example.com>',
        'Subject: =?utf-8?B?5ZCI5ZCM6K+E5a6h?=',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="gbk"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '=D6=D0=CE=C4=D5=FD=CE=C4',
      ].join('\r\n'),
    );
    await writeFile(path.join(root, '分析.ipynb'), JSON.stringify({
      cells: [{ cell_type: 'markdown', source: ['# 销售分析'] }],
      metadata: {},
      nbformat: 4,
    }));

    for (const [file, expected] of [
      // One paragraph per line: the source indentation must not double-space it.
      ['报告.odt', /^季度目标\n核对预算$/m],
      // Spine order decides reading order; the manifest also lists nav.xhtml,
      // which must not appear as a chapter of its own.
      ['手册.epub', /安装手册[\s\S]*第二章[\s\S]*第一章/],
      ['说明.rtf', /项目名称[\s\S]*正文/],
      ['邮件.eml', /张三[\s\S]*合同评审[\s\S]*中文正文/],
      ['分析.ipynb', /销售分析/],
    ]) {
      const preview = await get(file);
      assert.equal(preview.status, 200, `${file}: ${preview.text}`);
      assert.match(preview.payload.content, expected, file);
    }
    // Formatting tables and hidden field instructions must not reach the text.
    const rtf = await get('说明.rtf');
    assert.doesNotMatch(rtf.payload.content, /SimSun|fillColor|fldinst/);
    const epub = await get('手册.epub');
    assert.doesNotMatch(epub.payload.content, /不该出现/, 'a nav document is not a chapter');
    const odt = await get('报告.odt');
    assert.doesNotMatch(odt.payload.content, /内部批注/, 'a comment is not part of the document body');

    // The listing labels each file with the kind the panel branches on.
    const listed = await request('GET', url, { cookie });
    const kinds = Object.fromEntries(listed.payload.entries.map((entry) => [entry.name, entry.kind]));
    assert.deepEqual(kinds, {
      '图示.svg': 'image',
      '外部.svg': 'image',
      '扫描件.tif': 'image',
      '平面图.dxf': 'cad',
      '报告.odt': 'office',
      '手册.epub': 'office',
      '说明.rtf': 'office',
      '邮件.eml': 'office',
      '分析.ipynb': 'office',
    });

    // Legacy binary Office stays explicitly unsupported instead of failing on
    // the container parser with a confusing message.
    await writeFile(path.join(root, '旧版.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]));
    assert.equal((await get('旧版.doc')).status, 415);

    // A .dxf that is really just text must not be parsed as a drawing.
    await writeFile(path.join(root, '假图纸.dxf'), '这是一份说明\n0\nSECTION\n没有组码数据\n');
    const fake = await get('假图纸.dxf');
    assert.equal(fake.status, 400, fake.text);
    assert.match(fake.payload.error, /不匹配/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an HTML file renders in a sandboxed frame with its own assets', async () => {
  const { default: sharp } = await import('sharp');
  const { cookie } = await signUp();
  runtime.setDesktopWorkspace(true);
  const url = `/api/sessions/${await createSession(cookie)}/workspace`;
  const root = await realpath(await mkdtemp(path.join(projectDir, 'page-')));
  const raw = (rest) => fetch(`${base}${url.replace(/workspace$/, 'workspace/raw/')}${rest}`, {
    headers: { cookie },
  });
  try {
    await mkdir(path.join(root, '站点'));
    await writeFile(path.join(root, '站点', '首页.html'), [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="样式.css">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '</head><body><h1>季度报告</h1>',
      '<img src="图.png" alt="图"><script>document.title="pwned"</script>',
      '</body></html>',
    ].join(''));
    await writeFile(path.join(root, '站点', '样式.css'), 'h1 { color: #c00 }');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0a0' } })
      .png().toFile(path.join(root, '站点', '图.png'));
    await writeFile(path.join(root, '站点', '秘密.js'), 'alert(1)');
    assert.equal((await request('PUT', url, { cookie, body: { path: root } })).status, 200);

    // The panel asks the JSON route what kind the file is, and gets told to
    // render it rather than to show markup as text.
    const meta = await request('GET', `${url}?${new URLSearchParams({ file: '站点/首页.html' })}`, { cookie });
    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.payload.kind, 'html');
    assert.equal(meta.payload.render, true, 'the page is rendered, not dumped as text');

    const page = await raw('站点/首页.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await page.text();
    assert.match(html, /季度报告/);
    // A refresh meta tag navigates the frame without any script, so it is
    // stripped instead of being left for the sandbox to allow.
    assert.doesNotMatch(html, /http-equiv="refresh"/i);
    // Nothing may run and nothing may pull in another origin; the page is only
    // framable by this app.
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox allow-same-origin/);
    assert.doesNotMatch(csp, /allow-scripts/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /default-src 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('cache-control'), 'no-store');

    // Sibling assets load, or the page cannot look like itself.
    const css = await raw('站点/样式.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.match(await css.text(), /#c00/);
    const image = await raw('站点/图.png');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(
      [...new Uint8Array(await image.arrayBuffer()).slice(0, 4)],
      [0x89, 0x50, 0x4e, 0x47],
    );
    // A script is not an asset this route will hand out: the CSP forbids it, and
    // serving it would only widen what can leave the workspace.
    assert.equal((await raw('站点/秘密.js')).status, 404);

    // The same refusals as every other read apply to the raw route. A bare `..`
    // never reaches the handler (URL parsing folds it away), so what must hold
    // is that no escape attempt is ever served: each one is a 4xx.
    for (const attempt of ['%2e%2e/etc/passwd', '.env', '站点/%2e%2e%2f%2e%2e/.env', '站点/../../.env']) {
      const refused = await raw(attempt);
      assert.ok(refused.status >= 400 && refused.status < 500, `${attempt}: ${refused.status}`);
    }
    // And the guard itself rejects a parent segment when it is handed one, which
    // is the case a hand-written URL or a proxy could still produce.
    const { readHtmlAsset } = await import('../src/services/workspace-html.js');
    const workspace = { root };
    await assert.rejects(() => readHtmlAsset(workspace, '../.env'), /相对路径/);
    await assert.rejects(() => readHtmlAsset(workspace, '站点/../.env'), /相对路径/);

    const listed = await request('GET', `${url}?${new URLSearchParams({ directory: '站点' })}`, { cookie });
    const kinds = Object.fromEntries(listed.payload.entries.map((entry) => [entry.name, entry.kind]));
    assert.equal(kinds['首页.html'], 'html');

    // The raw route reuses the guarded reader, so its limits apply here too: a
    // page or stylesheet past the text ceiling is a 413, not an unbounded read.
    const { WORKSPACE_MAX_FILE_BYTES } = await import('../src/config.js');
    await writeFile(path.join(root, '站点', '大页面.html'), 'x'.repeat(WORKSPACE_MAX_FILE_BYTES + 1024));
    const oversizedPage = await raw('站点/大页面.html');
    assert.equal(oversizedPage.status, 413, 'an oversized page is refused, not read');
    assert.match((await oversizedPage.json()).error, /超过/);
    await writeFile(path.join(root, '站点', '大样式.css'), 'a'.repeat(WORKSPACE_MAX_FILE_BYTES + 1024));
    assert.equal((await raw('站点/大样式.css')).status, 413);

    // A root that no longer canonicalizes to the bound directory is reported,
    // not followed. This is the guard the duplicate resolver was missing: the
    // stored root is a real path, so replacing it with a symlink must be a 409
    // rather than silently serving whatever the link points at.
    const moved = `${root}-moved`;
    await rename(root, moved);
    await symlink(moved, root, 'dir');
    const rebound = await raw('站点/首页.html');
    assert.equal(rebound.status, 409, 'a replaced workspace root is refused');
    assert.match((await rebound.json()).error, /已变更|重新绑定/);
    await rm(root, { recursive: true, force: true });
    await rename(moved, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
