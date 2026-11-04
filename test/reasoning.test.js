import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildAnthropicRequest } from '../src/ai/anthropic.js';
import { streamChatCompletion } from '../src/ai/llm.js';
import { anthropicReasoning, normalizeReasoningEffort, openAiReasoning } from '../src/ai/reasoning.js';

test('normalizes only supported reasoning effort values', () => {
  assert.equal(normalizeReasoningEffort(' XHIGH '), 'xhigh');
  assert.equal(normalizeReasoningEffort('max'), 'max');
  assert.equal(normalizeReasoningEffort('ultra'), '');
  assert.deepEqual(openAiReasoning({ reasoningEffort: 'high' }), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(openAiReasoning({}), {});
  assert.deepEqual(anthropicReasoning({ reasoningEffort: 'max' }), {
    output_config: { effort: 'max' },
  });
});

test('Anthropic requests include the selected effort', () => {
  const request = buildAnthropicRequest(
    {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
      apiKey: 'secret',
      reasoningEffort: 'xhigh',
    },
    [{ role: 'user', content: 'hi' }],
  );
  assert.deepEqual(request.body.output_config, { effort: 'xhigh' });
});

test('OpenAI-compatible streams send reasoning_effort when configured', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'test',
        apiKey: 'test',
        reasoningEffort: 'max',
      },
      [],
      {},
    );
    assert.equal(received.reasoning_effort, 'max');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
