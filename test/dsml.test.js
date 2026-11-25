import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { closeDb, initDb } from '../src/data/database.js';
import { DsmlStream, splitDsmlText } from '../src/ai/dsml.js';

// The exact bytes from the bug report, pulled out of the desktop chat store. The
// gateway writes the name with a SPACE after the bar run (`<｜｜DSML｜｜ calls>`), the
// bars are FULLWIDTH and doubled, and one query value contains a `|` of its own:
//   '<｜｜DSML｜｜ calls>'
//   '<｜｜DSML｜｜ invoke name="search_workspace">'
//   '<｜｜DSML｜｜ parameter name="query" string="true">^## </｜｜DSML｜｜ parameter>'
//   '<｜｜DSML｜｜ parameter name="max_results" string="false">40</｜｜DSML｜｜ parameter>'
//   '</｜｜DSML｜｜ invoke>'
//   ...
const B = '\uff5c\uff5c'; // two fullwidth vertical lines
const ENVELOPE = [
  `<${B}DSML${B} calls>`,
  `<${B}DSML${B} invoke name="search_workspace">`,
  `<${B}DSML${B} parameter name="query" string="true">^## </${B}DSML${B} parameter>`,
  `<${B}DSML${B} parameter name="max_results" string="false">40</${B}DSML${B} parameter>`,
  `</${B}DSML${B} invoke>`,
  `<${B}DSML${B} invoke name="search_workspace">`,
  `<${B}DSML${B} parameter name="query" string="true">\u505c\u6b62\u7ebf|M1|\u9a8c\u6536\u6807\u51c6</${B}DSML${B} parameter>`,
  `<${B}DSML${B} parameter name="max_results" string="false">30</${B}DSML${B} parameter>`,
  `</${B}DSML${B} invoke>`,
  `</${B}DSML${B} calls>`,
].join('\n');

// Verbatim from the desktop chat store (`app.db`, chat 408823bf…), the message
// that made 1.1.1 look broken. Kept byte-for-byte, in its own test, so any future
// change to the tag grammar has to keep parsing this exact string.
const REAL_WIRE = [
  '<\uff5c\uff5cDSML\uff5c\uff5c calls>',
  '<\uff5c\uff5cDSML\uff5c\uff5c invoke name="search_workspace">',
  '<\uff5c\uff5cDSML\uff5c\uff5c parameter name="query" string="true">^## </\uff5c\uff5cDSML\uff5c\uff5c parameter>',
  '<\uff5c\uff5cDSML\uff5c\uff5c parameter name="max_results" string="false">40</\uff5c\uff5cDSML\uff5c\uff5c parameter>',
  '</\uff5c\uff5cDSML\uff5c\uff5c invoke>',
  '<\uff5c\uff5cDSML\uff5c\uff5c invoke name="search_workspace">',
  '<\uff5c\uff5cDSML\uff5c\uff5c parameter name="query" string="true">\u505c\u6b62\u7ebf|\u91cc\u7a0b\u7891|M1|\u9a8c\u6536\u6807\u51c6|\u9644\u5f55 A</\uff5c\uff5cDSML\uff5c\uff5c parameter>',
  '<\uff5c\uff5cDSML\uff5c\uff5c parameter name="max_results" string="false">30</\uff5c\uff5cDSML\uff5c\uff5c parameter>',
  '</\uff5c\uff5cDSML\uff5c\uff5c invoke>',
  '</\uff5c\uff5cDSML\uff5c\uff5c calls>',
].join('\n');

test('the exact bytes that leaked in the 1.1.1 report parse', () => {
  const { text, calls } = splitDsmlText(REAL_WIRE);
  assert.equal(text, '', 'nothing visible');
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.function.arguments)),
    [
      { query: '^## ', max_results: 40 },
      { query: '停止线|里程碑|M1|验收标准|附录 A', max_results: 30 },
    ],
  );
});

test('the envelope from the bug report becomes calls', () => {
  const { text, calls } = splitDsmlText(`我先看一下代码库。\n${ENVELOPE}`);
  assert.equal(text.trim(), '我先看一下代码库。');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].function.name, 'search_workspace');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    query: '^## ',
    max_results: 40,
  });
  assert.deepEqual(JSON.parse(calls[1].function.arguments), {
    query: '停止线|M1|验收标准',
    max_results: 30,
  });
  assert.ok(calls.every((call) => call.id), 'every recovered call carries an id');
});

test('the space after the bar run is optional', () => {
  const tight = [
    `<${B}DSML${B}calls>`,
    `<${B}DSML${B}invoke name="a">`,
    `<${B}DSML${B}parameter name="q" string="true">x</${B}DSML${B}parameter>`,
    `</${B}DSML${B}invoke>`,
    `</${B}DSML${B}calls>`,
  ].join('');
  const r = splitDsmlText(tight);
  assert.equal(r.text, '');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { q: 'x' });
});

test('ASCII bars with and without the separator space decode too', () => {
  for (const env of [
    ['<||DSML|| calls>', '<||DSML|| invoke name="a">', '<||DSML|| parameter name="q" string="true">', '</||DSML|| parameter>', '</||DSML|| invoke>', '</||DSML|| calls>'],
    ['<|DSML| calls>', '<|DSML| invoke name="a">', '<|DSML| parameter name="q" string="true">', '</|DSML| parameter>', '</|DSML| invoke>', '</|DSML| calls>'],
  ]) {
    const markup = [env[0], env[1], env[2] + 'x' + env[3], env[4], env[5]].join('\n');
    const r = splitDsmlText(markup);
    assert.equal(r.text, '', `${env[0]} leaves no visible text`);
    assert.equal(r.calls.length, 1, `${env[0]} yields one call`);
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { q: 'x' });
  }
});

test('single-bar and fullwidth spellings decode identically', () => {
  const p = '\uff5c'; // FULLWIDTH VERTICAL LINE
  const variants = [
    '<|DSML|calls>', // single ASCII bar
    `<${p}DSML${p}calls>`, // fullwidth bar
    `<${p}${p}DSML${p}${p}calls>`, // doubled fullwidth bar
  ];
  for (const open of variants) {
    const bars = open.slice(1, open.indexOf('DSML'));
    const e = (closing, name, rest = '') =>
      `${closing ? '</' : '<'}${bars}DSML${bars}${name}${rest}>`;
    const markup = [
      open,
      e(false, 'invoke', ' name="edit_image"'),
      e(false, 'parameter', ' name="prompt" string="true"') + 'Change only the sky' + e(true, 'parameter'),
      e(false, 'parameter', ' name="count" string="false"') + '2' + e(true, 'parameter'),
      e(true, 'invoke'),
      e(true, 'calls'),
    ].join('');
    const { text, calls } = splitDsmlText(markup);
    assert.equal(text, '', `${open} leaves no visible text`);
    assert.equal(calls.length, 1, `${open} yields one call`);
    assert.equal(calls[0].function.name, 'edit_image');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      prompt: 'Change only the sky',
      count: 2,
    });
  }
});

// Every split point, not one hand-picked one.
test('a bare opener keeps the prose spacing whatever the chunking', () => {
  const src = 'A<||DSML||calls>hello world';
  const whole = new DsmlStream();
  const oneChunk = whole.push(src) + whole.flush();
  assert.equal(oneChunk, 'Ahello world');

  for (const chunks of [
    ['A<||DSML||calls>hello', ' ', 'world'],
    ['A<||DSML||calls>hello w', 'orld'],
    ['A<||DSML||calls>', 'hello', ' ', 'world'],
    ['A', '<||DSML||calls>', 'h', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'],
  ]) {
    const stream = new DsmlStream();
    let visible = '';
    for (const chunk of chunks) visible += stream.push(chunk);
    visible += stream.flush();
    assert.equal(visible, oneChunk, `chunks ${JSON.stringify(chunks)}`);
  }

  // And every single split point, which covers both boundary shapes at once.
  for (let cut = 0; cut <= src.length; cut += 1) {
    const stream = new DsmlStream();
    const visible =
      stream.push(src.slice(0, cut)) + stream.push(src.slice(cut)) + stream.flush();
    assert.equal(visible, oneChunk, `split at ${cut}`);
  }
});

// The old filter cleared its buffer when a closing tag arrived split across
// chunks, so `</||DS` + `ML||calls>` never popped the stack and the trailing
// prose was swallowed. Every split point must still render the same answer.
test('no split point leaks markup or eats trailing prose', () => {
  const full = `答案${ENVELOPE}结尾`;
  for (let cut = 0; cut <= full.length; cut += 1) {
    const stream = new DsmlStream();
    const visible = stream.push(full.slice(0, cut)) + stream.push(full.slice(cut)) + stream.flush();
    assert.equal(visible, '答案结尾', `split at ${cut} (${JSON.stringify(full.slice(cut, cut + 6))})`);
    const calls = stream.calls();
    assert.equal(calls.length, 2, `split at ${cut} recovers both calls`);
    assert.deepEqual(JSON.parse(calls[1].function.arguments), {
      query: '停止线|M1|验收标准',
      max_results: 30,
    });
  }

  // And byte by byte, the worst case a real socket can produce.
  const stream = new DsmlStream();
  let visible = '';
  for (const char of full) visible += stream.push(char);
  visible += stream.flush();
  assert.equal(visible, '答案结尾');
  assert.equal(stream.calls().length, 2);
});

// A truncated envelope must still be removed from the answer, but it must not
// produce a runnable call: the unclosed parameter would have swallowed the
// prose that follows, and the agent loop only checks that the arguments parse.
test('a truncated envelope is hidden but never dispatched', () => {
  const open = '<||DSML||';
  const close = '</||DSML||';

  // The parameter never closed, so everything after the opening tag is
  // indistinguishable from its body: it is withheld with the envelope.
  const unclosedParam = `前文${open}calls>${open}invoke name="a">${open}parameter name="q" string="true">x后文`;
  const a = splitDsmlText(unclosedParam);
  assert.equal(a.text, '前文');
  assert.equal(a.calls.length, 0);

  // Parameter closed but `</invoke>` missing: the answer after it is shown, yet
  // the call is still not runnable.
  const unclosedInvoke = `前文${open}calls>${open}invoke name="a">${open}parameter name="q" string="true">x${close}parameter>后文`;
  const b = splitDsmlText(unclosedInvoke);
  assert.equal(b.text, '前文后文');
  assert.equal(b.calls.length, 0);

  // The model merely explaining the format must be shown verbatim.
  const mention = `格式是 ${open}note>这样${close}note> 的。`;
  const c = splitDsmlText(mention);
  assert.equal(c.text, mention);
  assert.equal(c.calls.length, 0);
});

test('a well-formed envelope still yields its calls', () => {
  const open = '<||DSML||';
  const close = '</||DSML||';
  const good = `${open}calls>${open}invoke name="a">${open}parameter name="q" string="true">x${close}parameter>${close}invoke>${close}calls>`;
  const r = splitDsmlText(`前文${good}后文`);
  assert.equal(r.text, '前文后文');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { q: 'x' });
});

// A closed parameter is not proof the call is whole: the model can lose the
// rest of the arguments. Only `</invoke>` releases a call, so an invocation
// abandoned by the next opener must never run — but a following, properly
// closed one must.
test('only the invocation with its own close is dispatched', () => {
  const open = '<||DSML||';
  const close = '</||DSML||';
  const first = `${open}invoke name="read_workspace_file">${open}parameter name="file" string="true">a.js${close}parameter>`;
  const second = `${open}invoke name="search_workspace">${open}parameter name="query" string="true">ROWNUM${close}parameter>${close}invoke>${close}calls>`;
  const { text, calls } = splitDsmlText(`${open}calls>${first}${second}`);

  assert.equal(text, '');
  assert.equal(calls.length, 1, 'the abandoned invocation is dropped');
  assert.equal(calls[0].function.name, 'search_workspace');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { query: 'ROWNUM' });
});

test('two rounds of recovered calls never share an id', () => {
  const open = '<||DSML||';
  const close = '</||DSML||';
  const one = `${open}calls>${open}invoke name="a">${close}invoke>${open}invoke name="a">${close}invoke>${close}calls>`;
  const first = splitDsmlText(one).calls;
  const second = splitDsmlText(one).calls;
  const ids = [...first, ...second].map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique across rounds and within a batch');
});

test('the agent dispatches an envelope its provider sent as text', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-dsml-data-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      const reply =
        seen.length === 1
          ? { choices: [{ delta: { content: ENVELOPE }, finish_reason: 'stop' }] }
          : { choices: [{ delta: { content: '没有绑定工作目录，无法搜索。' } }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { runAgent } = await import('../src/services/agent-service.js');
    const deltas = [];
    const result = await runAgent({
      user: { id: 'c'.repeat(16) },
      chat: { id: 'd'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: 'test',
          apiKey: 'test',
        },
        image: {},
      },
      options: {},
      workspace: null,
      turnId: 'turn-dsml',
      userText: '这个查询在哪用过？',
      emit: (event) => {
        if (event.type === 'delta') deltas.push(event.text);
      },
      signal: undefined,
      turnImages: [],
    });

    assert.ok(
      deltas.every((delta) => !delta.includes('DSML')),
      'markup never reaches the screen',
    );
    assert.equal(result.text.trim(), '没有绑定工作目录，无法搜索。');

    const toolReply = seen[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolReply, 'the recovered call is dispatched and answered');
    const payload = JSON.parse(toolReply.content);
    assert.match(payload.error, /不支持工作目录|没有绑定工作目录/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The failing provider is Anthropic-protocol: its SSE frames carry the envelope
// as `text_delta`, so this path—not the OpenAI one—is the real regression.
test('an Anthropic-protocol stream delivers the envelope as text and still runs the tool', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-dsml-anthropic-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);

  // Cut the envelope at every fourth character, so the SSE deltas split tags,
  // closing tags and parameter bodies — the case the old filter got wrong.
  const chunks = [];
  for (let at = 0; at < ENVELOPE.length; at += 4) chunks.push(ENVELOPE.slice(at, at + 4));

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (seen.length === 1) {
        const delta = (text) =>
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          })}\n\n`;
        res.end(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            delta('我先看'),
            ...chunks.map(delta),
            delta('再看'),
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
        );
        return;
      }
      res.end(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"搜到了。"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { runAgent } = await import('../src/services/agent-service.js');
    const deltas = [];
    const result = await runAgent({
      user: { id: 'e'.repeat(16) },
      chat: { id: 'f'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: {
          baseUrl: `http://127.0.0.1:${server.address().port}/anthropic`,
          model: 'test',
          apiKey: 'test',
          protocol: 'anthropic',
        },
        image: {},
      },
      options: {},
      workspace: null,
      turnId: 'turn-dsml-anthropic',
      userText: '搜一下 ROWNUM',
      emit: (event) => {
        if (event.type === 'delta') deltas.push(event.text);
      },
      signal: undefined,
      turnImages: [],
    });

    assert.ok(deltas.every((delta) => !delta.includes('DSML')));
    // "再看" follows the closing `</||DSML||calls>`: losing it means the stack
    // never popped.
    assert.equal(result.process.trim(), '我先看再看');
    assert.equal(result.text.trim(), '搜到了。');

    const blocks = seen[1].messages.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool_result'),
    );
    assert.ok(blocks, 'the recovered call reaches the model as a tool_result');
    assert.equal(blocks.content.length, 2, 'both recovered calls are answered');
    assert.match(blocks.content[0].content, /没有绑定工作目录|不支持工作目录/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The turn that made the fix look broken: the model answers every round with an
// in-band call and never writes prose. On the final round the request carries no
// tools at all, so there is nothing left to dispatch — that round has to end the
// turn with an explanation instead of the generic "I did not understand you".
test('a turn that only ever emits calls still ends with a truthful message', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-dsml-loop-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);

  const requests = [];
  const rounds = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      rounds.push(Array.isArray(parsed.tools) ? parsed.tools.length : 0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: ENVELOPE }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { runAgent } = await import('../src/services/agent-service.js');
    const result = await runAgent({
      user: { id: 'a'.repeat(16) },
      chat: { id: 'b'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: 'test',
          apiKey: 'test',
        },
        image: {},
      },
      options: {},
      workspace: null,
      turnId: 'turn-loop',
      userText: '分析一下这个代码库',
      emit: () => {},
      signal: undefined,
      turnImages: [],
    });

    // The tool budget is spent, and from then on no request offers tools: the
    // in-loop final round plus the one bounded synthesis retry.
    assert.ok(rounds.length > 2, 'the loop dispatched tool rounds');
    const toolRounds = rounds.filter((count) => count > 0).length;
    assert.ok(toolRounds > 0 && toolRounds === rounds.length - 2, 'one tool-less round, then one retry');
    assert.ok(
      rounds.slice(0, toolRounds).every((count) => count > 0) &&
        rounds.slice(toolRounds).every((count) => count === 0),
      'tools stop being offered once the budget is spent',
    );
    // A call volunteered on the final round has no round left to run in, so the
    // tool must not execute it. The workspace is unbound here, so any dispatch
    // shows up as the refusal payload — counting those pairs proves none came
    // from the last round.
    const lastRequest = requests[requests.length - 1];
    const toolReplies = lastRequest.messages.filter((message) => message.role === 'tool');
    assert.equal(
      lastRequest.messages[lastRequest.messages.length - 1].role,
      'user',
      'the last request ends on the reminder, not on a tool reply',
    );
    assert.equal(
      toolReplies.length,
      2 * toolRounds,
      'exactly the rounds with budget dispatched; the tool-less ones did not',
    );
    // A dispatch on the tool-less round would still bump the counter, even though
    // its reply never reaches another request. The stated count is therefore the
    // only place that wasted call is observable.
    const stated = /调用了 (\d+) 次工具/.exec(result.text);
    assert.ok(stated, 'the fallback states how many calls ran');
    assert.equal(Number(stated[1]), toolRounds, 'the tool-less rounds ran nothing');

    // A turn that gathered results must not claim it misunderstood the question.
    assert.doesNotMatch(result.text, /没有理解你的需求/);
    assert.match(result.text, /调用了 \d+ 次工具/);
    assert.doesNotMatch(result.text, /DSML/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The synthesis retry is what makes a tool-heavy turn salvageable: the tool
// results never leave runAgent, so the answer has to be written in the same turn
// or not at all. A "continue" from the user starts from an empty history.
test('the budgets are spent, so the answer is synthesized in the same turn', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-dsml-synth-'));
  process.env.DATA_DIR = dataDir;
  initDb(dataDir);

  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      const offersTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      // Every tool round emits an envelope; the two tool-less rounds answer in
      // prose the second time, which is the case that must reach the user.
      const content = offersTools
        ? ENVELOPE
        : requests.length === 6
          ? ''
          : '根据检索到的代码，慢查询集中在报表 SQL 的跨周期扫描上。';
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { runAgent } = await import('../src/services/agent-service.js');
    const result = await runAgent({
      user: { id: 'a'.repeat(16) },
      chat: { id: 'b'.repeat(16), messages: [], summary: '', summaryUpto: 0 },
      models: {
        llm: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: 'test',
          apiKey: 'test',
        },
        image: {},
      },
      options: {},
      workspace: null,
      turnId: 'turn-synth',
      userText: '分析一下报表性能',
      emit: () => {},
      signal: undefined,
      turnImages: [],
    });

    // The retry exists and carried the observations along.
    assert.ok(requests.length >= 7, `expected a retry request, saw ${requests.length}`);
    const retry = requests[requests.length - 1];
    assert.equal(retry.tools, undefined, 'the retry offers no tools');
    // Every batch that was allowed to dispatch is present, and no batch from the
    // tool-less rounds sneaked in: five rounds x two calls each.
    const observations = retry.messages.filter((message) => message.role === 'tool');
    const dispatched = requests.filter(
      (request) => Array.isArray(request.tools) && request.tools.length > 0,
    ).length;
    assert.equal(
      observations.length,
      2 * dispatched,
      'the retry carries exactly the dispatched tool results',
    );

    // And its prose is what the user gets.
    assert.match(result.text, /慢查询集中在报表 SQL/);
    assert.doesNotMatch(result.text, /没有可交付的分析/);
    assert.doesNotMatch(result.text, /没有理解你的需求/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  }
});
