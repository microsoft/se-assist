-- Milestone ↔ signal link table.
-- Persists the emails, meetings, and Teams chats that the "Related signal" AI agent
-- (milestone-signal-finder) determined relate to a specific engagement milestone, so the
-- result is stable across opens (no repeated LLM calls) and auditable/editable by the user.
-- Fields are stored as a snapshot (title/subtitle/date/reason) so a link stays meaningful
-- even if the underlying email/meeting/chat row is later purged from the local cache.

CREATE TABLE IF NOT EXISTS milestone_signal_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- email | meeting | chat
  ref_id TEXT NOT NULL,                        -- emails.message_id | meetings.event_id | teams_chat_messages.message_id
  chat_id TEXT,                                -- teams: parent chat id (lets the UI open the conversation)
  title TEXT,                                  -- email subject / meeting subject / chat topic
  subtitle TEXT,                               -- email sender / meeting organizer / chat sender
  item_date TEXT,                              -- received_at / start_at / sent_at
  reason TEXT,                                 -- one-line AI rationale for the link
  source TEXT NOT NULL DEFAULT 'ai',           -- ai | manual
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (milestone_id, kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_msig_links_ms ON milestone_signal_links(milestone_id);
CREATE INDEX IF NOT EXISTS idx_msig_links_kind ON milestone_signal_links(milestone_id, kind);
