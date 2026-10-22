-- Concept-key identity for workload suggestions (dedup/dismissal Option A).
--
-- Permanent dismissal (the "Delete" action on a suggested workload) now suppresses by a stable,
-- model-assigned CONCEPT KEY per account — a short kebab-case slug naming the effort
-- (e.g. "fabric-data-migration") — instead of the earlier fuzzy title/description token overlap.
--
-- Exact (tpid, concept_key) matching is:
--   * stable across runs (the same effort yields the same slug even when the model re-words the
--     title on a later run), so a dismissed idea stays dismissed;
--   * volume-independent (an account has a handful of concepts regardless of how many thousands
--     of raw signals it generates), so a noisy account still converges to quiet;
--   * precise (no fuzzy token overlap), so dismissing one effort never silently suppresses an
--     unrelated one for the same account.
--
-- Migration notes: 027 created workload_suggestion_dismissals with the fuzzy title/description
-- columns; here we add concept_key to it AND to workload_suggestions. Existing dismissal rows
-- from the fuzzy era keep concept_key = NULL and simply stop matching (they no longer suppress) —
-- a clean, intentional cutover. New dismissals record the suggestion's concept_key.

ALTER TABLE workload_suggestions ADD COLUMN concept_key TEXT;
ALTER TABLE workload_suggestion_dismissals ADD COLUMN concept_key TEXT;

-- One durable dismissal per (account, concept). SQLite treats NULLs as distinct, so legacy
-- fuzzy-era rows (concept_key NULL) do not collide and INSERT OR IGNORE stays idempotent for
-- real keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wsd_tpid_concept
  ON workload_suggestion_dismissals(tpid, concept_key);

PRAGMA user_version = 28;
