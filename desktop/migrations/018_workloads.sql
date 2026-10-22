-- Workload Management: a personal, local-only tracking layer for a Solution Engineer's
-- "workloads" — things to deliver that need work to get there. Many workloads come up in
-- conversation (POCs, demos, ideas, requested work) that don't map cleanly to an MSX
-- Dynamics milestone, making them hard to track and easy to forget at review time. This
-- lets the SE capture each workload, link the MSX milestone(s) that represent it (so the
-- real work is tied to the tracking system that drives bonus), attach ad-hoc to-dos, and
-- also record non-customer/internal work that has no milestone but still shows value.
--
-- These tables are NOT synced to Dynamics; they are the SE's own overlay.

CREATE TABLE IF NOT EXISTS workloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'customer',        -- customer | internal
  tpid TEXT,                                    -- customer account TPID (customer workloads only)
  account_name TEXT,                            -- snapshot of the account name for display
  category TEXT,                                -- optional free-text bucket (e.g. POC, Demo, Enablement)
  status TEXT NOT NULL DEFAULT 'active',        -- active | delivered | archived
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workloads_kind ON workloads(kind);
CREATE INDEX IF NOT EXISTS idx_workloads_tpid ON workloads(tpid);
CREATE INDEX IF NOT EXISTS idx_workloads_status ON workloads(status);

-- Milestones (from the synced `milestones` table) attached to a workload. Fields are a
-- snapshot so a link stays meaningful even if the milestone row is later re-synced/purged.
CREATE TABLE IF NOT EXISTS workload_milestone_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  milestone_id TEXT NOT NULL,
  milestone_name TEXT,
  account_name TEXT,
  status_label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workload_id, milestone_id),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wml_workload ON workload_milestone_links(workload_id);

-- Ad-hoc to-dos attached to a workload (personal checklist toward delivering it).
CREATE TABLE IF NOT EXISTS workload_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_at TEXT,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wtodos_workload ON workload_todos(workload_id);
