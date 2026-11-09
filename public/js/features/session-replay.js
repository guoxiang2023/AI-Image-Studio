/**
 * Decide whether a live stream shell must be replayed after loading a session.
 *
 * A completed stream can race a session fetch: the fetch may contain only the
 * in-progress draft, while historical assistants already exist. Looking at any
 * historical assistant would incorrectly treat the turn as finished, so only
 * the final message can prove that the current turn was persisted.
 */
export function shouldReplayLiveStream(live, messages) {
  if (!live) return false;
  if (!live.done) return true;
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  return !(last && last.role === 'assistant' && last.draft !== true);
}
