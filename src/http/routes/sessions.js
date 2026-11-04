import { json, readJsonBody } from '../responses.js';
import {
  chatToClient,
  deleteUserChat,
  listSessions,
  loadChatForUser,
  setUserChatArchived,
} from '../../services/chat-service.js';

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
