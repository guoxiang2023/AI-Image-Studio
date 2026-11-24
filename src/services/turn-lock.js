/**
 * One in-flight turn per chat.
 *
 * Two tabs on the same conversation used to run two turns concurrently: each
 * appended its own user message and its own draft to the same chat document,
 * and whichever finished last overwrote the other's persisted answer. Slow
 * streams made this easy to hit — open a second tab, send, and the first tab's
 * reply was silently replaced.
 *
 * The lock is claimed for the whole turn, from before the body is prepared
 * until the stream ends, because preparing mutates nothing but running appends
 * the user message and the draft immediately.
 *
 * A second concurrent turn is rejected rather than queued. Queueing would make
 * the user wait behind a stream that may run for minutes with no feedback, and
 * an SSE response has already committed its status line by then.
 */

const activeTurns = new Map();

export class TurnBusyError extends Error {
  constructor(chatId) {
    super('这个会话正在生成回复，请等当前回复结束后再发送');
    this.name = 'TurnBusyError';
    this.code = 'TURN_BUSY';
    this.chatId = chatId;
    this.status = 409;
  }
}

/**
 * Claims the chat for one turn.
 *
 * Returns a release function. Callers must release in a `finally`: a leaked
 * entry would make the chat permanently unusable until the process restarts.
 */
export function acquireTurn(chatId) {
  if (!chatId) throw new Error('acquireTurn 需要 chatId');
  if (activeTurns.has(chatId)) throw new TurnBusyError(chatId);
  const token = Symbol(chatId);
  activeTurns.set(chatId, token);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // Only clear our own claim: a release arriving after the entry was taken
    // over (impossible today, but cheap to keep honest) must not free the
    // successor's lock.
    if (activeTurns.get(chatId) === token) activeTurns.delete(chatId);
  };
}

/** Test seam: the lock is process state, so tests need to observe it. */
export function activeTurnCount() {
  return activeTurns.size;
}

/**
 * Whether a turn currently holds this chat.
 *
 * Synchronous on purpose: callers use it immediately before a delete so the
 * check and the write happen in one tick. `handleChat` claims the id before it
 * awaits turn preparation, so a chat can be busy while it still has no
 * persisted message — checking only stored fields would delete a session that
 * is actively generating a reply.
 */
export function isTurnActive(chatId) {
  return Boolean(chatId) && activeTurns.has(chatId);
}