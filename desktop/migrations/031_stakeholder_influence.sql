-- Stakeholder influence map: opt-in state, user corrections and the optional AI assessment.
--
-- PRIVACY. Inferring who influences a customer's decisions analyses email and meeting
-- metadata (CC patterns, attendance, transcript turn-taking). The feature is therefore off
-- by default. stakeholder_influence_settings records the explicit opt-in together with the
-- time the user acknowledged the legal / privacy notice. Turning the feature off deletes
-- every override and assessment in the same transaction, so no inferred profile outlives
-- the opt-in. The deterministic signals themselves are never stored: they are recomputed
-- on demand from the local email / meeting / transcript inventory.
--
-- TABLES.
--   stakeholder_influence_settings -- single row (id = 1): enabled flag + acknowledgement.
--   stakeholder_overrides          -- the user's own correction per customer person:
--                                     stance, private note, or "hide this person" (hidden
--                                     people are excluded from the map and from AI input).
--   stakeholder_assessments        -- the latest AI stance / adopted-suggestion assessment
--                                     per account, with the hash of the exact input it saw
--                                     so the UI can label it stale when the evidence moves.

CREATE TABLE IF NOT EXISTS stakeholder_influence_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  acknowledged_at TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stakeholder_overrides (
  tpid       TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  stance     TEXT CHECK (stance IS NULL OR stance IN ('champion', 'blocker', 'neutral', 'unclear')),
  note       TEXT NOT NULL DEFAULT '',
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tpid, person_id)
);

CREATE TABLE IF NOT EXISTS stakeholder_assessments (
  tpid        TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT,
  analyzed_at TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  result_json TEXT NOT NULL
);

PRAGMA user_version = 31;
