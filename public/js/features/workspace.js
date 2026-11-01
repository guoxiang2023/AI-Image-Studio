import {
  api,
  autoGrow,
  els,
  renderModels,
  setTitle,
  showChatView,
  state,
  toast,
  updateSendButton,
} from '../core/index.js';
import { newChatView, openSession, refreshSessions } from './sessions.js';
import { renderParams } from './params.js';
import { clearReference } from './reference.js';
import { loadSkills, updateSkillChip } from './skills.js';

export async function enterApp(user) {
  state.user = user;
  els.authView.hidden = true;
  els.bootView.hidden = true;
  els.appShell.hidden = false;
  els.userName.textContent = user.username;
  els.userAvatar.textContent = Array.from(user.username)[0]?.toUpperCase() || '?';
  await initWorkspace();
}

export async function initWorkspace() {
  state.config = null;
  state.sessions = [];
  state.sessionId = null;
  state.messages = [];
  state.summary = '';
  state.summaryUpto = 0;
  state.streaming = false;
  state.gallery = { images: [], folders: [], activeFolder: 'all', query: '', favoriteOnly: false };
  state.options = { aspectRatio: null, count: null, quality: null };
  state.templateId = null;
  state.skills = [];
  state.skillId = null;
  if (els.gallerySearch) els.gallerySearch.value = '';
  if (els.galleryFavFilter) els.galleryFavFilter.classList.remove('active');
  renderParams();
  showChatView();
  clearReference();
  setTitle('新对话');
  els.messages.innerHTML = '';

  try {
    state.config = await api('/api/config');
  } catch (error) {
    toast(error.message);
  }
  renderModels();

  await loadSkills();
  await refreshSessions();
  const requestedSession = new URLSearchParams(location.search).get('session');
  const restoreSession =
    requestedSession && state.sessions.some((session) => session.id === requestedSession);
  if (restoreSession) await openSession(requestedSession);
  else if (state.sessions.length) await openSession(state.sessions[0].id);
  else newChatView();

  autoGrow();
  updateSendButton();
  if (window.matchMedia('(min-width: 861px)').matches) els.input.focus();

  if (state.config && (!state.config.llm.apiKeySet || !state.config.image.apiKeySet)) {
    toast('请先在「模型设置」中填写模型 API Key');
  }
}

export function resetWorkspace() {
  state.user = null;
  state.config = null;
  state.sessions = [];
  state.sessionId = null;
  state.messages = [];
  state.skills = [];
  state.skillId = null;
  state.options = { aspectRatio: null, count: null, quality: null };
  renderParams();
  updateSkillChip();
  clearReference();
  els.messages.innerHTML = '';
}
