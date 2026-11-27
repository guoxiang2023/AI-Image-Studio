import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Every case pins a behaviour that a long conversation actually broke. They run
// against a real HTTP server so the prompt is inspected exactly as the provider
// receives it, and they assert on what the model was shown rather than on an
// internal counter: a summary that looks right but never sent the text is the
// bug these tests exist to catch.

process.env.RETRY_BASE_MS = '1';

const { SUMMARY_INPUT_CHARS, SUMMARY_MAX_CHARS } = await import('../src/config.js');
const { clipSummary, isLossySummary, toLlmHistory } = await import('../src/domain/chat.js');
const { compressChatNow, maybeCompressChat } = await import('../src/services/summary-service.js');

const llm = () => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'summary', apiKey: 'test' });

/**
 * A provider that records every summary prompt it was sent.
 *
 * `reply` decides the card body per call, so an over-long answer and a failure
 * mid-run are both expressible without touching the service.
 */
async function provider(t, reply = () => '【用户目标与偏好】卡片') {
  const prompts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      prompts.push(String(body.messages?.[0]?.content || ''));
      const answer = reply(prompts.length, prompts.at(-1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [typeof answer === 'string' ? { message: { role: 'assistant', content: answer } } : answer],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { prompts, llm: { ...llm(), baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}

function chatOf(count, content = (index) => `第${index}条 ${'内容'.repeat(300)}`) {
  return {
    id: 'a'.repeat(24),
    userId: 'summary-user',
    summary: '',
    summaryUpto: 0,
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: content(index),
    })),
  };
}

/** Asserts the card was persisted through the same call the route makes. */
function saver() {
  const writes = [];
  const save = (userId, chatId, summary, upto) => writes.push({ userId, chatId, summary, upto });
  return { writes, save };
}

test('a short provider-truncated card leaves the batch available to the next compression', async (t) => {
  const { prompts, llm: config } = await provider(t, (call) => call === 1
    ? { message: { content: '已确认' }, finish_reason: 'length' }
    : '交接单号为 LK-942');
  const chat = chatOf(12, (index) => index === 2 ? '交接单号为 LK-942' : `常规记录 ${index}`);
  chat.summary = '原有记忆';
  chat.summaryUpto = 2;
  const { writes, save } = saver();
  const interrupted = await compressChatNow(chat, config, null, { saveSummary: save });
  assert.equal(interrupted.complete, false);
  assert.match(interrupted.error, /截断/);
  assert.equal(chat.summaryUpto, 2);
  assert.equal(chat.summary, '原有记忆');
  assert.equal(writes.length, 0);

  const retried = await compressChatNow(chat, config, null, { saveSummary: save });
  assert.match(prompts[1], /交接单号为 LK-942/);
  assert.equal(retried.complete, true);
  assert.ok(retried.upto > 2);
  assert.equal(chat.summary, '交接单号为 LK-942');
});

test('a single oversized message is consumed in full, not clipped to its head', async (t) => {
  const { prompts, llm: config } = await provider(t);
  const giant =
    'HEAD_START|' + 'M'.repeat(SUMMARY_INPUT_CHARS) + '|MIDDLE_MARK|' +
    'N'.repeat(SUMMARY_INPUT_CHARS) + '|TAIL_END';
  const chat = chatOf(0);
  chat.messages = [{ role: 'user', content: giant }];
  for (let index = 0; index < 10; index += 1) {
    chat.messages.push({ role: 'assistant', content: `短消息${index}` });
  }

  const result = await compressChatNow(chat, config, null, { saveSummary: saver().save });
  const sent = prompts.join('\n');

  // The whole message reached the model, in parts each within the input budget.
  assert.match(sent, /HEAD_START/);
  assert.match(sent, /MIDDLE_MARK/);
  assert.match(sent, /TAIL_END/);
  assert.ok(prompts.length > 1, 'a message larger than one request must be split');
  for (const prompt of prompts) {
    assert.ok(prompt.length <= SUMMARY_INPUT_CHARS + 4000, 'each request stays within its input budget');
  }
  assert.equal(result.compacted, true);
  // The cursor only moves past messages that were fully read.
  assert.ok(result.upto > 0);
});

test('an attachment body is summarised in full even beyond several requests', async (t) => {
  const { prompts, llm: config } = await provider(t);
  const body =
    'ATT_START|' + 'x'.repeat(SUMMARY_INPUT_CHARS * 2) + '|ATT_MIDDLE|' +
    'y'.repeat(SUMMARY_INPUT_CHARS * 2) + '|ATT_END';
  const chat = chatOf(8);
  chat.messages[0] = {
    role: 'user',
    content: '看附件',
    attachments: [{ id: 'f'.repeat(16), name: 'big.txt', chars: body.length, text: body }],
  };

  const result = await compressChatNow(chat, config, null, { saveSummary: saver().save });
  const sent = prompts.join('\n');

  assert.match(sent, /ATT_START/);
  assert.match(sent, /ATT_MIDDLE/);
  assert.match(sent, /ATT_END/);
  assert.equal(result.compacted, true);
});

test('a message whose final part did not fit is not claimed as covered', async (t) => {
  // The exact regression: parts are fetched one ahead, so the *next* message's
  // last part is already in hand when the current request is built. If the
  // cursor trusted that fetch, it would claim a message whose tail was never
  // sent — and the tail would then be gone from memory forever.
  const { prompts, llm: config } = await provider(t);
  const saves = [];
  const save = (userId, chatId, summary, upto) => saves.push({ upto, summary });

  // Message 0 and message 1 each need two parts; each part nearly fills a
  // request, so message 1's tail cannot share a request with message 0's.
  const pad = Math.floor(SUMMARY_INPUT_CHARS * 0.95);
  const chat = chatOf(0);
  chat.messages = [
    { role: 'user', content: `P0A|${'a'.repeat(pad)}|P0B_END` },
    { role: 'assistant', content: `P1A|${'b'.repeat(pad)}|P1B_TAIL` },
    ...Array.from({ length: 6 }, (_, index) => ({ role: 'assistant', content: `尾${index}` })),
  ];

  const result = await compressChatNow(chat, config, null, { saveSummary: save });
  assert.ok(result.compacted);

  // For every commit, the part that proves it must have been SENT by then.
  const sentBy = (callIndex, marker) => prompts.slice(0, callIndex + 1).some((p) => p.includes(marker));
  for (const write of saves) {
    if (write.upto >= 2) {
      const firstClaim = saves.indexOf(write);
      assert.ok(
        sentBy(firstClaim, 'P1B_TAIL'),
        "claiming message 1 requires message 1's tail to have been sent",
      );
      assert.ok(sentBy(firstClaim, 'P0B_END'), "and message 0's tail too");
    }
  }
  // The tail did eventually reach the model, so nothing was silently dropped.
  assert.ok(prompts.some((p) => p.includes('P1B_TAIL')));
});

test('an over-long card keeps the newest facts and records that it dropped the middle', () => {
  const answer =
    '【用户目标与偏好】让画面更安静' + 'A'.repeat(SUMMARY_MAX_CHARS) + '【最近一次用户要求】保留原话XYZ';
  const card = clipSummary(answer);

  assert.ok(card.length <= SUMMARY_MAX_CHARS, 'card stays within its budget');
  assert.match(card, /【用户目标与偏好】/, 'the goals survive');
  assert.match(card, /保留原话XYZ/, 'the latest request survives');
  assert.match(card, /【中段已省略】/, 'the loss is recorded');
  assert.equal(isLossySummary(card), true);
});

test('manual compaction rebuilds a lossy card from the original messages', async (t) => {
  const { prompts, llm: config } = await provider(t, () => '【用户目标与偏好】重建后的完整记忆');
  const chat = chatOf(12, (index) => `原始事实${index}`);
  // A card written by the old code: clipped past the ceiling, no marker.
  chat.summary = '旧记忆' + 'Z'.repeat(SUMMARY_MAX_CHARS);
  chat.summaryUpto = 10;

  const result = await compressChatNow(chat, config, null, {
    saveSummary: saver().save,
    rebuild: true,
  });

  assert.equal(result.rebuilt, true);
  assert.equal(chat.summary, '【用户目标与偏好】重建后的完整记忆');
  // The rebuild re-read the covered messages instead of trusting the old card.
  assert.match(prompts[0], /原始事实0/);
  assert.doesNotMatch(prompts[0], /旧记忆/);
  assert.equal(isLossySummary(chat.summary), false);
});

test('a rebuild that cannot reach the model keeps the card it was replacing', async (t) => {
  // 401 is not retried, so the model is unusable immediately and the repair has
  // nothing to write.
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { ...llm(), baseUrl: `http://127.0.0.1:${server.address().port}/v1` };

  const chat = chatOf(12, (index) => `原始事实${index}`);
  const original = '【用户目标与偏好】旧但有用的记忆';
  chat.summary = original;
  chat.summaryUpto = 8;
  const { writes, save } = saver();

  const result = await compressChatNow(chat, config, null, { saveSummary: save, rebuild: true });

  // A repair that fails must not downgrade a real card to an excerpt.
  assert.equal(calls, 1);
  assert.equal(writes.length, 0, 'nothing was written');
  assert.equal(chat.summary, original);
  assert.equal(chat.summaryUpto, 8);
  assert.equal(result.compacted, false);
  assert.match(result.error || '', /保留原记忆/);
});

test('a provider that rejects every call stops after two attempts and keeps an excerpt', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { ...llm(), baseUrl: `http://127.0.0.1:${server.address().port}/v1` };

  const chat = chatOf(60);
  const { writes, save } = saver();
  const result = await compressChatNow(chat, config, null, { saveSummary: save });

  // Two failures are enough to know the model is unusable; the rest is excerpted
  // deterministically so the backlog still shrinks.
  assert.equal(calls, 2);
  assert.equal(result.fallback, true);
  assert.ok(writes.length > 0, 'progress was still persisted');
  assert.ok(chat.summary.length <= SUMMARY_MAX_CHARS);
  assert.match(chat.summary, /【自动摘录】/);
});

test('automatic compaction is bounded per turn and resumes where it stopped', async (t) => {
  const { prompts, llm: config } = await provider(t);
  const chat = chatOf(300);

  const first = await maybeCompressChat(chat, config, null, () => {}, { saveSummary: saver().save });
  const afterFirst = chat.summaryUpto;
  assert.equal(first.complete, false, 'one turn cannot finish a 300-message backlog');
  assert.ok(afterFirst > 0 && afterFirst < 300);

  const second = await maybeCompressChat(chat, config, null, () => {}, { saveSummary: saver().save });
  assert.ok(chat.summaryUpto > afterFirst, 'the next turn continues instead of restarting');
  assert.ok(second.upto === chat.summaryUpto);

  // No message was read twice across the two runs.
  const sent = prompts.join('\n');
  const appearances = sent.split('第0条').length - 1;
  assert.equal(appearances, 1, 'a covered message is never re-sent');
});

test('history reports a gap it cannot attribute to the summary', () => {
  // Rows already start at the summary cutoff, so everything the token trimmer
  // drops is genuinely absent from the request. Reporting it as "covered by the
  // summary" invited the model to invent detail.
  const history = toLlmHistory({
    summaryUpto: 2,
    summary: '较早的摘要',
    messages: [
      { role: 'user', content: '已摘要一' },
      { role: 'assistant', content: '已摘要二' },
      ...Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `第${index}条 ${'中'.repeat(600)}`,
      })),
    ],
  });
  assert.ok(history.length > 0);
  assert.ok(history.length < 200);
  assert.ok(history.omitted > 0);
  assert.equal(history[0].content.includes('已摘要'), false, 'summarised rows are not re-sent');
});
