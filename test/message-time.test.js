import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageTime } from '../public/js/features/message-time.js';

test('formats message timestamps to the second with date context', () => {
  const now = new Date(2026, 10, 9, 15, 4, 5);
  assert.equal(formatMessageTime(new Date(2026, 10, 9, 9, 8, 7).getTime(), now), '09:08:07');
  assert.equal(
    formatMessageTime(new Date(2026, 10, 8, 23, 59, 59).getTime(), now),
    '11月8日 23:59:59',
  );
  assert.equal(
    formatMessageTime(new Date(2025, 0, 2, 3, 4, 5).getTime(), now),
    '2025-01-02 03:04:05',
  );
  assert.equal(formatMessageTime(null, now), '');
});
