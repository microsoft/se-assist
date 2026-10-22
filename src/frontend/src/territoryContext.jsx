import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { dbQuery } from './electronBridge';
import { SSP_NAMES_SQL, milestoneMatchesScope } from './lib/milestoneMetrics';

// Fired (on window) whenever the signed-in user's identity may have just been written
// to app_settings — e.g. after a CRM sync. The provider re-reads identity on this event
// so the Territory toggle enables itself without needing an app reload.
export const IDENTITY_UPDATED_EVENT = 'se-assist:identity-updated';

// Fired (on window) whenever the configured SSPs change — e.g. after saving in
// User Home → SSP Configuration. The provider re-reads the SSP name set so Discover mode
// reflects the change live, without an app reload.
export const SSP_UPDATED_EVENT = 'se-assist:ssp-updated';

// Global "territory scope" used by the Dashboard, Milestone Map, Milestone Timeline,
// Milestones table, and HoK Activities. It cycles through three states:
//   'all'      -> the full territory (every milestone in the book).
//   'mine'     -> only milestones where the signed-in user is the owner or on the deal team.
//   'discover' -> the complement of 'mine': milestones the user is NOT on the deal team of
//                 (candidates to join). Same population as 'all' minus 'mine'.
// `myOnly` (= scope === 'mine') and `discover` (= scope === 'discover') are derived for
// consumers. This intentionally does NOT affect the customer comprehensive summary
// generator — that always operates over the full account data.
const TerritoryContext = createContext(null);

const SCOPE_KEY = 'seassist.scope';
const LEGACY_MYONLY_KEY = 'seassist.myOnly'; // pre-3-state boolean, migrated on first read
const SCOPES = ['all', 'mine', 'discover'];

function readInitialScope() {
  const s = localStorage.getItem(SCOPE_KEY);
  if (SCOPES.includes(s)) return s;
  // Migrate the old boolean toggle: true -> 'mine', false -> 'all'. Default is 'mine'.
  const legacy = localStorage.getItem(LEGACY_MYONLY_KEY);
  return legacy === 'false' ? 'all' : 'mine';
}

export function TerritoryProvider({ children }) {
  const [scope, setScope] = useState(readInitialScope);
  const [currentUserName, setCurrentUserName] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [sspNames, setSspNames] = useState([]); // distinct configured SSP display names

  // Load the signed-in user's identity (persisted on CRM sync) so views can scope to
  // "my" milestones and the nav toggle can enable/disable itself.
  const loadIdentity = useCallback(() => {
    return dbQuery("SELECT key, value FROM app_settings WHERE key IN ('current_user_name','current_user_id')")
      .then((rows) => {
        for (const r of rows || []) {
          if (r.key === 'current_user_name' && r.value) setCurrentUserName(r.value);
          if (r.key === 'current_user_id' && r.value) setCurrentUserId(r.value);
        }
      })
      .catch(() => {});
  }, []);

  // Load the configured SSP names (single source of truth for Discover mode), sorted for
  // stable filter quick-pick ordering.
  const loadSspNames = useCallback(() => {
    return dbQuery(SSP_NAMES_SQL)
      .then((rows) => setSspNames(
        [...new Set((rows || []).map((r) => (r.person_name || '').trim()).filter(Boolean))].sort(),
      ))
      .catch(() => {});
  }, []);

  useEffect(() => { loadIdentity(); loadSspNames(); }, [loadIdentity, loadSspNames]);

  // Identity is written to app_settings during a CRM sync, which can happen AFTER this
  // provider has already mounted (e.g. the first sync of a session). Without this, the
  // Territory toggle stays greyed out until the app is reloaded. Re-read on the event.
  useEffect(() => {
    const onIdentity = () => { loadIdentity(); };
    const onSsp = () => { loadSspNames(); };
    window.addEventListener(IDENTITY_UPDATED_EVENT, onIdentity);
    window.addEventListener(SSP_UPDATED_EVENT, onSsp);
    return () => {
      window.removeEventListener(IDENTITY_UPDATED_EVENT, onIdentity);
      window.removeEventListener(SSP_UPDATED_EVENT, onSsp);
    };
  }, [loadIdentity, loadSspNames]);

  useEffect(() => {
    localStorage.setItem(SCOPE_KEY, scope);
  }, [scope]);

  // Cycle order matches the toggle's display order: All → My → Discover → All.
  const cycleScope = useCallback(() => {
    setScope((s) => (s === 'all' ? 'mine' : s === 'mine' ? 'discover' : 'all'));
  }, []);

  const myOnly = scope === 'mine';
  const discover = scope === 'discover';
  // Backward-compat shim for any consumer that still flips a boolean: true → 'mine',
  // false → 'all'. Supports the functional-updater form the old toggle used.
  const setMyOnly = useCallback((v) => {
    setScope((s) => {
      const next = typeof v === 'function' ? v(s === 'mine') : v;
      return next ? 'mine' : 'all';
    });
  }, []);

  const sspNameSet = useMemo(() => new Set(sspNames), [sspNames]);
  // Whether the current scope actually prunes the milestone list (used to skip work when 'all').
  const scopeFiltersMilestones = (scope === 'mine' && !!currentUserName) || scope === 'discover';
  // Bound scope predicate — the single source of truth for My/Discover/All membership.
  const matchesScope = useCallback(
    (m) => milestoneMatchesScope(m, { scope, currentUserName, sspNameSet }),
    [scope, currentUserName, sspNameSet],
  );

  const value = {
    scope, setScope, cycleScope, myOnly, discover, setMyOnly,
    currentUserName, currentUserId,
    sspNames, sspNameSet, scopeFiltersMilestones, matchesScope,
  };
  return <TerritoryContext.Provider value={value}>{children}</TerritoryContext.Provider>;
}

export function useTerritory() {
  const ctx = useContext(TerritoryContext);
  if (!ctx) {
    return {
      scope: 'all', setScope: () => {}, cycleScope: () => {},
      myOnly: false, discover: false, setMyOnly: () => {},
      currentUserName: '', currentUserId: '',
      sspNames: [], sspNameSet: new Set(), scopeFiltersMilestones: false, matchesScope: () => true,
    };
  }
  return ctx;
}
