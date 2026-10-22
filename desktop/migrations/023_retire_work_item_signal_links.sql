-- Retire work_item_signal_links; move workload comms-assignments fully onto signal_links.
--
-- BACKGROUND. Migration 022 made signal_links the canonical signal -> entity graph and
-- copied both legacy tables into it. The workload "Communication assignments" panel was the
-- ONLY writer of work_item_signal_links, a wide polymorphic row that could name a workload,
-- an action, a milestone and an opportunity at once. In practice that fan-out never happened:
--   * action_id was ALWAYS null (the panel never sets it), so 022's action branch is empty;
--   * the milestone/opportunity a workload assignment carried was a per-assignment ANNOTATION
--     ("this comms item supports milestone X"), not a real signal->milestone/opportunity
--     association. Fanning it into standalone milestone/opportunity signal_links rows created
--     phantom links no card ever reads, and on live data implied ZERO milestone rows.
-- The product decision (see the SignalAssignments cutover): a workload assignment is simply a
-- signal -> workload link that OPTIONALLY records which milestone/opportunity it supports. That
-- annotation belongs ON the workload row as qualifier columns, not as separate target rows.
--
-- WHAT THIS DOES.
--   1. Add qualifier columns to signal_links (only meaningful for target_type='workload').
--   2. Backfill those qualifiers onto the workload rows 022 already created, from the matching
--      work_item_signal_links row (deterministic pick; qualifiers are near-unused so any tie is
--      inconsequential).
--   3. Delete the phantom 'opportunity' / 'action' rows 022 derived from the fan-out. Nothing
--      reads them and, per the decision above, a workload assignment does not create a real
--      signal->opportunity/action association. (Milestone rows are left to the startup
--      reconcile, which after this release mirrors milestone_signal_links ONLY and will prune
--      any work_item-derived milestone row not implied by the milestone card. On live data
--      there are none.)
--   4. Drop work_item_signal_links (its indexes go with it).
--
-- ORDERING IS SAFE. 019 creates the table, 022 backfills FROM it, 023 drops it -- each runs in
-- order, so the table exists when 022 reads it and is gone only after this point. The reconcile
-- engine (services/signal-links.js) drops its four work_item branches in the SAME release, so
-- no code references the table after it is dropped.

ALTER TABLE signal_links ADD COLUMN qualifier_milestone_id TEXT;   -- workload assignments only
ALTER TABLE signal_links ADD COLUMN qualifier_opportunity_id TEXT; -- workload assignments only

-- Backfill the milestone/opportunity annotation onto the canonical workload rows. The canonical
-- signal_id for a workload row is '<signal_type>:<native id>' (022's backfill), so it joins back
-- to a work_item row on (signal_type, signal_type||':'||signal_id, workload_id). Where several
-- work_item rows collapsed onto one canonical row (same signal + workload, different milestones)
-- we deterministically prefer a row that actually names a milestone / opportunity, newest first.
UPDATE signal_links
   SET qualifier_milestone_id = (
         SELECT w.milestone_id
           FROM work_item_signal_links w
          WHERE w.signal_type = signal_links.signal_type
            AND w.signal_type || ':' || w.signal_id = signal_links.signal_id
            AND CAST(w.workload_id AS TEXT) = signal_links.target_id
            AND w.milestone_id IS NOT NULL AND TRIM(w.milestone_id) <> ''
          ORDER BY w.updated_at DESC, w.id DESC
          LIMIT 1
       ),
       qualifier_opportunity_id = (
         SELECT w.opportunity_id
           FROM work_item_signal_links w
          WHERE w.signal_type = signal_links.signal_type
            AND w.signal_type || ':' || w.signal_id = signal_links.signal_id
            AND CAST(w.workload_id AS TEXT) = signal_links.target_id
            AND w.opportunity_id IS NOT NULL AND TRIM(w.opportunity_id) <> ''
          ORDER BY w.updated_at DESC, w.id DESC
          LIMIT 1
       )
 WHERE signal_links.target_type = 'workload'
   AND EXISTS (
         SELECT 1 FROM work_item_signal_links w
          WHERE w.signal_type = signal_links.signal_type
            AND w.signal_type || ':' || w.signal_id = signal_links.signal_id
            AND CAST(w.workload_id AS TEXT) = signal_links.target_id
       );

-- Remove the phantom fan-out byproducts. The only thing that ever created canonical
-- 'opportunity' / 'action' rows was the work_item_signal_links fan-out we are retiring; they
-- have no reader and (per the product decision) are not real signal associations.
DELETE FROM signal_links WHERE target_type IN ('opportunity', 'action');

DROP TABLE IF EXISTS work_item_signal_links;

PRAGMA user_version = 23;
