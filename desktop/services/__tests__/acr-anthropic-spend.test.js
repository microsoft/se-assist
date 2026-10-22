'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const { createAcrService } = require('../acr-querydata');
const { projectCachedAcr } = require('../acr-cache-projection');

const args = { tpids: ['1', '2'], fiscalYears: ['FY27'] };
const options = {
  getPowerBiToken: async () => 'test-token',
  getCacheIdentity: () => 'user-a',
  clock: () => new Date('2026-10-20T15:00:00Z'),
  logger: { info() {}, warn() {} },
  sleepImpl: async () => {},
};
const sample = [
  { tpid: '1', account: 'Shared name', fiscalMonth: 'FY27-Jul', acr: 0.004 },
  { tpid: '1', account: 'Shared name', fiscalMonth: 'FY27-Aug', acr: 10.12 },
  { tpid: '1', account: 'Shared name', fiscalMonth: 'FY27-Sep', acr: 20.11 },
  { tpid: '2', account: 'Shared name', fiscalMonth: 'FY27-Jul', acr: 0.004 },
  { tpid: '2', account: 'Shared name', fiscalMonth: 'FY27-Sep', acr: 30.22 },
  { tpid: '2', account: 'Shared name', fiscalMonth: 'FY27-Oct', acr: 999 },
];
const queryOf = (request) => JSON.parse(request.body).queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
function filterValues(query, property) {
  return query.Where.find((w) => w?.Condition?.In?.Expressions?.[0]?.Column?.Property === property)
    ?.Condition.In.Values.map((tuple) => tuple[0].Literal.Value) || [];
}
function response(select, rows) {
  let dimension = 0;
  let measure = 0;
  const schema = select.map((column) => ({ N: column.Column ? `G${dimension++}` : `M${measure++}` }));
  return {
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ results: [{ result: { data: {
      descriptor: { Select: select.map(() => ({})) },
      dsr: { DS: [{ IC: true, PH: [{ DM0: rows.map((row, index) => ({
        ...(index === 0 ? { S: schema } : {}),
        C: select.map((column) => row[column.NativeReferenceName] ?? null),
      })) }] }] },
    } } }] }),
  };
}

test('native spend uses account TPIDs and native dollars, sums before rounding, and omits the partial month', async () => {
  const requests = [];
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => {
      const query = queryOf(request);
      requests.push(query);
      return response(query.Select, sample);
    },
  });
  const result = await service.getAnthropicMonthlySpend({ ...args, services: ['Azure OpenAI'] });
  assert.deepEqual(filterValues(requests[0], 'AdjustmentFlag'), ["'XCR - Anthropic'"]);
  assert.deepEqual(filterValues(requests[0], 'TPIDTxt'), ["'1'", "'2'"]);
  assert.deepEqual(filterValues(requests[0], 'FiscalYear'), ["'FY27'"]);
  assert.equal(requests[0].Select.at(-1).Measure.Property, '$ ACR');
  assert.doesNotMatch(JSON.stringify(requests[0]), /ServiceLevel|FACT_AzureConsumedRevenuePartnerUniqueId/);
  assert.equal(result.grandTotal, 60.46, 'aggregate unrounded native amounts, not independently rounded rows');
  assert.equal(result.monthly['FY27-Jul'], 0.01);
  assert.equal(result.latestMonth, 'FY27-Sep');
  assert.equal(result.latest, 50.33);
  assert.deepEqual(result.months, ['FY27-Jul', 'FY27-Aug', 'FY27-Sep']);
  assert.equal(result.accounts.length, 2, 'identical display names must not merge different TPIDs');
  assert.equal(result.accounts.find((account) => account.tpid === '1').total, 30.23);
  assert.equal(result.accounts.find((account) => account.tpid === '2').monthly['FY27-Aug'], undefined);
  assert.equal(result.source.adjustmentFlag, 'XCR - Anthropic');
  assert.equal(result.source.currency, 'USD');
  assert.equal(result.cache.status, 'live');
});

test('ordinary and Anthropic caches and fiscal projections never contaminate each other', async () => {
  for (const nativeFirst of [true, false]) {
    const requests = [];
    const service = createAcrService({
      ...options,
      fetchImpl: async (_url, request) => {
        const query = queryOf(request);
        requests.push(query);
        const amount = filterValues(query, 'AdjustmentFlag')[0] === "'N/A'" ? 900 : 10;
        return response(query.Select, [{ tpid: '1', account: 'Test', fiscalMonth: 'FY27-Sep', acr: amount }]);
      },
    });
    const native = () => service.getAnthropicMonthlySpend(args);
    const ordinary = () => service.queryAcr({ ...args, groupBy: ['tpid', 'account', 'fiscalMonth'] });
    if (nativeFirst) { await native(); await ordinary(); }
    else { await ordinary(); await native(); }
    assert.equal(requests.length, 2);
    assert.equal((await native()).grandTotal, 10);
    assert.equal((await ordinary()).rows[0].acr, 900);
    assert.equal(requests.length, 2, 'both source-specific caches remain reusable');
  }
  const stored = { identity: 'a', tpids: ['1'], fy: ['FY26', 'FY27'], month: '', cols: ['tpid', 'account', 'fiscalMonth', 'acr'], sf: '' };
  const native = { ...stored, fy: ['FY27'], adjustmentScope: 'anthropic' };
  assert.equal(projectCachedAcr(sample, stored, native), null);
  assert.equal(projectCachedAcr(sample, native, { ...stored, fy: ['FY27'] }), null);
  assert.notEqual(projectCachedAcr(sample, { ...stored, adjustmentScope: 'anthropic' }, native), null);
});

test('simultaneous native loads and manual refreshes coalesce within the shared ACR path', async () => {
  let calls = 0;
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => { calls++; return response(queryOf(request).Select, sample); },
  });
  const first = await Promise.all([1, 2, 3].map(() => service.getAnthropicMonthlySpend(args)));
  assert.equal(calls, 1);
  assert.ok(first.every((result) => result.grandTotal === 60.46));
  await Promise.all([1, 2, 3].map(() => service.getAnthropicMonthlySpend({ ...args, force: true })));
  assert.equal(calls, 2);
});

test('native caches remain identity-scoped and signed-out results never masquerade as zero spend', async () => {
  let identity = 'user-a';
  let calls = 0;
  const service = createAcrService({
    ...options,
    getCacheIdentity: () => identity,
    fetchImpl: async (_url, request) => { calls++; return response(queryOf(request).Select, sample); },
  });
  await service.getAnthropicMonthlySpend(args);
  identity = 'user-b';
  await service.getAnthropicMonthlySpend(args);
  assert.equal(calls, 2);
  identity = null;
  const signedOut = await service.getAnthropicMonthlySpend(args);
  assert.equal(signedOut.grandTotal, null);
  assert.deepEqual(signedOut.accounts, []);
  assert.equal(signedOut.cache.status, 'missing');
  assert.equal(signedOut.cache.error.code, 'NO_ACCOUNT');
  await assert.rejects(service.getAnthropicMonthlySpend({ ...args, force: true }), (error) => error.code === 'NO_ACCOUNT');
  assert.equal(calls, 2);
});

test('native monthly overlays preserve the Anthropic scope and replace, rather than add, earlier month values', async () => {
  let now = new Date('2026-08-20T15:00:00Z');
  const requests = [];
  const service = createAcrService({
    ...options, clock: () => now,
    fetchImpl: async (_url, request) => {
      const query = queryOf(request);
      requests.push(query);
      const isOverlay = filterValues(query, 'FiscalMonth').length > 0;
      return response(query.Select, isOverlay
        ? [{ tpid: '1', account: 'Test', fiscalMonth: 'FY27-Aug', acr: 21.11 }]
        : [
          { tpid: '1', account: 'Test', fiscalMonth: 'FY27-Jul', acr: 10 },
          { tpid: '1', account: 'Test', fiscalMonth: 'FY27-Aug', acr: 20 },
        ]);
    },
  });
  assert.equal((await service.getAnthropicMonthlySpend(args)).grandTotal, 10);
  now = new Date('2026-09-20T15:00:00Z');
  const next = await service.getAnthropicMonthlySpend({ ...args, force: true });
  assert.equal(next.grandTotal, 31.11);
  assert.deepEqual(next.months, ['FY27-Jul', 'FY27-Aug']);
  assert.deepEqual(filterValues(requests[1], 'FiscalMonth'), ["'FY27-Aug'"]);
  assert.ok(requests.every((query) => filterValues(query, 'AdjustmentFlag')[0] === "'XCR - Anthropic'"));
});

test('access failure surfaces on a cold view and is disclosed alongside a previously good native cache', async () => {
  let denied = false;
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => denied
      ? { status: 403, headers: { get: () => null }, text: async () => 'Access denied' }
      : response(queryOf(request).Select, sample),
  });
  await service.getAnthropicMonthlySpend(args);
  denied = true;
  const cached = await service.getAnthropicMonthlySpend({ ...args, force: true });
  assert.equal(cached.grandTotal, 60.46);
  assert.equal(cached.cache.status, 'stale');
  assert.equal(cached.cache.error.code, 'ACR_UNAUTHORIZED');
  await assert.rejects(service.getAnthropicMonthlySpend({ tpids: ['3'], fiscalYears: ['FY27'] }), (error) => error.code === 'ACR_UNAUTHORIZED');
});

test('HTTP 200 nested Power BI query errors are failures, not empty Anthropic spend', async () => {
  const service = createAcrService({
    ...options,
    fetchImpl: async () => ({
      status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ results: [{ result: { data: {
        descriptor: { Select: [{}, {}, {}, {}] },
        dsr: { DataShapes: [{ 'odata.error': { code: 'QueryUserError', message: 'Native query failed.' } }] },
      } } }] }),
    }),
  });
  await assert.rejects(service.getAnthropicMonthlySpend(args), (error) => (
    error.code === 'ACR_QUERY_ERROR' && /QueryUserError.*Native query failed/.test(error.message)
  ));
});

test('a successful empty native query is distinct from missing access and cannot erase prior spend', async () => {
  let data = [];
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => response(queryOf(request).Select, data),
  });
  const empty = await service.getAnthropicMonthlySpend(args);
  assert.equal(empty.grandTotal, 0);
  assert.equal(empty.latest, 0);
  assert.equal(empty.cache.status, 'live');
  data = sample;
  await service.getAnthropicMonthlySpend(args);
  data = [];
  const retained = await service.getAnthropicMonthlySpend({ ...args, force: true });
  assert.equal(retained.grandTotal, 60.46);
  assert.equal(retained.cache.error.code, 'ACR_UNEXPECTED_EMPTY');
});

test('native spend validates input and refuses unexpected account or missing monetary data', async () => {
  let data = [{ tpid: '3', account: 'Unexpected', fiscalMonth: 'FY27-Sep', acr: 10 }];
  let calls = 0;
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => { calls++; return response(queryOf(request).Select, data); },
  });
  for (const tpids of [[], ["1' OR 1=1"]]) {
    await assert.rejects(service.getAnthropicMonthlySpend({ ...args, tpids }), /numeric customer TPIDs/);
  }
  assert.equal(calls, 0);
  await assert.rejects(service.getAnthropicMonthlySpend(args), (error) => error.code === 'ACR_INVALID_DATA');
  data = [{ tpid: '1', account: 'Test', fiscalMonth: 'FY27-Sep', acr: null }];
  await assert.rejects(service.getAnthropicMonthlySpend({ ...args, force: true }), (error) => error.code === 'ACR_INVALID_DATA');
});

test('native spend IPC is origin-guarded, exposes only its fixed capability, and preserves failures', async () => {
  const handlers = new Map();
  const calls = [];
  let failure = null;
  const ipcPath = path.join(__dirname, '..', '..', 'acr-ipc.js');
  const stubs = {
    electron: {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      app: { getPath: () => 'test-user-data' },
      webContents: { getAllWebContents: () => [] },
    },
    './services/acr-querydata': {
      createAcrService: () => ({ getAnthropicMonthlySpend: async (payload) => {
        calls.push(JSON.parse(JSON.stringify(payload)));
        if (failure) throw failure;
        return { grandTotal: 12.34 };
      } }),
    },
    './msx-ipc': {},
    './sqlite-ipc': { openDb: () => ({ prepare: () => ({ all: () => args.tpids.map(tpid => ({ tpid })) }) }) },
    './account-roster': require('../../account-roster'),
    './services/acr-insights': {},
    './services/acr-schema': {},
    './services/acr-request-log': { createAcrFileLogger: () => undefined },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ipcPath, 'utf8'), {
    module, exports: module.exports,
    require: (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (isBuiltin(name)) return require(name);
      throw new Error(`Unexpected IPC test dependency: ${name}`);
    },
  }, { filename: ipcPath });
  module.exports.registerAcrIpc();
  const run = handlers.get('acr-anthropic-spend');
  const denied = await run({ senderFrame: { url: 'https://example.com/' } }, args);
  assert.equal(denied.ok, false);
  assert.equal(calls.length, 0);
  const event = { senderFrame: { url: 'http://localhost:5173' } };
  const result = await run(event, { ...args, force: true, adjustmentScope: 'actuals', groupBy: ['subscription'] });
  assert.equal(result.ok, true);
  assert.equal(result.grandTotal, 12.34);
  assert.deepEqual(calls[0], { ...args, force: true });
  failure = Object.assign(new Error('Capacity overloaded'), { code: 'ACR_CAPACITY_LIMIT', retryAt: 123456 });
  const failed = await run(event, args);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Capacity overloaded');
  assert.equal(failed.code, 'ACR_CAPACITY_LIMIT');
  assert.equal(failed.retryAt, 123456);
});
