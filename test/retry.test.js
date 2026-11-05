import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.RETRY_BASE_MS = '1';

const { MAX_ATTEMPTS, NETWORK_ERROR_MESSAGE } = await import('../src/shared/utils.js');
const { requestImage, streamChatCompletion } = await import('../src/ai/llm.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('stream reports a network error after five retries', async () => {
  let requests = 0;
  const server = http.createServer((req) => {
    req.resume();
    requests += 1;
    req.socket.destroy();
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      streamChatCompletion(
        { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
        [],
        {},
      ),
      { message: NETWORK_ERROR_MESSAGE },
    );
    assert.equal(requests, MAX_ATTEMPTS);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('image generation reports a network error after five retries', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    requests += 1;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"temporarily unavailable"}}');
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      requestImage(
        { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
        '/images/generations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      ),
      { message: NETWORK_ERROR_MESSAGE },
    );
    assert.equal(requests, MAX_ATTEMPTS);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns image data together with provider usage', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [{ b64_json: 'aGVsbG8=' }],
        usage: { total_tokens: 42, input_tokens: 12, output_tokens: 30 },
      }),
    );
  });
  const port = await listen(server);
  try {
    const result = await requestImage(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
      '/images/generations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].b64_json, 'aGVsbG8=');
    assert.equal(result.usage.total_tokens, 42);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('does not retry a non-retryable client error', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    requests += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"invalid key"}}');
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      requestImage(
        { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'test' },
        '/images/generations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      ),
      /401/,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
