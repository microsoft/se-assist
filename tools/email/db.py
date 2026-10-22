"""Database access for the email datastore.

Reuses the live seassist.db. Mirrors desktop/migrations/005_email_inventory.sql so the
tool works standalone before the app applies the migration. Also ensures the
teams_customer_aliases table exists (the email linker reuses the shared account alias
map built by tools.teams.aliases).
"""
from __future__ import annotations

from tools.common import db as _common

# Mirror of desktop/migrations/005_email_inventory.sql.
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS emails (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  internet_message_id TEXT,
  subject TEXT,
  from_name TEXT,
  from_address TEXT,
  to_json TEXT,
  cc_json TEXT,
  sent_at TEXT,
  received_at TEXT,
  folder TEXT,
  body_text TEXT,
  body_source TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  importance TEXT,
  web_link TEXT,
  is_customer_related INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_conversation ON emails(conversation_id);

CREATE TABLE IF NOT EXISTS email_customer_links (
  message_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, tpid),
  FOREIGN KEY (message_id) REFERENCES emails(message_id)
);
CREATE INDEX IF NOT EXISTS idx_email_links_tpid ON email_customer_links(tpid);

CREATE TABLE IF NOT EXISTS email_customer_profile (
  tpid TEXT PRIMARY KEY,
  display_name TEXT,
  email_count INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  profile_markdown TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_sync (
  scope_key TEXT PRIMARY KEY,
  synced_through TEXT,
  last_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Shared account alias table (also created by migration 003). The email linker
-- reuses it so there is one source of truth for the 16 accounts.
CREATE TABLE IF NOT EXISTS teams_customer_aliases (
  tpid TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tpid, alias)
);
"""


# Shared connector + path resolution (see tools/common/db.py).
default_db_path = _common.default_db_path
connect = _common.connect


def ensure_schema(con) -> None:
    _common.ensure_schema(con, SCHEMA_SQL)
