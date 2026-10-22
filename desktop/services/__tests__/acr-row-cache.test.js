'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  readRowCache,
  writeRowCache,
  deleteRowCache,
  deleteRowCacheByPrefix,
  scopedLegacyCacheKey,
  claimLegacyRowCache,
  invalidateCacheOnModelChange,
  parseSqliteUtc,
} = require('../acr-row-cache');

// Minimal in-memory stand-in for a better-sqlite3 handle: understands only the two
// statements the row-cache module issues, storing rows in a Map keyed by cache_key.
// A settable `now` lets writes stamp a controllable pulled_at so freshness math is
// deterministic. Runs anywhere `node --test` runs (no native SQLite build).
function makeFakeDb() {
  const rows = new Map();
  const settings = new Map();
  const db = {
    rows,
    settings,
    now: Date.now(),
    transaction(fn) {
      return () => fn();
    },
    prepare(sql) {
      const s = String(sql).trim();
      if (/^SELECT value FROM app_settings/i.test(s)) {
        const m = s.match(/key\s*=\s*'([^']+)'/i);
        const key = m ? m[1] : null;
        return { get: () => (key && settings.has(key) ? { value: settings.get(key) } : undefined) };
      }
      if (/^SELECT cache_key FROM acr_row_cache/i.test(s)) {
        return { all: () => [...rows.keys()].map((cacheKey) => ({ cache_key: cacheKey })) };
      }
      if (/^UPDATE OR IGNORE acr_row_cache/i.test(s)) {
        return {
          run: (newKey, oldKey) => {
            if (!rows.has(String(oldKey)) || rows.has(String(newKey))) return { changes: 0 };
            const row = rows.get(String(oldKey));
            rows.delete(String(oldKey));
            rows.set(String(newKey), { ...row, cache_key: String(newKey) });
            return { changes: 1 };
          },
        };
      }
      if (/^INSERT INTO app_settings/i.test(s)) {
        const m = s.match(/VALUES\s*\(\s*'([^']+)'/i);
        const key = m ? m[1] : 'acr_legacy_cache_claimed_for';
        return { run: (value) => { settings.set(key, String(value)); return { changes: 1 }; } };
      }
      if (/^INSERT INTO acr_row_cache/i.test(s)) {
        return {
          run: (key, rowsJson, rowCount) => {
            rows.set(String(key), {
              cache_key: String(key),
              rows_json: rowsJson,
              row_count: rowCount,
              pulled_at: new Date(db.now).toISOString(),
            });
            return { changes: 1 };
          },
        };
      }
      if (/^SELECT rows_json, pulled_at FROM acr_row_cache/i.test(s)) {
        return { get: (key) => rows.get(String(key)) };
      }
      if (/^DELETE FROM acr_row_cache/i.test(s)) {
        return {
          run: (...args) => {
            if (/substr\(cache_key/i.test(s)) {
              const prefix = String(args[1]);
              let changes = 0;
              for (const key of [...rows.keys()]) {
                if (key.startsWith(prefix)) {
                  rows.delete(key);
                  changes += 1;
                }
              }
              return { changes };
            }
            if (!/WHERE/i.test(s)) {
              const changes = rows.size;
              rows.clear();
              return { changes };
            }
            return { changes: rows.delete(String(args[0])) ? 1 : 0 };
          },
        };
      }
      throw new Error(`unexpected sql: ${s}`);
    },
  };
  return db;
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const sampleRows = [
  { account: 'Contoso', fiscalMonth: 'FY26-May', acr: 1200 },
  { account: 'Contoso', fiscalMonth: 'FY26-Jun', acr: 1500 },
];

test('write then read round-trips the rows and pulled_at', () => {
  const db = makeFakeDb();
  assert.strictEqual(writeRowCache(db, 'k1', sampleRows), true);

  const hit = readRowCache(db, 'k1', SEVEN_DAYS);
  assert.ok(hit, 'expected a cache hit');
  assert.strictEqual(hit.rows.length, 2);
  assert.strictEqual(hit.rows[1].acr, 1500);
  assert.ok(hit.pulledAt, 'expected a pulled_at timestamp');
  assert.ok(hit.ageMs >= 0, 'expected a non-negative age');
});

test('rows older than the freshness window are treated as a miss', () => {
  const db = makeFakeDb();
  db.now = Date.now() - 8 * 24 * 60 * 60 * 1000; // pulled 8 days ago
  writeRowCache(db, 'stale', sampleRows);

  assert.strictEqual(readRowCache(db, 'stale', SEVEN_DAYS), null, 'stale rows must not be served');
  // ...but with no TTL supplied, the row is still returned (freshness ignored).
  const noTtl = readRowCache(db, 'stale', null);
  assert.ok(noTtl && noTtl.rows.length === 2, 'no-ttl read should still return the row');
});

test('rows within the freshness window are served', () => {
  const db = makeFakeDb();
  db.now = Date.now() - 3 * 24 * 60 * 60 * 1000; // pulled 3 days ago
  writeRowCache(db, 'fresh', sampleRows);
  const hit = readRowCache(db, 'fresh', SEVEN_DAYS);
  assert.ok(hit, 'rows pulled 3 days ago should still be fresh');
});

test('never caches a non-array payload', () => {
  const db = makeFakeDb();
  assert.strictEqual(writeRowCache(db, 'x', null), false);
  assert.strictEqual(writeRowCache(db, 'x', { not: 'array' }), false);
  assert.strictEqual(writeRowCache(db, '', sampleRows), false);
  assert.strictEqual(db.rows.size, 0, 'nothing should have been written');
});

test('caches an empty array (a valid "no consumption" result)', () => {
  const db = makeFakeDb();
  assert.strictEqual(writeRowCache(db, 'empty', []), true);
  const hit = readRowCache(db, 'empty', SEVEN_DAYS);
  assert.ok(hit && Array.isArray(hit.rows) && hit.rows.length === 0);
});

test('read returns null when there is no row', () => {
  const db = makeFakeDb();
  assert.strictEqual(readRowCache(db, 'missing', SEVEN_DAYS), null);
});

test('delete removes a persisted cache entry', () => {
  const db = makeFakeDb();
  writeRowCache(db, 'delete-me', sampleRows);
  assert.equal(deleteRowCache(db, 'delete-me'), true);
  assert.equal(readRowCache(db, 'delete-me', null), null);
});

test('prefix delete removes every cache entry for one identity', () => {
  const db = makeFakeDb();
  writeRowCache(db, '{"identity":"a",1}', sampleRows);
  writeRowCache(db, '{"identity":"a",2}', sampleRows);
  writeRowCache(db, '{"identity":"b",1}', sampleRows);
  assert.equal(deleteRowCacheByPrefix(db, '{"identity":"a",'), true);
  assert.equal(db.rows.size, 1);
  assert.ok(db.rows.has('{"identity":"b",1}'));
});

test('legacy cache ownership is claimed once for the remembered identity', () => {
  const db = makeFakeDb();
  const identity = 'user@example.com';
  const legacyKey = JSON.stringify({
    fy: ['FY26'],
    month: '',
    tpids: ['1'],
    cols: ['account', 'fiscalMonth', 'acr'],
    sf: '',
  });
  const expectedKey = JSON.stringify({
    identity,
    fy: ['FY26'],
    month: '',
    tpids: ['1'],
    cols: ['account', 'fiscalMonth', 'acr'],
    sf: '',
  });
  db.settings.set('signed_in_user_upn', identity);
  writeRowCache(db, legacyKey, sampleRows);

  assert.equal(scopedLegacyCacheKey(legacyKey, identity), expectedKey);
  assert.deepEqual(claimLegacyRowCache(db, identity), { claimed: 1, skipped: null });
  assert.equal(readRowCache(db, legacyKey, null), null);
  assert.equal(readRowCache(db, expectedKey, null).rows.length, 2);
  assert.equal(db.settings.get('acr_legacy_cache_claimed_for'), identity);
  assert.equal(claimLegacyRowCache(db, identity).skipped, 'already-claimed');
  assert.equal(claimLegacyRowCache(db, 'someoneelse@microsoft.com').skipped, 'identity-mismatch');
});

test('legacy cache is not claimed without a matching remembered identity', () => {
  const db = makeFakeDb();
  const legacyKey = JSON.stringify({
    fy: ['FY26'],
    month: '',
    tpids: ['1'],
    cols: ['account'],
    sf: '',
  });
  writeRowCache(db, legacyKey, sampleRows);
  const result = claimLegacyRowCache(db, 'user@example.com');
  assert.equal(result.skipped, 'identity-mismatch');
  assert.ok(readRowCache(db, legacyKey, null));
});

test('read tolerates an unparseable payload without throwing', () => {
  const db = makeFakeDb();
  db.rows.set('bad', { rows_json: '{not json', pulled_at: new Date().toISOString() });
  assert.strictEqual(readRowCache(db, 'bad', SEVEN_DAYS), null);
});

test('a later write overwrites the cached row and re-stamps pulled_at', () => {
  const db = makeFakeDb();
  db.now = Date.now() - 5 * 24 * 60 * 60 * 1000;
  writeRowCache(db, 'k', sampleRows);
  db.now = Date.now(); // fresh pull now
  writeRowCache(db, 'k', [{ account: 'New', fiscalMonth: 'FY26-Jul', acr: 42 }]);
  const hit = readRowCache(db, 'k', SEVEN_DAYS);
  assert.strictEqual(hit.rows.length, 1);
  assert.strictEqual(hit.rows[0].acr, 42);
  assert.strictEqual(db.rows.size, 1, 'should be a single upserted row');
});

test('parseSqliteUtc parses the CURRENT_TIMESTAMP format as UTC', () => {
  const ms = parseSqliteUtc('2026-07-14 04:30:00');
  assert.strictEqual(ms, Date.parse('2026-07-14T04:30:00Z'));
  // Already-zoned inputs pass through.
  assert.strictEqual(parseSqliteUtc('2026-07-14T04:30:00Z'), Date.parse('2026-07-14T04:30:00Z'));
  assert.ok(Number.isNaN(parseSqliteUtc('')), 'empty is NaN');
});

test('a changed ACR model id clears the cache once, then no-ops', () => {
  const db = makeFakeDb();
  writeRowCache(db, 'k1', sampleRows);
  writeRowCache(db, 'k2', sampleRows);
  assert.equal(db.rows.size, 2);

  // First run with the new model id: no marker yet → clear everything.
  const first = invalidateCacheOnModelChange(db, 6670867);
  assert.equal(first.cleared, true);
  assert.equal(first.previous, null);
  assert.equal(first.removed, 2);
  assert.equal(db.rows.size, 0, 'stale rows from the previous model must be cleared');
  assert.equal(db.settings.get('acr_model_id'), '6670867');

  // Fresh rows written against the new model survive a second check (same id).
  writeRowCache(db, 'k3', sampleRows);
  const second = invalidateCacheOnModelChange(db, 6670867);
  assert.equal(second.cleared, false, 'same model id must be a no-op');
  assert.equal(db.rows.size, 1, 'new-model rows must be preserved');
});

test('a later model migration clears the previous model\'s cache', () => {
  const db = makeFakeDb();
  db.settings.set('acr_model_id', '6307665'); // pretend we were on the old model
  writeRowCache(db, 'old', sampleRows);

  const result = invalidateCacheOnModelChange(db, 6670867);
  assert.equal(result.cleared, true);
  assert.equal(result.previous, '6307665');
  assert.equal(db.rows.size, 0);
  assert.equal(db.settings.get('acr_model_id'), '6670867');
});
