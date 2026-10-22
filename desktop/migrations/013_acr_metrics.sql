-- Local Azure Consumed Revenue (ACR) analytics store. The live ACR surfaces read
-- from the MSX-I Power BI model on demand (and cache in-memory for a day); this
-- table persists explicit "download FY26/FY27" snapshots to SQLite so the analysis
-- engine and offline analytics can work without re-querying Power BI. Rows are
-- replaced per (fiscal_year, grain, service_level) on each snapshot — the store is
-- a materialized cache, not a system of record.

-- Territory account x fiscal-month ACR ($), summed across the snapshot's TPIDs.
CREATE TABLE IF NOT EXISTS acr_account_metrics (
  fiscal_year  TEXT NOT NULL,                 -- e.g. FY26
  fiscal_month TEXT NOT NULL,                 -- e.g. FY26-Sep
  account      TEXT NOT NULL,                 -- TPAccountName from the model
  acr          REAL NOT NULL DEFAULT 0,
  snapshot_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fiscal_year, fiscal_month, account)
);
CREATE INDEX IF NOT EXISTS idx_acr_acct_metrics_fy ON acr_account_metrics(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_acr_acct_metrics_acct ON acr_account_metrics(account);

-- Territory service x fiscal-month ACR ($) at a chosen service level, summed across
-- the snapshot's TPIDs. Powers service-mix trends and the analysis engine.
CREATE TABLE IF NOT EXISTS acr_service_metrics (
  fiscal_year   TEXT NOT NULL,
  fiscal_month  TEXT NOT NULL,
  service_level INTEGER NOT NULL,             -- 1..5
  service       TEXT NOT NULL,                -- ServiceLevelN value
  acr           REAL NOT NULL DEFAULT 0,
  snapshot_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fiscal_year, service_level, fiscal_month, service)
);
CREATE INDEX IF NOT EXISTS idx_acr_svc_metrics_fy ON acr_service_metrics(fiscal_year, service_level);

-- One row per completed snapshot run, for freshness display + provenance.
CREATE TABLE IF NOT EXISTS acr_snapshot_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_years  TEXT NOT NULL,                -- comma-joined, e.g. "FY26,FY27"
  service_level INTEGER NOT NULL,
  tpid_count    INTEGER NOT NULL DEFAULT 0,
  account_rows  INTEGER NOT NULL DEFAULT 0,
  service_rows  INTEGER NOT NULL DEFAULT 0,
  ran_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
