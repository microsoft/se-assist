/**
 * concurrency.js — chunked, bounded-parallel fetch helpers (CommonJS).
 *
 * Main-process twin of src/frontend/src/lib/concurrency.js. Used by the
 * owned-accounts derivation to fan out its GUID-list OData chunks with a
 * bounded number of requests in flight, mirroring the Python reference
 * client's `asyncio.gather` + `Semaphore(MAX_CONCURRENT_REQUESTS)` batching.
 */

// Max concurrent CRM requests per batch (matches the MSX reference client).
const MAX_CONCURRENT_REQUESTS = 5;

// Split an array into contiguous chunks of at most `size` elements.
function chunkArray(arr, size) {
  const out = [];
  const list = Array.isArray(arr) ? arr : [...(arr || [])];
  const step = Math.max(1, size);
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

// Run `worker(item, index)` across `items` with at most `concurrency` calls in
// flight at once, returning results in the original item order. If a worker
// rejects, the returned promise rejects (like Promise.all / asyncio.gather).
async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [...(items || [])];
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const limit = Math.max(1, Math.min(concurrency || 1, list.length));
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  const runners = [];
  for (let i = 0; i < limit; i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

module.exports = { MAX_CONCURRENT_REQUESTS, chunkArray, mapWithConcurrency };
