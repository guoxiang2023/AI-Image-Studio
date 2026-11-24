import { json, readJsonBody } from '../responses.js';
import { prepareChatTurn, runPreparedTurn } from '../../services/chat-turn-service.js';
import { acquireTurn } from '../../services/turn-lock.js';

export async function handleChat(req, res, user) {
  const body = await readJsonBody(req);

  // The claim must follow the chat that actually runs, which is not always
  // body.sessionId: prepareChatTurn creates a chat when the id is absent OR
  // when it does not resolve (stale, deleted, another user's). Tracking the
  // claimed id — rather than merely whether a claim exists — is what makes the
  // stale case safe; a truthy-but-unused id used to leave the real chat
  // unlocked.
  let release = null;
  let claimedId = null;

  /** Returns the busy error instead of throwing, so the caller can answer 409. */
  const claim = (chatId) => {
    try {
      release = acquireTurn(chatId);
      claimedId = chatId;
      return null;
    } catch (err) {
      if (err?.code === 'TURN_BUSY') return err;
      throw err;
    }
  };

  // Claim before preparing: the turn appends its user message as soon as it
  // runs, and a second tab must not slip through during preparation.
  if (body.sessionId) {
    const busy = claim(body.sessionId);
    // The SSE status line has not been written yet, so a real 409 is possible.
    if (busy) return json(res, 409, { error: busy.message });
  }

  let prepared;
  try {
    prepared = await prepareChatTurn(user, body);
  } catch (err) {
    release?.();
    throw err;
  }

  if (claimedId !== prepared.chat.id) {
    // Either there was no sessionId, or the one supplied did not resolve and a
    // new chat replaced it. Either way the new chat is persisted and its id is
    // announced in the opening `session` event, so it must be claimed before
    // anything is sent to the client.
    release?.();
    release = null;
    claimedId = null;
    const busy = claim(prepared.chat.id);
    if (busy) return json(res, 409, { error: busy.message });
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const emit = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 15000);

  try {
    await runPreparedTurn({
      user,
      prepared,
      emit,
      signal: controller.signal,
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    release?.();
  }
}
