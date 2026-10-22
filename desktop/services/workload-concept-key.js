'use strict';

// Stable CONCEPT KEYS for workload suggestions (dedup/dismissal Option A).
//
// A concept key is a short, account-agnostic kebab-case slug naming the *effort* a suggestion is
// about — e.g. "fabric-data-migration", "copilot-adoption", "sap-on-azure-migration". It is
// assigned by the model per proposal and normalized here.
//
// Permanent dismissal ("Delete" on a suggested workload) suppresses by (tpid, concept_key):
//   * EXACT match, so it never silently over-suppresses unrelated efforts the way fuzzy
//     title/description token-overlap could;
//   * STABLE across runs, because the same effort yields the same slug even when the model
//     re-words the title/description on a later run;
//   * VOLUME-INDEPENDENT, because an account has a handful of concepts no matter how many
//     thousands of raw signals it generates — unlike per-signal review, which never converges
//     against a high-volume account.

const MAX_KEY_LEN = 60;

// Lowercase, collapse any run of non-alphanumerics to a single hyphen, trim hyphens, cap length.
// Returns '' for empty/garbage input so callers can fall back to a title-derived key.
function normalizeConceptKey(s) {
  const slug = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_KEY_LEN)
    .replace(/^-+|-+$/g, '');
  return slug;
}

// Deterministic fallback when the model omits a usable key: derive one from the title so every
// suggestion ALWAYS carries a stable key (a missing key must never mean "un-dismissable").
function deriveConceptKey(title) {
  return normalizeConceptKey(title);
}

// Return the subset of `suggestions` whose (tpid, conceptKey) was NOT permanently dismissed.
// `dismissedKeysByTpid` is a Map<tpid, Set<normalizedConceptKey>>. Input order is preserved and
// matching is EXACT on the normalized key — a suggestion with no resolvable key is never treated
// as dismissed (it simply passes through and is caught, if needed, by the existing-workload check).
function dropDismissedByKey(suggestions, dismissedKeysByTpid) {
  if (!dismissedKeysByTpid || !dismissedKeysByTpid.size) return (suggestions || []).slice();
  return (suggestions || []).filter((s) => {
    const keys = dismissedKeysByTpid.get(String((s && s.tpid) || ''));
    if (!keys || !keys.size) return true;
    const key = normalizeConceptKey(s && s.conceptKey);
    return !(key && keys.has(key));
  });
}

module.exports = { normalizeConceptKey, deriveConceptKey, dropDismissedByKey, MAX_KEY_LEN };
