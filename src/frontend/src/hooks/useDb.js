import { useState, useEffect, useCallback, useRef } from 'react';
import { dbQuery, dbRun, ACCOUNT_ROSTER_CHANGED_EVENT } from '../electronBridge';

/**
 * Hook for querying SQLite. Returns { data, loading, error, refresh }.
 */
export function useDbQuery(sql, params = [], deps = []) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  // True only until the first load resolves. Background refreshes (after a mutation)
  // leave this false so callers can keep their content mounted and avoid scroll jumps.
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const rows = await dbQuery(sql, params);
      if (request !== generation.current) return;
      setData(rows || []);
      setError(null);
    } catch (e) {
      if (request !== generation.current) return;
      setError(e.message || 'Query failed');
      setData([]);
    } finally {
      if (request === generation.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }, [sql, ...params, ...deps]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const changed = () => { setData([]); refresh(); };
    window.addEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, changed);
    return () => { generation.current++; window.removeEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, changed); };
  }, [refresh]);

  return { data, loading, initialLoading, error, refresh };
}

/**
 * Run a write operation (INSERT/UPDATE/DELETE).
 */
export async function runDb(sql, params = []) {
  return dbRun(sql, params);
}
