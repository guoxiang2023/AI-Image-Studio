import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nU8AAAAASUVORK5CYII=';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('generate_image routes session references through the edits endpoint', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-ref-'));
  process.env.DATA_DIR = dataDir;
  const userId = 'a'.repeat(16);
  const refId = 'b'.repeat(16);
  const imageDir = path.join(dataDir, 'users', userId, 'images');
  await mkdir(imageDir, { recursive: true });
  await writeFile(path.join(imageDir, `${refId}.png`), Buffer.from(TINY_PNG, 'base64'));

  let requestPath = '';
  let requestBody = '';
  const server = http.createServer((req, res) => {
    requestPath = req.url;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('latin1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
  });
  const port = await listen(server);

  try {
    const { initDb, closeDb } = await import('../src/data/database.js');
    initDb(dataDir);
    const { runTool } = await import('../src/services/tools-service.js');
    const events = [];
    const result = await runTool(
      'generate_image',
      { prompt: 'a small cat sitting on a windowsill', count: 1 },
      {
        user: { id: userId },
        models: {
          llm: { apiKey: '' },
          image: {
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'gpt-image-2.5-flare',
            quality: 'xhigh',
            apiKey: 'test',
          },
        },
        chat: { lastImageId: null },
        references: [{ id: refId, role: '风格' }],
        options: { aspectRatio: null, quality: null, count: null },
        countBudget: null,
        turnId: 'c'.repeat(16),
        turnImages: [],
        userText: '按这个风格画一只猫',
        emit: (event) => events.push(event),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.equal(requestPath, '/images/edits');
    assert.match(requestBody, /Reference image rules:/);
    assert.match(requestBody, /style reference only/);
    assert.match(requestBody, /Image 1/);
    assert.match(requestBody, /name="quality"\r\n\r\nxhigh/);
    assert.equal(events.some((event) => event.type === 'image'), true);
    closeDb();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Two callers share runTool and they need opposite contracts:
//   - the agent must survive a tool failure and keep the turn alive
//   - the style studio maps a returned { error } to HTTP 400, so a provider
//     outage must still THROW there to stay a 500
// Guarding runTool itself satisfied the first and silently broke the second.

const DEAD = 'http://127.0.0.1:1';

async function withImageFixture(fn) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-fail-'));
  process.env.DATA_DIR = dataDir;
  const userId = 'c'.repeat(16);
  const refId = 'd'.repeat(16);
  const { initDb, closeDb } = await import('../src/data/database.js');
  initDb(dataDir);
  // USERS_DIR is fixed at config import time, so resolve it through the module
  // that owns it instead of rebuilding the path from this test's temp dir.
  const { userImageDir } = await import('../src/media/image-storage.js');
  await mkdir(userImageDir(userId), { recursive: true });
  await writeFile(path.join(userImageDir(userId), `${refId}.png`), Buffer.from(TINY_PNG, 'base64'));
  try {
    return await fn({ userId, refId });
  } finally {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function imageCtx(userId, entry) {
  return {
    user: { id: userId },
    chat: { id: 'e'.repeat(16), lastImageId: entry },
    turnId: 'f'.repeat(16),
    signal: undefined,
    options: {},
    userText: '画一只猫',
    emit: () => {},
    models: { llm: {}, image: { model: 'gpt-image-1', apiKey: 'bad', baseUrl: DEAD } },
  };
}

test('the style studio still sees a provider failure as a throw (HTTP 500)', async () => {
  // runTool must not absorb the failure: style-studio-service converts a
  // returned { error } into AppError(400), which would misreport an image
  // provider outage as a bad request.
  await withImageFixture(async ({ userId, refId }) => {
    const { runTool } = await import('../src/services/tools-service.js');
    await assert.rejects(
      () => runTool('edit_image', { prompt: 'change to blue' }, imageCtx(userId, refId)),
      (err) => /网络|fetch failed/.test(err.message),
      'the provider error propagates for the studio route',
    );
  });
});

test('the agent survives a failing image tool and still answers', async () => {
  // The real regression: an unreachable image host ended the whole turn.
  await withImageFixture(async ({ userId, refId }) => {
    const originalFetch = globalThis.fetch;
    const toolResults = [];
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      // Chat model: first turn asks for the tool, second answers in text.
      if (call === 1) {
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call1',
                    type: 'function',
                    function: { name: 'edit_image', arguments: '{"prompt":"change to blue"}' },
                  }],
                },
              }],
            })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (call === 2) {
        // This is the image endpoint... except runAgent posts the tool result
        // back to the model first. Order is: chat, tool, chat.
        return new Response('', { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '图片服务不可用，我先说明情况。' } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    try {
      const { runAgent } = await import('../src/services/agent-service.js');
      const out = await runAgent({
        user: { id: userId },
        chat: {
          id: 'c'.repeat(24),
          summary: '',
          lastImageId: refId,
          messages: [{ role: 'user', content: '把背景改成蓝色' }],
        },
        models: {
          llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub-model' },
          image: { model: 'gpt-image-1', apiKey: 'bad', baseUrl: DEAD },
        },
        options: {},
        turnId: 't',
        turnImages: [],
        emit: () => {},
      });
      assert.match(out.text, /图片服务不可用/, 'the turn produced a text answer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('an aborted tool call still unwinds the turn', async () => {
  // The guard must not turn an abort into a tool error. Note this assertion is
  // weaker than it looks: with the guard removed, the next model call still
  // re-throws AbortError (llm.js checks signal.aborted before retrying), so the
  // observable behaviour is the same. The explicit check is kept because the
  // intent must be local and obvious, not an accident of a later layer.
  await withImageFixture(async ({ userId, refId }) => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let first = true;
    globalThis.fetch = async () => {
      if (first) {
        first = false;
        return new Response(
          [
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call1',
                    type: 'function',
                    function: { name: 'edit_image', arguments: '{"prompt":"change to blue"}' },
                  }],
                },
              }],
            })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      // The image request: abort mid-flight, exactly like a user pressing stop.
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    try {
      const { runAgent } = await import('../src/services/agent-service.js');
      await assert.rejects(
        () =>
          runAgent({
            user: { id: userId },
            chat: {
              id: 'c'.repeat(24),
              summary: '',
              lastImageId: refId,
              messages: [{ role: 'user', content: '把背景改成蓝色' }],
            },
            models: {
              llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub-model' },
              image: { model: 'gpt-image-1', apiKey: 'bad', baseUrl: DEAD },
            },
            options: {},
            turnId: 't',
            turnImages: [],
            emit: () => {},
            signal: controller.signal,
          }),
        (err) => err.name === 'AbortError',
        'abort is not a tool failure and must not be swallowed',
      );

    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a studio provider failure stays a 500, not a 400', async () => {
  // style-studio-service maps a RETURNED { error } to AppError(400). A provider
  // outage must throw instead, so the global handler reports 500. Guarding
  // runTool turned this 500 into a 400 and mislabelled a server fault as the
  // user's bad request.
  await withImageFixture(async ({ userId, refId }) => {
    const { generateStyleMaterial } = await import('../src/services/style-studio-service.js');
    const { saveUserSettings } = await import('../src/services/model-settings-service.js');
    const [{ setSecretBox }, { createSecretBox }] = await Promise.all([
      import('../src/shared/runtime.js'),
      import('../src/auth/crypto.js'),
    ]);
    setSecretBox(createSecretBox(Buffer.alloc(32, 7)));
    const { AppError } = await import('../src/shared/errors.js');
    // Give the studio a configured image model pointed at a dead port, so it
    // reaches the network instead of failing on a missing API key.
    saveUserSettings(userId, {
      llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub-model' },
      image: { apiKey: 'bad', baseUrl: DEAD, model: 'gpt-image-1' },
    });
    let caught = null;
    try {
      await generateStyleMaterial(
        { id: userId },
        {
          referenceImageId: refId,
          mode: 'edit',
          count: 1,
          content: { title: '春季新品发布' },
        },
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'the provider outage throws');
    const status = caught instanceof AppError ? caught.status : caught?.status;
    assert.notEqual(status, 400, 'a provider outage must not present as a bad request');
    assert.ok(
      status === undefined || status >= 500,
      `provider outage must map to 500, got status ${status}`,
    );
  });
});

test('an image tool works when the turn context omits turnImages', async () => {
  // ctx.turnImages is owned by the turn. A caller that omits it used to crash
  // inside saveImageResults with "undefined.push", surfacing to the model as an
  // opaque tool error rather than a picture.
  await withImageFixture(async ({ userId, refId }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const { runTool } = await import('../src/services/tools-service.js');
      const result = await runTool('edit_image', { prompt: 'change to blue' }, {
        user: { id: userId },
        chat: { id: 'e'.repeat(16), lastImageId: refId },
        turnId: 'f'.repeat(16),
        signal: undefined,
        options: {},
        userText: '换个颜色',
        emit: () => {},
        models: { llm: {}, image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' } },
        // turnImages deliberately absent.
      });
      assert.equal(result.ok, true);
      assert.equal(result.images.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('the same image call repeated in one turn costs one provider request', async () => {
  // Models re-issue an identical call after seeing the result; each one used to
  // be a billed request and a second nearly identical picture.
  await withImageFixture(async ({ userId }) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const { runTool } = await import('../src/services/tools-service.js');
      const ctx = {
        user: { id: userId },
        chat: { id: 'e'.repeat(16), lastImageId: null },
        turnId: 'f'.repeat(16),
        options: {},
        userText: '画一只猫',
        emit: () => {},
        turnImages: [],
        models: { llm: {}, image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' } },
      };
      const args = { prompt: 'a ginger cat asleep on a wooden chair', count: 1 };
      const first = await runTool('generate_image', args, ctx);
      // A second identical call in the SAME batch is the user asking twice and
      // must still run.
      const sameBatch = await runTool('generate_image', { ...args }, ctx);
      assert.equal(calls, 2, 'identical calls in one batch both run');
      assert.equal(sameBatch.reused, undefined);

      // A repeat in a later round is the model redoing work it already did.
      ctx.toolRound = 1;
      const second = await runTool('generate_image', { ...args }, ctx);
      assert.equal(calls, 2, 'the later round must not reach the provider');
      assert.deepEqual(
        second.images.map((image) => image.image_id),
        first.images.map((image) => image.image_id),
        'the repeat hands back the pictures that already exist',
      );
      assert.equal(second.reused, true);
      assert.equal(ctx.turnImages.length, 2, 'no duplicate picture is added to the turn');

      // A real change is a new request, not a cached result.
      await runTool('generate_image', { ...args, count: 2 }, ctx);
      assert.equal(calls, 3, 'a different count is a different request');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a timed-out generation is never re-posted when the model repeats the call', async () => {
  // The provider may have produced (and billed) the picture before the response
  // was lost. Every automatic resubmission makes the user's "one picture" into
  // several, so the unknown outcome has to outlive the tool error.
  await withImageFixture(async ({ userId }) => {
    const originalFetch = globalThis.fetch;
    let imagePosts = 0;
    let chatCalls = 0;
    const stream = (delta, finish) =>
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    globalThis.fetch = async (url) => {
      if (String(url).includes('/images/')) {
        imagePosts += 1;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      chatCalls += 1;
      // Rounds 1 and 2 issue the identical call; round 3 answers in text.
      if (chatCalls <= 2) {
        return stream(
          {
            tool_calls: [{
              index: 0,
              id: `call${chatCalls}`,
              type: 'function',
              function: {
                name: 'generate_image',
                arguments: '{"prompt":"a ginger cat asleep on a wooden chair"}',
              },
            }],
          },
          'tool_calls',
        );
      }
      return stream({ content: '出图超时了，请先看画册里是否已经有这张图。' }, 'stop');
    };
    try {
      const { runAgent } = await import('../src/services/agent-service.js');
      const out = await runAgent({
        user: { id: userId },
        chat: {
          id: 'c'.repeat(24),
          summary: '',
          lastImageId: null,
          messages: [{ role: 'user', content: '画一只趴在木椅上的橘猫' }],
        },
        models: {
          llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub-model' },
          image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' },
        },
        options: {},
        turnId: 't',
        turnImages: [],
        emit: () => {},
      });
      assert.equal(imagePosts, 1, 'the identical repeat must not reach the provider again');
      assert.match(out.text, /画册/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('the same references in the opposite order are a different request', async () => {
  // File order is meaningful: the provider receives them in sequence and the
  // prompt names Image 1 and Image 2, so [A,B] and [B,A] are distinct edits.
  await withImageFixture(async ({ userId, refId }) => {
    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(String(init?.body || ''));
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const { runTool } = await import('../src/services/tools-service.js');
      const { saveImageBuffer } = await import('../src/media/image-storage.js');
      const other = await saveImageBuffer(userId, Buffer.from(TINY_PNG, 'base64'));
      const ctx = {
        user: { id: userId },
        chat: { id: 'e'.repeat(16), lastImageId: null },
        turnId: 'f'.repeat(16),
        options: {},
        userText: '把两张图合成一张',
        emit: () => {},
        turnImages: [],
        models: { llm: {}, image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' } },
      };
      const args = (ids) => ({ prompt: 'blend the two references into one poster', reference_image_ids: ids });

      await runTool('edit_image', args([refId, other.id]), ctx);
      assert.equal(bodies.length, 1, 'the first order reaches the provider');

      await runTool('edit_image', args([other.id, refId]), ctx);
      assert.equal(bodies.length, 2, 'reversed references are a new edit, not a repeat');

      ctx.toolRound = 1;
      await runTool('edit_image', args([other.id, refId]), ctx);
      assert.equal(bodies.length, 2, 'an exact repeat of that order is reused');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
