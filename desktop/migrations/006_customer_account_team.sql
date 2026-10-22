-- Internal Microsoft account team (v-team) + customer contacts per account, derived
-- from the Teams chat and email datastores. Built by tools/account_team. Read by the
-- desktop app to show the account team on the customer profile and to give the AI
-- summary / assistant the people-context for each account.

CREATE TABLE IF NOT EXISTS customer_account_team (
  tpid TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_email TEXT,                 -- lower-cased; null when only seen in Teams
  org TEXT NOT NULL DEFAULT 'unverified',  -- microsoft | customer | partner | unverified
  email_sends INTEGER NOT NULL DEFAULT 0,  -- emails this person sent on this account
  email_cc INTEGER NOT NULL DEFAULT 0,     -- emails they were a to/cc recipient on
  teams_msgs INTEGER NOT NULL DEFAULT 0,   -- Teams messages they sent on this account
  last_activity TEXT,
  sources TEXT NOT NULL DEFAULT '',        -- csv: email,teams
  engagement INTEGER NOT NULL DEFAULT 0,   -- ranking score
  PRIMARY KEY (tpid, person_name)
);

CREATE INDEX IF NOT EXISTS idx_account_team_tpid ON customer_account_team(tpid, org, engagement DESC);
