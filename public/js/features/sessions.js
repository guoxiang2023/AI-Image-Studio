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
import { setSkillId } from './skills.js';

export function setSessionInUrl(id) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function renderSessionList() {
  els.sessionList.innerHTML = '';
  if (!state.sessions.length) {
    els.sessionList.appendChild(el('div', 'session-empty', '还没有对话'));
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
      const thumb = el('div', 'session-thumb empty');
      thumb.appendChild(icon('spark'));
      item.appendChild(thumb);
    }

    const meta = el('div', 'session-meta');
    meta.appendChild(el('div', 'session-name', s.title || '新对话'));
    meta.appendChild(el('div', 'session-date', formatTime(s.updatedAt)));
    item.appendChild(meta);

    const del = el('button', 'session-del', '×');
    del.title = '删除对话';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSession(s.id);
    });
    item.appendChild(del);

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
    state.sessions = await api('/api/sessions');
    renderSessionList();
  } catch (error) {
    toast(error.message);
  }
}

export function newChatView() {
  cancelStreamForNavigation();
  showChatView();
  state.sessionId = null;
  setSessionInUrl(null);
  state.messages = [];
  state.summary = '';
  state.summaryUpto = 0;
  setSkillId(null);
  clearReference();
  setTitle('新对话');
  renderMessages();
  markActiveSession();
  closeSidebar();
  els.input.focus();
}

export async function openSession(id) {
  cancelStreamForNavigation();
  showChatView();
  try {
    const session = await api(`/api/sessions/${id}`);
    state.sessionId = session.id;
    setSessionInUrl(session.id);
    state.messages = session.messages || [];
    state.summary = session.summary || '';
    state.summaryUpto = session.summaryUpto || 0;
    setSkillId(session.skillId || null);
    clearReference();
    setTitle(session.title || '对话');
    renderMessages();
    markActiveSession();
    closeSidebar();
  } catch (error) {
    toast(error.message);
  }
}

export async function deleteSession(id) {
  if (!confirm('删除这个对话？')) return;
  try {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.sessionId === id) newChatView();
    await refreshSessions();
  } catch (error) {
    toast(error.message);
  }
}
