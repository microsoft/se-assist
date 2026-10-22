'use strict';

// Focused tests for the ACR live-pull progress stream (onProgress). They prove
// the engine emits a `start` when a live pull begins, a `done` when it finishes,
// and — the reason this feature exists — a `throttle` event carrying the backoff
// countdown when Power BI rate-limits a request. A frozen-looking pull is almost
// always a backoff sleep, so that event must fire with a positive attempt and a
// retry delay the UI can count down.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcrService } = require('../acr-querydata');

// Build a Power BI querydata-shaped 200 response from the query's Select list.
function dsrResponse(select, rows) {
  let dimensionIndex = 0;
  let measureIndex = 0;
  const schema = select.map((entry) => ({ N: entry.Column ? `G${dimensionIndex++}` : `M${measureIndex++}` }));
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
            dsr: { DS: [{ PH: [{ DM0: rows.map((row, index) => ({ ...(index === 0 ? { S: schema } : {}), C: names.map((name) => row[name] ?? null) })) }], IC: true }] },
          },
        },
      }],
    }),
  };
}

function selectOf(options) {
  const body = JSON.parse(options.body);
  return body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select;
}

const SAMPLE_ROW = { serviceLevel2: 'Foundry Models', serviceLevel4: 'gpt-5', fiscalMonth: 'FY26-Jun', acr: 100 };

test('emits start then done around a successful live pull', async () => {
  const events = [];
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    fetchImpl: async (_url, options) => dsrResponse(selectOf(options), [SAMPLE_ROW]),
    onProgress: (evt) => events.push(evt),
  });

  const result = await service.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4 });
  assert.equal(result.cache.status, 'live');

  const start = events.find((e) => e.phase === 'start');
  const done = events.find((e) => e.phase === 'done');
  assert.ok(start, 'a start event should be emitted');
  assert.ok(done, 'a done event should be emitted');
  assert.equal(typeof start.id, 'number');
  assert.equal(done.id, start.id, 'start and done share the same pull id');
  assert.ok(done.rows > 0, 'done reports the fetched row count');
});

test('emits a throttle countdown event when Power BI returns 429', async () => {
  const events = [];
  let throttledOnce = false;
  const service = createAcrService({
    getPowerBiToken: async () => 'token',
    fetchImpl: async (_url, options) => {
      if (!throttledOnce) {
        throttledOnce = true;
        // Retry-After: 0 → parseRetryAfter yields 0ms, so the retry sleep is
        // instant and the test stays fast while still exercising the path.
        return { ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '0' : null) }, text: async () => 'throttled' };
      }
      return dsrResponse(selectOf(options), [SAMPLE_ROW]);
    },
    onProgress: (evt) => events.push(evt),
  });

  const result = await service.getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY26'], modelLevel: 4 });
  assert.equal(result.cache.status, 'live');

  const throttle = events.find((e) => e.phase === 'throttle');
  assert.ok(throttle, 'a throttle event should be emitted on 429');
  assert.equal(throttle.status, 429);
  assert.equal(throttle.attempt, 1);
  assert.ok(throttle.maxAttempts >= throttle.attempt);
  assert.equal(throttle.retryInMs, 0);
  assert.ok(events.some((e) => e.phase === 'start'), 'start still emitted');
  assert.ok(events.some((e) => e.phase === 'done'), 'done still emitted after recovery');
});
