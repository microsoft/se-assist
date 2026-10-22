-- Confidence tiers + AI link-verification cache for customer linking.
--
-- The email/meetings/teams linkers already store match_method, matched_term and a
-- numeric confidence per (item, tpid) link. This migration adds an explicit,
-- human-readable tier ('strong' | 'medium' | 'weak') so downstream consumers can
-- threshold on trust without re-deriving it from the method, and adds two support
-- tables used by the identity-first + AI-classifier linking work:
--
--   ai_link_verifications    — cache of the AI classifier's yes/no verdict for a
--                              weak (item, tpid) link, so repeated Backfill /
--                              Pull-new runs never re-query the model.
--   customer_alias_promotions — per (tpid, alias) count of AI-confirmed successes;
--                              once an AI-guessed alias accrues enough confirmations
--                              its future matches are promoted weak -> medium.
--
-- tier is left NULL for pre-existing rows; the linkers backfill it on their next run.

ALTER TABLE email_customer_links   ADD COLUMN tier TEXT;
ALTER TABLE meeting_customer_links ADD COLUMN tier TEXT;
ALTER TABLE teams_chat_customer_links ADD COLUMN tier TEXT;

CREATE TABLE IF NOT EXISTS ai_link_verifications (
  kind          TEXT NOT NULL,          -- 'email' | 'meeting' | 'chat'
  item_id       TEXT NOT NULL,          -- message_id | event_id | chat_id
  tpid          TEXT NOT NULL,
  content_hash  TEXT,                   -- hash of the context sent to the model
  verdict       INTEGER NOT NULL,       -- 1 = related, 0 = not related
  confidence    REAL,
  model         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, item_id, tpid)
);

CREATE TABLE IF NOT EXISTS customer_alias_promotions (
  tpid          TEXT NOT NULL,
  alias         TEXT NOT NULL,          -- normalized alias text
  success_count INTEGER NOT NULL DEFAULT 0,
  last_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tpid, alias)
);
