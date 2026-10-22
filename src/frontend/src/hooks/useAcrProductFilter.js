import { useState, useEffect, useCallback } from 'react';
import { dbQuery, dbRun } from '../electronBridge';

// Persistent, app-wide ACR product (Service Level 2) filter.
//
// Stored in the app_settings(key, value) SQLite table under a single JSON key
// so it survives restarts and applies to BOTH the Azure Consumption page and
// each per-account ACR subpage. Cross-page reactivity within a session is
// achieved with a window CustomEvent that every mounted hook instance listens
// for — so applying the filter on one page immediately updates the other.

const SETTING_KEY = 'acr_product_filter';
const CHANGE_EVENT = 'acr-product-filter-changed';
const DEFAULT_FILTER = { level: 2, services: [] };

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FILTER };
  const level = [1, 2, 3, 4, 5].includes(Number(raw.level)) ? Number(raw.level) : 2;
  const services = Array.isArray(raw.services)
    ? [...new Set(raw.services.map((s) => String(s || '').trim()).filter(Boolean))]
    : [];
  return { level, services };
}

/**
 * @returns {{
 *   filter: { level: number, services: string[] },
 *   loading: boolean,
 *   error: string|null,
 *   setFilter: (next: { level?: number, services: string[] }) => Promise<void>,
 *   clear: () => Promise<void>,
 * }}
 */
export function useAcrProductFilter() {
  const [filter, setFilterState] = useState(DEFAULT_FILTER);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await dbQuery('SELECT value FROM app_settings WHERE key = ?', [SETTING_KEY]);
      if (rows && rows.length && rows[0].value) {
        setFilterState(normalize(JSON.parse(rows[0].value)));
      } else {
        setFilterState({ ...DEFAULT_FILTER });
      }
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load product filter');
      setFilterState({ ...DEFAULT_FILTER });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Sync across every mounted instance in this window.
  useEffect(() => {
    const handler = (e) => setFilterState(normalize(e.detail));
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);

  const persist = useCallback(async (next) => {
    const normalized = normalize(next);
    const json = JSON.stringify(normalized);
    await dbRun(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      [SETTING_KEY, json, json]
    );
    setFilterState(normalized);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: normalized }));
  }, []);

  const setFilter = useCallback((next) => persist(next), [persist]);
  const clear = useCallback(() => persist({ level: 2, services: [] }), [persist]);

  return { filter, loading, error, setFilter, clear };
}
