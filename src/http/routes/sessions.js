import { json, readBody, readJsonBody } from '../responses.js';
import {
  chatToClient,
  deleteUserChat,
  listSessions,
  loadChatForUser,
  setUserChatArchived,
  updateSummary,
} from '../../services/chat-service.js';
import { loadSettings } from '../../services/model-settings-service.js';
import { compressChatNow } from '../../services/summary-service.js';
import { friendlyError } from '../../shared/utils.js';
import {
  SESSION_IMPORT_MAX_BYTES,
  buildSessionExport,
  importSessionArchive,
} from '../../services/session-transfer-service.js';

export function handleListSessions(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const archived = url.searchParams.get('archived') === '1';
  return json(res, 200, listSessions(user.id, { archived }));
}

export async function handleSession(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  if (req.method === 'GET') return json(res, 200, chatToClient(chat));
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
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

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const result = await compressChatNow(chat, models.llm, controller.signal, {
      saveSummary: updateSummary,
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
