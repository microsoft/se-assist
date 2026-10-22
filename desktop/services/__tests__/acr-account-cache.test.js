'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  upsertAcrAccountServiceCache,
  readAcrAccountServiceCache,
} = require('../acr-account-cache');

// Minimal in-memory stand-in for a better-sqlite3 handle: it understands only the
// two statements the cache module issues, and stores rows in a Map keyed by tpid.
// This verifies the module's control flow (upsert-on-success, honest read, empty
// rejection) without a native SQLite build, so it runs anywhere `node --test` runs.
function makeFakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      const s = String(sql).trim();
      if (/^INSERT INTO acr_account_service_cache/i.test(s)) {
        return {
          run: (tpid, fiscalYears, level, grandTotal, latestMonth, payloadJson) => {
            rows.set(String(tpid), {
              tpid: String(tpid),
              fiscal_years: fiscalYears,
              level,
              grand_total: grandTotal,
              latest_month: latestMonth,
              payload_json: payloadJson,
              cached_at: `2026-07-14T00:00:0${rows.size}Z`,
            });
            return { changes: 1 };
          },
        };
      }
      if (/^SELECT payload_json, cached_at, fiscal_years, level FROM acr_account_service_cache/i.test(s)) {
        return { get: (tpid) => rows.get(String(tpid)) };
      }
      throw new Error(`unexpected sql: ${s}`);
    },
  };
}

const sampleResult = {
  fiscalYear: 'FY26 + FY27',
  fiscalYears: ['FY26', 'FY27'],
  level: 2,
  months: ['FY26-May', 'FY26-Jun'],
  services: [
    { service: 'Azure OpenAI', monthly: { 'FY26-May': 100, 'FY26-Jun': 180 }, total: 280 },
    { service: 'Storage', monthly: { 'FY26-May': 40, 'FY26-Jun': 35 }, total: 75 },
  ],
  grandTotal: 355,
};

test('upsert then read round-trips the payload and metadata', () => {
  const db = makeFakeDb();
  assert.strictEqual(upsertAcrAccountServiceCache(db, '12345', sampleResult), true);

  const hit = readAcrAccountServiceCache(db, '12345');
  assert.ok(hit, 'expected a cache hit');
  assert.strictEqual(hit.payload.services.length, 2);
  assert.strictEqual(hit.payload.grandTotal, 355);
  assert.strictEqual(hit.fiscalYears, 'FY26 + FY27');
  assert.strictEqual(hit.level, 2);
  assert.ok(hit.cachedAt, 'expected a cached_at timestamp');
});

test('tpid is coerced to string so numeric and string keys match', () => {
  const db = makeFakeDb();
  upsertAcrAccountServiceCache(db, 777, sampleResult); // numeric write
  assert.ok(readAcrAccountServiceCache(db, '777'), 'string read should hit numeric write');
});

test('never caches an empty or failed fetch', () => {
  const db = makeFakeDb();
  assert.strictEqual(upsertAcrAccountServiceCache(db, '1', { services: [] }), false);
  assert.strictEqual(upsertAcrAccountServiceCache(db, '1', null), false);
  assert.strictEqual(upsertAcrAccountServiceCache(db, '', sampleResult), false);
  assert.strictEqual(db.rows.size, 0, 'nothing should have been written');
});

test('read returns null when there is no row', () => {
  const db = makeFakeDb();
  assert.strictEqual(readAcrAccountServiceCache(db, 'missing'), null);
});

test('read rejects a cached payload that has no services', () => {
  const db = makeFakeDb();
  // Simulate a row whose payload somehow holds no services.
  db.rows.set('9', { payload_json: JSON.stringify({ services: [], months: [] }), cached_at: 'x', fiscal_years: '', level: 2 });
  assert.strictEqual(readAcrAccountServiceCache(db, '9'), null);
});

test('read tolerates an unparseable payload without throwing', () => {
  const db = makeFakeDb();
  db.rows.set('9', { payload_json: '{not json', cached_at: 'x', fiscal_years: '', level: 2 });
  assert.strictEqual(readAcrAccountServiceCache(db, '9'), null);
});

test('a later successful fetch overwrites the cached row', () => {
  const db = makeFakeDb();
  upsertAcrAccountServiceCache(db, '5', sampleResult);
  const bigger = { ...sampleResult, grandTotal: 999, services: [{ service: 'X', monthly: { 'FY26-Jun': 999 }, total: 999 }] };
  upsertAcrAccountServiceCache(db, '5', bigger);
  const hit = readAcrAccountServiceCache(db, '5');
  assert.strictEqual(hit.payload.grandTotal, 999);
  assert.strictEqual(db.rows.size, 1, 'should be a single upserted row');
});
