-- Meeting (calendar) inventory + customer mapping datastore (personal enrichment,
-- mirrors the email datastore in 005). Populated by the Python tool in tools/meetings
-- from calendar data pulled via the WorkIQ MCP / Microsoft Graph (/me/calendarView).
-- The desktop app reads these tables read-only to give the customer profile, the
-- comprehensive summary, and the AI assistant additional meeting-derived context
-- (subject, agenda/body, organizer, attendees, times).

CREATE TABLE IF NOT EXISTS meetings (
  event_id TEXT PRIMARY KEY,                    -- Graph event id
  ical_uid TEXT,                                -- iCalUId (stable across instances)
  series_master_id TEXT,                        -- recurring series master, if any
  subject TEXT,
  organizer_name TEXT,
  organizer_address TEXT,
  attendees_json TEXT,                          -- [{name,address,type,response}]
  start_at TEXT,
  end_at TEXT,
  is_online_meeting INTEGER NOT NULL DEFAULT 0,
  online_meeting_url TEXT,
  location TEXT,
  body_text TEXT,                               -- cleaned full body/agenda
  body_source TEXT,                             -- 'body' | 'preview'
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

-- Many-to-many: one meeting can relate to several accounts (shared pod reviews).
CREATE TABLE IF NOT EXISTS meeting_customer_links (
  event_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',   -- alias | alias-series | contact | manual
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, tpid),
  FOREIGN KEY (event_id) REFERENCES meetings(event_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_links_tpid ON meeting_customer_links(tpid);

-- Generated per-account meeting intelligence (markdown + structured facts), parallel
-- to email_customer_profile, for meeting prep and assistant context.
CREATE TABLE IF NOT EXISTS meeting_customer_profile (
  tpid TEXT PRIMARY KEY,
  display_name TEXT,
  meeting_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  profile_markdown TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Differential watermark per scope (tpid or 'global'): newest start_at ingested.
CREATE TABLE IF NOT EXISTS meeting_sync (
  scope_key TEXT PRIMARY KEY,
  synced_through TEXT,
  last_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
