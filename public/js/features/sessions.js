import {
  api,
  el,
  els,
  formatTime,
  icon,
  setTitle,
  showChatView,
  state,
  toast,
} from '../core/index.js';
import { renderMessages } from './messages.js';
import { cancelStreamForNavigation } from './stream.js';
import { clearReference } from './reference.js';
import { closeSidebar } from './overlays.js';

export function setSessionInUrl(id) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function renderSessionList() {
  const archivedMode = state.sessionFilter === 'archived';
  els.sessionLabel.textContent = archivedMode ? '已归档' : '我的会话';
  els.archiveToggle.textContent = archivedMode ? '返回' : '已归档';
  els.archiveToggle.title = archivedMode ? '返回我的会话' : '查看已归档会话';
  els.archiveToggle.setAttribute(
    'aria-label',
    archivedMode ? '返回我的会话' : '查看已归档会话',
  );
  els.sessionList.innerHTML = '';
  if (!state.sessions.length) {
    els.sessionList.appendChild(
      el('div', 'session-empty', archivedMode ? '还没有归档的会话' : '还没有对话'),
    );
    return;
  }
  for (const s of state.sessions) {
    const item = el('button', 'session-item');
    item.dataset.id = s.id;
    if (s.id === state.sessionId) item.classList.add('active');

    if (s.cover) {
      const img = el('img', 'session-thumb');
      img.src = s.cover;
      img.alt = '';
      item.appendChild(img);
    } else {
      const thumb = el('div', 'session-thumb is-empty');
      thumb.appendChild(icon('spark'));
      item.appendChild(thumb);
    }

    const meta = el('div', 'session-meta');
    meta.appendChild(el('div', 'session-name', s.title || '新对话'));
    meta.appendChild(el('div', 'session-date', formatTime(s.updatedAt)));
    item.appendChild(meta);

    const actions = el('div', 'session-actions');
    if (archivedMode) {
      const restore = el('button', 'session-restore', '恢复');
      restore.type = 'button';
      restore.title = '恢复会话';
      restore.setAttribute('aria-label', `恢复 ${s.title || '新对话'}`);
      restore.addEventListener('click', (ev) => {
        ev.stopPropagation();
        restoreSession(s.id);
      });
      actions.appendChild(restore);
    } else {
      const archive = el('button', 'session-archive');
      archive.type = 'button';
      archive.title = '归档对话';
      archive.setAttribute('aria-label', `归档 ${s.title || '新对话'}`);
      archive.appendChild(icon('archive'));
      archive.addEventListener('click', (ev) => {
        ev.stopPropagation();
        archiveSession(s.id);
      });
      actions.appendChild(archive);
    }

    const del = el('button', 'session-del', '×');
    del.type = 'button';
    del.title = archivedMode ? '永久删除' : '删除对话';
    del.setAttribute('aria-label', `${archivedMode ? '永久删除' : '删除'} ${s.title || '新对话'}`);
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSession(s.id);
    });
    actions.appendChild(del);
    item.appendChild(actions);

    item.addEventListener('click', () => openSession(s.id));
    els.sessionList.appendChild(item);
  }
}

export function markActiveSession() {
  for (const node of els.sessionList.querySelectorAll('.session-item')) {
    node.classList.toggle('active', node.dataset.id === state.sessionId);
  }
}

export async function refreshSessions() {
  try {
    const query = state.sessionFilter === 'archived' ? '?archived=1' : '';
    state.sessions = await api(`/api/sessions${query}`);
    renderSessionList();
  } catch (error) {
    toast(error.message);
  }
}

export async function toggleSessionFilter() {
  state.sessionFilter = state.sessionFilter === 'archived' ? 'active' : 'archived';
  await refreshSessions();
}

export function newChatView() {
  cancelStreamForNavigation();
  state.chatArchived = false;
  if (state.sessionFilter !== 'active') {
    state.sessionFilter = 'active';
    void refreshSessions();
  }
  showChatView();
  state.sessionId = null;
  setSessionInUrl(null);
  state.messages = [];
  state.summary = '';
  state.summaryUpto = 0;
  clearReference();
  setTitle('新对话');
  renderMessages();
  markActiveSession();
  closeSidebar();
  els.input.focus();
}

export async function openSession(id) {
  if (state.streaming && id === state.sessionId) {
    showChatView();
    closeSidebar();
    els.input.focus();
    return true;
  }
  cancelStreamForNavigation();
  try {
    const session = await api(`/api/sessions/${id}`);
    state.chatArchived = Boolean(session.archivedAt);
    showChatView();
    state.sessionId = session.id;
    setSessionInUrl(session.id);
    state.messages = session.messages || [];
    state.summary = session.summary || '';
    state.summaryUpto = session.summaryUpto || 0;
    clearReference();
    setTitle(session.title || '对话');
    renderMessages();
    markActiveSession();
    closeSidebar();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

export async function archiveSession(id) {
  try {
    await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    if (state.sessionId === id) newChatView();
    await refreshSessions();
    toast('会话已归档');
  } catch (error) {
    toast(error.message);
  }
}

export async function restoreSession(id) {
  try {
    await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    if (state.sessionId === id) {
      state.chatArchived = false;
      showChatView();
    }
    state.sessionFilter = 'active';
    await refreshSessions();
    toast('会话已恢复');
  } catch (error) {
    toast(error.message);
  }
}

export async function deleteSession(id) {
  const archivedMode = state.sessionFilter === 'archived';
  if (!confirm(archivedMode ? '永久删除这个已归档会话？' : '删除这个对话？')) return;
  try {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.sessionId === id) newChatView();
    await refreshSessions();
  } catch (error) {
    toast(error.message);
  }
}
