import { json } from '../responses.js';
import {
  chatToClient,
  deleteUserChat,
  listSessions,
  loadChatForUser,
} from '../../services/chat-service.js';

export function handleListSessions(req, res, user) {
  return json(res, 200, listSessions(user.id));
}

export async function handleSession(req, res, user, sessionId) {
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  if (req.method === 'GET') return json(res, 200, chatToClient(chat));
  if (req.method === 'DELETE') {
    deleteUserChat(user.id, chat.id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method Not Allowed' });
}
