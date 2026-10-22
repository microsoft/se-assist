// Renderer-local preference for which sidebar tabs the user has chosen to hide.
// Persisted in localStorage and broadcast via a custom event so the sidebar
// (App.jsx) re-renders live when the User Home customizer changes the set —
// the same pattern used by territoryContext and msxAutoSync.
import { LOCKED_PATHS } from './navConfig';

const STORAGE_KEY = 'se-assist:hidden-nav';
const DEFAULT_HIDDEN_NAV = [
  '/action-center', '/deep-research', '/milestone-map', '/milestone-timeline', '/products', '/accelerators',
];
export const NAV_PREFS_EVENT = 'se-assist:nav-prefs-updated';

// localStorage key (read through usePersistedState) for whether the sidebar is
// minimized to icons only. Remembered across launches; the sidebar starts full width.
export const SIDEBAR_MINIMIZED_KEY = 'se-assist:sidebar-minimized';

// Returns the list of hidden tab paths. Locked tabs are always filtered out so a
// stale/edited value can never hide a tab that must stay visible. New users start
// with Action Center and its Deep Research sub-page, the two Milestone sub-views (Map,
// Timeline), Microsoft Products, and Solutions hidden — the Milestone views are reachable
// from links on the Milestones page, so they stay discoverable without cluttering the
// sidebar by default.
export function getHiddenNav() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [...DEFAULT_HIDDEN_NAV];
  }

  if (raw === null) return [...DEFAULT_HIDDEN_NAV];

  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => typeof p === 'string' && !LOCKED_PATHS.includes(p));
  } catch {
    return [];
  }
}

// Persists the hidden set (de-duplicated, locked paths removed) and notifies
// listeners. Returns the cleaned array that was actually stored.
export function setHiddenNav(paths) {
  const clean = Array.isArray(paths)
    ? [...new Set(paths.filter((p) => typeof p === 'string' && !LOCKED_PATHS.includes(p)))]
    : [];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(NAV_PREFS_EVENT, { detail: clean })); } catch { /* ignore */ }
  return clean;
}
