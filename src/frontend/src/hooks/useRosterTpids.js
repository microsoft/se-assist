import { useState, useEffect } from 'react';
import { getAccountRoster, ACCOUNT_ROSTER_CHANGED_EVENT } from '../electronBridge';

// The account roster (Settings → Default Accounts) is the authoritative list of
// TPIDs the user operates on. It lives in the local `tpid_config` table and can
// diverge from the `customers` table (which only holds accounts already synced
// from MSX). The ACR pages must reflect the full roster, so this hook exposes the
// saved roster TPIDs. Cached accounts must never be unioned into this list.
export function useRosterTpids() {
  const [tpids, setTpids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const load = async () => {
      const request = revision;
      try {
        const res = await getAccountRoster();
        if (cancelled || request !== revision) return;
        if (!Array.isArray(res?.tpids)) throw new Error('The desktop returned an invalid active roster.');
        const ids = res.tpids
          .map((t) => String(t == null ? '' : t).trim())
          .filter(Boolean);
        setTpids([...new Set(ids)]);
        setError(null);
      } catch (e) {
        if (!cancelled && request === revision) { setTpids([]); setError(e.message || 'Could not load active accounts.'); }
      } finally {
        if (!cancelled && request === revision) setLoading(false);
      }
    };
    const changed = (event) => {
      revision++;
      setTpids(event.detail.tpids);
      setError(null);
      setLoading(false);
    };
    load();
    window.addEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, changed);
    return () => { cancelled = true; window.removeEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, changed); };
  }, []);

  return { rosterTpids: tpids, loading, error };
}
