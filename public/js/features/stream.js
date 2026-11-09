import { state, updateSendButton } from '../core/index.js';
import { createAssistantShell } from './messages.js';

export function activeStream() {
  for (const stream of state.streams.values()) {
    if (!stream.done && stream.viewSeq === state.viewSeq) return stream;
  }
  return null;
}

export function streamForSession(sessionId) {
  if (!sessionId) return null;
  for (const stream of state.streams.values()) {
    if (!stream.done && stream.sessionId === sessionId) return stream;
  }
  return null;
}

export function syncStreamingState() {
  const stream = activeStream();
  state.streaming = Boolean(stream);
  updateSendButton();
}

function paintStream(stream, shell) {
  for (const image of stream.images) shell.addImage(image);
  if (stream.content) shell.setText(stream.content);
  if (stream.finishedAt) shell.setTime(stream.finishedAt);
  if (stream.durationMs) shell.setDuration(stream.durationMs);
  if (stream.error) {
    shell.setError(stream.error);
  } else if (stream.status && !stream.content && !stream.images.length) {
    shell.setStatus(stream.status);
  }
  if (stream.done) shell.finish();
}

export function ensureStreamShell(stream) {
  if (stream.viewSeq !== state.viewSeq) return null;
  if (!stream.shell) {
    stream.shell = createAssistantShell({ startedAt: stream.startedAt });
    paintStream(stream, stream.shell);
  }
  return stream.shell;
}

export function detachChatView() {
  state.viewSeq += 1;
  for (const stream of state.streams.values()) {
    stream.shell?.stopTimer();
    stream.shell = null;
  }
  syncStreamingState();
}

export function attachStreamToView(stream) {
  stream.viewSeq = state.viewSeq;
  stream.shell = null;
  const shell = ensureStreamShell(stream);
  syncStreamingState();
  return shell;
}

export function cancelAllStreams() {
  for (const stream of state.streams.values()) {
    stream.done = true;
    stream.shell?.stopTimer();
    stream.controller?.abort();
  }
  state.streams.clear();
  state.streaming = false;
  updateSendButton();
}
