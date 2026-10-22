'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelRequestScheduler } = require('../model-request-scheduler');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('serializes requests and gives queued foreground work priority over background work', async () => {
  const scheduler = new ModelRequestScheduler({ minIntervalMs: 0 });
  const order = [];
  let release;
  const first = scheduler.schedule(() => new Promise(resolve => {
    order.push('first');
    release = resolve;
  }), { label: 'first' });
  const background = scheduler.schedule(async () => { order.push('background'); }, { priority: 'background' });
  const foreground = scheduler.schedule(async () => { order.push('foreground'); }, { priority: 'foreground' });
  await wait(0);
  release();
  await Promise.all([first, background, foreground]);
  assert.deepEqual(order, ['first', 'foreground', 'background']);
});

test('uses configured parallel capacity without exceeding it', async () => {
  const scheduler = new ModelRequestScheduler({ maxConcurrent: 2, minIntervalMs: 0 });
  let running = 0;
  let maximum = 0;
  const releases = [];
  const work = Array.from({ length: 3 }, () => scheduler.schedule(() => new Promise(resolve => {
    running += 1;
    maximum = Math.max(maximum, running);
    releases.push(() => {
      running -= 1;
      resolve();
    });
  })));
  await wait(0);
  assert.equal(releases.length, 2);
  assert.equal(maximum, 2);
  releases.splice(0).forEach(release => release());
  await wait(0);
  assert.equal(releases.length, 1);
  releases[0]();
  await Promise.all(work);
  assert.equal(maximum, 2);
});

test('coalesces identical in-flight work without starting a second request', async () => {
  const scheduler = new ModelRequestScheduler({ minIntervalMs: 0 });
  let calls = 0;
  let release;
  const run = () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  };
  const first = scheduler.schedule(run, { dedupeKey: 'same' });
  const second = scheduler.schedule(run, { dedupeKey: 'same' });
  await wait(0);
  release('done');
  assert.deepEqual(await Promise.all([first, second]), ['done', 'done']);
  assert.equal(calls, 1);
  assert.equal(scheduler.snapshot().coalesced, 1);
});

test('honors a short shared cooldown and retries the throttled request once', async () => {
  const scheduler = new ModelRequestScheduler({
    minIntervalMs: 0,
    maxAutoCooldownMs: 100,
    maxCooldownRetries: 1,
  });
  const states = [];
  scheduler.subscribe(state => states.push(state.phase));
  let calls = 0;
  const result = await scheduler.schedule(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('rate limited');
      error.retryAt = Date.now() + 10;
      throw error;
    }
    return 'recovered';
  });
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
  assert.ok(states.includes('cooldown'));
});

test('rejects queued work explicitly instead of hanging through a long cooldown', async () => {
  const scheduler = new ModelRequestScheduler({
    minIntervalMs: 0,
    maxAutoCooldownMs: 20,
  });
  let release;
  const blocker = scheduler.schedule(() => new Promise((_resolve, reject) => { release = reject; }));
  const queued = scheduler.schedule(async () => 'must not run');
  await wait(0);
  const error = new Error('rate limited');
  error.retryAt = Date.now() + 5_000;
  release(error);
  await assert.rejects(blocker, /rate limited/);
  await assert.rejects(queued, err => err.code === 'MODEL_PROVIDER_COOLDOWN' && err.retryAt === error.retryAt);
});

test('cancelling queued work removes it without affecting the active request', async () => {
  const scheduler = new ModelRequestScheduler({ minIntervalMs: 0 });
  let release;
  const active = scheduler.schedule(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const queued = scheduler.schedule(async () => 'must not run', { signal: controller.signal });
  controller.abort(new Error('Stopped by user'));
  await assert.rejects(queued, /Stopped by user/);
  release('active result');
  assert.equal(await active, 'active result');
  assert.equal(scheduler.snapshot().phase, 'idle');
});
