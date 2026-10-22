'use strict';

// During a capacity rejection, allow one recovery probe after the shared delay.
// Other charts wait; they do not each run an independent retry burst.
function createAcrRequestScheduler({ maximum = 3, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), maxWaitMs = 120000 } = {}) {
  let active = 0;
  let capacityBlocked = false;
  let retryAt = 0;
  let generation = 0;
  let rejectionCode = 'ACR_CAPACITY_LIMIT';
  let waitingTimer = null;
  const queue = [];
  const drain = () => {
    if (!queue.length) return;
    if (capacityBlocked && retryAt > now()) {
      if (retryAt - now() > maxWaitMs) {
        while (queue.length) queue.shift().reject(Object.assign(new Error(`Power BI requests are paused until ${new Date(retryAt).toLocaleString()}. No early retry was sent.`), {
          code: rejectionCode, retryAt,
        }));
        return;
      }
      if (!waitingTimer) waitingTimer = delay(retryAt - now()).then(() => { waitingTimer = null; drain(); });
      return;
    }
    const limit = capacityBlocked ? 1 : maximum;
    while (active < limit && queue.length) {
      active++;
      const next = queue.shift();
      const admittedGeneration = generation;
      next.resolve({
        release() { active--; drain(); },
        succeeded() {
          if (admittedGeneration === generation) { capacityBlocked = false; retryAt = 0; }
        },
        throttle(waitMs, error) {
          generation++;
          capacityBlocked = true;
          rejectionCode = error?.code || 'ACR_CAPACITY_LIMIT';
          retryAt = Math.max(retryAt, now() + waitMs);
        },
      });
    }
  };
  return {
    acquire(onWait) {
      if (capacityBlocked && retryAt > now()) onWait?.(retryAt - now());
      return new Promise((resolve, reject) => { queue.push({ resolve, reject }); drain(); });
    },
    get retryAt() { return retryAt; },
  };
}

const sharedAcrScheduler = createAcrRequestScheduler();
module.exports = { createAcrRequestScheduler, sharedAcrScheduler };
