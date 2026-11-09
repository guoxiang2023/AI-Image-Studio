import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReplayLiveStream } from '../public/js/features/session-replay.js';

test('replays a stream when the session response still has this turn draft', () => {
  const history = [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'partial current answer', draft: true },
  ];
  // The stream completed while the session request was in flight.
  assert.equal(shouldReplayLiveStream({ done: true }, history), true);
});

test('replays while the stream is still running even with historical replies', () => {
  const messages = [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'current question' },
  ];
  assert.equal(shouldReplayLiveStream({ done: false }, messages), true);
});

test('does not replay when the current turn is already the final assistant message', () => {
  const messages = [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'final current answer' },
  ];
  assert.equal(shouldReplayLiveStream({ done: true }, messages), false);
});

test('does not replay without a live stream', () => {
  assert.equal(shouldReplayLiveStream(null, []), false);
});
