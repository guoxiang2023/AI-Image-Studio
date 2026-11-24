import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The chat model used to receive only the string "image_id=…" for a reference
// image, so "what is in this picture" could not be answered at all. These tests
// pin the two halves: history carries the ids, and the agent turns them into
// real image blocks.

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nU8AAAAASUVORK5CYII=';

// Each case gets its OWN user id. USERS_DIR is fixed at config import time, so
// a per-case DATA_DIR does not isolate anything: two concurrent cases that
// reuse an id write and delete the same directory, and one case's cleanup
// removes the other's fixture mid-run.
async function withUserImages(userId, fn) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-vision-'));
  process.env.DATA_DIR = dataDir;
  const { initDb, closeDb } = await import('../src/data/database.js');
  initDb(dataDir);
  const { userImageDir } = await import('../src/media/image-storage.js');
  await mkdir(userImageDir(userId), { recursive: true });
  try {
    return await fn({ userId });
  } finally {
    closeDb();
    await rm(userImageDir(userId), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('history carries reference ids without reading pixels', async () => {
  const { toLlmHistory } = await import('../src/domain/chat.js');
  const history = toLlmHistory({
    messages: [
      {
        role: 'user',
        content: '这张图是什么颜色？',
        references: [{ id: 'c'.repeat(16), role: '参考' }],
      },
    ],
  });
  assert.equal(history.length, 1);
  // Text still names the image, so the model can refer to it even when the
  // pixels are not attached (older messages, unreadable files).
  assert.match(history[0].content, /image_id=c+/);
  assert.deepEqual(history[0].imageIds, ['c'.repeat(16)]);
  // The domain layer must stay synchronous and IO-free.
  assert.equal(typeof history[0].content, 'string');
});

test('the agent expands the newest user message into image blocks', async () => {
  await withUserImages('user-1111111111111111', async ({ userId }) => {
    const { imageDataUrl } = await import('../src/media/image-storage.js');
    const { attachReferenceImages } = await import('../src/services/agent-service.js');
    const { userImageDir } = await import('../src/media/image-storage.js');
    const id = 'd'.repeat(16);
    const olderId = 'e'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));
    // The older row points at a REAL image too, so "only the newest is
    // expanded" is a real constraint and not an artefact of a missing file.
    await writeFile(path.join(userImageDir(userId), `${olderId}.png`), Buffer.from(TINY_PNG, 'base64'));

    // Sanity: the reader produces a data URI, not a server-local path a
    // provider could never fetch.
    const url = await imageDataUrl(userId, id);
    assert.match(url, /^data:image\/png;base64,/);

    const history = [
      { role: 'user', content: '旧消息', imageIds: [olderId] },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '这张图是什么颜色？', imageIds: [id] },
    ];
    const out = await attachReferenceImages(history, userId);
    const last = out[out.length - 1];
    assert.ok(Array.isArray(last.content), 'the newest user message becomes multimodal');
    assert.equal(last.content[0].type, 'text');
    assert.equal(last.content[0].text, '这张图是什么颜色？');
    assert.equal(last.content[1].type, 'image_url');
    assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
    // Only the newest message is expanded: older images would be re-sent and
    // re-billed on every turn. Both old rows must stay textual even though one
    // of them references a real image id.
    assert.equal(typeof out[0].content, 'string', 'an older user row stays text');
    assert.equal(typeof out[1].content, 'string', 'an assistant row stays text');
  });
});

test('an unreadable image degrades to text instead of failing the turn', async () => {
  await withUserImages('user-2222222222222222', async ({ userId }) => {
    const { toLlmHistory } = await import('../src/domain/chat.js');
    const { attachReferenceImages } = await import('../src/services/agent-service.js');
    // Build through the real history layer so the degraded text is the one the
    // model would actually see, not a hand-made row.
    const history = toLlmHistory({
      messages: [
        { role: 'user', content: '看看这张', references: [{ id: 'f'.repeat(16), role: '参考' }] },
      ],
    });
    const out = await attachReferenceImages(history, userId);
    // A deleted or corrupt file must not throw and must not silently drop the
    // message: the model keeps the text and the id it always had.
    assert.equal(typeof out[0].content, 'string');
    assert.match(out[0].content, /image_id=f+/);
  });
});

test('an svg reference is not sent as pixels', async () => {
  await withUserImages('user-3333333333333333', async ({ userId }) => {
    const { imageDataUrl, userImageDir } = await import('../src/media/image-storage.js');
    const id = 'a'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal(await imageDataUrl(userId, id), null, 'chat endpoints take bitmaps only');
  });
});

test('anthropic conversion turns the image block into base64 source', async () => {
  const { toAnthropicMessages } = await import('../src/ai/anthropic.js');
  const converted = toAnthropicMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    },
  ]);
  const parts = converted.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image');
  assert.equal(parts[1].source.type, 'base64');
  assert.equal(parts[1].source.media_type, 'image/png');
  assert.equal(parts[1].source.data, 'iVBORw0KGgo=');
});

test('runAgent sends the reference image to the model as pixels', async () => {
  // The wiring test: attachReferenceImages can be correct in isolation while
  // runAgent never calls it. Assert on what actually reaches the provider.
  await withUserImages('user-4444444444444444', async ({ userId }) => {
    const { userImageDir } = await import('../src/media/image-storage.js');
    const id = 'b'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));

    const originalFetch = globalThis.fetch;
    let sentBody = null;
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '红色' } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    try {
      const { runAgent } = await import('../src/services/agent-service.js');
      await runAgent({
        user: { id: userId },
        chat: {
          id: 'c'.repeat(24),
          summary: '',
          messages: [
            { role: 'user', content: '这张图是什么颜色？', references: [{ id, role: '参考' }] },
          ],
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
    } finally {
      globalThis.fetch = originalFetch;
    }

    const userMessage = sentBody.messages.find((message) => message.role === 'user');
    assert.ok(Array.isArray(userMessage.content), 'the user message carries structured parts');
    const imagePart = userMessage.content.find((part) => part.type === 'image_url');
    assert.ok(imagePart, 'an image block reached the provider');
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
    // The text is preserved alongside the pixels.
    const textPart = userMessage.content.find((part) => part.type === 'text');
    assert.match(textPart.text, /这张图是什么颜色/);
  });
});

test('a later text-only turn does not re-upload an older image', async () => {
  // Stated behaviour: only the newest USER message is expanded. Selecting the
  // newest row that happens to carry ids uploads a stale image on every later
  // turn, re-billing it and showing the model a picture nobody asked about.
  await withUserImages('user-5555555555555555', async ({ userId }) => {
    const { toLlmHistory } = await import('../src/domain/chat.js');
    const { attachReferenceImages } = await import('../src/services/agent-service.js');
    const { userImageDir } = await import('../src/media/image-storage.js');
    const id = 'a'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));

    const history = toLlmHistory({
      messages: [
        { role: 'user', content: '这张图是什么？', references: [{ id, role: '参考' }] },
        { role: 'assistant', content: '是一只猫。' },
        // Newest user turn is text only: it must not inherit the old image.
        { role: 'user', content: '谢谢，再讲讲别的。' },
      ],
    });
    const out = await attachReferenceImages(history, userId);
    assert.equal(
      typeof out[out.length - 1].content,
      'string',
      'the newest text-only turn stays text',
    );
    const hasImage = out.some(
      (row) => Array.isArray(row.content) && row.content.some((part) => part.type === 'image_url'),
    );
    assert.equal(hasImage, false, 'no stale image is uploaded');
  });
});

test('the internal imageIds field never reaches the provider', async () => {
  // rows carry imageIds for the assembly step; leaving it on outbound rows
  // sends an unknown field to the chat endpoint.
  await withUserImages('user-6666666666666666', async ({ userId }) => {
    const { toLlmHistory } = await import('../src/domain/chat.js');
    const { attachReferenceImages } = await import('../src/services/agent-service.js');
    const history = toLlmHistory({
      messages: [
        { role: 'user', content: '第一轮', references: [{ id: 'b'.repeat(16), role: '参考' }] },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '第三轮' },
      ],
    });
    const out = await attachReferenceImages(history, userId);
    for (const row of out) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, 'imageIds'),
        false,
        `imageIds leaked on a ${row.role} row`,
      );
    }
  });
});

// --- same-turn artifact inspection -------------------------------------------
// A model that cannot see what it just produced can only guess whether the
// picture matches the request. These tests cover passing its own output back.

test('generated images never ride inside a tool message', async () => {
  // OpenAI Chat Completions accepts only string/text parts in role:'tool'.
  // Putting image_url there is an invalid request, so the pictures are attached
  // as a separate user message after the batch instead.
  await withUserImages('user-7777777777777777', async ({ userId }) => {
    const { userImageDir } = await import('../src/media/image-storage.js');
    const { appendImageObservation, collectResultImages } = await import(
      '../src/services/agent-service.js'
    );
    const id = '7'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));

    const messages = [
      { role: 'user', content: '画一只猫' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'generate_image', arguments: '{}' } }] },
    ];
    const produced = [];
    collectResultImages({ ok: true, images: [{ image_id: id }] }, produced);
    messages.push({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true }) });
    await appendImageObservation(messages, produced, userId);

    // Every tool reply is text: that is what the provider requires.
    for (const message of messages.filter((m) => m.role === 'tool')) {
      assert.equal(typeof message.content, 'string');
    }

    const observation = messages[messages.length - 1];
    assert.equal(observation.role, 'user', 'pictures come in a user message');
    assert.ok(Array.isArray(observation.content));
    assert.equal(observation.content[0].type, 'text');
    assert.match(observation.content[0].text, new RegExp(id), 'the text ties the picture to its id');
    assert.equal(observation.content[1].type, 'image_url');
    assert.match(observation.content[1].image_url.url, /^data:image\/png;base64,/);
  });
});

test('collectResultImages caps the batch and skips unusable entries', async () => {
  const { collectResultImages } = await import('../src/services/agent-service.js');
  const into = [];
  collectResultImages(
    { images: [{ image_id: 'a1' }, { image_id: 'b2' }, { image_id: 'c3' }, {}] },
    into,
  );
  assert.deepEqual(into, ['a1', 'b2'], 'at most two pictures per result');
  collectResultImages({ images: [{ image_id: 'd4' }] }, into);
  assert.deepEqual(into, ['a1', 'b2'], 'the cap holds across the batch');
  collectResultImages({ error: 'nope' }, into);
  assert.deepEqual(into, ['a1', 'b2'], 'a failed tool contributes nothing');
});

test('an observation with no readable picture is not appended', async () => {
  await withUserImages('user-8888888888888888', async ({ userId }) => {
    const { appendImageObservation } = await import('../src/services/agent-service.js');
    const messages = [];
    await appendImageObservation(messages, ['9'.repeat(16)], userId);
    // An empty user message would be an invalid request.
    assert.equal(messages.length, 0);
  });
});

test('anthropic keeps image blocks inside tool_result content', async () => {
  const { toAnthropicMessages } = await import('../src/ai/anthropic.js');
  const out = toAnthropicMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call1', function: { name: 'generate_image', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'call1',
      content: [
        { type: 'text', text: '{"ok":true,"images":[{"image_id":"abc"}]}' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ]);
  const result = out.messages[1].content[0];
  assert.equal(result.type, 'tool_result');
  assert.ok(Array.isArray(result.content), 'the block list is preserved, not flattened');
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].source.media_type, 'image/png');
  assert.equal(result.content[1].source.data, 'AAAA');
});

test('a text-only tool result still becomes a string', async () => {
  const { toAnthropicMessages } = await import('../src/ai/anthropic.js');
  const out = toAnthropicMessages([
    { role: 'tool', tool_call_id: 'call1', content: '{"error":"nope"}' },
  ]);
  assert.equal(out.messages[0].content[0].content, '{"error":"nope"}');
});

test('a provider that rejects images is retried as text instead of failing', async () => {
  // Sending the model its own output must never cost the turn: if the endpoint
  // refuses image input, the conversation is retried with the images stripped.
  await withUserImages('user-aaaaaaaaaaaaaaa1', async ({ userId }) => {
    const { userImageDir } = await import('../src/media/image-storage.js');
    const id = 'a'.repeat(16);
    await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));

    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasImage = JSON.stringify(body).includes('image_url') ||
        JSON.stringify(body).includes('"image"');
      if (hasImage) {
        // What a text-only model does with image input.
        return new Response(
          JSON.stringify({ error: { message: 'this model does not support image input' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '按文字继续：画好了。' } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
          'data: [DONE]', '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const statuses = [];
    try {
      const { runAgent } = await import('../src/services/agent-service.js');
      const out = await runAgent({
        user: { id: userId },
        chat: {
          id: 'c'.repeat(24), summary: '',
          messages: [{
            role: 'user', content: '改一下这张图',
            references: [{ id, role: '参考' }],
          }],
        },
        models: {
          llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub' },
          image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' },
        },
        options: {}, turnId: 't', turnImages: [],
        emit: (event) => { if (event.type === 'status') statuses.push(event.text); },
      });
      assert.match(out.text, /画好了/);
      assert.ok(
        statuses.some((s) => /不支持图片输入/.test(s)),
        'the downgrade is reported, not silent',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The retry must actually be image-free.
    const retried = bodies[bodies.length - 1];
    assert.doesNotMatch(JSON.stringify(retried), /image_url/);
  });
});

test('runAgent sends a legal body on both protocols after generating an image', async () => {
  // The regression this guards: OpenAI rejects image blocks inside role:'tool'
  // content, and llm.js forwards messages unchanged. Verified on the actual
  // request body for each protocol, not on an intermediate structure.
  for (const protocol of ['openai', 'anthropic']) {
    await withUserImages(`user-${protocol === 'openai' ? 'b1' : 'b2'}${'0'.repeat(14)}`, async ({ userId }) => {
      const { userImageDir } = await import('../src/media/image-storage.js');
      const id = 'a'.repeat(16);
      await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));

      const originalFetch = globalThis.fetch;
      let modelCalls = 0;
      let secondBody = null;
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        // Only intercept the chat endpoint; the image host stays dead so the
        // tool result is deterministic.
        if (!/chat\/completions|\/messages/.test(target)) {
          return originalFetch(url, init);
        }
        modelCalls += 1;
        const body = JSON.parse(init.body);
        if (modelCalls === 1) {
          // The tool-call round also streams: streamChatCompletion is SSE for
          // both protocols, so a JSON body would not be parsed.
          if (protocol === 'anthropic') {
            return new Response(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call1","name":"generate_image","input":{"prompt":"a cat"}}}\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ].join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return new Response(
            [
              `data: ${JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0, id: 'call1', type: 'function',
                      function: { name: 'generate_image', arguments: '{"prompt":"a cat"}' },
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
        secondBody = body;
        if (protocol === 'anthropic') {
          return new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好了"}}\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n',
            ].join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: '好了' } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      };

      try {
        const { runAgent } = await import('../src/services/agent-service.js');
        await runAgent({
          user: { id: userId },
          chat: {
            id: 'c'.repeat(24),
            summary: '',
            messages: [{ role: 'user', content: '画一只猫' }],
          },
          models: {
            llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub', protocol },
            // A dead host: the tool reports an error, so no picture is produced.
            image: { model: 'gpt-image-1', apiKey: 'bad', baseUrl: 'http://127.0.0.1:1' },
          },
          options: {},
          turnId: 't',
          turnImages: [],
          emit: () => {},
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.ok(secondBody, `${protocol}: the follow-up request was sent`);
      // Whatever the tool returned, a tool reply must never carry image blocks.
      for (const message of secondBody.messages) {
        if (message.role === 'tool') {
          assert.equal(
            typeof message.content,
            'string',
            `${protocol}: tool content must stay a string`,
          );
        }
        if (Array.isArray(message.content)) {
          const isToolResult = message.content.some((part) => part.type === 'tool_result');
          if (isToolResult) {
            for (const block of message.content.filter((part) => part.type === 'tool_result')) {
              assert.equal(
                typeof block.content,
                'string',
                `${protocol}: an image-free tool result must stay a string`,
              );
            }
          }
        }
      }
    });
  }
});

test('both protocols carry generated pictures in a user message, not a tool reply', async () => {
  // The decisive case: the tool DOES produce an image. Whatever protocol, the
  // picture must arrive as a user-role observation after the batch, and no tool
  // message may contain image blocks.
  for (const protocol of ['openai', 'anthropic']) {
    await withUserImages(`user-${protocol === 'openai' ? 'c1' : 'c2'}${'0'.repeat(14)}`, async ({ userId }) => {
      const { userImageDir, imageDataUrl } = await import('../src/media/image-storage.js');
      const { appendImageObservation, collectResultImages } = await import(
        '../src/services/agent-service.js'
      );
      const id = 'e'.repeat(16);
      await writeFile(path.join(userImageDir(userId), `${id}.png`), Buffer.from(TINY_PNG, 'base64'));
      assert.match(await imageDataUrl(userId, id), /^data:image/, 'fixture is readable');

      // Rebuild exactly the message list the loop builds for a successful tool.
      const produced = [];
      const messages = [
        { role: 'user', content: '画一只猫' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call1', function: { name: 'generate_image', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call1',
          content: JSON.stringify({ ok: true, images: [{ image_id: id }] }),
        },
      ];
      collectResultImages({ ok: true, images: [{ image_id: id }] }, produced);
      await appendImageObservation(messages, produced, userId);

      const outbound =
        protocol === 'anthropic'
          ? (await import('../src/ai/anthropic.js')).toAnthropicMessages(messages).messages
          : messages;

      // 1. No tool reply carries a picture, on either protocol.
      for (const message of outbound) {
        if (message.role === 'tool') {
          assert.equal(typeof message.content, 'string');
          assert.doesNotMatch(JSON.stringify(message.content), /image_url/);
        }
        if (Array.isArray(message.content)) {
          for (const part of message.content.filter((p) => p.type === 'tool_result')) {
            assert.equal(typeof part.content, 'string', 'tool_result stays text');
          }
        }
      }

      // 2. The picture is present, in a user-role message.
      const flattened = JSON.stringify(outbound);
      assert.match(flattened, /image_url|"type":"image"/, 'the picture reached the request');
      const carrier = outbound.filter(
        (m) => m.role === 'user' && Array.isArray(m.content) &&
          m.content.some((p) => p.type === 'image' || p.type === 'image_url'),
      );
      assert.equal(carrier.length, 1, 'exactly one user message carries the picture');
    });
  }
});

test('runAgent reports generated pictures as a user message on both protocols', async () => {
  // True end-to-end: the image tool SUCCEEDS, so the loop really produces a
  // picture. This is the case the placement rule exists for, and the only one
  // that can catch images being put back inside a tool reply.
  for (const protocol of ['openai', 'anthropic']) {
    await withUserImages(`user-${protocol === 'openai' ? 'd1' : 'd2'}${'0'.repeat(14)}`, async ({ userId }) => {
      const originalFetch = globalThis.fetch;
      let modelCalls = 0;
      let followUp = null;
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        if (/\/images\/generations|\/images\/edits/.test(target)) {
          return new Response(
            JSON.stringify({ data: [{ b64_json: TINY_PNG }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        modelCalls += 1;
        if (modelCalls === 1) {
          if (protocol === 'anthropic') {
            return new Response(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call1","name":"generate_image","input":{"prompt":"a cat"}}}\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ].join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return new Response(
            [
              `data: ${JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0, id: 'call1', type: 'function',
                      function: { name: 'generate_image', arguments: '{"prompt":"a cat"}' },
                    }],
                  },
                }],
              })}`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
              'data: [DONE]', '',
            ].join('\n\n'),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        followUp = JSON.parse(init.body);
        if (protocol === 'anthropic') {
          return new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"画好了"}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: '画好了' } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
            'data: [DONE]', '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      };

      try {
        const { runAgent } = await import('../src/services/agent-service.js');
        await runAgent({
          user: { id: userId },
          chat: { id: 'c'.repeat(24), summary: '', messages: [{ role: 'user', content: '画一只猫' }] },
          models: {
            llm: { apiKey: 'k', baseUrl: 'http://stub', model: 'stub', protocol },
            image: { model: 'gpt-image-1', apiKey: 'k', baseUrl: 'http://stub' },
          },
          options: {}, turnId: 't', turnImages: [], emit: () => {},
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.ok(followUp, `${protocol}: the follow-up request was sent`);
      // A tool reply must never carry image blocks on either protocol.
      for (const message of followUp.messages) {
        if (message.role === 'tool') {
          assert.equal(typeof message.content, 'string', `${protocol}: tool content stays a string`);
          assert.doesNotMatch(String(message.content), /image_url/);
        }
        if (Array.isArray(message.content)) {
          for (const part of message.content.filter((p) => p.type === 'tool_result')) {
            assert.equal(typeof part.content, 'string', `${protocol}: tool_result stays text`);
          }
        }
      }
      // And the picture is present, carried by a user message.
      const carrier = followUp.messages.filter(
        (m) => m.role === 'user' && Array.isArray(m.content) &&
          m.content.some((p) => p.type === 'image' || p.type === 'image_url'),
      );
      assert.equal(carrier.length, 1, `${protocol}: one user message carries the picture`);
    });
  }
});
