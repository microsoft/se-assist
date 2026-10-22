-- Workload orchestration: ordered workload cards, reusable templates, delivery
-- stages, actions, workflows, assets, and links back to communication signals.

ALTER TABLE workloads ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workloads ADD COLUMN name TEXT;
ALTER TABLE workloads ADD COLUMN customer_tpid TEXT;
ALTER TABLE workloads ADD COLUMN customer_name TEXT;
ALTER TABLE workloads ADD COLUMN ssp_name TEXT;
ALTER TABLE workloads ADD COLUMN opportunity_id TEXT;
ALTER TABLE workloads ADD COLUMN opportunity_name TEXT;
ALTER TABLE workloads ADD COLUMN template_id INTEGER;
ALTER TABLE workloads ADD COLUMN is_reusable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workloads ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workloads ADD COLUMN artifact_url TEXT;

UPDATE workloads
SET sort_order = CASE WHEN sort_order = 0 THEN id ELSE sort_order END,
    name = COALESCE(NULLIF(name, ''), title),
    customer_tpid = COALESCE(customer_tpid, tpid),
    customer_name = COALESCE(customer_name, account_name);

ALTER TABLE workload_milestone_links ADD COLUMN opportunity_id TEXT;
ALTER TABLE workload_milestone_links ADD COLUMN opportunity_name TEXT;
ALTER TABLE workload_milestone_links ADD COLUMN customer_tpid TEXT;
ALTER TABLE workload_milestone_links ADD COLUMN customer_name TEXT;

UPDATE workload_milestone_links
SET customer_name = COALESCE(customer_name, account_name);

ALTER TABLE workload_todos ADD COLUMN due_date TEXT;
ALTER TABLE workload_todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workload_todos ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS workload_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workload_stages_workload
  ON workload_stages(workload_id, sort_order, id);

CREATE TABLE IF NOT EXISTS workload_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  stage_id INTEGER,
  milestone_id TEXT,
  opportunity_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  action_type TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  workflow_id INTEGER,
  asset_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_id) REFERENCES workload_stages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workload_actions_workload
  ON workload_actions(workload_id, status, sort_order, id);

-- Preserve existing to-dos as first-class actions.
INSERT INTO workload_actions (
  workload_id, title, status, due_date, sort_order, created_at, updated_at
)
SELECT
  t.workload_id,
  t.title,
  CASE WHEN t.done = 1 THEN 'done' ELSE 'open' END,
  t.due_date,
  t.sort_order,
  t.created_at,
  COALESCE(t.updated_at, t.done_at, t.created_at, CURRENT_TIMESTAMP)
FROM workload_todos t
WHERE NOT EXISTS (
  SELECT 1
  FROM workload_actions a
  WHERE a.workload_id = t.workload_id
    AND a.title = t.title
    AND COALESCE(a.due_date, '') = COALESCE(t.due_date, '')
);

CREATE TABLE IF NOT EXISTS workload_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  actions_reduced INTEGER NOT NULL DEFAULT 0,
  is_reusable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workload_workflows_workload
  ON workload_workflows(workload_id, status, id);

CREATE TABLE IF NOT EXISTS workload_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workload_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'reference',
  url TEXT,
  notes TEXT,
  is_reusable INTEGER NOT NULL DEFAULT 1,
  is_shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workload_assets_workload
  ON workload_assets(workload_id, asset_type, id);

CREATE TABLE IF NOT EXISTS workload_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  source_workload_id INTEGER,
  is_shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workload_template_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (template_id) REFERENCES workload_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workload_template_stages
  ON workload_template_stages(template_id, sort_order, id);

CREATE TABLE IF NOT EXISTS workload_template_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  template_stage_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  action_type TEXT NOT NULL DEFAULT 'task',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (template_id) REFERENCES workload_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (template_stage_id) REFERENCES workload_template_stages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workload_template_actions
  ON workload_template_actions(template_id, sort_order, id);

-- A signal can be assigned manually or by AI to any level of the work hierarchy.
CREATE TABLE IF NOT EXISTS work_item_signal_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  signal_title TEXT,
  signal_date TEXT,
  tpid TEXT,
  workload_id INTEGER,
  action_id INTEGER,
  milestone_id TEXT,
  opportunity_id TEXT,
  assignment_source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  rationale TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (action_id) REFERENCES workload_actions(id) ON DELETE CASCADE,
  UNIQUE(signal_type, signal_id, workload_id, action_id, milestone_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_work_item_signal_links_workload
  ON work_item_signal_links(workload_id, action_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_signal_links_unique_target
  ON work_item_signal_links(
    signal_type,
    signal_id,
    workload_id,
    COALESCE(action_id, -1),
    COALESCE(milestone_id, ''),
    COALESCE(opportunity_id, '')
  );

PRAGMA user_version = 19;
