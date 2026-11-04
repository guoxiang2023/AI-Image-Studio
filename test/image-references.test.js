import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REDRAW_INSTRUCTION,
  STYLE_ISOLATION,
  referencePromptBlock,
} from '../src/domain/image-references.js';

test('style references are isolated from content', () => {
  const block = referencePromptBlock([
    { id: 'a'.repeat(16), role: '风格' },
    { id: 'b'.repeat(16), role: '角色' },
  ]);
  assert.match(block, /Image 1: style reference only/);
  assert.match(block, /Image 2: identity and appearance reference/);
  assert.match(block, new RegExp(STYLE_ISOLATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(block, /from scratch/);
});

test('style-transfer edits require a redraw instead of a photo filter', () => {
  const block = referencePromptBlock([{ id: 'a'.repeat(16), role: '风格' }], {
    mode: 'edit',
  });
  assert.match(block, new RegExp(REDRAW_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('non-style references do not receive the style isolation block', () => {
  const block = referencePromptBlock([{ id: 'a'.repeat(16), role: '角色' }]);
  assert.match(block, /identity and appearance reference/);
  assert.doesNotMatch(block, /style reference only/);
});

test('layout references preserve composition without isolating style', () => {
  const block = referencePromptBlock([{ id: 'a'.repeat(16), role: '版式' }]);
  assert.match(block, /layout and art-direction reference/);
  assert.match(block, /Replace its exact text and content/);
  assert.match(block, /Never relabel or reuse the reference product/);
  assert.doesNotMatch(block, /style reference only/);
});

test('returns no block when there are no references', () => {
  assert.equal(referencePromptBlock([]), '');
  assert.equal(referencePromptBlock([{ role: '风格' }]), '');
});
