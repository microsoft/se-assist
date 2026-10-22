-- Unified signal -> entity link graph.
--
-- Emails, meetings and Teams chats are "signals". Until now they were associated with
-- the rest of the app through THREE different, inconsistent mechanisms:
--   * per-source account links (email_customer_links / meeting_customer_links /
--     teams_chat_customer_links) -- clean, keyed on each source's native id + tpid;
--   * milestone_signal_links (kind / ref_id / chat_id -> milestone_id) -- polymorphic #1;
--   * work_item_signal_links (signal_type / signal_id -> workload_id/action_id/
--     milestone_id/opportunity_id) -- polymorphic #2, different column vocabulary.
-- A milestone could be expressed in BOTH polymorphic tables (source-of-truth ambiguity),
-- HoK activities had no signal association at all, and the "signal id" grain for Teams was
-- documented one way (message_id) but written another (chat_id).
--
-- This migration introduces ONE canonical association table, signal_links, with a single
-- rule set so a Teams id can never be confused with an email id:
--   * identity is the COMPOSITE (signal_type, signal_id, target_type, target_id) -- never
--     signal_id alone;
--   * signal_id is SELF-DESCRIBING / namespaced as '<signal_type>:<native id>'
--     (email:<message_id> | meeting:<event_id> | chat:<chat_id>). Even a stray type-less
--     lookup cannot cross namespaces because the prefixes differ. This mirrors the id
--     convention already used in services/customer-relationship-graph.js ("email:<id>").
--   * ONE grain per source: email = emails.message_id, meeting = meetings.event_id,
--     chat = teams_chats.chat_id (thread grain -- the unit the app actually operates on);
--   * CHECK constraints pin the allowed signal_type / target_type values and enforce that
--     signal_id carries its own type prefix.
-- No polymorphic foreign keys: target_id references live local rows (workloads.id,
-- workload_actions.id) as well as external CRM ids (milestone_id, opportunity_id) and
-- account tpids, so integrity is enforced by the resolver (services/signal-links.js) and
-- the CHECKs rather than by FK. On delete of a workload/action the app is responsible for
-- pruning its signal_links rows (the resolver exposes unlink helpers for that).
--
-- SCOPE: signal_links carries the "work item" associations that were fragmented above the
-- account layer (milestone / opportunity / workload / action / hok_activity). Account
-- associations intentionally stay in the existing, already-clean per-source *_customer_links
-- tables; duplicating them here would create a second source of truth with no consumer.
--
-- LEGACY: milestone_signal_links and work_item_signal_links are SUPERSEDED by this table but
-- are NOT dropped here -- they are still read/written by live code (the milestone "Related
-- signal" finder and the workload SignalAssignments section). Their data is copied (not moved)
-- into signal_links below so the canonical table is complete from day one. Once every consumer
-- reads/writes signal_links, a later migration can drop the two legacy tables. The legacy
-- cached_customer_*_refs tables (Graph era) are also left untouched -- still live.

CREATE TABLE IF NOT EXISTS signal_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type     TEXT NOT NULL,                 -- email | meeting | chat
  signal_id       TEXT NOT NULL,                 -- '<signal_type>:<native id>'
                                                 --   email   -> emails.message_id
                                                 --   meeting -> meetings.event_id
                                                 --   chat    -> teams_chats.chat_id
  target_type     TEXT NOT NULL,                 -- account | milestone | opportunity | workload | action | hok_activity
  target_id       TEXT NOT NULL,                 -- tpid | milestone_id | opportunity_id | workloads.id | workload_actions.id | hok_tasks.activity_id
  tpid            TEXT,                          -- denormalized account for fast scoping (nullable)
  signal_title    TEXT,                          -- snapshot: subject / topic
  signal_subtitle TEXT,                          -- snapshot: from_name / organizer_name / sender_name
  signal_date     TEXT,                          -- snapshot: received_at / start_at / sent_at
  source          TEXT NOT NULL DEFAULT 'manual',-- ai | manual
  confidence      REAL,
  rationale       TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (signal_type IN ('email','meeting','chat')),
  CHECK (target_type IN ('account','milestone','opportunity','workload','action','hok_activity')),
  CHECK (signal_id LIKE signal_type || ':%'),
  UNIQUE (signal_type, signal_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_links_target ON signal_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_signal_links_signal ON signal_links(signal_type, signal_id);
CREATE INDEX IF NOT EXISTS idx_signal_links_tpid   ON signal_links(tpid);

-- ---------------------------------------------------------------------------
-- Backfill #1: milestone_signal_links -> signal_links (target_type = 'milestone').
-- Native id: email/meeting = ref_id; chat = chat_id (fall back to ref_id which also
-- holds the chat_id in practice). INSERT OR IGNORE dedupes against the UNIQUE identity,
-- which also absorbs any milestone rows re-derived from work_item_signal_links below.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO signal_links
  (signal_type, signal_id, target_type, target_id, tpid,
   signal_title, signal_subtitle, signal_date, source, rationale, created_at, updated_at)
SELECT
  msl.kind,
  msl.kind || ':' || (
    CASE WHEN msl.kind = 'chat'
         THEN COALESCE(NULLIF(TRIM(msl.chat_id), ''), msl.ref_id)
         ELSE msl.ref_id
    END
  ),
  'milestone',
  msl.milestone_id,
  NULL,
  msl.title,
  msl.subtitle,
  msl.item_date,
  COALESCE(NULLIF(TRIM(msl.source), ''), 'ai'),
  msl.reason,
  COALESCE(msl.created_at, CURRENT_TIMESTAMP),
  COALESCE(msl.created_at, CURRENT_TIMESTAMP)
FROM milestone_signal_links msl
WHERE msl.kind IN ('email','meeting','chat')
  AND msl.milestone_id IS NOT NULL AND TRIM(msl.milestone_id) <> ''
  AND (
    CASE WHEN msl.kind = 'chat'
         THEN COALESCE(NULLIF(TRIM(msl.chat_id), ''), msl.ref_id)
         ELSE msl.ref_id
    END
  ) IS NOT NULL
  AND TRIM(
    CASE WHEN msl.kind = 'chat'
         THEN COALESCE(NULLIF(TRIM(msl.chat_id), ''), msl.ref_id)
         ELSE msl.ref_id
    END
  ) <> '';

-- ---------------------------------------------------------------------------
-- Backfill #2: work_item_signal_links -> signal_links. A single legacy row can name up to
-- four targets on one record (workload/action/milestone/opportunity); the clean model is
-- one row per (signal, target), so each non-null target is fanned out into its own row.
-- signal_id is raw + already the canonical grain (chat uses chat_id), so we just prefix it.
-- ---------------------------------------------------------------------------

-- 2a. workload targets
INSERT OR IGNORE INTO signal_links
  (signal_type, signal_id, target_type, target_id, tpid,
   signal_title, signal_subtitle, signal_date, source, confidence, rationale, created_at, updated_at)
SELECT
  w.signal_type,
  w.signal_type || ':' || w.signal_id,
  'workload',
  CAST(w.workload_id AS TEXT),
  w.tpid,
  w.signal_title, NULL, w.signal_date,
  COALESCE(NULLIF(TRIM(w.assignment_source), ''), 'manual'),
  w.confidence, w.rationale,
  COALESCE(w.created_at, CURRENT_TIMESTAMP),
  COALESCE(w.updated_at, w.created_at, CURRENT_TIMESTAMP)
FROM work_item_signal_links w
WHERE w.signal_type IN ('email','meeting','chat')
  AND w.signal_id IS NOT NULL AND TRIM(w.signal_id) <> ''
  AND w.workload_id IS NOT NULL;

-- 2b. action targets
INSERT OR IGNORE INTO signal_links
  (signal_type, signal_id, target_type, target_id, tpid,
   signal_title, signal_subtitle, signal_date, source, confidence, rationale, created_at, updated_at)
SELECT
  w.signal_type,
  w.signal_type || ':' || w.signal_id,
  'action',
  CAST(w.action_id AS TEXT),
  w.tpid,
  w.signal_title, NULL, w.signal_date,
  COALESCE(NULLIF(TRIM(w.assignment_source), ''), 'manual'),
  w.confidence, w.rationale,
  COALESCE(w.created_at, CURRENT_TIMESTAMP),
  COALESCE(w.updated_at, w.created_at, CURRENT_TIMESTAMP)
FROM work_item_signal_links w
WHERE w.signal_type IN ('email','meeting','chat')
  AND w.signal_id IS NOT NULL AND TRIM(w.signal_id) <> ''
  AND w.action_id IS NOT NULL;

-- 2c. milestone targets
INSERT OR IGNORE INTO signal_links
  (signal_type, signal_id, target_type, target_id, tpid,
   signal_title, signal_subtitle, signal_date, source, confidence, rationale, created_at, updated_at)
SELECT
  w.signal_type,
  w.signal_type || ':' || w.signal_id,
  'milestone',
  w.milestone_id,
  w.tpid,
  w.signal_title, NULL, w.signal_date,
  COALESCE(NULLIF(TRIM(w.assignment_source), ''), 'manual'),
  w.confidence, w.rationale,
  COALESCE(w.created_at, CURRENT_TIMESTAMP),
  COALESCE(w.updated_at, w.created_at, CURRENT_TIMESTAMP)
FROM work_item_signal_links w
WHERE w.signal_type IN ('email','meeting','chat')
  AND w.signal_id IS NOT NULL AND TRIM(w.signal_id) <> ''
  AND w.milestone_id IS NOT NULL AND TRIM(w.milestone_id) <> '';

-- 2d. opportunity targets
INSERT OR IGNORE INTO signal_links
  (signal_type, signal_id, target_type, target_id, tpid,
   signal_title, signal_subtitle, signal_date, source, confidence, rationale, created_at, updated_at)
SELECT
  w.signal_type,
  w.signal_type || ':' || w.signal_id,
  'opportunity',
  w.opportunity_id,
  w.tpid,
  w.signal_title, NULL, w.signal_date,
  COALESCE(NULLIF(TRIM(w.assignment_source), ''), 'manual'),
  w.confidence, w.rationale,
  COALESCE(w.created_at, CURRENT_TIMESTAMP),
  COALESCE(w.updated_at, w.created_at, CURRENT_TIMESTAMP)
FROM work_item_signal_links w
WHERE w.signal_type IN ('email','meeting','chat')
  AND w.signal_id IS NOT NULL AND TRIM(w.signal_id) <> ''
  AND w.opportunity_id IS NOT NULL AND TRIM(w.opportunity_id) <> '';

PRAGMA user_version = 22;
