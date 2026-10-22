// Onboarding / first-run tutorial state — persisted in localStorage, mirroring the
// navPrefs/themePrefs pattern. Tracks whether the user has seen the guided setup, and
// lets any surface (e.g. User Home) request that the tutorial be (re)opened via an event
// the always-mounted App listener handles.

const STORAGE_KEY = 'se-assist:onboarding';
// Bump when the setup steps change materially, to re-surface the guide once for existing
// users. `seen` is only honored while the stored version matches this.
// v2: added step 7 (configure SSPs for accounts).
export const ONBOARDING_VERSION = 2;
// Event App listens for to open the tutorial on demand (from the User Home button).
export const OPEN_SETUP_EVENT = 'se-assist:open-setup';

export function getOnboarding() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { seen: false, version: 0 };
    const o = JSON.parse(raw);
    return { seen: !!o.seen, version: Number(o.version) || 0 };
  } catch {
    return { seen: false, version: 0 };
  }
}

// True on a genuine first run, or after ONBOARDING_VERSION is bumped (new steps added).
export function shouldAutoShowSetup() {
  const o = getOnboarding();
  return !o.seen || o.version < ONBOARDING_VERSION;
}

// Mark the guide as seen for this version so it stops auto-opening. The user can always
// reopen it from User Home.
export function markSetupSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ seen: true, version: ONBOARDING_VERSION, at: new Date().toISOString() }));
  } catch { /* ignore */ }
}

// Ask App to open the tutorial now (used by the User Home "Setup guide" button).
export function openSetupGuide() {
  try { window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT)); } catch { /* ignore */ }
}
