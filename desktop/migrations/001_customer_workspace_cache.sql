CREATE TABLE IF NOT EXISTS sync_cursors (
  entity_type TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor_value TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, source)
);

CREATE TABLE IF NOT EXISTS local_outbox (
  op_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_customer_profiles (
  id TEXT PRIMARY KEY,
  tpid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  relationship_health TEXT NOT NULL DEFAULT 'unknown',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_customer_timeline_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  relevance_score REAL NOT NULL DEFAULT 0.5,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_customer_email_refs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  graph_message_id TEXT NOT NULL,
  conversation_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  sender_email TEXT,
  sent_at TEXT,
  snippet TEXT CHECK (length(snippet) <= 512),
  participants_json TEXT NOT NULL DEFAULT '[]',
  extracted_facts_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, graph_message_id)
);

CREATE TABLE IF NOT EXISTS cached_customer_meeting_refs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  graph_event_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  starts_at TEXT,
  ends_at TEXT,
  organizer_email TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  transcript_ref TEXT,
  prep_status TEXT NOT NULL DEFAULT 'not_started',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, graph_event_id)
);

CREATE TABLE IF NOT EXISTS cached_customer_todos (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  due_at TEXT,
  source_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_customer_assets (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  asset_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  freshness_label TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cached_customer_transcripts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  meeting_ref_id TEXT,
  title TEXT NOT NULL,
  recorded_at TEXT,
  storage_uri TEXT,
  summary TEXT NOT NULL DEFAULT '',
  extracted_actions_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cached_profiles_tpid ON cached_customer_profiles(tpid);
CREATE INDEX IF NOT EXISTS idx_cached_timeline_profile ON cached_customer_timeline_events(profile_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_outbox_status ON local_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cached_assets_profile ON cached_customer_assets(profile_id);
CREATE INDEX IF NOT EXISTS idx_cached_todos_profile ON cached_customer_todos(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_cached_transcripts_profile ON cached_customer_transcripts(profile_id, recorded_at DESC);
