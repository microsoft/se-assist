'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcrService } = require('../acr-querydata');
const { projectCachedAcr } = require('../acr-cache-projection');
const { createAcrRequestScheduler } = require('../acr-request-scheduler');

const query = options => JSON.parse(options.body).queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
const rows = [
  { serviceLevel1: 'AI', serviceLevel2: 'Foundry Models', serviceLevel3: 'AI', serviceLevel4: 'Model A', fiscalMonth: 'FY27-Jul', acr: 100 },
  { serviceLevel1: 'AI', serviceLevel2: 'Foundry Models', serviceLevel3: 'AI', serviceLevel4: 'Model A', fiscalMonth: 'FY27-Aug', acr: 110 },
  { serviceLevel1: 'AI', serviceLevel2: 'Foundry Models', serviceLevel3: 'AI', serviceLevel4: 'Model A', fiscalMonth: 'FY27-Sep', acr: 999 },
  { serviceLevel1: 'AI', serviceLevel2: 'Foundry Tools', serviceLevel3: 'AI', serviceLevel4: 'Speech', fiscalMonth: 'FY27-Jul', acr: 30 },
  { serviceLevel1: 'Compute', serviceLevel2: 'Azure App Service', serviceLevel3: 'App', serviceLevel4: 'Managed', fiscalMonth: 'FY27-Jul', acr: 20 },
  { serviceLevel1: 'Compute', serviceLevel2: 'Virtual Machines', serviceLevel3: 'VM', serviceLevel4: 'Managed', fiscalMonth: 'FY27-Jul', acr: 10 },
  { serviceLevel1: 'Developer', serviceLevel2: 'Azure DevOps', serviceLevel3: 'DevOps', serviceLevel4: 'Pipelines', fiscalMonth: 'FY27-Jul', acr: 40 },
];
const response = (select, data = rows) => {
  let dimension = 0;
  let measure = 0;
  const schema = select.map(column => ({ N: column.Column ? `G${dimension++}` : `M${measure++}` }));
  return {
    status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ results: [{ result: { data: {
      descriptor: { Select: select.map(() => ({})) },
      dsr: { DS: [{ IC: true, PH: [{ DM0: data.map((row, index) => ({
        ...(index === 0 ? { S: schema } : {}),
        C: select.map(column => row[column.NativeReferenceName] ?? null),
      })) }] }] },
    } } }] }),
  };
};
const args = { tpids: ['1'], fiscalYears: ['FY27'] };
const charts = [
  { ...args, modelLevel: 4 },
  { ...args, modelLevel: 4, categories: ['Foundry Tools'] },
  { ...args, modelLevel: 2, categories: ['Azure App Service'] },
  { ...args, modelLevel: 2, categories: ['Azure DevOps'] },
];
const options = {
  getPowerBiToken: async () => 'test-token',
  clock: () => new Date('2026-09-24T15:00:00Z'),
  logger: { info() {}, warn() {} },
};

test('four Apps charts share one complete query and produce the exact requested closed-month totals', async () => {
  const requests = [];
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => { requests.push(query(request)); return response(query(request).Select); },
  });
  const results = await Promise.all(charts.map(chart => service.getModelMonthlyAcr(chart)));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].Select.map(column => column.NativeReferenceName), ['serviceLevel2', 'serviceLevel4', 'fiscalMonth', 'acr']);
  assert.deepEqual(results.map(result => result.grandTotal), [210, 30, 20, 40]);
  assert.deepEqual(results[0].months, ['FY27-Jul', 'FY27-Aug']);
  assert.equal(results[2].models[0].model, 'Azure App Service');
  assert.equal(results[1].models[0].model, 'Speech');
  assert.ok(results.every(result => result.cache.status === 'live'));
  await Promise.all(charts.map(chart => service.getModelMonthlyAcr(chart)));
  assert.equal(requests.length, 1, 'reopening charts uses the shared cache');
  await Promise.all(charts.map(chart => service.getModelMonthlyAcr({ ...chart, force: true })));
  assert.equal(requests.length, 2, 'a simultaneous forced refresh also coalesces');
});

test('capacity rejection recovers all four charts through one shared retry, not twenty independent calls', async () => {
  let calls = 0;
  let now = 0;
  const waits = [];
  const progress = [];
  const scheduler = createAcrRequestScheduler({ now: () => now, delay: async ms => { waits.push(ms); now += ms; } });
  const service = createAcrService({
    ...options, scheduler, onProgress: event => progress.push(event),
    fetchImpl: async (_url, request) => {
      calls++;
      if (calls === 1) return {
        status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ results: [{ result: { error: { code: 'CapacityLimitExceeded', message: 'Busy capacity' } } }] }),
      };
      return response(query(request).Select);
    },
  });

  test('detail rows are aggregated before currency rounding so L2 totals match native L2 queries', async () => {
    const data = [
      { serviceLevel2: 'Azure App Service', serviceLevel4: 'Plan A', fiscalMonth: 'FY27-Jul', acr: 0.004 },
      { serviceLevel2: 'Azure App Service', serviceLevel4: 'Plan B', fiscalMonth: 'FY27-Jul', acr: 0.004 },
    ];
    const service = createAcrService({ ...options, fetchImpl: async (_url, request) => response(query(request).Select, data) });
    const result = await service.getModelMonthlyAcr(charts[2]);
    assert.equal(result.models[0].monthly['FY27-Jul'], 0.01);
    assert.equal(result.grandTotal, 0.01);
  });
  const results = await Promise.all(charts.map(chart => service.getModelMonthlyAcr(chart)));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [30000]);
  assert.deepEqual(results.map(result => result.grandTotal), [210, 30, 20, 40]);
  assert.ok(progress.some(event => event.phase === 'throttle' && event.code === 'ACR_CAPACITY_LIMIT'));
  assert.ok(progress.every(event => event.queryKey), 'cache update notifications identify the exact data query');
});

test('capacity scheduler admits one recovery probe and ignores unrelated in-flight success', async () => {
  let now = 0;
  let finishDelay;
  const scheduler = createAcrRequestScheduler({ now: () => now, delay: () => new Promise(resolve => { finishDelay = resolve; }) });
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  const third = await scheduler.acquire();
  first.throttle(30000);
  let admitted = 0;
  const fourth = scheduler.acquire().then(token => { admitted++; return token; });
  const fifth = scheduler.acquire().then(token => { admitted++; return token; });
  first.release();
  second.succeeded();
  second.release();
  third.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, 0);
  now = 30000;
  finishDelay();
  const probe = await fourth;
  assert.equal(admitted, 1);
  probe.succeeded();
  probe.release();
  const normal = await fifth;
  assert.equal(admitted, 2);
  normal.release();
});

test('long server cooldowns fail queued queries explicitly instead of waiting indefinitely or retrying early', async () => {
  const scheduler = createAcrRequestScheduler({ now: () => 0, delay: () => { throw new Error('Must not sleep through an hour-long cooldown'); } });
  const request = await scheduler.acquire();
  request.throttle(3600000, { code: 'ACR_SERVICE_UNAVAILABLE' });
  request.release();
  await assert.rejects(scheduler.acquire(), error => error.code === 'ACR_SERVICE_UNAVAILABLE' && error.retryAt === 3600000);
});

test('failed manual refresh keeps the last good data with the real connection error', async () => {
  let fail = false;
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => {
      if (fail) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return response(query(request).Select);
    },
  });
  const before = await service.getModelMonthlyAcr(charts[0]);
  fail = true;
  const after = await service.getModelMonthlyAcr({ ...charts[0], force: true });
  assert.equal(after.grandTotal, before.grandTotal);
  assert.equal(after.cache.status, 'stale');
  assert.match(after.cache.error.message, /ENOTFOUND/);
  assert.doesNotMatch(after.cache.error.message, /Connect to corpnet\/VPN/);
});

test('unexpected empty refresh retains good data and its warning through subsequent cache reads', async () => {
  let empty = false;
  const events = [];
  const service = createAcrService({
    ...options, onProgress: event => events.push(event),
    fetchImpl: async (_url, request) => response(query(request).Select, empty ? [] : rows),
  });
  await service.getModelMonthlyAcr(charts[0]);
  empty = true;
  const refreshed = await service.getModelMonthlyAcr({ ...charts[0], force: true });
  assert.equal(refreshed.grandTotal, 210);
  assert.equal(refreshed.cache.error.code, 'ACR_UNEXPECTED_EMPTY');
  assert.equal(events.at(-1).phase, 'error');
  const cached = await service.getModelMonthlyAcr(charts[0]);
  assert.equal(cached.grandTotal, 210);
  assert.equal(cached.cache.error.code, 'ACR_UNEXPECTED_EMPTY');
});

test('temporary connection resets retry the same data and do not demand a VPN change', async () => {
  let calls = 0;
  const service = createAcrService({
    ...options, sleepImpl: async () => {},
    fetchImpl: async (_url, request) => {
      if (++calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return response(query(request).Select);
    },
  });
  const result = await service.getModelMonthlyAcr(charts[0]);
  assert.equal(calls, 2);
  assert.equal(result.grandTotal, 210);
});

test('complete hierarchy caches serve narrower product charts before any live request', async () => {
  let calls = 0;
  const service = createAcrService({
    ...options,
    fetchImpl: async (_url, request) => { calls++; return response(query(request).Select); },
  });
  await service.getAccountServiceHierarchy({ ...args, level: 4 });
  assert.equal(calls, 1);
  const results = await Promise.all(charts.map(chart => service.getModelMonthlyAcr(chart)));
  assert.equal(calls, 1);
  assert.deepEqual(results.map(result => result.grandTotal), [210, 30, 20, 40]);
  assert.ok(results.every(result => result.cache.source.includes('derived')));
});

test('cached projections cannot mix identities, account sets, missing dimensions or narrower product scopes', () => {
  const stored = { identity: 'user-a', tpids: ['1'], fy: ['FY26', 'FY27'], month: '', cols: ['serviceLevel2', 'serviceLevel4', 'fiscalMonth', 'acr'], sf: '' };
  const requested = { ...stored, fy: ['FY27'], cols: ['serviceLevel2', 'fiscalMonth', 'acr'], sf: { level: 2, values: ['Azure App Service'] } };
  const projected = projectCachedAcr(rows, stored, requested);
  assert.deepEqual(projected, [{ serviceLevel2: 'Azure App Service', fiscalMonth: 'FY27-Jul', acr: 20 }]);
  assert.deepEqual(projectCachedAcr(rows, stored, { ...requested, fy: 'FY27' }), projected);
  for (const changed of [
    { ...stored, identity: 'user-b' },
    { ...stored, tpids: ['1', '2'] },
    { ...stored, fy: ['FY26'] },
    { ...stored, cols: ['serviceLevel4', 'fiscalMonth', 'acr'] },
    { ...stored, sf: { level: 2, values: ['Azure DevOps'] } },
    { ...stored, cols: [...stored.cols, 'avgDailyAcr'] },
  ]) assert.equal(projectCachedAcr(rows, changed, requested), null);
  assert.deepEqual(projectCachedAcr(rows, stored, { ...requested, sf: { level: 2, values: ['Product with no usage'] } }), []);
});

test('a failed capacity refresh preserves service code, request ID and the existing cache', async () => {
  let failing = false;
  let requests = 0;
  let now = 0;
  const service = createAcrService({
    ...options, scheduler: createAcrRequestScheduler({ now: () => now, delay: async ms => { now += ms; } }),
    fetchImpl: async (_url, request) => {
      requests++;
      if (!failing) return response(query(request).Select);
      return {
        status: 200, headers: { get: name => name === 'requestid' ? 'test-request' : null },
        text: async () => JSON.stringify({ error: { code: 'CapacityLimitExceeded', message: 'Busy' } }),
      };
    },
  });
  await service.getModelMonthlyAcr(charts[0]);
  failing = true;
  const result = await service.getModelMonthlyAcr({ ...charts[0], force: true });
  assert.equal(requests, 6);
  assert.equal(result.grandTotal, 210);
  assert.equal(result.cache.error.code, 'ACR_CAPACITY_LIMIT');
  assert.equal(result.cache.status, 'stale');
  assert.ok(result.cache.error.retryAt > 0);
});
