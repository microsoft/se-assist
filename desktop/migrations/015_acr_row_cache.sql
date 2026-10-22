-- Persistent read-through cache for raw ACR row fetches (fetchRows in
-- acr-querydata.js), keyed by the full query spec (columns + TPIDs + fiscal
-- year/month + service filter). ACR is a monthly-grain model, so a fetched result
-- stays valid for days. Persisting each fetch to SQLite means the Consumption
-- surfaces populate from the local database across app restarts and only re-hit
-- Power BI when the cached rows are older than the freshness window (7 days) or
-- the user forces a refresh.
--
-- A materialized cache, not a system of record: each successful live fetch
-- replaces the row and stamps a fresh pulled_at. The pulled_at date is surfaced so
-- consumers can disclose when a local (cached) result is being used instead of a
-- live pull (repo policy: no silent fallback).
CREATE TABLE IF NOT EXISTS acr_row_cache (
  cache_key  TEXT PRIMARY KEY,            -- deterministic JSON spec key (cols+tpids+fy+month+serviceFilter)
  rows_json  TEXT NOT NULL,               -- JSON array of shaped rows returned by the query
  row_count  INTEGER NOT NULL DEFAULT 0,  -- rows_json length, for cheap logging/inspection
  pulled_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP  -- UTC timestamp of the live Power BI pull
);
CREATE INDEX IF NOT EXISTS idx_acr_row_cache_pulled ON acr_row_cache(pulled_at);
