import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { insertChat } from '../src/data/repositories/chats.js';
import { setSecretBox } from '../src/shared/runtime.js';
import { publicSettings, updateSettingsPatch } from '../src/services/model-settings-service.js';
import { insertUsageEvent } from '../src/data/repositories/usage.js';
import {
  normalizeUsage,
  recordImageUsage,
  recordLlmUsage,
  usageOverview,
} from '../src/services/usage-service.js';
import { compressChatNow } from '../src/services/summary-service.js';

let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-usage-test-'));
  setSecretBox({
    seal: (value) => `sealed:${Buffer.from(value).toString('base64')}`,
    unseal: (value) =>
      Buffer.from(value.replace(/^sealed:/, ''), 'base64').toString('utf8'),
  });
  initDb(dataDir);
});

after(async () => {
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('persists pricing and aggregates token, request, image, and cost totals', () => {
  const saved = updateSettingsPatch('u1', {
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      imagePerImage: 0.5,
    },
  });
  assert.deepEqual(saved.pricing, {
    inputPerMillion: 1,
    cachedPerMillion: 1,
    outputPerMillion: 2,
    imagePerImage: 0.5,
  });
  assert.deepEqual(publicSettings('u1').pricing, saved.pricing);

  insertChat({
    id: 'c1',
    userId: 'u1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });

  recordLlmUsage({
    userId: 'u1',
    chatId: 'c1',
    turnId: 't1',
    kind: 'chat',
    model: 'test-chat',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
  recordImageUsage({
    userId: 'u1',
    chatId: 'c1',
    turnId: 't1',
    model: 'test-image',
    images: 2,
  });

  const overview = usageOverview('u1', 'c1');
  assert.equal(overview.pricingConfigured, true);
  assert.equal(overview.currentSessionId, 'c1');
  assert.equal(overview.totals.promptTokens, 100);
  assert.equal(overview.totals.completionTokens, 50);
  assert.equal(overview.totals.totalTokens, 150);
  assert.equal(overview.totals.llmRequests, 1);
  assert.equal(overview.totals.imageRequests, 1);
  assert.equal(overview.totals.images, 2);
  assert.equal(overview.totals.estimatedTokens, 0);
  assert.equal(overview.totals.cost, 1.0002);
  assert.equal(overview.daily.length, 7);
  assert.equal(
    overview.daily.reduce((total, day) => total + day.totalTokens, 0),
    overview.totals.totalTokens,
  );

  const session = overview.sessions.find((row) => row.id === 'c1');
  assert.equal(session.title, '测试会话');
  assert.equal(session.totalTokens, 150);
  assert.equal(session.cost, 1.0002);
});

test('prices models independently within one provider and keeps old model prices', () => {
  insertChat({
    id: 'c10',
    userId: 'u10',
    title: '多模型会话',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });
  updateSettingsPatch('u10', {
    llm: {
      activeId: 'llm-a',
      providers: [
        {
          id: 'llm-a',
          name: 'Multi Model',
          baseUrl: 'https://models.example/v1',
          model: 'model-b',
        },
      ],
    },
  });
  updateSettingsPatch('u10', {
    modelPricing: {
      'llm-a': {
        'model-a': { inputPerMillion: 1, outputPerMillion: 0 },
        'model-b': { inputPerMillion: 5, outputPerMillion: 0 },
      },
    },
  });

  for (const model of ['model-a', 'model-b']) {
    recordLlmUsage({
      userId: 'u10',
      chatId: 'c10',
      turnId: `t-${model}`,
      kind: 'chat',
      model,
      providerId: 'llm-a',
      providerName: 'Multi Model',
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
    });
  }

  let overview = usageOverview('u10');
  const byModel = new Map(overview.models.map((model) => [model.model, model]));
  assert.equal(byModel.get('model-a').cost, 1);
  assert.equal(byModel.get('model-b').cost, 5);
  assert.equal(overview.totals.cost, 6);
  assert.equal(overview.sessions.find((session) => session.id === 'c10').cost, 6);
  assert.equal(
    overview.daily.reduce((total, day) => total + day.cost, 0),
    6,
  );

  const pricingModels = new Map(
    overview.pricingModels.map((row) => [row.model, row]),
  );
  assert.equal(pricingModels.size, 2);
  assert.equal(pricingModels.get('model-a').cost, 1);
  assert.equal(pricingModels.get('model-b').cost, 5);
  assert.equal(pricingModels.get('model-a').pricing.inputPerMillion, 1);

  const settings = updateSettingsPatch('u10', {
    llm: {
      activeId: 'llm-a',
      providers: [
        {
          id: 'llm-a',
          name: 'Multi Model',
          baseUrl: 'https://models.example/v1',
          model: 'model-c',
        },
      ],
    },
  });
  assert.equal(settings.llm.providers[0].modelPricing['model-a'].inputPerMillion, 1);
  assert.equal(settings.llm.providers[0].modelPricing['model-b'].inputPerMillion, 5);
  assert.equal(settings.llm.providers[0].modelPricing['model-c'].inputPerMillion, 0);

  recordLlmUsage({
    userId: 'u10',
    chatId: 'c10',
    turnId: 't-model-c',
    kind: 'chat',
    model: 'model-c',
    providerId: 'llm-a',
    providerName: 'Multi Model',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
  });
  overview = usageOverview('u10');
  const modelC = overview.models.find((model) => model.model === 'model-c');
  assert.equal(modelC.cost, 0);
  assert.equal(modelC.pricingConfigured, false);
  assert.equal(overview.totals.cost, 6);
  assert.equal(overview.pricingModels.length, 3);
});

test('prices cached input tokens separately and reports hit rate', () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 600 },
    }),
    { promptTokens: 1000, cachedTokens: 600, completionTokens: 100, totalTokens: 1100 },
  );
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 200,
      cache_read_input_tokens: 50,
      output_tokens: 20,
    }),
    { promptTokens: 200, cachedTokens: 50, completionTokens: 20, totalTokens: 220 },
  );

  insertChat({
    id: 'c-cache',
    userId: 'u-cache',
    title: '缓存会话',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });
  updateSettingsPatch('u-cache', {
    llm: {
      activeId: 'llm-cache',
      providers: [
        {
          id: 'llm-cache',
          name: 'Cache Provider',
          baseUrl: 'https://cache.example/v1',
          model: 'cache-model',
        },
      ],
    },
  });
  updateSettingsPatch('u-cache', {
    modelPricing: {
      'llm-cache': {
        'cache-model': {
          inputPerMillion: 10,
          cachedPerMillion: 2,
          outputPerMillion: 20,
        },
      },
    },
  });

  recordLlmUsage({
    userId: 'u-cache',
    chatId: 'c-cache',
    turnId: 't-cache',
    kind: 'chat',
    model: 'cache-model',
    providerId: 'llm-cache',
    providerName: 'Cache Provider',
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      total_tokens: 1_100_000,
      prompt_tokens_details: { cached_tokens: 400_000 },
    },
  });

  const overview = usageOverview('u-cache');
  assert.equal(overview.totals.cachedTokens, 400_000);
  assert.equal(overview.totals.cacheHitRate, 0.4);
  assert.equal(overview.totals.cost, 8.8);
  assert.equal(overview.providers[0].cachedTokens, 400_000);
  assert.equal(overview.models[0].cachedTokens, 400_000);
  assert.equal(overview.models[0].cost, 8.8);
  assert.equal(overview.sessions[0].cacheHitRate, 0.4);
  assert.equal(overview.sessions[0].cost, 8.8);
  assert.equal(overview.pricingModels[0].cacheHitRate, 0.4);
  assert.equal(overview.pricingModels[0].pricing.cachedPerMillion, 2);
});

test('all-time totals include usage outside the seven-day chart', () => {
  const now = Date.now();
  insertUsageEvent({
    userId: 'u4',
    chatId: 'c4',
    turnId: 'old',
    kind: 'chat',
    model: 'test-chat',
    promptTokens: 900,
    completionTokens: 100,
    totalTokens: 1000,
    requests: 1,
    images: 0,
    estimated: 0,
    createdAt: now - 10 * 86_400_000,
  });
  insertUsageEvent({
    userId: 'u4',
    chatId: 'c4',
    turnId: 'recent',
    kind: 'chat',
    model: 'test-chat',
    promptTokens: 80,
    completionTokens: 20,
    totalTokens: 100,
    requests: 1,
    images: 0,
    estimated: 0,
    createdAt: now,
  });
  const overview = usageOverview('u4');
  assert.equal(overview.totals.totalTokens, 1100);
  assert.equal(
    overview.daily.reduce((total, day) => total + day.totalTokens, 0),
    100,
  );
});

test('estimates tokens when a provider omits usage', () => {
  recordLlmUsage({
    userId: 'u2',
    chatId: 'c2',
    turnId: 't2',
    kind: 'chat',
    model: 'test-chat',
    messages: [{ role: 'user', content: '画一只猫'.repeat(20) }],
    completionText: '好的，正在生成图片。',
  });
  const overview = usageOverview('u2');
  assert.ok(overview.totals.promptTokens > 0);
  assert.ok(overview.totals.completionTokens > 0);
  assert.ok(overview.totals.estimatedTokens > 0);
  assert.equal(overview.totals.llmRequests, 1);
  assert.equal(overview.pricingConfigured, false);
  assert.equal(overview.totals.cost, 0);
});

test('returns empty usage for a user without settings or sessions', () => {
  const overview = usageOverview('brand-new-user');
  assert.deepEqual(overview.sessions, []);
  assert.deepEqual(overview.models, []);
  assert.equal(overview.totals.totalTokens, 0);
  assert.equal(overview.totals.llmRequests, 0);
  assert.equal(overview.totals.imageRequests, 0);
  assert.equal(overview.totals.images, 0);
  assert.equal(overview.totals.estimatedTokens, 0);
  assert.equal(overview.totals.cost, 0);
  assert.equal(overview.daily.length, 7);
  assert.ok(overview.daily.every((day) => day.totalTokens === 0));
});

test('records summary compaction as an LLM request', async () => {
  insertChat({
    id: 'c3',
    userId: 'u3',
    title: '摘要测试',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '【用户目标与偏好】\n测试摘要' } }],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
      }),
    );
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const chat = {
      id: 'c3',
      userId: 'u3',
      summary: '',
      summaryUpto: 0,
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `第 ${index} 轮：${'测试内容'.repeat(80)}`,
      })),
    };
    const result = await compressChatNow(
      chat,
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'summary-model', apiKey: 'test' },
      null,
      { saveSummary: () => {} },
    );
    assert.equal(result.compacted, true);
    const overview = usageOverview('u3');
    assert.equal(overview.totals.llmRequests, 1);
    assert.equal(overview.totals.promptTokens, 40);
    assert.equal(overview.totals.completionTokens, 10);
    assert.equal(overview.totals.estimatedTokens, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('aggregates usage and cost per provider', () => {
  updateSettingsPatch('u8', {
    llm: {
      activeId: 'llm-a',
      providers: [
        { id: 'llm-a', name: 'LLM A', baseUrl: 'https://a.example/v1', model: 'a' },
        { id: 'llm-b', name: 'LLM B', baseUrl: 'https://b.example/v1', model: 'b' },
      ],
    },
    image: {
      activeId: 'image-a',
      providers: [
        { id: 'image-a', name: 'Image A', baseUrl: 'https://img.example/v1', model: 'img' },
      ],
    },
  });
  updateSettingsPatch('u8', {
    providerPricing: {
      'llm-a': { inputPerMillion: 1, outputPerMillion: 2 },
      'llm-b': { inputPerMillion: 10, outputPerMillion: 20 },
      'image-a': { imagePerImage: 0.5 },
    },
  });

  recordLlmUsage({
    userId: 'u8',
    chatId: 'c8',
    turnId: 't8a',
    kind: 'chat',
    model: 'a',
    providerId: 'llm-a',
    providerName: 'LLM A',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
  });
  recordLlmUsage({
    userId: 'u8',
    chatId: 'c8',
    turnId: 't8b',
    kind: 'chat',
    model: 'b',
    providerId: 'llm-b',
    providerName: 'LLM B',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
  });
  recordImageUsage({
    userId: 'u8',
    chatId: 'c8',
    turnId: 't8c',
    model: 'img',
    providerId: 'image-a',
    providerName: 'Image A',
    images: 2,
  });

  const overview = usageOverview('u8');
  assert.equal(overview.totals.totalTokens, 3_000_000);
  assert.equal(overview.totals.llmRequests, 2);
  assert.equal(overview.totals.imageRequests, 1);
  assert.equal(overview.totals.images, 2);
  assert.equal(overview.totals.cost, 14);

  const byId = new Map(overview.providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.get('llm-a').cost, 3);
  assert.equal(byId.get('llm-b').cost, 10);
  assert.equal(byId.get('image-a').cost, 1);
  assert.equal(byId.get('llm-a').active, true);
  assert.equal(byId.get('llm-a').type, 'llm');
  assert.equal(byId.get('image-a').type, 'image');

  const byModel = new Map(overview.models.map((model) => [model.model, model]));
  assert.equal(byModel.get('a').cost, 3);
  assert.equal(byModel.get('a').totalTokens, 2_000_000);
  assert.equal(byModel.get('a').type, 'llm');
  assert.equal(byModel.get('a').providerCount, 1);
  assert.equal(byModel.get('b').cost, 10);
  assert.equal(byModel.get('img').cost, 1);
  assert.equal(byModel.get('img').images, 2);
  assert.equal(byModel.get('img').type, 'image');
  assert.equal(
    overview.models.reduce((total, model) => total + model.cost, 0),
    overview.totals.cost,
  );

  assert.equal(
    overview.daily.reduce((total, day) => total + day.cost, 0).toFixed(6),
    '14.000000',
  );
});

test('groups one model across providers and prices each request by provider', () => {
  updateSettingsPatch('u9', {
    llm: {
      activeId: 'llm-a',
      providers: [
        { id: 'llm-a', name: 'LLM A', baseUrl: 'https://a.example/v1', model: 'shared' },
        { id: 'llm-b', name: 'LLM B', baseUrl: 'https://b.example/v1', model: 'shared' },
      ],
    },
    image: {
      activeId: 'image-a',
      providers: [
        { id: 'image-a', name: 'Image A', baseUrl: 'https://img.example/v1', model: 'img' },
      ],
    },
  });
  updateSettingsPatch('u9', {
    providerPricing: {
      'llm-a': { inputPerMillion: 1, outputPerMillion: 0 },
      'llm-b': { inputPerMillion: 3, outputPerMillion: 0 },
    },
  });

  for (const [providerId, providerName] of [
    ['llm-a', 'LLM A'],
    ['llm-b', 'LLM B'],
  ]) {
    recordLlmUsage({
      userId: 'u9',
      chatId: 'c9',
      turnId: `t-${providerId}`,
      kind: 'chat',
      model: 'shared',
      providerId,
      providerName,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
    });
  }

  const overview = usageOverview('u9');
  assert.equal(overview.models.length, 1);
  const [model] = overview.models;
  assert.equal(model.model, 'shared');
  assert.equal(model.providerCount, 2);
  assert.equal(model.totalTokens, 2_000_000);
  assert.equal(model.llmRequests, 2);
  assert.equal(model.cost, 4);
  assert.equal(model.pricingConfigured, true);
  assert.equal(overview.totals.cost, 4);
});
