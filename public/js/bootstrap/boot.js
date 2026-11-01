import { els, setUnauthorizedHandler, state, updateSendButton } from '../core/index.js';
import { enterApp } from '../features/workspace.js';
import { showAuth } from '../features/auth.js';
import { bindEvents } from './events.js';

export async function boot() {
  setUnauthorizedHandler(showAuth);
  bindEvents();
  updateSendButton();

  try {
    const res = await fetch('/api/auth/status');
    state.authStatus = res.ok ? await res.json() : null;
  } catch {
    state.authStatus = null;
  }

  let user = null;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      user = data.user;
    }
  } catch {
    user = null;
  }

  if (user) {
    try {
      await enterApp(user);
    } catch {
      showAuth('login');
    }
  } else {
    showAuth();
    els.bootView.hidden = true;
  }
}
