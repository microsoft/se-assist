CREATE TABLE IF NOT EXISTS cached_customer_teams_refs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  chat_id TEXT,
  team_id TEXT,
  channel_id TEXT,
  message_id TEXT NOT NULL,
  created_at TEXT,
  sender_name TEXT,
  sender_user_id TEXT,
  mention_summary TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_cached_teams_profile ON cached_customer_teams_refs(profile_id, created_at DESC);
