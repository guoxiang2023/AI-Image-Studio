import {
  api,
  el,
  els,
  formatTime,
  icon,
  notifyUnauthorized,
  scrollBottom,
  setTitle,
  showChatView,
  state,
  toast,
} from '../core/index.js';
import { prependSummaryNote, renderMessages } from './messages.js';
import { cancelStreamForNavigation } from './stream.js';
import { clearReference } from './reference.js';
import { clearAttachments } from './attachments.js';
import { closeSidebar } from './overlays.js';

export function setSessionInUrl(id) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

const IMPORT_MAX_BYTES = 96 * 1024 * 1024;
let importing = false;

function safeDownloadName(title) {
  const name = String(title || 'Luma 会话')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .replace(/[. ]+$/, '');
  return `${name || 'Luma 会话'}.luma-session.zip`;
}

function responseFilename(response, title) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      /* use the local fallback */
    }
  }
  return safeDownloadName(title);
}

export async function exportSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  try {
    toast('正在导出会话…');
    const response = await fetch(`/api/sessions/${id}/export`);
    if (response.status === 401) {
      notifyUnauthorized();
      throw new Error('请先登录');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '导出失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = responseFilename(response, session?.title);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('会话已导出');
  } catch (error) {
    toast(error.message);
  }
}

export async function importSessionFile(file) {
  if (!file || importing) return;
  if (!/\.zip$/i.test(file.name || '')) {
    toast('请选择 .zip 会话文件');
    return;
  }
  if (file.size > IMPORT_MAX_BYTES) {
    toast('会话文件不能超过 96MB');
    return;
  }

  importing = true;
  try {
    toast('正在导入会话…');
    const response = await fetch('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      notifyUnauthorized();
      throw new Error('请先登录');
    }
    if (!response.ok) throw new Error(data.error || '导入失败');
    state.sessionFilter = 'active';
    await refreshSessions();
    await openSession(data.session.id);
    toast(`已导入「${data.session.title}」`);
  } catch (error) {
    toast(error.message);
  } finally {
    importing = false;
    if (els.sessionImportInput) els.sessionImportInput.value = '';
  }
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

    const exportBtn = el('button', 'session-archive session-export');
    exportBtn.type = 'button';
    exportBtn.title = '导出会话';
    exportBtn.setAttribute('aria-label', `导出 ${s.title || '新对话'}`);
    exportBtn.appendChild(icon('download'));
    exportBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      exportSession(s.id);
    });
    actions.appendChild(exportBtn);

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

export function updateCompactButton() {
  if (!els.compactBtn) return;
  els.compactBtn.disabled = !state.sessionId || state.chatArchived;
  els.compactBtn.title = state.chatArchived
    ? '恢复会话后可压缩'
    : '压缩上下文，保留长期记忆';
}

export async function compactSession() {
  if (!state.sessionId) {
    toast('先打开一个会话');
    return;
  }
  if (state.streaming) {
    toast('请等待当前回复完成');
    return;
  }
  if (state.chatArchived) {
    toast('恢复会话后才能压缩');
    return;
  }

  const button = els.compactBtn;
  if (!button || button.disabled) return;
  button.disabled = true;
  button.classList.add('is-busy');
  toast('正在压缩上下文…');
  try {
    const result = await api(`/api/sessions/${state.sessionId}/compact`, { method: 'POST' });
    state.summary = result.summary || '';
    state.summaryUpto = result.upto || 0;
    prependSummaryNote();
    scrollBottom();
    toast(
      result.compacted
        ? result.fallback
          ? '摘要模型不可用，已用自动摘录压缩'
          : '上下文已压缩，较早内容已存入记忆'
        : '当前没有可压缩的上下文',
    );
  } catch (error) {
    toast(error.message);
  } finally {
    button.classList.remove('is-busy');
    updateCompactButton();
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
  clearAttachments();
  setTitle('新对话');
  renderMessages();
  markActiveSession();
  updateCompactButton();
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
    clearAttachments();
    setTitle(session.title || '对话');
    renderMessages();
    markActiveSession();
    updateCompactButton();
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
      updateCompactButton();
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
