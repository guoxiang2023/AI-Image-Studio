import { readJsonBody } from '../responses.js';
import { prepareChatTurn, runPreparedTurn } from '../../services/chat-turn-service.js';

export async function handleChat(req, res, user) {
  const body = await readJsonBody(req);
  const prepared = await prepareChatTurn(user, body);

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
  }
}
