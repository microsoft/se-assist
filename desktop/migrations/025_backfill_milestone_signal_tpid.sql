-- Backfill tpid on milestone rows in signal_links.
--
-- WHY THESE ARE NULL. The milestone "Related signal" links originated in
-- milestone_signal_links (migration 017), a table that never had a tpid column --
-- the account was always resolved live at query time (resolveMilestoneTpid) and
-- never persisted. Migrations 022 and 024 backfilled those rows into signal_links
-- with a literal NULL tpid because the source had none, and the finder's
-- INSERT OR IGNORE write path never updates an existing row, so the historical
-- rows stay NULL. A milestone is deterministically tied to exactly one account via
-- its opportunity (milestone -> opportunities.parent_account_id -> customers), so a
-- NULL tpid here is a persistence artifact, not missing data. On the live datastore
-- all 18 affected milestones (150 legacy links / 139 canonical rows) resolve.
--
-- WHAT THIS DOES. Stamps tpid on every milestone signal_links row that is still
-- NULL, resolving it through the SAME primary chain resolveMilestoneTpid uses:
-- milestone_id -> milestones.opportunity_id -> opportunities.parent_account_id ->
-- customers.crm_account_id -> customers.tpid (non-empty). Idempotent: only touches
-- rows still NULL/empty, and only when the chain yields a real tpid (guarded by
-- EXISTS), so a re-run or an already-stamped DB writes zero rows.
--
-- FAIL LOUD, DON'T GUESS. We deliberately use ONLY the deterministic account-id
-- join. resolveMilestoneTpid also has a fuzzy customers.name fallback, but matching
-- an account by display name inside a bulk migration risks a wrong-account stamp on
-- a name collision. A milestone that cannot be resolved by account id is left NULL
-- on purpose -- an honest, visible gap rather than a silent guess. (On live data
-- this leaves zero rows NULL; the account-id path resolves 100%.)

UPDATE signal_links
   SET tpid = (
         SELECT c.tpid
           FROM milestones m
           JOIN opportunities o ON m.opportunity_id = o.opportunity_id
           JOIN customers c ON c.crm_account_id = o.parent_account_id
          WHERE m.milestone_id = signal_links.target_id
            AND c.tpid IS NOT NULL AND TRIM(c.tpid) <> ''
          LIMIT 1
       ),
       updated_at = CURRENT_TIMESTAMP
 WHERE signal_links.target_type = 'milestone'
   AND (signal_links.tpid IS NULL OR TRIM(signal_links.tpid) = '')
   AND EXISTS (
         SELECT 1
           FROM milestones m
           JOIN opportunities o ON m.opportunity_id = o.opportunity_id
           JOIN customers c ON c.crm_account_id = o.parent_account_id
          WHERE m.milestone_id = signal_links.target_id
            AND c.tpid IS NOT NULL AND TRIM(c.tpid) <> ''
       );

PRAGMA user_version = 25;
