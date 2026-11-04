import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { getSettings } from '../src/data/repositories/model-settings.js';
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
