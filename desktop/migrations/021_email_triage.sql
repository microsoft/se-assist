-- Email triage: local, app-owned per-thread handling state for the Email (Priority Inbox) surface.
--
-- The `emails` datastore (migration 005) is ingested READ-ONLY by the Python/Graph tool, so the
-- app must never mutate it. "Handling" an email inside SE Assist therefore lives here, in a
-- dedicated local table keyed by the email THREAD (conversation_id, or the message_id when a mail
-- has no conversation). A row exists only once the SE has acted on a thread; its absence means the
-- thread is untouched. This mirrors how workload_suggestions keeps app-owned state separate from the
-- ingested source rows, and — like Delete on a suggestion — clearing triage records NO suppression,
-- so a thread simply returns to the untouched inbox.

CREATE TABLE IF NOT EXISTS email_triage (
  conversation_id TEXT PRIMARY KEY,             -- thread key: emails.conversation_id, else emails.message_id
  status TEXT,                                  -- todo | waiting | done | snoozed | NULL (note-only, no bucket)
  snooze_until TEXT,                            -- ISO timestamp; set when status = 'snoozed'
  note TEXT,                                    -- freeform SE note about how the thread is being handled
  last_subject TEXT,                            -- snapshot of the thread subject for display continuity
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_triage_status ON email_triage(status);

PRAGMA user_version = 21;
