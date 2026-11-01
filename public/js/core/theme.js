const THEME_KEY = 'huajing-theme';

export function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}

try {
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark', false);
} catch {
  applyTheme('dark', false);
}
