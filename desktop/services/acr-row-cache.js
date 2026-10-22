'use strict';

// Persistent read-through cache for raw ACR row fetches (fetchRows in
// acr-querydata.js), keyed by the full query spec. ACR is a monthly-grain model,
// so a fetched result stays valid for days — persisting it to SQLite means the
// Consumption surfaces load from the local database across app restarts and only
// re-hit Power BI when the cached rows are older than the freshness window (or the
// user forces a refresh). Backed by the acr_row_cache table (migration 015).
//
// Pure data-access with the database handle injected, so it is unit-testable
// without a live Electron/SQLite runtime. Every read returns pulled_at so callers
// can log/disclose that a local (cached) result is being used instead of a live
// pull (repo policy: no silent fallback).

// SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS". Parse it as UTC so age
// math is correct regardless of the machine's local timezone.
function parseSqliteUtc(ts) {
  if (!ts) return NaN;
  const s = String(ts).trim();
  // Already ISO-with-zone? Let Date handle it. Otherwise normalize to ISO UTC.
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

/**
 * Read the cached rows for a query spec, if present and (optionally) fresh.
 *
 * @param {object} database  better-sqlite3 handle (prepare()).
 * @param {string} key       Deterministic cache key for the query spec.
 * @param {number} [ttlMs]   Freshness window; rows older than this are treated as
 *                           a miss (return null) so the caller re-pulls live.
 * @returns {{ rows: object[], pulledAt: string, ageMs: number }|null}
 */
function readRowCache(database, key, ttlMs) {
  if (!database || !key) return null;
  let row;
  try {
    row = database
      .prepare('SELECT rows_json, pulled_at FROM acr_row_cache WHERE cache_key = ?')
      .get(key);
  } catch {
    return null;
  }
  if (!row || !row.rows_json || !row.pulled_at) return null;

  const pulledMs = parseSqliteUtc(row.pulled_at);
  if (Number.isNaN(pulledMs)) return null;
  const ageMs = Date.now() - pulledMs;
  if (ttlMs != null && ageMs > ttlMs) return null; // stale → force a fresh pull

  let rows;
  try {
    rows = JSON.parse(row.rows_json);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return { rows, pulledAt: row.pulled_at, ageMs };
}

/**
 * Persist a successful live row fetch for a query spec, stamping a fresh
 * pulled_at. Never call this with a failed fetch — only cache real results.
 *
 * @param {object} database  better-sqlite3 handle.
 * @param {string} key       Deterministic cache key for the query spec.
 * @param {object[]} rows    Shaped rows returned by the query.
 * @returns {boolean} true if a row was written.
 */
function writeRowCache(database, key, rows) {
  if (!database || !key || !Array.isArray(rows)) return false;
  try {
    database
      .prepare(
        `INSERT INTO acr_row_cache (cache_key, rows_json, row_count, pulled_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(cache_key) DO UPDATE SET
           rows_json = excluded.rows_json,
           row_count = excluded.row_count,
           pulled_at = CURRENT_TIMESTAMP`,
      )
      .run(key, JSON.stringify(rows), rows.length);
    return true;
  } catch {
    return false;
  }
}

function deleteRowCache(database, key) {
  if (!database || !key) return false;
  try {
    database.prepare('DELETE FROM acr_row_cache WHERE cache_key = ?').run(key);
    return true;
  } catch {
    return false;
  }
}

function deleteRowCacheByPrefix(database, prefix) {
  if (!database || !prefix) return false;
  try {
    database
      .prepare('DELETE FROM acr_row_cache WHERE substr(cache_key, 1, ?) = ?')
      .run(prefix.length, prefix);
    return true;
  } catch {
    return false;
  }
}

/**
 * List cache-key metadata (key + pulled_at + row_count) for every persisted
 * entry whose key begins with `prefix` — used to discover cached supersets that
 * can satisfy a related query when a live pull is unavailable. Rows are not
 * loaded here; read the chosen key with readRowCache once selected.
 *
 * @param {object} database  better-sqlite3 handle.
 * @param {string} prefix    Leading substring to match (e.g. the identity key prefix).
 * @returns {{ key: string, pulledAt: string, rowCount: number }[]}
 */
function listRowCacheKeysByPrefix(database, prefix) {
  if (!database || !prefix) return [];
  try {
    return database
      .prepare('SELECT cache_key, pulled_at, row_count FROM acr_row_cache WHERE substr(cache_key, 1, ?) = ?')
      .all(prefix.length, prefix)
      .map((row) => ({ key: row.cache_key, pulledAt: row.pulled_at, rowCount: row.row_count }));
  } catch {
    return [];
  }
}

function scopedLegacyCacheKey(key, identity) {
  const cleanIdentity = String(identity || '').trim().toLowerCase();
  if (!key || !cleanIdentity) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(key));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.identity != null) return null;
  const required = ['fy', 'month', 'tpids', 'cols', 'sf'];
  if (!required.every((field) => Object.prototype.hasOwnProperty.call(parsed, field))) {
    return null;
  }
  return JSON.stringify({
    identity: cleanIdentity,
    fy: parsed.fy,
    month: parsed.month,
    tpids: parsed.tpids,
    cols: parsed.cols,
    sf: parsed.sf,
  });
}

function claimLegacyRowCache(database, identity) {
  const cleanIdentity = String(identity || '').trim().toLowerCase();
  if (!database || !cleanIdentity) return { claimed: 0, skipped: 'missing-identity' };
  try {
    const saved = database.prepare(
      `SELECT value FROM app_settings WHERE key = 'signed_in_user_upn'`,
    ).get();
    if (String(saved?.value || '').trim().toLowerCase() !== cleanIdentity) {
      return { claimed: 0, skipped: 'identity-mismatch' };
    }
    const marker = database.prepare(
      `SELECT value FROM app_settings WHERE key = 'acr_legacy_cache_claimed_for'`,
    ).get();
    if (marker?.value) {
      return {
        claimed: 0,
        skipped: String(marker.value).trim().toLowerCase() === cleanIdentity
          ? 'already-claimed'
          : 'claimed-by-another-identity',
      };
    }
    const legacyRows = database.prepare('SELECT cache_key FROM acr_row_cache').all()
      .map((row) => ({
        oldKey: row.cache_key,
        newKey: scopedLegacyCacheKey(row.cache_key, cleanIdentity),
      }))
      .filter((row) => row.newKey);
    if (!legacyRows.length) return { claimed: 0, skipped: 'no-legacy-rows' };

    const migrate = database.transaction(() => {
      const update = database.prepare(
        'UPDATE OR IGNORE acr_row_cache SET cache_key = ? WHERE cache_key = ?',
      );
      const remove = database.prepare('DELETE FROM acr_row_cache WHERE cache_key = ?');
      let claimed = 0;
      for (const row of legacyRows) {
        const result = update.run(row.newKey, row.oldKey);
        if (result.changes) claimed += result.changes;
        else remove.run(row.oldKey);
      }
      database.prepare(
        `INSERT INTO app_settings (key, value)
         VALUES ('acr_legacy_cache_claimed_for', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(cleanIdentity);
      return claimed;
    });
    return { claimed: migrate(), skipped: null };
  } catch (error) {
    return { claimed: 0, skipped: 'migration-failed', error: error.message || String(error) };
  }
}

/**
 * One-time cache reset when the ACR Power BI model changes (e.g. the MSXI SL5
 * migration from model 6307665 → 6670867). The value semantics differ across a
 * migration (a new dataset, and organic-only AdjustmentFlag scoping), so any
 * rows cached from the previous model must not linger — permanent closed-month
 * rows would otherwise mix old and new numbers in the same series. Clears the
 * row cache and records the new model id; a no-op once the ids match.
 *
 * @param {object} database  better-sqlite3 handle.
 * @param {number|string} modelId  The current ACR_MODEL_ID.
 * @returns {{ cleared: boolean, removed?: number, previous?: string|null, error?: string }}
 */
function invalidateCacheOnModelChange(database, modelId) {
  if (!database || modelId == null || modelId === '') return { cleared: false };
  const current = String(modelId);
  try {
    const row = database
      .prepare("SELECT value FROM app_settings WHERE key = 'acr_model_id'")
      .get();
    const stored = row && row.value != null ? String(row.value) : null;
    if (stored === current) return { cleared: false, previous: stored };
    const reset = database.transaction(() => {
      const result = database.prepare('DELETE FROM acr_row_cache').run();
      database.prepare(
        `INSERT INTO app_settings (key, value)
         VALUES ('acr_model_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(current);
      return result && result.changes ? result.changes : 0;
    });
    return { cleared: true, removed: reset(), previous: stored };
  } catch (error) {
    return { cleared: false, error: error.message || String(error) };
  }
}

module.exports = {
  readRowCache,
  writeRowCache,
  deleteRowCache,
  deleteRowCacheByPrefix,
  listRowCacheKeysByPrefix,
  scopedLegacyCacheKey,
  claimLegacyRowCache,
  invalidateCacheOnModelChange,
  parseSqliteUtc,
};
