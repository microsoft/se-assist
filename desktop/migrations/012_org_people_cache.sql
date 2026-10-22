-- Local read-through cache of the Microsoft org directory (Entra people + reporting
-- edges), populated ON-READ from WorkIQ/Graph by the My Org page. This is a *cache*,
-- never the source of truth:
--   * Hierarchy traversal (person / manager chain / direct reports) is served from here
--     for speed — the org chart changes rarely — and refreshed live on a cache miss, when
--     stale (TTL), or when the user hits Refresh.
--   * The two SEARCH modes (individual + product) ALWAYS query the live directory and only
--     *merge* cached matches in. They are never restricted to cached rows, so newly-relevant
--     people are never missed.
--
-- Rows are only ever written as a side effect of the user's own on-demand reads — there is
-- no bulk tenant enumeration. Privacy: single-user private app; directory PII stays local
-- and is never committed to the repo (same posture as the other cached tables).
--
-- Edge model (adjacency list — a SQLite table IS a graph):
--   manager_id = '<id>'  -> known manager (upward edge; that person's direct reports)
--   manager_id = ''      -> resolved and confirmed top-of-chain / no manager
--   manager_id IS NULL   -> manager not yet resolved (node seen via search only)

CREATE TABLE IF NOT EXISTS org_people (
  id                  TEXT PRIMARY KEY,               -- Entra objectId
  display_name        TEXT NOT NULL DEFAULT '',
  job_title           TEXT NOT NULL DEFAULT '',
  department          TEXT NOT NULL DEFAULT '',
  mail                TEXT NOT NULL DEFAULT '',        -- lower-cased mail or UPN
  user_principal_name TEXT NOT NULL DEFAULT '',
  office_location     TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  country             TEXT NOT NULL DEFAULT '',
  manager_id          TEXT,                            -- see edge model above
  manager_fetched_at  TEXT,                            -- ISO ts the manager edge was resolved
  reports_fetched_at  TEXT,                            -- ISO ts direct reports were enumerated
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_people_manager ON org_people(manager_id);
CREATE INDEX IF NOT EXISTS idx_org_people_name    ON org_people(display_name);
CREATE INDEX IF NOT EXISTS idx_org_people_mail    ON org_people(mail);
CREATE INDEX IF NOT EXISTS idx_org_people_title   ON org_people(job_title);
