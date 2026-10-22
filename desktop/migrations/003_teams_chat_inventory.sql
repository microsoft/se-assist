-- Teams chat inventory + customer mapping datastore.
-- Populated by the Python ingestion tool in tools/teams (data sourced from the
-- working Teams MCP tools, bypassing the non-functional Microsoft Graph backend).
-- The desktop app reads these tables read-only to surface chats on a customer profile.

CREATE TABLE IF NOT EXISTS teams_chats (
  chat_id TEXT PRIMARY KEY,
  topic TEXT,
  chat_type TEXT NOT NULL DEFAULT 'unknown',   -- oneOnOne | group | meeting | unnamed | unknown
  member_count INTEGER,
  has_unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_message_from TEXT,
  last_message_preview TEXT,
  is_customer_related INTEGER NOT NULL DEFAULT 0,
  messages_synced INTEGER NOT NULL DEFAULT 0,  -- 1 once full message bodies pulled
  raw_json TEXT,
  first_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_teams_chats_last_msg ON teams_chats(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_teams_chats_customer ON teams_chats(is_customer_related);

CREATE TABLE IF NOT EXISTS teams_chat_messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_name TEXT,
  sender_id TEXT,
  sent_at TEXT,
  content_type TEXT,
  body_text TEXT,
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES teams_chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_msgs_chat ON teams_chat_messages(chat_id, sent_at);

-- Many-to-many: one chat can relate to several accounts (e.g. "Contoso/Fabrikam").
CREATE TABLE IF NOT EXISTS teams_chat_customer_links (
  chat_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',  -- alias | manual | member | domain
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, tpid),
  FOREIGN KEY (chat_id) REFERENCES teams_chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_links_tpid ON teams_chat_customer_links(tpid);

CREATE TABLE IF NOT EXISTS teams_customer_aliases (
  tpid TEXT NOT NULL,
  alias TEXT NOT NULL,            -- normalized, lower-case match term
  source TEXT NOT NULL DEFAULT 'auto',  -- auto (from customers table) | curated | manual
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tpid, alias)
);

-- Generated comprehensive profile per account, for meeting prep.
CREATE TABLE IF NOT EXISTS teams_customer_profile (
  tpid TEXT PRIMARY KEY,
  display_name TEXT,
  chat_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  profile_markdown TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
