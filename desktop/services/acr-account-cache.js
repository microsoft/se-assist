'use strict';

// Read-through cache for per-account × service × month ACR results
// (getAccountMonthlyServiceAcr), keyed by TPID. Lets the customer analysis engine
// reuse a previously-fetched consumption snapshot when offline, reliably keyed by
// the exact TPID that was queried — not a fuzzy account-name match against the
// territory rollups. Backed by the acr_account_service_cache table (migration 014).
//
// Pure data-access with the database handle injected, so it is unit-testable
// without a live Electron/SQLite runtime. Every read discloses cached_at so callers
// can label offline reuse honestly (repo policy: no silent fallback).

/**
 * Persist a successful live ACR result for one account. Only call this with a
 * result that actually has services — never cache an empty/failed fetch (that would
 * clobber a good cached row with nothing).
 *
 * @param {object} database  better-sqlite3 handle (prepare()).
 * @param {string|number} tpid  The single account TPID that was queried.
 * @param {object} result  getAccountMonthlyServiceAcr shape { services, months, grandTotal, ... }.
 * @returns {boolean} true if a row was written.
 */
function upsertAcrAccountServiceCache(database, tpid, result) {
  const id = String(tpid || '').trim();
  if (!database || !id || !result || !Array.isArray(result.services) || result.services.length === 0) {
    return false;
  }
  const months = Array.isArray(result.months) ? result.months : [];
  const fiscalYears = String(result.fiscalYear || (Array.isArray(result.fiscalYears) ? result.fiscalYears.join(' + ') : '') || '');
  const level = Number(result.level) || 2;
  const grandTotal = Number(result.grandTotal) || 0;
  const latestMonth = months.length ? months[months.length - 1] : null;

  database.prepare(
    `INSERT INTO acr_account_service_cache
       (tpid, fiscal_years, level, grand_total, latest_month, payload_json, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tpid) DO UPDATE SET
       fiscal_years = excluded.fiscal_years,
       level        = excluded.level,
       grand_total  = excluded.grand_total,
       latest_month = excluded.latest_month,
       payload_json = excluded.payload_json,
       cached_at    = CURRENT_TIMESTAMP`,
  ).run(id, fiscalYears, level, grandTotal, latestMonth, JSON.stringify(result));
  return true;
}

/**
 * Read the cached ACR result for one account, if any. Returns null when there is no
 * row, the payload is unparseable, or it holds no services (so the engine treats it
 * as "no consumption" rather than empty data).
 *
 * @returns {{ payload: object, cachedAt: string, fiscalYears: string, level: number }|null}
 */
function readAcrAccountServiceCache(database, tpid) {
  const id = String(tpid || '').trim();
  if (!database || !id) return null;
  let row;
  try {
    row = database.prepare(
      'SELECT payload_json, cached_at, fiscal_years, level FROM acr_account_service_cache WHERE tpid = ?',
    ).get(id);
  } catch {
    return null;
  }
  if (!row || !row.payload_json) return null;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.services) || payload.services.length === 0) return null;
  return {
    payload,
    cachedAt: row.cached_at || null,
    fiscalYears: row.fiscal_years || '',
    level: Number(row.level) || 2,
  };
}

module.exports = { upsertAcrAccountServiceCache, readAcrAccountServiceCache };
