// Renderer-local light/dark appearance preference. Persisted in localStorage and
// applied to <html data-theme="…"> so the CSS design-token layer in index.css swaps
// instantly. A custom event lets the FluentProvider (main.jsx) switch its base theme
// in step — the same persist-and-broadcast pattern used by navPrefs and territory.

const STORAGE_KEY = 'se-assist:theme';
export const THEME_PREFS_EVENT = 'se-assist:theme-updated';
const VALID = ['light', 'dark'];
const DEFAULT_THEME = 'light';

// The saved appearance ('light' | 'dark'), defaulting to light.
export function getTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

// Reflect a theme onto the document root so the CSS variables cascade everywhere
// (including Fluent portals rendered into <body>). Safe to call before React mounts.
export function applyTheme(theme) {
  const t = VALID.includes(theme) ? theme : DEFAULT_THEME;
  try { document.documentElement.setAttribute('data-theme', t); } catch { /* no DOM */ }
  return t;
}

// Persist, apply, and broadcast a theme change. Returns the cleaned value stored.
export function setTheme(theme) {
  const t = VALID.includes(theme) ? theme : DEFAULT_THEME;
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
  applyTheme(t);
  try { window.dispatchEvent(new CustomEvent(THEME_PREFS_EVENT, { detail: t })); } catch { /* ignore */ }
  return t;
}
