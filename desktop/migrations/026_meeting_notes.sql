-- Per-meeting working notes: preparation brief, transcript, summary and personal notes.
--
-- WHY A SIDE TABLE. The meetings table (migration 007) is a read-only inventory populated
-- by the Python calendar ingest from Microsoft Graph; the desktop app treats it as a cache
-- and re-syncs it wholesale, so any user-authored text written back onto meetings rows would
-- be clobbered on the next sync. meeting_notes is app-owned, keyed 1:1 to meetings.event_id,
-- and never touched by the ingest -- so a user's prep/transcript/summary/personal notes
-- survive every re-sync. One row per meeting, created lazily on first save (upsert).
--
-- FIELDS.
--   preparation_notes -- the AI meeting brief (prepareMeetingBrief), persisted when generated
--                        so it is still there on reopen instead of being regenerated each time.
--   transcript        -- user-pasted or captured meeting transcript (free text).
--   summary           -- a short human/AI summary of what happened.
--   personal_notes    -- the SE's own private notes.
-- All are nullable free text; the panel writes whichever field changed via an upsert.
--
-- Milestone linking for a meeting is NOT stored here -- it reuses the canonical signal_links
-- graph (signal_type='meeting', signal_id='meeting:<event_id>', target_type='milestone'),
-- exactly like the milestone "Related signal" finder, so a link made from the meeting panel
-- shows up in the milestone detail panel and everywhere else that reads signal_links.

CREATE TABLE IF NOT EXISTS meeting_notes (
  event_id          TEXT PRIMARY KEY,
  preparation_notes TEXT,
  transcript        TEXT,
  summary           TEXT,
  personal_notes    TEXT,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES meetings(event_id)
);

PRAGMA user_version = 26;
