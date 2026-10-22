'use strict';

const PRIORITY = Object.freeze({
  background: 0,
  normal: 1,
  foreground: 2,
});

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('AI request cancelled.');
}

function cooldownError(retryAt) {
  const error = new Error(`The AI provider is rate-limited until ${new Date(retryAt).toLocaleTimeString()}. Try again after the cooldown.`);
  error.code = 'MODEL_PROVIDER_COOLDOWN';
  error.statusCode = 429;
  error.retryAt = retryAt;
  return error;
}

function rateLimitRetryAt(headers, now = Date.now(), fallbackMs = 5_000) {
  const get = (...names) => {
    for (const name of names) {
      const value = headers?.get?.(name);
      if (value != null && value !== '') return value;
    }
    return null;
  };
  for (const names of [['retry-after-ms', 'Retry-After-Ms'], ['x-ms-retry-after-ms', 'X-Ms-Retry-After-Ms']]) {
    const raw = get(...names);
    if (raw != null) {
      const milliseconds = Number(raw);
      if (Number.isFinite(milliseconds) && milliseconds >= 0) return now + milliseconds;
    }
  }

  const retryAfter = get('retry-after', 'Retry-After');
  if (retryAfter != null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? now + Math.max(0, seconds) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(parsed) && parsed >= now) return parsed;
  }

  const reset = Number(get('x-ratelimit-reset', 'X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const parsed = reset > 10_000_000_000 ? reset : reset * 1000;
    if (parsed >= now) return parsed;
  }

  return now + Math.max(0, Number(fallbackMs) || 0);
}

class ModelRequestScheduler {
  constructor({
    maxConcurrent = 1,
    minIntervalMs = 750,
    maxAutoCooldownMs = 30_000,
    maxCooldownRetries = 1,
    now = () => Date.now(),
  } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.maxAutoCooldownMs = Math.max(0, Number(maxAutoCooldownMs) || 0);
    this.maxCooldownRetries = Math.max(0, Number(maxCooldownRetries) || 0);
    this.now = now;
    this.queue = [];
    this.active = new Map();
    this.shared = new Map();
    this.listeners = new Set();
    this.sequence = 0;
    this.lastStartedAt = 0;
    this.cooldownUntil = 0;
    this.timer = null;
    this.coalescedCount = 0;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('Model scheduler listener must be a function.');
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    const now = this.now();
    const cooldownUntil = this.cooldownUntil > now ? this.cooldownUntil : null;
    const running = [...this.active.values()].map(item => this.publicItem(item, 'running'));
    const queued = this.queue.map(item => this.publicItem(item, cooldownUntil ? 'cooldown' : 'queued'));
    return {
      phase: running.length ? 'running' : cooldownUntil ? 'cooldown' : queued.length ? 'queued' : 'idle',
      running: running.length,
      queued: queued.length,
      cooldownUntil,
      coalesced: this.coalescedCount,
      requests: [...running, ...queued],
    };
  }

  publicItem(item, state) {
    return {
      id: item.id,
      label: item.label,
      model: item.model,
      modelRole: item.modelRole,
      state,
      queuedAt: item.queuedAt,
      startedAt: item.startedAt || null,
    };
  }

  emit() {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* status reporting must not break model work */ }
    }
  }

  notifyItem(item, phase, extra = {}) {
    try {
      item.onStatus?.({
        phase,
        label: item.label,
        model: item.model,
        modelRole: item.modelRole,
        queued: this.queue.length,
        running: this.active.size,
        cooldownUntil: this.cooldownUntil > this.now() ? this.cooldownUntil : null,
        ...extra,
      });
    } catch { /* per-request progress is best-effort */ }
  }

  schedule(run, {
    priority = 'foreground',
    label = 'AI request',
    model = null,
    modelRole = 'primary',
    signal,
    dedupeKey = null,
    onStatus,
  } = {}) {
    if (typeof run !== 'function') return Promise.reject(new Error('Model scheduler requires a request function.'));
    signal?.throwIfAborted();

    const now = this.now();
    if (this.cooldownUntil > now && this.cooldownUntil - now > this.maxAutoCooldownMs) {
      return Promise.reject(cooldownError(this.cooldownUntil));
    }

    if (dedupeKey && this.shared.has(dedupeKey)) {
      this.coalescedCount += 1;
      try {
        onStatus?.({ phase: 'reused', label, model, modelRole, reused: true });
      } catch { /* progress is best-effort */ }
      this.emit();
      return this.shared.get(dedupeKey);
    }

    const item = {
      id: `model-${++this.sequence}`,
      run,
      priority: Object.hasOwn(PRIORITY, priority) ? PRIORITY[priority] : PRIORITY.foreground,
      label,
      model,
      modelRole,
      signal,
      dedupeKey,
      onStatus,
      queuedAt: now,
      startedAt: null,
      attempts: 0,
      resolve: null,
      reject: null,
      abortListener: null,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    const settled = promise.finally(() => {
      if (item.dedupeKey && this.shared.get(item.dedupeKey) === settled) this.shared.delete(item.dedupeKey);
      if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener);
    });
    if (dedupeKey) this.shared.set(dedupeKey, settled);

    item.abortListener = () => {
      const index = this.queue.indexOf(item);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.notifyItem(item, 'cancelled');
        item.reject(abortReason(signal));
        this.emit();
        this.drain();
      }
    };
    signal?.addEventListener('abort', item.abortListener, { once: true });

    this.queue.push(item);
    this.sortQueue();
    this.notifyItem(item, this.cooldownUntil > now ? 'cooldown' : 'queued');
    this.emit();
    this.drain();
    return settled;
  }

  sortQueue() {
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }

  scheduleDrain(waitMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.cooldownUntil <= this.now()) this.cooldownUntil = 0;
      this.emit();
      this.drain();
    }, Math.max(0, waitMs));
    this.timer.unref?.();
  }

  drain() {
    if (this.active.size >= this.maxConcurrent) return;
    if (!this.queue.length) {
      if (this.cooldownUntil > this.now()) this.scheduleDrain(this.cooldownUntil - this.now());
      else this.emit();
      return;
    }
    const now = this.now();
    const waitUntil = Math.max(this.cooldownUntil, this.lastStartedAt + this.minIntervalMs);
    if (waitUntil > now) {
      for (const item of this.queue) this.notifyItem(item, this.cooldownUntil > now ? 'cooldown' : 'queued');
      this.emit();
      this.scheduleDrain(waitUntil - now);
      return;
    }

    const item = this.queue.shift();
    if (item.signal?.aborted) {
      item.reject(abortReason(item.signal));
      this.drain();
      return;
    }
    item.startedAt = now;
    this.lastStartedAt = now;
    this.active.set(item.id, item);
    this.notifyItem(item, 'running');
    this.emit();

    Promise.resolve()
      .then(item.run)
      .then(result => this.complete(item, result))
      .catch(error => this.fail(item, error));
    this.drain();
  }

  complete(item, result) {
    this.active.delete(item.id);
    this.notifyItem(item, 'complete');
    item.resolve(result);
    this.emit();
    this.drain();
  }

  fail(item, error) {
    this.active.delete(item.id);
    if (item.signal?.aborted) {
      this.notifyItem(item, 'cancelled');
      item.reject(abortReason(item.signal));
      this.emit();
      this.drain();
      return;
    }

    const retryAt = Number(error?.retryAt);
    if (Number.isFinite(retryAt) && retryAt > this.now()) {
      this.cooldownUntil = Math.max(this.cooldownUntil, retryAt);
      const delay = this.cooldownUntil - this.now();
      if (delay <= this.maxAutoCooldownMs && item.attempts < this.maxCooldownRetries) {
        item.attempts += 1;
        item.startedAt = null;
        item.queuedAt = this.now();
        this.queue.push(item);
        this.sortQueue();
        this.notifyItem(item, 'cooldown', { retryAt: this.cooldownUntil, retry: item.attempts });
        this.emit();
        this.scheduleDrain(delay);
        return;
      }
      if (delay > this.maxAutoCooldownMs) {
        const queued = this.queue.splice(0);
        for (const waiting of queued) {
          this.notifyItem(waiting, 'failed', { retryAt: this.cooldownUntil });
          waiting.reject(cooldownError(this.cooldownUntil));
        }
      }
    }

    this.notifyItem(item, 'failed', { error: error?.message || String(error) });
    item.reject(error);
    this.emit();
    this.drain();
  }

  resetForTests({
    maxConcurrent = this.maxConcurrent,
    minIntervalMs = this.minIntervalMs,
    maxAutoCooldownMs = this.maxAutoCooldownMs,
    maxCooldownRetries = this.maxCooldownRetries,
  } = {}) {
    if (this.active.size || this.queue.length) throw new Error('Cannot reset a busy model scheduler.');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.shared.clear();
    this.maxConcurrent = maxConcurrent;
    this.minIntervalMs = minIntervalMs;
    this.maxAutoCooldownMs = maxAutoCooldownMs;
    this.maxCooldownRetries = maxCooldownRetries;
    this.sequence = 0;
    this.lastStartedAt = 0;
    this.cooldownUntil = 0;
    this.coalescedCount = 0;
    this.emit();
  }
}

const modelRequestScheduler = new ModelRequestScheduler({
  maxConcurrent: Number(process.env.COPILOT_MAX_CONCURRENT) || 1,
  minIntervalMs: Number(process.env.COPILOT_MIN_REQUEST_INTERVAL_MS) || 750,
  maxAutoCooldownMs: Number(process.env.COPILOT_MAX_AUTO_COOLDOWN_MS) || 30_000,
  maxCooldownRetries: Number(process.env.COPILOT_COOLDOWN_RETRIES) || 1,
});

module.exports = {
  ModelRequestScheduler,
  modelRequestScheduler,
  rateLimitRetryAt,
};
