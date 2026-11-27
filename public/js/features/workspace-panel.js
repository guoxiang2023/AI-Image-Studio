import { api, el, els, icon, notifyUnauthorized, state, toast } from '../core/index.js';
import { refreshSessions } from './sessions.js';
import { bindWorkspaceForView, isSameWorkspaceTarget, workspaceTarget } from './workspace-session.js';

let browserView = null;

function clearWorkspaceImage() {
  const image = els.workspaceBrowserImage;
  if (image.hasAttribute('src')) URL.revokeObjectURL(image.src);
  image.removeAttribute('src');
  image.hidden = true;
}

/**
 * Unloads the preview frame.
 *
 * `src` has to go, not just `hidden`: a page left loaded keeps painting and can
 * still finish navigations, and the next file opened would be framed on top of
 * stale content. `about:blank` is the one value that reliably clears it.
 */
function clearWorkspaceFrame() {
  const frame = els.workspaceBrowserFrame;
  frame.hidden = true;
  if (frame.getAttribute('src') !== 'about:blank') frame.setAttribute('src', 'about:blank');
}

function closeWorkspaceBrowser() {
  browserView?.request?.abort();
  browserView = null;
  els.workspaceBrowser.hidden = true;
  els.workspaceBrowseBtn.setAttribute('aria-expanded', 'false');
  els.workspaceBrowserPath.textContent = '';
  els.workspaceBrowserPath.removeAttribute('title');
  els.workspaceBrowserList.replaceChildren();
  els.workspaceBrowserText.textContent = '';
  clearWorkspaceImage();
  clearWorkspaceFrame();
  els.workspaceBrowserStatus.textContent = '';
}

function renderDirectory(view, data) {
  const entries = document.createDocumentFragment();
  for (const entry of data.entries) {
    const item = el('li');
    const row = el(entry.kind === 'file' ? 'span' : 'button', 'workspace-browser-entry');
    row.append(icon(entry.kind === 'directory' ? 'folder' : 'document'), el('span', '', entry.name));
    if (entry.kind === 'file') {
      row.append(el('small', '', '无预览'));
    } else {
      row.type = 'button';
      row.title = entry.name;
      row.addEventListener('click', () => {
        const path = view.directory ? `${view.directory}/${entry.name}` : entry.name;
        if (entry.kind === 'directory') {
          view.directory = path;
          view.offset = 0;
        } else {
          view.file = path;
          view.fileKind = entry.kind;
          view.page = 1;
          view.shownPage = 0;
          view.totalPages = 0;
        }
        void loadWorkspaceBrowser();
      });
    }
    item.append(row);
    entries.append(item);
  }

  view.offset = data.offset;
  view.previous = data.previous;
  view.next = data.next;
  els.workspaceBrowserList.replaceChildren(entries);
  els.workspaceBrowserList.hidden = !data.entries.length;
  els.workspaceBrowserStatus.textContent = data.entries.length ? '' : '此目录没有可显示的文件';
  els.workspaceBrowserPages.hidden = data.previous === null && data.next === null;
  els.workspaceBrowserPrev.disabled = data.previous === null;
  els.workspaceBrowserNext.disabled = data.next === null;
  els.workspaceBrowserCount.textContent = `${data.offset + 1}–${data.offset + data.entries.length} / ${data.total}`;
}

function syncPdfPager(view) {
  const total = view.totalPages;
  if (!total) {
    els.workspaceBrowserPages.hidden = true;
    return;
  }
  els.workspaceBrowserPages.hidden = total <= 1;
  els.workspaceBrowserPrev.disabled = view.page <= 1;
  els.workspaceBrowserNext.disabled = view.page >= total;
  els.workspaceBrowserCount.textContent = `${view.page} / ${total}`;
}

async function renderMedia(view, url, signal, current) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `无法预览文件 (${response.status})`);
  }
  const blob = await response.blob();
  if (!current()) return;

  // Decode into a detached image first: the picture already on screen stays
  // visible until the replacement is known to be good, so a failed page shows
  // its error next to readable content instead of an empty panel.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const probe = new Image();
    probe.src = objectUrl;
    await probe.decode();
  } catch {
    URL.revokeObjectURL(objectUrl);
    if (!current()) return;
    throw new Error('图片无法显示，文件可能已损坏');
  }
  if (!current()) {
    URL.revokeObjectURL(objectUrl);
    return;
  }

  const image = els.workspaceBrowserImage;
  if (image.hasAttribute('src')) URL.revokeObjectURL(image.src);
  image.alt = view.file.split('/').at(-1);
  image.src = objectUrl;
  image.hidden = false;
  view.shownFile = view.file;
  els.workspaceBrowserStatus.textContent = '';

  if (view.fileKind === 'pdf') {
    view.page = Number(response.headers.get('X-Preview-Page'));
    const total = Number(response.headers.get('X-Preview-Total-Pages'));
    // Kept so a later page that fails can fall back to this one instead of
    // leaving the panel blank with no way back.
    view.shownPage = view.page;
    view.totalPages = total;
    syncPdfPager(view);
  }
}

/**
 * Renders an HTML file in the sandboxed frame.
 *
 * The page is loaded from the raw route, not from the preview route: the panel
 * needs the browser to parse and lay it out, and relative assets like
 * `style.css` have to resolve next to it. The frame carries
 * `sandbox="allow-same-origin"` with no `allow-scripts`, so even markup that
 * tries to run something stays inert.
 *
 * `load` never fires for a page the server refused; the frame then shows the
 * browser's own error, so the status line explains the likely cause instead.
 */
function renderPage(view, request, current) {
  const frame = els.workspaceBrowserFrame;
  view.shownFile = view.file;
  els.workspaceBrowserStatus.textContent = '正在渲染网页…';
  frame.addEventListener('load', () => {
    if (!current()) return;
    els.workspaceBrowserStatus.textContent = '网页预览 · 脚本已禁用';
  }, { once: true });
  frame.hidden = false;
  frame.setAttribute('src', `/api/sessions/${view.sessionId}/workspace/raw/${encodePath(view.file)}`);
}

/** Encodes each segment so a `#` or `?` in a filename stays part of the path. */
function encodePath(relative) {
  return String(relative).split('/').map(encodeURIComponent).join('/');
}

/** Kinds served as bytes rather than JSON. */
function isMediaKind(kind) {
  return kind === 'image' || kind === 'pdf' || kind === 'cad';
}

async function loadWorkspaceBrowser() {
  const view = browserView;
  if (!view) return;
  view.request?.abort();
  const request = new AbortController();
  view.request = request;
  const query = new URLSearchParams(view.file
    ? { file: view.file }
    : { directory: view.directory, offset: view.offset });
  if (view.fileKind === 'pdf' && view.file) query.set('page', view.page);
  const url = `/api/sessions/${view.sessionId}/workspace?${query}`;
  const location = [state.workspace.name || view.root, view.file || view.directory].filter(Boolean).join(' / ');
  els.workspaceBrowserPath.textContent = location;
  els.workspaceBrowserPath.title = location;
  els.workspaceBrowserBack.disabled = !view.file && !view.directory;
  els.workspaceBrowserStatus.textContent = '正在读取…';
  els.workspaceBrowserList.hidden = true;
  els.workspaceBrowserText.hidden = true;
  // Only drop the picture when the view moved to another file. For a PDF page
  // turn the current page stays up until the next one decodes, so a failed page
  // leaves something readable on screen.
  if (view.file !== view.shownFile) {
    clearWorkspaceImage();
    view.shownFile = '';
  }
  els.workspaceBrowserPages.hidden = true;
  if (view.fileKind !== 'html') clearWorkspaceFrame();
  const current = () => browserView === view && !request.signal.aborted &&
    isSameWorkspaceTarget(view, workspaceTarget(state)) && view.root === state.workspace?.root;

  try {
    if (view.file && view.fileKind === 'html') {
      renderPage(view, request, current);
    } else if (view.file && isMediaKind(view.fileKind)) {
      await renderMedia(view, url, request.signal, current);
    } else {
      const data = await api(url, { signal: request.signal });
      if (!current()) return;
      if (view.file) {
        const office = view.fileKind === 'office';
        els.workspaceBrowserStatus.textContent = office
          ? (data.truncated ? '内容预览 · 仅显示开头' : '内容预览')
          : (data.truncated ? '仅显示文件开头' : '');
        els.workspaceBrowserText.textContent = data.content;
        els.workspaceBrowserText.hidden = false;
      } else {
        renderDirectory(view, data);
      }
    }
    if (!current()) return;
    els.workspaceBrowserBody.scrollTop = 0;
  } catch (error) {
    if (!current()) return;
    els.workspaceBrowserStatus.textContent = error.message;
    // A PDF page that failed to render must not take the pager with it: restore
    // the controls, and put the page number back on the one still on screen so
    // "next" can be retried instead of scrolling into nothing.
    if (view.fileKind === 'pdf' && view.shownPage) {
      view.page = view.shownPage;
      syncPdfPager(view);
    }
  }
}

export function bindWorkspaceBrowserEvents() {
  const close = () => {
    closeWorkspaceBrowser();
    els.workspaceBrowseBtn.focus();
  };
  els.workspaceBrowseBtn.addEventListener('click', () => {
    if (browserView) {
      close();
      return;
    }
    if (!workspaceAvailable() || !state.sessionId || !state.workspace?.root) return;
    browserView = { ...workspaceTarget(state), root: state.workspace.root, directory: '', file: '', offset: 0 };
    els.workspaceBrowser.hidden = false;
    els.workspaceBrowseBtn.setAttribute('aria-expanded', 'true');
    void loadWorkspaceBrowser();
  });
  els.workspaceBrowserClose.addEventListener('click', close);
  els.workspaceBrowser.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  els.workspaceBrowserRefresh.addEventListener('click', loadWorkspaceBrowser);
  els.workspaceBrowserBack.addEventListener('click', () => {
    if (!browserView) return;
    if (browserView.file) {
      browserView.file = '';
      browserView.fileKind = '';
      browserView.shownPage = 0;
      browserView.totalPages = 0;
      browserView.shownFile = '';
    } else {
      browserView.directory = browserView.directory.substring(0, browserView.directory.lastIndexOf('/'));
      browserView.offset = 0;
    }
    void loadWorkspaceBrowser();
  });
  for (const [button, direction, field] of [
    [els.workspaceBrowserPrev, -1, 'previous'],
    [els.workspaceBrowserNext, 1, 'next'],
  ]) {
    button.addEventListener('click', () => {
      if (!browserView) return;
      if (browserView.file && browserView.fileKind === 'pdf') {
        const next = browserView.page + direction;
        const total = browserView.totalPages || next;
        browserView.page = Math.min(Math.max(1, next), total);
      } else {
        if (browserView[field] == null) return;
        browserView.offset = browserView[field];
      }
      void loadWorkspaceBrowser();
    });
  }
}

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
  const root = state.workspace?.root || '';
  const browsable = usable && Boolean(root && state.sessionId);
  els.workspaceBrowseBtn.hidden = !browsable;
  if (browserView && (!browsable || root !== browserView.root ||
    !isSameWorkspaceTarget(browserView, workspaceTarget(state)))) {
    closeWorkspaceBrowser();
  }
  els.workspaceBtn.hidden = !usable;
  if (!usable) return;
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
  const requested = workspaceTarget(state);
  state.workspace = null;
  renderWorkspace();
  if (!sessionId) return;
  try {
    const session = await api(`/api/sessions/${sessionId}`);
    if (!isSameWorkspaceTarget(requested, workspaceTarget(state))) return;
    state.workspace = session.workspace || null;
  } catch {
    if (!isSameWorkspaceTarget(requested, workspaceTarget(state))) return;
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