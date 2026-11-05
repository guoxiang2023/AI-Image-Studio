import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatCompletion, streamChatCompletion } from '../src/ai/llm.js';
import {
  ANTHROPIC_VERSION,
  anthropicBaseUrl,
  anthropicToOpenAiResponse,
  buildAnthropicRequest,
} from '../src/ai/anthropic.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

test('normalizes Anthropic base URLs with or without /v1', () => {
  assert.equal(anthropicBaseUrl('http://host/anthropic'), 'http://host/anthropic/v1');
  assert.equal(anthropicBaseUrl('http://host/anthropic/'), 'http://host/anthropic/v1');
  assert.equal(anthropicBaseUrl('http://host/anthropic/v1'), 'http://host/anthropic/v1');
  assert.equal(anthropicBaseUrl('http://host/anthropic/v1/'), 'http://host/anthropic/v1');
  assert.equal(
    anthropicBaseUrl('http://host/anthropic/v1/messages'),
    'http://host/anthropic/v1',
  );
  const request = buildAnthropicRequest(
    { baseUrl: 'http://host/anthropic', model: 'claude-test', apiKey: 'secret' },
    [{ role: 'user', content: 'hi' }],
  );
  assert.equal(request.url, 'http://host/anthropic/v1/messages');
});

test('converts tool messages and tools to Anthropic Messages format', () => {
  const request = buildAnthropicRequest(
    {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/',
      model: 'claude-test',
      apiKey: 'secret',
    },
    [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Draw a cat.' },
      {
        role: 'assistant',
        content: 'Working.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'generate_image',
              arguments: '{"prompt":"a cat","count":1}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"ok":false}' },
    ],
    {
      tools: [
        {
          type: 'function',
          function: {
            name: 'generate_image',
            description: 'Generate an image.',
            parameters: {
              type: 'object',
              properties: { prompt: { type: 'string' } },
              required: ['prompt'],
            },
          },
        },
      ],
      temperature: 2,
      maxTokens: 128,
      stream: true,
    },
  );

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'secret');
  assert.equal(request.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(request.body.model, 'claude-test');
  assert.equal(request.body.system, 'You are helpful.');
  assert.equal(request.body.max_tokens, 128);
  assert.equal(request.body.temperature, 1);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.tool_choice.type, 'auto');
  assert.equal(request.body.tools[0].name, 'generate_image');
  assert.equal(request.body.tools[0].input_schema.type, 'object');

  assert.equal(request.body.messages[0].role, 'user');
  assert.deepEqual(request.body.messages[0].content, [{ type: 'text', text: 'Draw a cat.' }]);
  assert.equal(request.body.messages[1].role, 'assistant');
  assert.equal(request.body.messages[1].content[0].type, 'text');
  assert.deepEqual(request.body.messages[1].content[1], {
    type: 'tool_use',
    id: 'call_1',
    name: 'generate_image',
    input: { prompt: 'a cat', count: 1 },
  });
  assert.equal(request.body.messages[2].role, 'user');
  assert.equal(request.body.messages[2].content.length, 2);
  assert.deepEqual(request.body.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '{"ok":true}',
  });
});

test('maps Anthropic cache usage to prompt and cached tokens', () => {
  const result = anthropicToOpenAiResponse({
    type: 'message',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
      output_tokens: 5,
    },
  });
  assert.deepEqual(result.usage, {
    prompt_tokens: 200,
    completion_tokens: 5,
    total_tokens: 205,
    cache_read_input_tokens: 80,
  });
});

test('maps non-stream Anthropic responses to chat completion shape', async () => {
  let received = null;
  const server = http.createServer(async (req, res) => {
    received = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await readBody(req)),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'generate_image',
            input: { prompt: 'a cat' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    );
  });
  const port = await listen(server);
  try {
    const result = await chatCompletion(
      {
        protocol: 'anthropic',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'claude-test',
        apiKey: 'secret',
      },
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
      ],
      { maxTokens: 64 },
    );

    assert.equal(received.url, '/v1/messages');
    assert.equal(received.headers['x-api-key'], 'secret');
    assert.equal(received.body.model, 'claude-test');
    assert.equal(received.body.system, 'system');
    assert.equal(received.body.tools[0].name, 'generate_image');
    assert.equal(result.choices[0].message.content, 'hello');
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(result.choices[0].message.tool_calls, [
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'generate_image', arguments: '{"prompt":"a cat"}' },
      },
    ]);
    assert.deepEqual(result.usage, {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('streams Anthropic text and fragmented tool input', async () => {
  const server = http.createServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end(
      [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"generate_image","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"prompt\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a cat\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(''),
    );
  });
  const port = await listen(server);
  try {
    const deltas = [];
    const result = await streamChatCompletion(
      {
        protocol: 'anthropic',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'claude-test',
        apiKey: 'secret',
      },
      [{ role: 'user', content: 'hi' }],
      { onDelta: (text) => deltas.push(text) },
    );

    assert.equal(deltas.join(''), '你好');
    assert.equal(result.choices[0].message.content, '你好');
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(result.choices[0].message.tool_calls, [
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'generate_image', arguments: '{"prompt":"a cat"}' },
      },
    ]);
    assert.deepEqual(result.usage, {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
