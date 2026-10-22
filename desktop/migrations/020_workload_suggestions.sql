-- Suggested workloads: AI-proposed workload drafts for the Workload Management surface.
--
-- The "Suggest workloads" button pulls the last week of emails, meetings and Teams chats
-- for the SE's roster accounts and asks the model to propose one or more workloads, each
-- resolved to a real customer (tpid + name). Those drafts live in their OWN tables so they
-- never pollute the real `workloads` list / WORKLOADS_SQL until the SE approves one.
--
-- A draft can be enriched (deterministically, no AI) with the account's SSP, its possible
-- opportunities, and the milestones under each added opportunity. A milestone can only be
-- added AFTER its parent opportunity has been added — mirroring the opportunity->milestone
-- linking model used for real workloads.
--
-- On Approve the draft is converted into a real workload (see services/workload-orchestration
-- .approveSuggestion) and the draft rows are deleted. On Delete the draft rows are deleted with
-- NO suppression recorded, so the same workload can be proposed again on a future run.

CREATE TABLE IF NOT EXISTS workload_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tpid TEXT NOT NULL,                            -- resolved customer account TPID
  account_name TEXT,                            -- snapshot of the resolved account name
  ssp_name TEXT,                                -- SSP for the account (opportunities.owner_name), if any
  title TEXT NOT NULL,                          -- proposed workload title
  description TEXT,                             -- 1-3 sentence proposed description
  source_json TEXT,                            -- provenance: counts of the comms that grounded it
  status TEXT NOT NULL DEFAULT 'suggested',     -- suggested (draft) | approved (transient before delete)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workload_suggestions_tpid ON workload_suggestions(tpid);
CREATE INDEX IF NOT EXISTS idx_workload_suggestions_status ON workload_suggestions(status);

-- Opportunities the SE has ADDED to a suggestion draft (deterministic, from the real
-- opportunities table). A milestone may only be picked once its parent opportunity is here.
CREATE TABLE IF NOT EXISTS workload_suggestion_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL,
  opportunity_id TEXT NOT NULL,
  opportunity_name TEXT,
  included INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (suggestion_id, opportunity_id),
  FOREIGN KEY (suggestion_id) REFERENCES workload_suggestions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wso_suggestion ON workload_suggestion_opportunities(suggestion_id);

-- Milestones the SE has picked under an added opportunity of a suggestion draft. These are
-- carried over as workload_milestone_links when the draft is approved.
CREATE TABLE IF NOT EXISTS workload_suggestion_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL,
  opportunity_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  milestone_name TEXT,
  status_label TEXT,
  included INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (suggestion_id, milestone_id),
  FOREIGN KEY (suggestion_id) REFERENCES workload_suggestions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wsm_suggestion ON workload_suggestion_milestones(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_wsm_opportunity ON workload_suggestion_milestones(suggestion_id, opportunity_id);

PRAGMA user_version = 20;
