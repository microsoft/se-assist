-- HoK Activities cache. Previously fetched live from Dynamics on every view; now the
-- single "Sync from CRM" action stores the territory's tasks here so the HoK tab and
-- Dashboard read from local SQLite (fast, offline, consistent with customers/milestones).
--
-- The stored set is the union of (a) tasks owned by the signed-in user and (b) tasks
-- whose "regarding" record is a milestone in the book of business. owner_id and
-- regarding_id let the read path reproduce both the "mine" and "full territory" views.
CREATE TABLE IF NOT EXISTS hok_tasks (
  activity_id     TEXT PRIMARY KEY,
  subject         TEXT,
  created_on      TEXT,
  scheduled_end   TEXT,
  actual_end      TEXT,
  state_code      INTEGER,
  status_code     INTEGER,
  task_category   INTEGER,
  owner_id        TEXT,
  regarding_id    TEXT,
  regarding_type  TEXT,
  last_synced_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hok_tasks_owner ON hok_tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_hok_tasks_regarding ON hok_tasks(regarding_id);
