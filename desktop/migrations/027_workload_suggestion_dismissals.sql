-- Permanent dismissals for AI-proposed workload suggestions.
--
-- When the SE Deletes a suggested workload, we record a durable dismissal here so the same
-- proposal (same account + a similar title/description) is NOT surfaced again by future
-- "Suggest workloads" runs. This is a deliberate reversal of the original draft-only Delete:
-- Delete now PERMANENTLY dismisses.
--
-- Rows are matched fuzzily at suggest time using the same normalized token-overlap logic that
-- drops proposals duplicating an already-existing workload (see services/workload-suggestion-dedup),
-- so a lightly-reworded re-proposal is still suppressed. We store the raw tpid/title/description
-- (not a precomputed key) to stay consistent with how existing workloads are compared.

CREATE TABLE IF NOT EXISTS workload_suggestion_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tpid TEXT NOT NULL,                 -- resolved customer account TPID the suggestion was for
  account_name TEXT,                  -- snapshot of the account name at dismissal time
  title TEXT NOT NULL,                -- dismissed proposal title (matched fuzzily)
  description TEXT,                    -- dismissed proposal description (matched fuzzily)
  source_json TEXT,                    -- provenance snapshot carried over from the dismissed draft
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wsd_tpid ON workload_suggestion_dismissals(tpid);

PRAGMA user_version = 27;
