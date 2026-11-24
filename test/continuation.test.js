import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every case here asserts on the persisted assistant message, not on a local
// buffer: a continuation that looks right in flight but loses a segment before
// the write is exactly the bug these tests exist to catch.

async function setup(t, handler) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-cont-'));
  process.env.DATA_DIR = dataDir;

  const [{ initDb, closeDb }, chatService, turnService] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/services/chat-service.js'),
    import('../src/services/chat-turn-service.js'),
  ]);
  initDb(dataDir);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    requests.push(body);
    return handler(body, requests.length);
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  const userId = 'cont-user';
  const chat = chatService.newChatForUser(userId);
  return { userId, chat, chatService, turnService, requests };
}

function sse(text, finishReason, usage = { prompt_tokens: 5, completion_tokens: 5 }) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function models() {
  return { llm: { apiKey: 'mock', baseUrl: 'http://mock', model: 'mock', protocol: 'openai' } };
}

async function runTurn(t, handler) {
  const ctx = await setup(t, handler);
  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '写一份很长的汇报',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'cont-turn',
    },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });
  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  return { text: assistant?.content || '', assistant, events, requests: ctx.requests };
}

const A = '第一段：2026 年完成一期主体封顶，累计完成投资 1.79 亿元。';
const B = '第二段：2027 年计划二三期开工，年度投资 2.45 亿元。';
const C = '第三段：需甲方在 Q1 前确认总平面与红线调整方案。';

test('a truncated answer is continued and persisted whole', async (t) => {
  const { text, requests } = await runTurn(t, (body, n) => {
    const isContinue = /从断掉的地方继续/.test(String(body.messages.at(-1)?.content || ''));
    if (!isContinue) return sse(A, 'length');
    if (n === 2) return sse(B, 'length');
    return sse(C, 'stop');
  });

  assert.equal(requests.length, 3, 'two continuations were requested');
  assert.equal(text, `${A}${B}${C}`, 'every segment reached the saved message');
  assert.ok(!/到达上限/.test(text), 'a complete answer carries no cut notice');
});

test('the continuation prompt asks for the remainder without replaying', async (t) => {
  const { requests } = await runTurn(t, (body) => {
    const last = String(body.messages.at(-1)?.content || '');
    return /从断掉的地方继续/.test(last) ? sse(B, 'stop') : sse(A, 'length');
  });
  const second = requests[1];
  const instruction = String(second.messages.at(-1).content);
  assert.match(instruction, /不要重复已经输出的内容/);
  assert.match(instruction, /不要重新开头/);
});

test('when the budget runs out, every segment is kept and the cut is reported', async (t) => {
  let n = 0;
  const { text, requests } = await runTurn(t, () => {
    n += 1;
    return sse(`第${n}段内容：` + '甲'.repeat(30), 'length');
  });

  assert.equal(requests.length, 4, 'first attempt plus three continuations');
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(text.includes(`第${index}段内容`), `segment ${index} was lost`);
  }
  assert.match(text, /已自动续写 3 段后到达上限/);
  assert.match(text, /如需更多请回复「继续」/);
});

test('a repeated continuation is dropped, not appended, and still saved', async (t) => {
  const { text } = await runTurn(t, () => sse(A, 'length'));
  assert.equal(text.split(A).length - 1, 1, 'the same paragraph appears once');
  assert.match(text, /模型再次输出相同内容/);
});

test('a failing continuation keeps what was already accepted', async (t) => {
  const { text, requests } = await runTurn(t, (body) => {
    const isContinue = /从断掉的地方继续/.test(String(body.messages.at(-1)?.content || ''));
    if (!isContinue) return sse(A, 'length');
    return new Response(JSON.stringify({ error: { message: 'upstream failed' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.ok(requests.length >= 2, 'a continuation was attempted');
  assert.ok(text.startsWith(A), 'the accepted first segment survived the failure');
  assert.match(text, /500/, 'the real provider status is reported');
  assert.ok(!/网络错误/.test(text), 'a provider error is not disguised as a network problem');
});

test('an answer that fits is returned untouched', async (t) => {
  const { text, requests } = await runTurn(t, () => sse('短回复。', 'stop'));
  assert.equal(requests.length, 1);
  assert.equal(text, '短回复。');
});
test('an empty reply that hit the limit is retried, not surfaced as an apology', async (t) => {
  // Measured live: a reasoning-heavy provider spent the whole budget before
  // emitting any visible text and reported finish_reason length with 0 chars.
  const { text, requests } = await runTurn(t, (body, n) => {
    if (n === 1) return sse('', 'length');
    // The retry must be the one that carries thinking-disabled instructions.
    return sse(A, 'stop');
  });

  assert.equal(requests.length, 2, 'the empty attempt was retried');
  assert.equal(text, A, 'the retry produced the answer');
});

test('an empty retry reports exhaustion instead of inventing a reply', async (t) => {
  const { text, requests } = await runTurn(t, () => sse('', 'length'));
  assert.equal(requests.length, 2, 'exactly one retry, no loop');
  assert.match(text, /内容较长|如需更多/, 'the user is told the output ran out');
  assert.ok(!/我没有理解你的需求/.test(text), 'not disguised as a misunderstanding');
});

test('a continuation that comes back empty keeps the prefix and reports it', async (t) => {
  const { text } = await runTurn(t, (body, n) => {
    if (n === 1) return sse(A, 'length');
    return sse('', 'length');
  });
  assert.ok(text.startsWith(A), 'the accepted first segment is still there');
  assert.match(text, /内容较长|如需更多/, 'the cut is reported');
});

test('a tool call cut off by the token limit is never executed', async (t) => {
  // The payload is valid JSON up to the cut, so parsing it as {} would run
  // create_document with no format — producing a Word file for a deck request.
  const ctx = await setup(t, (body, n) => {
    if (n === 1) {
      // Arguments truncated mid-key, with finish_reason 'length'.
      const body1 = [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'create_document', arguments: '{"format":"pptx","vis' },
                  },
                ],
              },
            },
          ],
        })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(body1, { headers: { 'content-type': 'text/event-stream' } });
    }
    return sse('已重新生成。', 'stop');
  });

  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '做成 PPT',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'truncated-tool',
    },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });

  // No document was created: the tool was refused, not run with defaults.
  assert.equal(events.filter((event) => event.type === 'document').length, 0);
  // The model was told why and asked to retry.
  const retryNotice = events.find(
    (event) => event.type === 'status' && /参数被截断/.test(event.text || ''),
  );
  assert.ok(retryNotice, 'the truncation is surfaced as a status');
  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.content, '已重新生成。');
});

test('unparseable tool arguments do not run the tool', async (t) => {
  const ctx = await setup(t, (body, n) => {
    if (n === 1) {
      const body1 = [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_bad',
                    type: 'function',
                    function: { name: 'create_document', arguments: 'not json at all' },
                  },
                ],
              },
            },
          ],
        })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(body1, { headers: { 'content-type': 'text/event-stream' } });
    }
    return sse('抱歉，请重试。', 'stop');
  });

  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '做成 PPT',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'bad-args',
    },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
  });

  assert.equal(events.filter((event) => event.type === 'document').length, 0);
  // The model is told the arguments were unusable, not handed a tool error
  // from executing with null — that feedback is what makes it retry properly.
  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.content, '抱歉，请重试。');
});

test('parseArgs reports unusable payloads instead of inventing an empty object', async () => {
  const { parseArgs } = await import('../src/shared/utils.js');
  // A truncated call must be distinguishable from "no arguments", or the
  // caller cannot refuse it and will run the tool with defaults.
  assert.equal(parseArgs('{"format":"pptx","vis'), null, 'truncated JSON is not {}');
  assert.equal(parseArgs('not json'), null);
  assert.equal(parseArgs('null'), null, 'JSON null is not an argument object');
  assert.equal(parseArgs('[1,2]'), null, 'an array is not an argument object');
  // Genuinely absent arguments are still allowed and mean "no parameters".
  assert.deepEqual(parseArgs(''), {});
  assert.deepEqual(parseArgs('{}'), {});
  assert.deepEqual(parseArgs('{"format":"pptx"}'), { format: 'pptx' });
});

test('an abort right after a retry reset keeps the committed prefix', async (t) => {
  // The exact failure this guards: text streams, a retry resets the visible
  // buffer, then the user aborts before the retry produces anything. The draft
  // must still hold what was already accepted instead of being deleted.
  const accepted = '已完成的段落：2026 年一期主体封顶。';
  let abortNow = null;
  const controller = new AbortController();

  const ctx = await setup(t, (body, n) => {
    if (n === 1) {
      // First segment streams fully, then the connection drops mid-answer so
      // the transport retries — which is what emits the reset.
      const first = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: accepted } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(first, { headers: { 'content-type': 'text/event-stream' } });
    }
    // The continuation never yields text: abort from inside the handler.
    if (abortNow) abortNow();
    return new Response('', { headers: { 'content-type': 'text/event-stream' } });
  });

  abortNow = () => controller.abort();

  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '写一份长汇报',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'abort-after-reset',
    },
    emit: (event) => events.push(event),
    signal: controller.signal,
  });

  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant, 'the turn was not deleted');
  assert.ok(
    String(assistant.content).includes(accepted),
    `the accepted paragraph survived the reset and abort, got: ${JSON.stringify(
      assistant?.content,
    )}`,
  );
});

test('a retry reset carries the committed text instead of blanking it', async (t) => {
  const accepted = '第一段已经完成的内容，长度足够用于校验。';
  let resets = 0;

  const ctx = await setup(t, (body, n) => {
    if (n === 1) {
      // Stream text, then end the body without a terminal event: the client
      // sees a dropped connection and the transport retries, which is the only
      // path that emits a reset.
      const partial = `data: ${JSON.stringify({
        choices: [{ delta: { content: accepted } }],
      })}\n\n`;
      return new Response(partial, { headers: { 'content-type': 'text/event-stream' } });
    }
    return sse('第二段。', 'stop');
  });

  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '写汇报',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'reset-shape',
    },
    emit: (event) => {
      events.push(event);
      if (event.type === 'reset') resets += 1;
    },
    signal: new AbortController().signal,
  });

  assert.ok(resets > 0, 'a dropped stream triggers the reset path');
  const reset = events.find((event) => event.type === 'reset');
  // On the first attempt nothing is committed yet, so the reset legitimately
  // carries an empty prefix: the retry re-sends the whole attempt. What must
  // hold is that the field exists and the answer is not lost.
  assert.equal(typeof reset.committed, 'string', 'the reset always carries the field');
  assert.ok(!reset.keep, 'a retry reset is not a process promotion');

  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.ok(
    assistant.content.includes('第二段。'),
    'the retried attempt produced the answer',
  );
});

test('an abort during a continuation retry keeps the already-appended segment', async (t) => {
  // Real sequence: segment 1 completes and is appended to `text`; the
  // continuation request starts, streams a little, then the transport retries
  // and emits a reset carrying `text` (= segment 1). The user aborts before the
  // retry delivers. Segment 1 must still be the saved answer.
  const SEG1 = '第一段：2026 年完成一期主体封顶，累计投资 1.79 亿元。';
  const controller = new AbortController();
  let calls = 0;

  const ctx = await setup(t, () => {
    calls += 1;
    if (calls === 1) return sse(SEG1, 'length');
    if (calls === 2) {
      // Stream a fragment, then die without a terminal frame -> reset + retry.
      const partial = `data: ${JSON.stringify({
        choices: [{ delta: { content: '第二段未完成' } }],
      })}\n\n`;
      return new Response(partial, { headers: { 'content-type': 'text/event-stream' } });
    }
    // The retry: abort from inside so runPreparedTurn takes the abort path.
    controller.abort();
    return new Response('', { headers: { 'content-type': 'text/event-stream' } });
  });

  const events = [];
  await ctx.turnService.runPreparedTurn({
    user: { id: ctx.userId },
    prepared: {
      message: '写长汇报',
      models: models(),
      chat: ctx.chat,
      isNew: true,
      references: [],
      attachments: [],
      options: {},
      turnId: 'abort-cont',
    },
    emit: (event) => events.push(event),
    signal: controller.signal,
  });

  assert.ok(
    events.some((event) => event.type === 'reset' && event.committed === SEG1),
    'the reset carried the committed first segment',
  );

  const saved = ctx.chatService.loadChatForUser(ctx.userId, ctx.chat.id);
  const assistant = saved.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant, 'the turn was not deleted on abort');
  assert.ok(
    String(assistant.content).includes(SEG1),
    `segment 1 survived, got: ${JSON.stringify(assistant?.content)}`,
  );
});
