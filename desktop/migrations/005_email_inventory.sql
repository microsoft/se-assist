-- Email inventory + customer mapping datastore (personal enrichment, mirrors the
-- Teams chat datastore in 003/004). Populated by the Python tool in tools/email
-- from mailbox data pulled via the WorkIQ MCP / Microsoft Graph. The desktop app
-- reads these tables read-only to give the customer profile, the comprehensive
-- summary, and the AI assistant additional email-derived context.

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
  body_source TEXT,                            -- 'body' | 'preview'
  has_attachments INTEGER NOT NULL DEFAULT 0,
  importance TEXT,
  web_link TEXT,
  is_customer_related INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_conversation ON emails(conversation_id);

-- Many-to-many: one email can relate to several accounts (shared pod threads).
CREATE TABLE IF NOT EXISTS email_customer_links (
  message_id TEXT NOT NULL,
  tpid TEXT NOT NULL,
  match_method TEXT NOT NULL DEFAULT 'alias',  -- alias | domain | search | manual
  matched_term TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, tpid),
  FOREIGN KEY (message_id) REFERENCES emails(message_id)
);
CREATE INDEX IF NOT EXISTS idx_email_links_tpid ON email_customer_links(tpid);

-- Generated per-account email intelligence (markdown + structured facts), parallel
-- to teams_customer_profile, for meeting prep and assistant context.
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

-- Differential watermark per scope (tpid or 'global'): newest received_at ingested.
CREATE TABLE IF NOT EXISTS email_sync (
  scope_key TEXT PRIMARY KEY,
  synced_through TEXT,
  last_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
