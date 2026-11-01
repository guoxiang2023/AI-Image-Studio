import { el, els, state } from '../core/index.js';
import { enterApp, resetWorkspace } from './workspace.js';
import { cancelStreamForNavigation } from './stream.js';
import { closeSettings } from './settings.js';
import { closeTemplates } from './templates.js';
import { closeTagModal } from './gallery.js';
import { closeCompare } from './compare.js';
import { closeSidebar } from './overlays.js';

export function showAuth(mode) {
  els.appShell.hidden = true;
  els.authView.hidden = false;
  els.bootView.hidden = true;
  setAuthMode(
    mode || (state.authStatus && state.authStatus.hasUsers === false ? 'register' : 'login'),
  );
}

export function setAuthMode(mode) {
  const registrationOpen = state.authStatus?.registrationOpen !== false;
  const next = mode === 'register' && registrationOpen ? 'register' : 'login';
  state.authMode = next;
  const register = next === 'register';

  els.authTitle.textContent = register ? '创建账号' : '登录';
  els.authSub.textContent = register ? '注册后配置自己的模型即可使用' : '使用你的账号继续';
  els.authSubmit.textContent = register ? '注册并进入' : '登录';
  els.authConfirmRow.hidden = !register;
  els.authCodeRow.hidden = !register || !state.authStatus?.requiresCode;
  els.authTabs.hidden = !registrationOpen;
  els.authPass.autocomplete = register ? 'new-password' : 'current-password';

  for (const tab of els.authTabs.querySelectorAll('.auth-tab')) {
    tab.classList.toggle('active', tab.dataset.mode === next);
  }

  els.authError.hidden = true;
  els.authError.textContent = '';

  els.authNote.textContent = register ? '已有账号？' : '还没有账号？';
  if (registrationOpen) {
    const link = el('button', 'link', register ? '去登录' : '去注册');
    link.type = 'button';
    link.addEventListener('click', () => setAuthMode(register ? 'login' : 'register'));
    els.authNote.appendChild(link);
  }
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
}

export async function submitAuth(event) {
  event?.preventDefault();
  if (state.authPending) return;

  const register = state.authMode === 'register';
  const username = els.authUser.value.trim();
  const password = els.authPass.value;

  if (!username || !password) return showAuthError('请输入用户名和密码');
  if (register) {
    if (password.length < 8) return showAuthError('密码至少需要 8 位');
    if (password !== els.authPass2.value) return showAuthError('两次输入的密码不一致');
  }

  state.authPending = true;
  els.authSubmit.disabled = true;
  els.authError.hidden = true;

  try {
    const res = await fetch(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        code: els.authCodeRow.hidden ? '' : els.authCode.value.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    els.authForm.reset();
    await enterApp(data.user);
  } catch (error) {
    showAuthError(error.message);
  } finally {
    state.authPending = false;
    els.authSubmit.disabled = false;
  }
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  cancelStreamForNavigation();
  resetWorkspace();
  closeSettings();
  closeTemplates();
  closeTagModal();
  closeCompare();
  closeSidebar();
  showAuth('login');
}

export { showAuthError };
