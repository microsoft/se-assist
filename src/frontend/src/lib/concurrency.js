/**
 * concurrency.js — small helpers for chunked, bounded-parallel CRM fetches.
 *
 * The MSX sync pipeline pulls large sets (opportunities, milestones, tasks) by
 * splitting GUID lists into OData `$filter` chunks. Historically each chunk was
 * awaited one-at-a-time; these helpers fan the chunks out with a bounded number
 * of requests in flight, mirroring the Python reference client's
 * `asyncio.gather` + `Semaphore(MAX_CONCURRENT_REQUESTS)` batching. Only the
 * network fetches run in parallel — callers still process/write results
 * sequentially so the local SQLite writes stay serialized.
 */

// Max concurrent CRM requests per batch (matches the MSX reference client).
export const MAX_CONCURRENT_REQUESTS = 5;

// Split an array into contiguous chunks of at most `size` elements.
export function chunkArray(arr, size) {
  const out = [];
  const list = Array.isArray(arr) ? arr : [...(arr || [])];
  const step = Math.max(1, size);
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

// Run `worker(item, index)` across `items` with at most `concurrency` calls in
// flight at once, returning results in the original item order. If a worker
// rejects, the returned promise rejects (like Promise.all / asyncio.gather).
export async function mapWithConcurrency(items, concurrency, worker) {
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
