import { json, readJsonBody } from '../responses.js';
import { loadChatForUser, setChatWorkspace } from '../../services/chat-service.js';
import {
  bindWorkspace,
  browseWorkspace,
  isWorkspaceEnabled,
  serializeWorkspace,
  workspaceFromChat,
  workspaceOverview,
} from '../../services/workspace-service.js';
import { readHtmlAsset } from '../../services/workspace-html.js';

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

/**
 * Serves an HTML page and its page-local assets for the sandboxed preview frame.
 *
 * The URL is directory-shaped (`.../raw/sub/page.html`), so a relative
 * `style.css` inside the page resolves to a sibling request that lands here.
 * Every response overrides the app-wide `DENY` framing policy: the page is only
 * ever shown inside this app's own frame.
 */
export async function handleWorkspaceAsset(req, res, user, sessionId, rest) {
  if (!isWorkspaceEnabled() || !isLoopback(req)) {
    return json(res, 403, { error: '当前版本不支持工作目录，请使用桌面端' });
  }
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });
  const workspace = workspaceFromChat(chat);
  if (!workspace) return json(res, 409, { error: '当前会话没有绑定工作目录' });

  res.setHeader('Cache-Control', 'no-store');
  const asset = await readHtmlAsset(workspace, String(rest || ''));
  if (asset.notFound) return json(res, 404, { error: '找不到该路径' });

  // The global security headers deny framing unconditionally; a preview page has
  // to be framable by this app or it can never render. `readHtmlAsset` returns
  // the page-specific policy for exactly those two headers.
  for (const [name, value] of Object.entries(asset.headers || {})) res.setHeader(name, value);
  res.writeHead(200, {
    'Content-Type': asset.mediaType,
    'Content-Length': asset.buffer.length,
  });
  res.end(asset.buffer);
}

export async function handleWorkspace(req, res, user, sessionId, query) {
  if (!isWorkspaceEnabled() || !isLoopback(req)) {
    return json(res, 403, { error: '当前版本不支持工作目录，请使用桌面端' });
  }
  const chat = loadChatForUser(user.id, sessionId);
  if (!chat) return json(res, 404, { error: '会话不存在' });

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const workspace = workspaceFromChat(chat);
    if (!workspace) return json(res, 409, { error: '当前会话没有绑定工作目录' });
    const result = await browseWorkspace(workspace, {
      directory: query.get('directory') ?? '',
      file: query.get('file'),
      offset: query.get('offset'),
      page: query.get('page'),
    });
    if (result.buffer) {
      const headers = {
        'Content-Type': result.mediaType,
        'Content-Length': result.buffer.length,
      };
      if (result.page) {
        headers['X-Preview-Page'] = result.page;
        headers['X-Preview-Total-Pages'] = result.totalPages;
      }
      res.writeHead(200, headers);
      return res.end(result.buffer);
    }
    return json(res, 200, result);
  }

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