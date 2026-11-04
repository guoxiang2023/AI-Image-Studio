import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseReferenceImages, imageCapabilities } from '../src/domain/image-capabilities.js';

test('known OpenAI image models support reference edits', () => {
  assert.equal(canUseReferenceImages('gpt-image-2.5-flare'), true);
  assert.equal(imageCapabilities('gpt-image-2.5-flare').family, 'openai-image');
  assert.equal(canUseReferenceImages('dall-e-2'), true);
});

test('known non-editing model is rejected', () => {
  assert.equal(canUseReferenceImages('dall-e-3'), false);
  assert.equal(imageCapabilities('dall-e-3').supportsEdits, false);
});

test('unknown models are attempted and flagged for reference fallback', () => {
  const caps = imageCapabilities('some-custom-image-model');
  assert.equal(caps.family, 'unknown');
  assert.equal(caps.supportsEdits, null);
  assert.equal(caps.referencePreferred, true);
  assert.equal(canUseReferenceImages('some-custom-image-model'), true);
});
