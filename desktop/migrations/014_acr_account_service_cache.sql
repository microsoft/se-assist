-- Read-through cache of the live per-account × service × month ACR result
-- (getAccountMonthlyServiceAcr), keyed by TPID. The customer analysis engine needs
-- THIS account's per-service momentum (rising/eroding/new services) — a finer grain
-- than the territory rollups in acr_account_metrics / acr_service_metrics, and one
-- that is only produced by the live per-TPID Power BI call. This table persists each
-- successful live fetch so the engine can reuse it when offline (no sign-in/VPN),
-- reliably keyed by the exact TPID that was queried (not a fuzzy account-name match).
--
-- A materialized cache, not a system of record: each successful live fetch replaces
-- the row. Consumers MUST disclose the cached_at date when they use a cached row
-- instead of a live number (repo policy: no silent fallback).
CREATE TABLE IF NOT EXISTS acr_account_service_cache (
  tpid          TEXT PRIMARY KEY,          -- the single account TPID that was queried
  fiscal_years  TEXT NOT NULL DEFAULT '',  -- e.g. "FY26 + FY27" from the result
  level         INTEGER NOT NULL DEFAULT 2,
  grand_total   REAL NOT NULL DEFAULT 0,
  latest_month  TEXT,                       -- most recent fiscal month in the series
  payload_json  TEXT NOT NULL,              -- full { services, months, grandTotal, ... }
  cached_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
