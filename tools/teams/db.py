"""Database access for the Teams datastore.

Locates the live seassist.db, opens it with sensible pragmas for concurrent access
with the running Electron app, and ensures the teams_* schema exists (idempotent —
mirrors desktop/migrations/003_teams_chat_inventory.sql so the tool also works
standalone before the app has applied the migration).
"""
from __future__ import annotations

from tools.common import db as _common

# Mirror of desktop/migrations/003_teams_chat_inventory.sql. Kept identical so the
# tool and the Electron app converge on the same schema regardless of which runs first.
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS teams_chats (
  chat_id TEXT PRIMARY KEY,
  topic TEXT,
  chat_type TEXT NOT NULL DEFAULT 'unknown',
  member_count INTEGER,
  has_unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_message_from TEXT,
  last_message_preview TEXT,
  is_customer_related INTEGER NOT NULL DEFAULT 0,
  messages_synced INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS teams_chat_customer_links (
  chat_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, tpid),
  FOREIGN KEY (chat_id) REFERENCES teams_chats(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_teams_links_tpid ON teams_chat_customer_links(tpid);

CREATE TABLE IF NOT EXISTS teams_customer_aliases (
  tpid TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tpid, alias)
);

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

CREATE TABLE IF NOT EXISTS teams_chat_sync (
  chat_id TEXT PRIMARY KEY,
  messages_synced_at TEXT,
  last_pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES teams_chats(chat_id)
);
"""

# Seed watermarks for chats already ingested, so the first differential run
# doesn't report them as stale. Idempotent (INSERT OR IGNORE).
BACKFILL_SQL = """
INSERT OR IGNORE INTO teams_chat_sync (chat_id, messages_synced_at)
SELECT chat_id, last_message_at FROM teams_chats WHERE messages_synced = 1;
"""


# Shared connector + path resolution (see tools/common/db.py).
default_db_path = _common.default_db_path
connect = _common.connect


def ensure_schema(con) -> None:
    _common.ensure_schema(con, SCHEMA_SQL, BACKFILL_SQL)
