import { json, readBody, readJsonBody } from '../responses.js';
import {
  chatToClient,
  deleteUserChat,
  discardUnusedSession,
  listSessions,
  loadChatForUser,
  newChatForUser,
  renameUserChat,
  setUserChatArchived,
  updateSummary,
} from '../../services/chat-service.js';
import { loadSettings } from '../../services/model-settings-service.js';
import { compressChatNow } from '../../services/summary-service.js';
import { isLossySummary } from '../../domain/chat.js';
import { friendlyError } from '../../shared/utils.js';
import {
  SESSION_IMPORT_MAX_BYTES,
  buildSessionExport,
  importSessionArchive,
} from '../../services/session-transfer-service.js';

// An empty session exists so a directory can be bound before the first message.
export function handleCreateSession(req, res, user) {
  return json(res, 201, chatToClient(newChatForUser(user.id)));
}

/**
 * Deletes a session only if it is still an unused create-and-nothing-else row.
 *
 * Separate from `DELETE /api/sessions/:id` (which the user invokes on purpose)
 * because this one is a cleanup after a failed bind: it must be a no-op for a
 * row that a turn wrote into or that a binding actually reached. The guard is
 * a single SQL statement, so it cannot be raced by a turn or a bind that lands
 * between the client's check and this call.
 */
export function handleDiscardUnusedSession(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  const removed = discardUnusedSession(user.id, chat.id);
  return json(res, 200, { ok: true, removed });
}

export function handleListSessions(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const archived = url.searchParams.get('archived') === '1';
  return json(res, 200, listSessions(user.id, { archived }));
}

const SESSION_TITLE_MAX = 60;

function normalizeSessionTitle(value) {
  if (typeof value !== 'string') return { error: 'title 必须是字符串' };
  const title = value
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return { error: '会话名称不能为空' };
  if (Array.from(title).length > SESSION_TITLE_MAX) {
    return { error: `会话名称不能超过 ${SESSION_TITLE_MAX} 个字符` };
  }
  return { title };
}

export async function handleSession(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  if (req.method === 'GET') return json(res, 200, chatToClient(chat));
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { error: '请求体必须是 JSON 对象' });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      const result = normalizeSessionTitle(body.title);
      if (result.error) return json(res, 400, { error: result.error });
      const ok = renameUserChat(user.id, chat.id, result.title);
      if (!ok) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, { ok: true, title: result.title });
    }
    if (typeof body.archived !== 'boolean') {
      return json(res, 400, { error: 'archived 必须是布尔值' });
    }
    const ok = setUserChatArchived(user.id, chat.id, body.archived);
    if (!ok) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { ok: true, archived: body.archived });
  }
  if (req.method === 'DELETE') {
    deleteUserChat(user.id, chat.id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method Not Allowed' });
}

export async function handleCompactSession(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  if (chat.archivedAt) return json(res, 409, { error: '归档会话恢复后才能压缩' });

  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    return json(res, 400, { error: '请先在「模型设置」中配置对话模型 API Key' });
  }

  // Manual compaction is the repair entry point. A card carrying a truncation
  // or excerpt marker is known to have dropped facts, so this explicit request
  // re-reads the original messages and rebuilds it; nothing is ever deleted, so
  // the rebuild can always recover what the card lost. The client may also ask
  // for it outright, which is how a user retries a card that merely looks thin.
  const body = await readJsonBody(req);
  const rebuild = body?.rebuild === true || isLossySummary(chat.summary);

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const result = await compressChatNow(chat, models.llm, controller.signal, {
      saveSummary: updateSummary,
      rebuild,
    });
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err?.code === 'COMPACTION_BUSY') {
      return json(res, 409, { error: err.message });
    }
    return json(res, 500, { error: friendlyError(err) });
  } finally {
    res.off('close', onClose);
  }
}


export async function handleExportSession(req, res, user, sessionId) {
  const result = await buildSessionExport(user, sessionId);
  const fallback = 'luma-session.zip';
  const encoded = encodeURIComponent(result.filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': result.buffer.length,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, no-store',
  });
  res.end(result.buffer);
}

export async function handleImportSession(req, res, user) {
  const buffer = await readBody(req, SESSION_IMPORT_MAX_BYTES);
  const session = await importSessionArchive(user, buffer);
  return json(res, 201, { ok: true, session });
}
