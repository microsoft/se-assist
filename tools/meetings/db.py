"""Database access for the meeting datastore.

Reuses the live seassist.db. Mirrors desktop/migrations/007_meeting_inventory.sql so the
tool works standalone before the app applies the migration. Also ensures the shared
teams_customer_aliases table exists (the linker reuses the account alias map built by
tools.teams.aliases).
"""
from __future__ import annotations

from tools.common import db as _common

# Mirror of desktop/migrations/007_meeting_inventory.sql.
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meetings (
  event_id TEXT PRIMARY KEY,
  ical_uid TEXT,
  series_master_id TEXT,
  subject TEXT,
  organizer_name TEXT,
  organizer_address TEXT,
  attendees_json TEXT,
  start_at TEXT,
  end_at TEXT,
  is_online_meeting INTEGER NOT NULL DEFAULT 0,
  online_meeting_url TEXT,
  location TEXT,
  body_text TEXT,
  body_source TEXT,
  body_preview TEXT,
  importance TEXT,
  sensitivity TEXT,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  web_link TEXT,
  is_customer_related INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_series ON meetings(series_master_id);

CREATE TABLE IF NOT EXISTS meeting_customer_links (
  event_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, tpid),
  FOREIGN KEY (event_id) REFERENCES meetings(event_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_links_tpid ON meeting_customer_links(tpid);

CREATE TABLE IF NOT EXISTS meeting_customer_profile (
  tpid TEXT PRIMARY KEY,
  display_name TEXT,
  meeting_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  profile_markdown TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meeting_sync (
  scope_key TEXT PRIMARY KEY,
  synced_through TEXT,
  last_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Shared account alias table (also created by migration 003).
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
