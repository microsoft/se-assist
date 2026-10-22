-- Retire milestone_signal_links; the milestone "Related signal" finder now writes signal_links
-- natively. This is the FINAL step of the expand -> migrate -> contract move begun in 022.
--
-- BACKGROUND. Migration 022 made signal_links the canonical signal -> entity graph and copied
-- milestone_signal_links into it (Backfill #1, target_type='milestone'). Until now signal_links
-- was kept as a DERIVED MIRROR of milestone_signal_links by a reconcile engine
-- (services/signal-links.js): every milestone signal write went to the legacy table and a
-- reconcile re-derived the milestone slice of signal_links from it. Migration 023 already cut the
-- workload panel over to native signal_links and dropped work_item_signal_links, leaving
-- milestone_signal_links as the ONE remaining legacy writer the reconcile engine governed.
--
-- WHAT THIS RELEASE DOES. The milestone finder, self-heal (prune-rejected / dedupe-email) and
-- delete paths are rewritten to read AND write signal_links directly (target_type='milestone'),
-- exactly as the workload panel does. With no legacy writer left, the reconcile engine, the
-- SE_SIGNAL_LINKS_READ flag and the se-db-run legacy-table sniffer are deleted in the SAME
-- release. This migration removes the now-unused table.
--
-- WHY BACKFILL-THEN-DROP IS LOSS-PROOF. The previous build reconciled after every milestone
-- write and on startup, so signal_links already mirrors milestone_signal_links row-for-row
-- (parity was proven: orphaned=0). This INSERT OR IGNORE re-runs migration 022's milestone
-- backfill verbatim as a belt-and-braces final sync BEFORE the drop: it can only ADD a row the
-- mirror somehow missed, never delete one (OR IGNORE skips rows already present on the UNIQUE
-- identity). Only after that idempotent top-up do we drop the legacy table. So even a last-second
-- legacy row written just before upgrade is preserved.
--
-- CHAT GRAIN (stated, not hidden). milestone_signal_links stored ONE ROW PER CHAT MESSAGE (same
-- chat_id, distinct ref_id message ids) and the reader collapsed them into a single card with a
-- message `count`. signal_links stores ONE ROW PER CHAT THREAD (signal_id='chat:'<chat_id>), so
-- the canonicalization below keys chats by chat_id and the roll-up count is gone (always 1). This
-- was already the live behavior in canonical read mode; the drop just makes it the only mode.
--
-- ORDERING IS SAFE. 017 creates the table, 022 backfills FROM it, 024 tops-up and drops it --
-- each runs in filename order under one transaction (see runVersionedMigrations), so the table
-- exists when 022/024 read it and is gone only after this point. No surviving code references the
-- table: the reconcile engine and its DESIRED_SET_SQL (the only other reader) are deleted in this
-- release.

-- ---------------------------------------------------------------------------
-- Final idempotent top-up: milestone_signal_links -> signal_links (target_type='milestone').
-- Verbatim port of migration 022's Backfill #1 -- same guards, chat canonicalization (chat uses
-- chat_id, falling back to ref_id) and source default -- so on an already-mirrored DB it inserts
-- zero rows. INSERT OR IGNORE dedupes against UNIQUE(signal_type, signal_id, target_type,
-- target_id).
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

DROP TABLE IF EXISTS milestone_signal_links;

PRAGMA user_version = 24;
