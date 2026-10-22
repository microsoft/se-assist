'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcrService } = require('../acr-querydata');
const { ACR_MODEL_ID } = require('../acr-schema');
const roster = require('../../account-roster');
const { makeRosterDb } = require('./helpers/roster-db');

function makeFakeDb() {
  const rows = new Map();
  const appSettings = new Map();
  const db = {
    rows,
    appSettings,
    now: Date.now(),
    transaction(fn) { return (...args) => fn(...args); },
    prepare(sql) {
      const statement = String(sql).trim();
      if (/^SELECT value FROM app_settings/i.test(statement)) {
        const m = statement.match(/key\s*=\s*'([^']+)'/i);
        const key = m ? m[1] : null;
        return { get: () => (key && appSettings.has(key) ? { value: appSettings.get(key) } : undefined) };
      }
      if (/^INSERT INTO app_settings/i.test(statement)) {
        const m = statement.match(/VALUES\s*\(\s*'([^']+)'/i);
        const key = m ? m[1] : null;
        return { run: (value) => { if (key) appSettings.set(key, value == null ? null : String(value)); return { changes: 1 }; } };
      }
      if (/^INSERT INTO acr_row_cache/i.test(statement)) {
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
      if (/^SELECT rows_json, pulled_at FROM acr_row_cache/i.test(statement)) {
        return { get: (key) => rows.get(String(key)) };
      }
      if (/^SELECT cache_key, pulled_at, row_count FROM acr_row_cache WHERE substr/i.test(statement)) {
        return {
          all: (_len, prefix) => [...rows.values()]
            .filter((row) => String(row.cache_key).startsWith(String(prefix)))
            .map((row) => ({
              cache_key: row.cache_key,
              pulled_at: row.pulled_at,
              row_count: row.row_count,
            })),
        };
      }
      if (/^DELETE FROM acr_row_cache/i.test(statement)) {
        return {
          run: (...args) => {
            if (/substr\(cache_key/i.test(statement)) {
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
            if (!/WHERE/i.test(statement)) {
              const changes = rows.size;
              rows.clear();
              return { changes };
            }
            return { changes: rows.delete(String(args[0])) ? 1 : 0 };
          },
        };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
  return db;
}

function dsrResponse(select, rows) {
  let dimensionIndex = 0;
  let measureIndex = 0;
  const schema = select.map((entry) => ({
    N: entry.Column ? `G${dimensionIndex++}` : `M${measureIndex++}`,
  }));
  const names = select.map((entry) => entry.NativeReferenceName);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      results: [{
        result: {
          data: {
            descriptor: { Select: select.map(() => ({})) },
            dsr: {
              DS: [{
                PH: [{
                  DM0: rows.map((row, index) => ({
                    ...(index === 0 ? { S: schema } : {}),
                    C: names.map((name) => row[name] ?? (name === 'serviceLevel2' && row.serviceLevel4 ? 'Foundry Models' : null)),
                  })),
                }],
                IC: true,
              }],
            },
          },
        },
      }],
    }),
  };
}

function modelFetch(counter, value = 100) {
  return async (_url, options) => {
    counter.count += 1;
    const body = JSON.parse(options.body);
    const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
    return dsrResponse(select, [{
      serviceLevel4: 'gpt-5',
      fiscalMonth: 'FY26-Jun',
      acr: value,
    }]);
  };
}

test('actual background refresh holds the roster lease and archived requests cannot read its cached result', async t => {
  const db = makeRosterDb(t);
  roster.saveRoster(db, ['1']);
  let now = new Date();
  now.setDate(3);
  let requests = 0;
  let finish;
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    clock: () => now,
    validateTpids: tpids => roster.assertActiveTpids(db, tpids),
    beginAccountWork: roster.beginRosterWork,
    fetchImpl: async (_url, options) => {
      requests++;
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      const response = () => dsrResponse(select, [{ account: 'Current account', acr: 100 }]);
      if (requests === 1) return response();
      return new Promise(resolve => { finish = () => resolve(response()); });
    },
    logger: { info() {}, warn() {} },
  });
  t.after(async () => { finish?.(); await service.waitForBackgroundRefreshes(); });
  const selection = { tpids: ['1'], groupBy: ['account'], measures: ['acr'], period: 'latest' };
  await service.queryAcr(selection);
  now = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const cached = await service.queryAcr(selection);
  assert.equal(cached.cache.refreshing, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.throws(() => roster.saveRoster(db, []), /still running/);
  finish();
  await service.waitForBackgroundRefreshes();
  roster.saveRoster(db, []);
  await assert.rejects(service.queryAcr(selection), /archived/);
  assert.equal(requests, 2);
});

test('cold load remains pending until the live query completes', async () => {
  let resolveFetch;
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return new Promise((resolve) => {
        resolveFetch = () => resolve(dsrResponse(select, [{
          serviceLevel4: 'gpt-5',
          fiscalMonth: 'FY26-Jun',
          acr: 100,
        }]));
      });
    },
  });
  let settled = false;
  const pending = service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  }).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveFetch();
  const result = await pending;
  assert.equal(result.cache.status, 'live');
  assert.equal(result.models[0].model, 'gpt-5');
});

test('cache miss waits for live data and returns it on the first visit', async () => {
  const db = makeFakeDb();
  const counter = { count: 0 };
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(counter),
  });

  const first = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  });
  assert.equal(first.cache.status, 'live');
  assert.equal(first.cache.refreshing, false);
  assert.equal(first.models[0].model, 'gpt-5');
  assert.equal(counter.count, 1);
  const second = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  });
  assert.equal(second.cache.status, 'fresh');
  assert.equal(second.models[0].model, 'gpt-5');
  assert.equal(counter.count, 1);
});

// ── Empty results must never be cached ───────────────────────────────────────
// The ACR model can answer "0 rows" while it is mid-refresh, or while row-level
// security is not resolving the signed-in user. Persisting that emptiness made the
// app replay "$0" from cache on every later visit, so one bad moment pinned a whole
// fiscal-year selection at zero while selections cached earlier kept showing real
// numbers — exactly the confusing mix seen when toggling the FY filters.

function emptyFetch(counter) {
  return async (_url, options) => {
    counter.count += 1;
    const body = JSON.parse(options.body);
    const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
    return dsrResponse(select, []);
  };
}

test('an empty live result is not persisted, so the next visit retries live', async () => {
  const db = makeFakeDb();
  const counter = { count: 0 };
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: emptyFetch(counter),
  });

  const first = await service.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4 });
  assert.equal(first.models.length, 0, 'the empty live result is reported honestly');
  assert.equal(counter.count, 1);
  assert.equal(db.rows.size, 0, 'nothing empty may be written to the row cache');

  // Without the guard this second call would be served from cache and never retried.
  const second = await service.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4 });
  assert.equal(second.models.length, 0);
  assert.equal(counter.count, 2, 'a cached empty must not satisfy the next visit');
});

test('an empty live result never overwrites rows that were cached when data existed', async () => {
  const db = makeFakeDb();
  const goodCounter = { count: 0 };
  const good = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(goodCounter, 250),
  });
  await good.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4, force: true });
  assert.equal(db.rows.size, 1, 'real rows are cached');
  const cachedBefore = [...db.rows.values()][0].rows_json;

  // ACR now goes empty (dataset refreshing / RLS not resolving).
  const emptyCounter = { count: 0 };
  const degraded = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: emptyFetch(emptyCounter),
  });
  await degraded.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4, force: true });

  assert.equal(db.rows.size, 1, 'the good entry must survive');
  assert.equal(
    [...db.rows.values()][0].rows_json,
    cachedBefore,
    'an empty pull must not destroy previously-good cached rows',
  );
});

test('rows cached by an earlier build as empty are ignored rather than replayed', async () => {
  const db = makeFakeDb();
  // Simulate a poisoned entry written before this guard existed.
  const counter = { count: 0 };
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(counter, 400),
  });
  // Seed the cache key by doing a real pull, then blank its stored rows in place.
  await service.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4, force: true });
  const key = [...db.rows.keys()][0];
  db.rows.set(key, { ...db.rows.get(key), rows_json: '[]', row_count: 0 });

  // A fresh service (empty in-memory cache) must not serve the blank entry.
  const counter2 = { count: 0 };
  const fresh = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(counter2, 400),
  });
  const result = await fresh.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4 });
  assert.equal(counter2.count, 1, 'a blank cached entry must trigger a live re-query');
  assert.equal(result.models[0].model, 'gpt-5', 'and real data comes back');
});

test('closed historical fiscal years remain permanent after the 22-hour threshold', async () => {
  const db = makeFakeDb();
  db.now = Date.now() - 23 * 60 * 60 * 1000;
  const seedCounter = { count: 0 };
  const seed = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(seedCounter, 100),
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
    force: true,
  });

  const refreshCounter = { count: 0 };
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(refreshCounter, 200),
  });
  const stale = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  });
  assert.equal(stale.cache.status, 'fresh');
  assert.equal(stale.cache.refreshing, false);
  assert.equal(stale.models[0].total, 100);

  await service.waitForBackgroundRefreshes();
  assert.equal(refreshCounter.count, 0);
});

test('a month cached while open refreshes after close, then becomes permanent', async () => {
  const db = makeFakeDb();
  let now = new Date('2026-07-15T12:00:00Z');
  db.now = now.getTime();
  const seed = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 100,
      }]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  now = new Date('2026-08-02T12:00:00Z');
  db.now = now.getTime();
  const refreshCounter = { count: 0 };
  const refresh = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      refreshCounter.count += 1;
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 200,
      }]);
    },
  });
  const pending = await refresh.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  assert.equal(pending.cache.status, 'partial');
  assert.deepEqual(pending.models, []);
  await refresh.waitForBackgroundRefreshes();
  assert.equal(refreshCounter.count, 1);

  now = new Date('2026-08-05T12:00:00Z');
  db.now = now.getTime();
  const permanentCounter = { count: 0 };
  const permanent = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(permanentCounter, 300),
  });
  const result = await permanent.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  assert.equal(result.cache.status, 'fresh');
  assert.equal(result.models[0].total, 200);
  assert.equal(permanentCounter.count, 0);
});

test('month rollover keeps the month that was in-progress at pull time hidden', async () => {
  const db = makeFakeDb();
  db.now = Date.parse('2026-07-15T12:00:00Z');
  const seed = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 100,
      }]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  const service = createAcrService({
    getPowerBiToken: async () => {
      throw new Error('offline');
    },
    getDb: () => db,
  });
  const result = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  assert.equal(result.cache.status, 'partial');
  assert.deepEqual(result.models, []);
  await service.waitForBackgroundRefreshes();
});

test('persistent ACR cache is scoped to the remembered Microsoft identity', async () => {
  const db = makeFakeDb();
  let identity = 'first@microsoft.com';
  const counter = { count: 0 };
  const service = createAcrService({
    getCacheIdentity: () => identity,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: modelFetch(counter, 100),
  });
  await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
    force: true,
  });

  identity = 'second@microsoft.com';
  const secondIdentity = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  });
  assert.equal(secondIdentity.cache.status, 'live');
  assert.equal(secondIdentity.models[0].model, 'gpt-5');
  assert.equal(counter.count, 2);
});

test('missing identity cannot read, write, or refresh a shared cache namespace', async () => {
  let fetches = 0;
  const service = createAcrService({
    getCacheIdentity: () => null,
    getPowerBiToken: async () => 'token',
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('fetch should not run');
    },
  });
  const result = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    modelLevel: 4,
  });
  assert.equal(result.cache.status, 'missing');
  assert.equal(result.cache.refreshing, false);
  assert.equal(result.cache.error.code, 'NO_ACCOUNT');
  assert.equal(fetches, 0);
});

test('forced refresh requires a remembered Microsoft identity', async () => {
  const service = createAcrService({
    getCacheIdentity: () => null,
    getPowerBiToken: async () => 'token',
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    },
  });
  await assert.rejects(
    service.getModelMonthlyAcr({
      tpids: ['1'],
      fiscalYears: ['FY26'],
      modelLevel: 4,
      force: true,
    }),
    (error) => error?.code === 'NO_ACCOUNT',
  );
});

test('authorization failure preserves scoped rows and discloses the refresh error', async () => {
  const db = makeFakeDb();
  let now = new Date('2026-07-15T12:00:00Z');
  db.now = now.getTime();
  const identity = 'first@microsoft.com';
  const seed = createAcrService({
    clock: () => now,
    getCacheIdentity: () => identity,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 100,
      }]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  now = new Date('2026-08-02T12:00:00Z');
  db.now = now.getTime();
  const service = createAcrService({
    clock: () => now,
    getCacheIdentity: () => identity,
    getPowerBiToken: async () => {
      const error = new Error('Not authorized');
      error.code = 'NO_ACCOUNT';
      throw error;
    },
    getDb: () => db,
  });
  const stale = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  assert.equal(stale.cache.status, 'partial');
  await service.waitForBackgroundRefreshes();

  const afterFailure = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  assert.equal(afterFailure.cache.status, 'partial');
  assert.match(afterFailure.cache.error.message, /Not authorized/);
  assert.equal(db.rows.size, 1);
});

test('cold-load failures are surfaced immediately', async () => {
  const service = createAcrService({
    getPowerBiToken: async () => {
      const error = new Error('Sign-in required');
      error.code = 'NO_ACCOUNT';
      throw error;
    },
  });
  await assert.rejects(
    service.getModelMonthlyAcr({
      tpids: ['1'],
      fiscalYears: ['FY26'],
      modelLevel: 4,
    }),
    /Sign-in required/,
  );
});

test('RLS denial is actionable and does not expose the raw Power BI response', async () => {
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        error: {
          code: 'RLSNotAuthorizedForModel',
          details: [{ sensitive: 'raw-detail' }],
        },
      }),
    }),
  });
  await assert.rejects(
    service.getModelMonthlyAcr({
      tpids: ['1'],
      fiscalYears: ['FY26'],
      modelLevel: 4,
    }),
    (error) => (
      error?.code === 'ACR_RLS_UNAUTHORIZED'
      && error.message.includes(`model ${ACR_MODEL_ID}`)
      && !/raw-detail|parameters|exceptionCulprit/.test(error.message)
    ),
  );
});

test('RLS denial serves a related cached fiscal series instead of blanking the page', async () => {
  const db = makeFakeDb();
  const now = new Date('2027-09-15T12:00:00Z');
  db.now = now.getTime();
  const identity = 'user@example.com';

  // Seed the wider FY26+FY27 account series — the superset that exists in cache.
  const seed = createAcrService({
    clock: () => now,
    getCacheIdentity: () => identity,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [
        { serviceLevel4: 'gpt-5', fiscalMonth: 'FY26-Jun', acr: 50 },
        { serviceLevel4: 'gpt-5', fiscalMonth: 'FY27-Jul', acr: 100 },
      ]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY26', 'FY27'],
    modelLevel: 4,
    force: true,
  });
  assert.equal(db.rows.size, 1);

  // A fresh process (empty memory cache) requests only FY27, whose exact key was
  // never pulled. Live Power BI denies RLS. Rather than throwing a blank-page
  // error, the service serves the FY27 slice of the cached FY26+FY27 series and
  // discloses the live error alongside it.
  const service = createAcrService({
    clock: () => now,
    getCacheIdentity: () => identity,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        error: { code: 'RLSNotAuthorizedForModel', details: [{ sensitive: 'raw' }] },
      }),
    }),
  });
  const result = await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  assert.equal(result.cache.status, 'stale');
  assert.equal(result.cache.error.code, 'ACR_RLS_UNAUTHORIZED');
  assert.ok(result.cache.error.message.includes(`model ${ACR_MODEL_ID}`));
  assert.ok(!/raw|exceptionCulprit/.test(result.cache.error.message));
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, 'gpt-5');
  assert.equal(result.models[0].total, 100);
  // The exact FY27 key must NOT be persisted — it is derived, not a real pull.
  assert.equal(db.rows.size, 1);
  await service.waitForBackgroundRefreshes();
});

test('explicit refresh reuses an in-flight background refresh', async () => {
  const db = makeFakeDb();
  let now = new Date('2026-07-15T12:00:00Z');
  db.now = now.getTime();
  const seed = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 100,
      }]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  let resolveFetch;
  let calls = 0;
  now = new Date('2026-08-02T12:00:00Z');
  db.now = now.getTime();
  const service = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return new Promise((resolve) => {
        resolveFetch = () => resolve(dsrResponse(select, [{
          serviceLevel4: 'gpt-5',
          fiscalMonth: 'FY27-Jul',
          acr: 300,
        }]));
      });
    },
  });

  await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const forced = service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });
  resolveFetch();
  const result = await forced;
  assert.equal(result.models[0].total, 300);
  assert.equal(calls, 1);
});

test('concurrent explicit refreshes coalesce after a background failure', async () => {
  const db = makeFakeDb();
  let now = new Date('2026-07-15T12:00:00Z');
  db.now = now.getTime();
  const seed = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 100,
      }]);
    },
  });
  await seed.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });

  let resolveBackground;
  let calls = 0;
  now = new Date('2026-08-02T12:00:00Z');
  db.now = now.getTime();
  const service = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveBackground = () => resolve({
            ok: false,
            status: 401,
            headers: { get: () => null },
            text: async () => 'unauthorized',
          });
        });
      }
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{
        serviceLevel4: 'gpt-5',
        fiscalMonth: 'FY27-Jul',
        acr: 400,
      }]);
    },
  });
  await service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const first = service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });
  const second = service.getModelMonthlyAcr({
    tpids: ['1'],
    fiscalYears: ['FY27'],
    modelLevel: 4,
    force: true,
  });
  resolveBackground();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.models[0].total, 400);
  assert.equal(secondResult.models[0].total, 400);
  assert.equal(calls, 2);
});

test('portfolio miss waits for account and service-mix data on the first visit', async () => {
  const db = makeFakeDb();
  let calls = 0;
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      if (names.includes('account')) {
        return dsrResponse(select, [{
          account: 'Contoso',
          fiscalMonth: 'FY26-Jun',
          acr: 100,
        }]);
      }
      return dsrResponse(select, [{ serviceLevel2: 'Storage', acr: 100 }]);
    },
  });

  const first = await service.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    level: 2,
  });
  assert.equal(first.cache.status, 'live');
  assert.equal(first.accounts[0].account, 'Contoso');
  assert.equal(first.serviceMix[0].service, 'Storage');
  assert.equal(calls, 2);

  const second = await service.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    level: 2,
  });
  assert.equal(second.accounts[0].account, 'Contoso');
  assert.equal(second.serviceMix[0].service, 'Storage');
  assert.equal(calls, 2);
});

test('stale portfolio refresh warms service mix for the newly completed month', async () => {
  const db = makeFakeDb();
  let now = new Date('2026-07-15T12:00:00Z');
  db.now = now.getTime();
  const seed = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      return names.includes('account')
        ? dsrResponse(select, [
          { account: 'Contoso', fiscalMonth: 'FY26-Jun', acr: 100 },
          { account: 'Contoso', fiscalMonth: 'FY27-Jul', acr: 150 },
        ])
        : dsrResponse(select, [{ serviceLevel2: 'Storage', acr: 100 }]);
    },
  });
  await seed.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26', 'FY27'],
    level: 2,
    force: true,
  });

  let calls = 0;
  now = new Date('2026-08-02T12:00:00Z');
  db.now = now.getTime();
  const service = createAcrService({
    clock: () => now,
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      const command = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
      const select = command.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      if (names.includes('account')) {
        return dsrResponse(select, [{ account: 'Contoso', fiscalMonth: 'FY27-Jul', acr: 200 }]);
      }
      return dsrResponse(select, [{
        serviceLevel2: 'Storage',
        acr: JSON.stringify(command.Query.Where).includes('FY27-Jul') ? 200 : 100,
      }]);
    },
  });

  const stale = await service.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26', 'FY27'],
    level: 2,
  });
  assert.equal(stale.latestMonth, 'FY26-Jun');
  await service.waitForBackgroundRefreshes();

  const fresh = await service.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26', 'FY27'],
    level: 2,
  });
  assert.equal(fresh.latestMonth, 'FY27-Jul');
  assert.equal(fresh.serviceMix[0].total, 200);
  assert.ok(calls >= 2);
});

test('missing service mix loads actively while cached account totals remain available', async () => {
  const db = makeFakeDb();
  const seed = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      return names.includes('account')
        ? dsrResponse(select, [{ account: 'Contoso', fiscalMonth: 'FY26-Jun', acr: 100 }])
        : dsrResponse(select, [{ serviceLevel2: 'Storage', acr: 100 }]);
    },
  });
  await seed.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    level: 2,
    force: true,
  });

  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    getDb: () => db,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      return dsrResponse(select, [{ serviceLevel3: 'Blob Storage', acr: 100 }]);
    },
  });
  const result = await service.getPortfolio({
    tpids: ['1'],
    fiscalYears: ['FY26'],
    level: 3,
  });
  assert.equal(result.cache.status, 'live');
  assert.equal(result.totals.latest, 100);
  assert.equal(result.accounts[0].account, 'Contoso');
  assert.equal(result.serviceMix[0].service, 'Blob Storage');
});

test('explicit refresh surfaces service-mix failures', async () => {
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      if (names.includes('account')) {
        return dsrResponse(select, [{ account: 'Contoso', fiscalMonth: 'FY26-Jun', acr: 100 }]);
      }
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => 'unauthorized',
      };
    },
  });

  await assert.rejects(
    service.getPortfolio({
      tpids: ['1'],
      fiscalYears: ['FY26'],
      level: 2,
      force: true,
    }),
    /not authorized/,
  );
});
