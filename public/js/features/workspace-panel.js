import { api, els, state, toast } from '../core/index.js';
import { refreshSessions } from './sessions.js';
import { bindWorkspaceForView, isSameWorkspaceTarget, workspaceTarget } from './workspace-session.js';

// The directory comes from the native picker in the desktop shell; the web app
// has no such bridge and never exposes this control.
function desktopBridge() {
  return typeof window === 'undefined' ? null : window.lumaDesktop || null;
}

export function workspaceAvailable() {
  return Boolean(state.workspaceEnabled && desktopBridge()?.pickDirectory);
}

export function renderWorkspace() {
  if (!els.workspaceBtn) return;
  // Both gates must hold: the deployment allows local reads, and this browser
  // context has the native picker bridge. A web tab gets neither.
  const usable = Boolean(state.workspaceEnabled && desktopBridge());
  els.workspaceBtn.hidden = !usable;
  if (!usable) return;
  const root = state.workspace?.root || '';
  // The full path is what disambiguates two checkouts with the same folder
  // name; the basename alone ("imageGen") is ambiguous once a project has more
  // than one copy. Middle-ellipsis keeps both the root and the leaf readable.
  els.workspaceBtnLabel.textContent = root ? shortenPath(root) : '工作目录';
  els.workspaceBtn.title = root
    ? `已绑定：${root}（点击更换或解除）`
    : '绑定本地工作目录，让 Luma 按需读取项目文件';
  els.workspaceBtn.classList.toggle('active', Boolean(root));
}

export async function loadWorkspaceStatus() {
  try {
    const data = await api('/api/workspace/status');
    state.workspaceEnabled = Boolean(data.enabled);
  } catch {
    state.workspaceEnabled = false;
  }
  renderWorkspace();
}

/**
 * Re-reads the binding of whichever session the view is on now.
 *
 * The chip is per-session state, and `state.sessionId` can change without a
 * view switch: a chat turn's `session` event adopts the new chat it just
 * created, and a `done` event can carry the persisted id. Rendering the old
 * binding after that paints one chat's folder onto another chat.
 *
 * Best-effort and only when the id is still the one asked for, so a slow
 * response cannot overwrite a newer switch.
 */
export async function syncWorkspaceForSession(sessionId) {
  if (!sessionId) {
    state.workspace = null;
    renderWorkspace();
    return;
  }
  try {
    const session = await api(`/api/sessions/${sessionId}`);
    if (state.sessionId !== sessionId) return;
    state.workspace = session.workspace || null;
  } catch {
    if (state.sessionId !== sessionId) return;
    state.workspace = null;
  }
  renderWorkspace();
}

/**
 * Keeps the start and end of a long path so the bound directory stays
 * identifiable in a one-line chip: /Users/me/…/Workspace/imageGen.
 */
function shortenPath(value, limit = 46) {
  const path = String(value || '');
  if (path.length <= limit) return path;
  const head = Math.ceil((limit - 1) * 0.45);
  const tail = limit - 1 - head;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

function normalizePath(value) {
  return String(value || '').replace(/\/+$/, '');
}

// Binds a directory for the view the user is looking at. The id is published
// only after the bind lands (see workspace-session.js for why ordering matters).
async function publishSession(id) {
  state.sessionId = id;
  const url = new URL(location.href);
  url.searchParams.set('session', id);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function bindDirectory(sessionId, directory) {
  return api(`/api/sessions/${sessionId}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: directory }),
  });
}

async function unbind(sessionId, requested) {
  await api(`/api/sessions/${sessionId}/workspace`, { method: 'DELETE' });
  // Only repaint the chip if the screen is still on the session this delete was
  // for. A slow unbind of A followed by navigation to B used to erase B's chip
  // and toast about a session the user had already left.
  if (isSameWorkspaceTarget(requested, workspaceTarget(state))) {
    state.workspace = null;
    renderWorkspace();
    toast('已解除工作目录');
  }
  // The list hides a row that just lost its binding and has no message; that is
  // true regardless of which view is on screen now.
  await refreshSessions().catch(() => {});
}

/**
 * Binds `directory` for the view currently on screen.
 *
 * Exported separately from the picker because the native directory dialog
 * cannot be driven from a test or a headless run: everything that decides
 * ordering, publishing and cleanup lives here, and `toggleWorkspace` is only
 * the picker in front of it.
 */
export async function bindDirectoryForView(directory) {
  // Anything awaited below can outlive this view: the user may switch sessions,
  // or a chat turn may adopt a session via its `session` event, while the bind
  // request is open. The identity captured here is checked again before any
  // state is applied, so a late answer can never paint onto a newer screen.
  const requested = workspaceTarget(state);
  const outcome = await bindWorkspaceForView({
    currentId: state.sessionId,
    directory: normalizePath(directory),
    create: async () => {
      const session = await api('/api/sessions', { method: 'POST' });
      return session.id;
    },
    // Guarded server-side: removes the row only while it is still empty,
    // unbound and unarchived, so a bind that actually landed is never deleted.
    discard: (id) => api(`/api/sessions/${id}/discard`, { method: 'POST' }),
    bind: bindDirectory,
    isStillCurrent: () => isSameWorkspaceTarget(requested, workspaceTarget(state)),
  });

  // The bind landed. Apply it only if the user is still looking at the same
  // view AND the same session; otherwise this binding belongs to a session the
  // screen has moved away from.
  if (outcome.applied && isSameWorkspaceTarget(requested, workspaceTarget(state))) {
    if (!state.sessionId) await publishSession(outcome.id);
    state.workspace = outcome.bound.workspace || null;
    renderWorkspace();
    const count = outcome.bound.overview?.files ?? 0;
    const bound = state.workspace?.root || '';
    toast(
      count
        ? `已绑定 ${bound} · ${count} 个文本文件`
        : `已绑定工作目录${bound ? `：${bound}` : ''}`,
    );
  }
  // A session created for this bind was invisible to the list until the binding
  // existed. Refresh either way: the row is real even when the user has moved to
  // another view, and leaving it unfetched would hide a live binding until the
  // next switch.
  await refreshSessions().catch(() => {});
  return outcome;
}

export async function toggleWorkspace() {
  if (!workspaceAvailable()) {
    toast('工作目录仅在桌面端可用');
    return;
  }
  const bridge = desktopBridge();
  // Captured before the picker: the dialog is modal and can be open for a long
  // time, during which a turn may bind this view to its own session.
  const requested = workspaceTarget(state);
  try {
    if (state.workspace) {
      const again = window.confirm(
        `当前已绑定：${state.workspace.root || state.workspace.name}\n\n确定＝解除绑定；取消＝换一个目录。`,
      );
      if (again && state.sessionId) {
        await unbind(state.sessionId, requested);
        return;
      }
    }
    const directory = await bridge.pickDirectory();
    if (!directory) return;
    // After the picker: an unbind or a session switch may have happened while
    // the dialog was open, in which case this bind no longer belongs here.
    if (!isSameWorkspaceTarget(requested, workspaceTarget(state))) return;
    await bindDirectoryForView(directory);
  } catch (error) {
    if (isSameWorkspaceTarget(requested, workspaceTarget(state))) toast(error.message);
  }
}

export function clearWorkspaceView() {
  state.workspace = null;
  renderWorkspace();
}