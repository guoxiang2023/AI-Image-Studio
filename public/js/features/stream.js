import { state, updateSendButton } from '../core/index.js';

export function abortStream() {
  state.controller?.abort();
}

export function cancelStreamForNavigation() {
  if (!state.streaming) return;
  state.streamSeq += 1;
  state.streaming = false;
  state.controller?.abort();
  state.controller = null;
  updateSendButton();
}
