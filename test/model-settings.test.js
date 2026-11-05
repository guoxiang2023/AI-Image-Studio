import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { getSettings, saveSettings } from '../src/data/repositories/model-settings.js';
import { setSecretBox } from '../src/shared/runtime.js';
import {
  draftSettings,
  loadSettings,
  publicSettings,
  revealApiKey,
  updateSettingsPatch,
} from '../src/services/model-settings-service.js';

let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-settings-test-'));
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

test('persists and exposes the Anthropic protocol without plaintext keys', () => {
  const saved = updateSettingsPatch('u1', {
    llm: {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
      apiKey: 'secret-key',
    },
  });

  assert.equal(saved.llm.protocol, 'anthropic');
  assert.equal(saved.llm.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(saved.llm.model, 'claude-test');
  assert.equal(saved.llm.apiKeySet, true);
  assert.equal('apiKey' in saved.llm, false);

  const stored = getSettings('u1').llm_json;
  assert.equal(stored.includes('secret-key'), false);
  assert.equal(loadSettings('u1').llm.apiKey, 'secret-key');
  assert.equal(revealApiKey('u1', 'llm'), 'secret-key');
  assert.equal(revealApiKey('u1', 'image'), '');
  assert.equal(loadSettings('u1').llm.protocol, 'anthropic');

  const draft = draftSettings({ protocol: 'anthropic' }, 'llm', 'u1');
  assert.equal(draft.protocol, 'anthropic');
  assert.equal(draft.model, 'claude-test');
});

test('defaults settings without a protocol to OpenAI-compatible', () => {
  updateSettingsPatch('u2', {
    llm: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      apiKey: 'openai-key',
    },
    image: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'image-test',
      apiKey: 'image-key',
    },
  });

  const settings = loadSettings('u2');
  assert.equal(settings.llm.protocol, 'openai');
  assert.equal(settings.image.quality, 'high');
  assert.equal(publicSettings('u2').llm.protocol, 'openai');
});

test('persists and clears the LLM reasoning effort', () => {
  const saved = updateSettingsPatch('u3', {
    llm: {
      baseUrl: 'https://api.example.com/v1',
      model: 'reasoning-test',
      apiKey: 'reasoning-key',
      reasoningEffort: 'xhigh',
    },
  });
  assert.equal(saved.llm.reasoningEffort, 'xhigh');
  assert.equal(loadSettings('u3').llm.reasoningEffort, 'xhigh');
  assert.equal(draftSettings({}, 'llm', 'u3').reasoningEffort, 'xhigh');
  assert.equal(
    draftSettings({ reasoningEffort: 'max' }, 'llm', 'u3').reasoningEffort,
    'max',
  );
  assert.equal(
    draftSettings({ reasoningEffort: 'ultra' }, 'llm', 'u3').reasoningEffort,
    'xhigh',
  );

  updateSettingsPatch('u3', { llm: { reasoningEffort: '' } });
  assert.equal(publicSettings('u3').llm.reasoningEffort, '');
});

test('persists image quality and uses it as the request default', () => {
  const saved = updateSettingsPatch('u4', {
    image: {
      baseUrl: 'https://api.example.com/v1',
      model: 'image-quality-test',
      apiKey: 'image-key',
      quality: 'xhigh',
    },
  });
  assert.equal(saved.image.quality, 'xhigh');
  assert.equal(loadSettings('u4').image.quality, 'xhigh');
  assert.equal(draftSettings({}, 'image', 'u4').quality, 'xhigh');
  assert.equal(draftSettings({ quality: 'max' }, 'image', 'u4').quality, 'max');
  assert.equal(draftSettings({ quality: 'ultra' }, 'image', 'u4').quality, 'xhigh');

  updateSettingsPatch('u4', { image: { quality: 'low' } });
  assert.equal(publicSettings('u4').image.quality, 'low');
});

test('stores multiple providers, switches active, and preserves keys by provider', () => {
  const saved = updateSettingsPatch('u5', {
    llm: {
      activeId: 'llm-a',
      providers: [
        {
          id: 'llm-a',
          name: 'Provider A',
          baseUrl: 'https://a.example/v1',
          model: 'model-a',
          apiKey: 'key-a',
        },
        {
          id: 'llm-b',
          name: 'Provider B',
          baseUrl: 'https://b.example/v1',
          model: 'model-b',
          apiKey: 'key-b',
        },
      ],
    },
  });
  assert.equal(saved.llm.providers.length, 2);
  assert.equal(saved.llm.id, 'llm-a');
  assert.equal(saved.llm.apiKeySet, true);
  assert.equal(loadSettings('u5').llm.apiKey, 'key-a');

  updateSettingsPatch('u5', { llm: { activeId: 'llm-b' } });
  const switched = publicSettings('u5').llm;
  assert.equal(switched.id, 'llm-b');
  assert.equal(switched.model, 'model-b');
  assert.equal(switched.apiKeySet, true);
  assert.equal(revealApiKey('u5', 'llm', 'llm-a'), 'key-a');
  assert.equal(revealApiKey('u5', 'llm', 'llm-b'), 'key-b');

  updateSettingsPatch('u5', {
    llm: {
      activeId: 'llm-b',
      providers: [
        { id: 'llm-a', name: 'Provider A2', baseUrl: 'https://a.example/v1', model: 'model-a2' },
        { id: 'llm-b', name: 'Provider B', baseUrl: 'https://b.example/v1', model: 'model-b' },
      ],
    },
  });
  assert.equal(revealApiKey('u5', 'llm', 'llm-a'), 'key-a');
  assert.equal(revealApiKey('u5', 'llm', 'llm-b'), 'key-b');

  updateSettingsPatch('u5', {
    providerPricing: {
      'llm-a': { inputPerMillion: 1, outputPerMillion: 2 },
      'llm-b': { inputPerMillion: 3, outputPerMillion: 4 },
    },
  });
  const priced = publicSettings('u5').llm.providers;
  assert.equal(priced.find((provider) => provider.id === 'llm-a').pricing.inputPerMillion, 1);
  assert.equal(priced.find((provider) => provider.id === 'llm-b').pricing.outputPerMillion, 4);

  updateSettingsPatch('u5', {
    llm: {
      activeId: 'llm-b',
      providers: [
        { id: 'llm-b', name: 'Provider B', baseUrl: 'https://b.example/v1', model: 'model-b' },
      ],
    },
  });
  assert.equal(publicSettings('u5').llm.providers.length, 1);
  assert.equal(publicSettings('u5').llm.activeId, 'llm-b');
});

test('does not inherit an active key for an unsaved provider probe', () => {
  updateSettingsPatch('u6', {
    llm: {
      baseUrl: 'https://safe.example/v1',
      model: 'safe-model',
      apiKey: 'active-secret',
    },
  });
  const activeId = publicSettings('u6').llm.id;
  const unknown = draftSettings(
    {
      providerId: 'not-saved-provider',
      baseUrl: 'https://other.example/v1',
      model: 'other-model',
    },
    'llm',
    'u6',
  );
  assert.equal(unknown.apiKey, '');
  assert.equal(unknown.baseUrl, 'https://other.example/v1');

  const known = draftSettings(
    {
      providerId: activeId,
      baseUrl: 'https://safe.example/v1',
      model: 'safe-model-2',
    },
    'llm',
    'u6',
  );
  assert.equal(known.apiKey, 'active-secret');
});

test('wraps a legacy single provider with its old pricing', () => {
  const sealed = (value) => `sealed:${Buffer.from(value).toString('base64')}`;
  saveSettings(
    'u7',
    JSON.stringify({
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-llm',
      apiKey: sealed('legacy-key'),
    }),
    JSON.stringify({
      baseUrl: 'https://legacy-image.example/v1',
      model: 'legacy-image',
      apiKey: sealed('legacy-image-key'),
    }),
    JSON.stringify({ inputPerMillion: 1.5, outputPerMillion: 6, imagePerImage: 0.04 }),
  );

  const cfg = publicSettings('u7');
  assert.equal(cfg.llm.providers.length, 1);
  assert.equal(cfg.llm.providers[0].id, 'llm-default');
  assert.equal(cfg.llm.activeId, 'llm-default');
  assert.equal(cfg.llm.providers[0].apiKeySet, true);
  assert.equal(cfg.llm.providers[0].pricing.inputPerMillion, 1.5);
  assert.equal(cfg.image.providers.length, 1);
  assert.equal(cfg.image.providers[0].id, 'image-default');
  assert.equal(cfg.image.providers[0].pricing.imagePerImage, 0.04);
  assert.equal(loadSettings('u7').llm.apiKey, 'legacy-key');
});
