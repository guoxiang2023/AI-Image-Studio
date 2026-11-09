import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../public/js/features/duration.js';

test('formats turn durations with second precision', () => {
  assert.equal(formatDuration(0, { allowZero: true }), '0 秒');
  assert.equal(formatDuration(400, { allowZero: true }), '0 秒');
  assert.equal(formatDuration(400), '1 秒');
  assert.equal(formatDuration(12_400), '12 秒');
  assert.equal(formatDuration(59_600), '1 分 00 秒');
  assert.equal(formatDuration(61_000), '1 分 01 秒');
  assert.equal(formatDuration(3_661_000), '1 小时 01 分 01 秒');
});
