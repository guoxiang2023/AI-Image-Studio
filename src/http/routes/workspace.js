import { json, readJsonBody } from '../responses.js';
import { loadChatForUser, setChatWorkspace } from '../../services/chat-service.js';
import {
  bindWorkspace,
  isWorkspaceEnabled,
  serializeWorkspace,
  workspaceOverview,
} from '../../services/workspace-service.js';

// A local directory read is a second gate beyond the desktop capability flag:
// the request must come from the same machine. A future bug that flips the flag
// on a networked deployment still cannot be reached from a remote client.
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '');
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    /^::ffff:127\./i.test(address)
  );
}

export function handleWorkspaceStatus(req, res) {
  return json(res, 200, { enabled: isWorkspaceEnabled() && isLoopback(req) });
}

export async function handleWorkspace(req, res, user, sessionId) {
  if (!isWorkspaceEnabled() || !isLoopback(req)) {
    return json(res, 403, { error: '当前版本不支持工作目录，请使用桌面端' });
  }
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });

  if (req.method === 'DELETE') {
    setChatWorkspace(user.id, chat.id, '');
    return json(res, 200, { ok: true, workspace: null });
  }
  if (req.method !== 'PUT') return json(res, 405, { error: 'Method Not Allowed' });

  const body = await readJsonBody(req);
  const workspace = await bindWorkspace(body?.path);
  const overview = await workspaceOverview(workspace);
  const workspaceJson = serializeWorkspace(workspace);
  setChatWorkspace(user.id, chat.id, workspaceJson);
  return json(res, 200, {
    ok: true,
    workspace,
    overview: {
      files: overview.files,
      bytes: overview.bytes,
      truncated: overview.truncated,
      languages: overview.languages,
    },
  });
}