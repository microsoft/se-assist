CREATE TABLE work_output_investigations (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL UNIQUE,
  task_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_output_areas (
  investigation_id TEXT NOT NULL REFERENCES work_output_investigations(id) ON DELETE CASCADE,
  area TEXT NOT NULL CHECK (area IN ('situation', 'reply', 'actions', 'technical')),
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'working', 'ready', 'ready_with_gaps', 'failed', 'needs_input')),
  version INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  focus TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  content_json TEXT,
  gaps_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  model TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (investigation_id, area)
);

CREATE TABLE work_output_steps (
  investigation_id TEXT NOT NULL REFERENCES work_output_investigations(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  step TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'blocked')),
  result_json TEXT,
  error_json TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (investigation_id, area, step)
);

CREATE TABLE work_output_task_links (
  investigation_id TEXT NOT NULL REFERENCES work_output_investigations(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES cached_customer_todos(id),
  PRIMARY KEY (investigation_id, action_key)
);

PRAGMA user_version = 30;
