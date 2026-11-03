import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChatCompletion } from '../src/ai/llm.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('streams text and assembles fragmented tool calls', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end(
      [
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"generate_image","arguments":"{\\"prompt\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cat\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );
  });
  const port = await listen(server);
  try {
    const deltas = [];
    const result = await streamChatCompletion(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
      [],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.equal(deltas.join(''), '你好');
    assert.equal(result.choices[0].message.content, '你好');
    assert.deepEqual(result.choices[0].message.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'generate_image', arguments: '{"prompt":"cat"}' },
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
