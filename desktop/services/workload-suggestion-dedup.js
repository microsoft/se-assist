'use strict';

// Secondary de-duplication for AI-proposed workload suggestions. Drops any proposal that already
// exists as a workload for the same account (matched on account + a similar title/description) or
// that duplicates an earlier proposal in the same batch. Uses normalized token overlap so a
// slightly-reworded re-proposal is still caught, not only a verbatim match.
//
// "Account + description" is the identity signal the caller asked for: suggestions are keyed by
// tpid (account) and compared by normalized title+description similarity within that account.

function normText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(s) {
  return new Set(normText(s).split(' ').filter((w) => w.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// Two items (each { title, description }) are "the same workload" when they share the same account
// and either an identical normalized title or a high normalized token overlap of title+description.
const SIMILAR_THRESHOLD = 0.6;

function fingerprint(item) {
  return { title: normText(item && item.title), tokens: tokenSet(`${(item && item.title) || ''} ${(item && item.description) || ''}`) };
}

function matchesAny(fp, list) {
  if (!list || !list.length) return false;
  return list.some((w) => (w.title && fp.title && w.title === fp.title) || jaccard(w.tokens, fp.tokens) >= SIMILAR_THRESHOLD);
}

// Index existing workloads by account tpid → [fingerprint]. `customer_tpid`/`tpid` and
// `title`/`name`/`description` are read by the caller; here we accept { tpid, title, description }.
function indexByTpid(items) {
  const byTpid = new Map();
  for (const it of items || []) {
    const key = String((it && it.tpid) || '');
    if (!key) continue;
    if (!byTpid.has(key)) byTpid.set(key, []);
    byTpid.get(key).push(fingerprint(it));
  }
  return byTpid;
}

// Return the subset of `suggestions` that are NOT already an existing workload and NOT a near-dup
// of an earlier kept suggestion. Input order is preserved. `suggestions` and `existingWorkloads`
// are arrays of objects with { tpid, title, description }.
function dedupeSuggestions(suggestions, existingWorkloads) {
  const existingByTpid = indexByTpid(existingWorkloads);
  const kept = [];
  const keptByTpid = new Map();
  for (const sug of suggestions || []) {
    const tpidKey = String((sug && sug.tpid) || '');
    const fp = fingerprint(sug);
    if (matchesAny(fp, existingByTpid.get(tpidKey))) continue;   // already exists as a workload
    if (matchesAny(fp, keptByTpid.get(tpidKey))) continue;       // near-dup of one kept this batch
    kept.push(sug);
    if (!keptByTpid.has(tpidKey)) keptByTpid.set(tpidKey, []);
    keptByTpid.get(tpidKey).push(fp);
  }
  return kept;
}

module.exports = { dedupeSuggestions, normText, tokenSet, jaccard, SIMILAR_THRESHOLD };
