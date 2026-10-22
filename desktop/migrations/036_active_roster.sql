-- Archive by membership, not by moving, deleting, or changing historical rows.
-- All active readers use these views; persistence and backups retain the base tables.
CREATE VIEW active_customers AS
SELECT c.* FROM customers c WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = c.tpid);

CREATE VIEW active_opportunities AS
SELECT o.* FROM opportunities o
WHERE EXISTS (SELECT 1 FROM active_customers c WHERE c.crm_account_id = o.parent_account_id);

CREATE VIEW active_milestones AS
SELECT m.* FROM milestones m
WHERE EXISTS (SELECT 1 FROM active_opportunities o WHERE o.opportunity_id = m.opportunity_id);

CREATE VIEW active_hok_tasks AS
SELECT h.* FROM hok_tasks h
WHERE EXISTS (SELECT 1 FROM active_milestones m WHERE lower(trim(m.milestone_id, '{}')) = lower(trim(h.regarding_id, '{}')))
   OR EXISTS (SELECT 1 FROM active_opportunities o WHERE lower(trim(o.opportunity_id, '{}')) = lower(trim(h.regarding_id, '{}')))
   OR EXISTS (SELECT 1 FROM active_customers c WHERE lower(trim(c.crm_account_id, '{}')) = lower(trim(h.regarding_id, '{}')));

CREATE VIEW active_cached_customer_profiles AS
SELECT p.* FROM cached_customer_profiles p WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = p.tpid);

CREATE VIEW active_workloads AS
SELECT w.* FROM workloads w
WHERE (COALESCE(NULLIF(trim(w.customer_tpid), ''), NULLIF(trim(w.tpid), '')) IS NULL
   OR EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = COALESCE(NULLIF(trim(w.customer_tpid), ''), NULLIF(trim(w.tpid), ''))))
  AND (NULLIF(trim(w.opportunity_id), '') IS NULL
   OR NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.opportunity_id = w.opportunity_id)
   OR EXISTS (SELECT 1 FROM active_opportunities o WHERE o.opportunity_id = w.opportunity_id));

CREATE VIEW active_workload_suggestions AS
SELECT s.* FROM workload_suggestions s WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = s.tpid);

CREATE VIEW active_workload_stages AS
SELECT s.* FROM workload_stages s WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = s.workload_id);
CREATE VIEW active_workload_actions AS
SELECT a.* FROM workload_actions a WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = a.workload_id);
CREATE VIEW active_workload_assets AS
SELECT a.* FROM workload_assets a WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = a.workload_id);
CREATE VIEW active_workload_todos AS
SELECT t.* FROM workload_todos t WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = t.workload_id);
CREATE VIEW active_workload_workflows AS
SELECT f.* FROM workload_workflows f WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = f.workload_id);
CREATE VIEW active_workload_milestone_links AS
SELECT l.* FROM workload_milestone_links l
WHERE EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = l.workload_id)
  AND (NULLIF(trim(l.customer_tpid), '') IS NULL OR EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.customer_tpid))
  AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.milestone_id = l.milestone_id
    AND NOT EXISTS (SELECT 1 FROM active_milestones a WHERE a.milestone_id = m.milestone_id));
CREATE VIEW active_workload_suggestion_opportunities AS
SELECT o.* FROM workload_suggestion_opportunities o WHERE EXISTS (SELECT 1 FROM active_workload_suggestions s WHERE s.id = o.suggestion_id);
CREATE VIEW active_workload_suggestion_milestones AS
SELECT m.* FROM workload_suggestion_milestones m WHERE EXISTS (SELECT 1 FROM active_workload_suggestions s WHERE s.id = m.suggestion_id);

CREATE VIEW active_signal_links AS
SELECT l.* FROM signal_links l
WHERE ((NULLIF(trim(l.tpid), '') IS NOT NULL AND EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.tpid))
   OR (NULLIF(trim(l.tpid), '') IS NULL AND (
        (l.target_type = 'account' AND EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.target_id))
     OR (l.target_type = 'milestone' AND EXISTS (SELECT 1 FROM active_milestones m WHERE m.milestone_id = l.target_id))
     OR (l.target_type = 'opportunity' AND EXISTS (SELECT 1 FROM active_opportunities o WHERE o.opportunity_id = l.target_id))
     OR (l.target_type = 'workload' AND EXISTS (SELECT 1 FROM active_workloads w WHERE CAST(w.id AS TEXT) = l.target_id))
     OR (l.target_type = 'action' AND EXISTS (SELECT 1 FROM active_workload_actions a WHERE CAST(a.id AS TEXT) = l.target_id))
     OR (l.target_type = 'hok_activity' AND EXISTS (SELECT 1 FROM active_hok_tasks h WHERE h.activity_id = l.target_id))
   )))
  AND NOT EXISTS (SELECT 1 FROM workloads w WHERE l.target_type='workload' AND CAST(w.id AS TEXT)=l.target_id
    AND NOT EXISTS (SELECT 1 FROM active_workloads a WHERE a.id=w.id))
  AND (l.target_type<>'account' OR EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid=l.target_id))
  AND NOT EXISTS (SELECT 1 FROM workload_actions a WHERE l.target_type='action' AND CAST(a.id AS TEXT)=l.target_id
    AND NOT EXISTS (SELECT 1 FROM active_workload_actions w WHERE w.id=a.id))
  AND NOT EXISTS (SELECT 1 FROM hok_tasks h WHERE l.target_type='hok_activity' AND h.activity_id=l.target_id
    AND NOT EXISTS (SELECT 1 FROM active_hok_tasks a WHERE a.activity_id=h.activity_id))
  AND NOT EXISTS (SELECT 1 FROM milestones m WHERE (l.target_type='milestone' AND m.milestone_id=l.target_id OR m.milestone_id=l.qualifier_milestone_id)
    AND NOT EXISTS (SELECT 1 FROM active_milestones a WHERE a.milestone_id=m.milestone_id))
  AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE (l.target_type='opportunity' AND o.opportunity_id=l.target_id OR o.opportunity_id=l.qualifier_opportunity_id)
    AND NOT EXISTS (SELECT 1 FROM active_opportunities a WHERE a.opportunity_id=o.opportunity_id));

CREATE VIEW active_email_customer_links AS
SELECT l.* FROM email_customer_links l WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.tpid);
CREATE VIEW active_meeting_customer_links AS
SELECT l.* FROM meeting_customer_links l WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.tpid);
CREATE VIEW active_teams_chat_customer_links AS
SELECT l.* FROM teams_chat_customer_links l WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = l.tpid);

-- Unassigned/internal communications remain usable. An archived-only association
-- hides a shared source; any active association makes it available again.
CREATE VIEW active_emails AS
SELECT e.* FROM emails e
WHERE EXISTS (SELECT 1 FROM active_email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')
   OR EXISTS (SELECT 1 FROM active_signal_links l WHERE l.signal_type = 'email' AND l.signal_id = 'email:' || e.message_id)
   OR (NOT EXISTS (SELECT 1 FROM email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')
       AND NOT EXISTS (SELECT 1 FROM signal_links l WHERE l.signal_type = 'email' AND l.signal_id = 'email:' || e.message_id));
CREATE VIEW active_meetings AS
SELECT m.* FROM meetings m
WHERE EXISTS (SELECT 1 FROM active_meeting_customer_links l WHERE l.event_id = m.event_id AND l.match_method <> 'ai-rejected')
   OR EXISTS (SELECT 1 FROM active_signal_links l WHERE l.signal_type = 'meeting' AND l.signal_id = 'meeting:' || m.event_id)
   OR (NOT EXISTS (SELECT 1 FROM meeting_customer_links l WHERE l.event_id = m.event_id AND l.match_method <> 'ai-rejected')
       AND NOT EXISTS (SELECT 1 FROM signal_links l WHERE l.signal_type = 'meeting' AND l.signal_id = 'meeting:' || m.event_id));
CREATE VIEW active_teams_chats AS
SELECT c.* FROM teams_chats c
WHERE EXISTS (SELECT 1 FROM active_teams_chat_customer_links l WHERE l.chat_id = c.chat_id AND l.match_method <> 'ai-rejected')
   OR EXISTS (SELECT 1 FROM active_signal_links l WHERE l.signal_type = 'chat' AND l.signal_id = 'chat:' || c.chat_id)
   OR (NOT EXISTS (SELECT 1 FROM teams_chat_customer_links l WHERE l.chat_id = c.chat_id AND l.match_method <> 'ai-rejected')
       AND NOT EXISTS (SELECT 1 FROM signal_links l WHERE l.signal_type = 'chat' AND l.signal_id = 'chat:' || c.chat_id));
CREATE VIEW active_teams_chat_messages AS
SELECT m.* FROM teams_chat_messages m WHERE EXISTS (SELECT 1 FROM active_teams_chats c WHERE c.chat_id = m.chat_id);

CREATE VIEW active_cached_customer_todos AS
SELECT t.* FROM cached_customer_todos t
WHERE (t.profile_id IS NULL OR EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = t.profile_id))
  AND (t.workload_id IS NULL OR EXISTS (SELECT 1 FROM active_workloads w WHERE w.id = t.workload_id))
  AND (t.meeting_event_id IS NULL OR EXISTS (SELECT 1 FROM active_meetings m WHERE m.event_id = t.meeting_event_id));
CREATE VIEW active_cached_customer_assets AS
SELECT a.* FROM cached_customer_assets a
WHERE a.profile_id IS NULL OR EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = a.profile_id);
CREATE VIEW active_cached_customer_timeline_events AS
SELECT e.* FROM cached_customer_timeline_events e WHERE EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = e.profile_id);
CREATE VIEW active_cached_customer_transcripts AS
SELECT t.* FROM cached_customer_transcripts t WHERE EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = t.profile_id);
CREATE VIEW active_cached_customer_email_refs AS
SELECT e.* FROM cached_customer_email_refs e WHERE EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = e.profile_id);
CREATE VIEW active_cached_customer_meeting_refs AS
SELECT m.* FROM cached_customer_meeting_refs m WHERE EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = m.profile_id);
CREATE VIEW active_cached_customer_teams_refs AS
SELECT t.* FROM cached_customer_teams_refs t WHERE EXISTS (SELECT 1 FROM active_cached_customer_profiles p WHERE p.id = t.profile_id);

CREATE VIEW active_customer_contacts AS
SELECT c.* FROM customer_contacts c WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = c.tpid);
CREATE VIEW active_customer_account_team AS
SELECT t.* FROM customer_account_team t WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = t.tpid);
CREATE VIEW active_customer_account_team_roles AS
SELECT t.* FROM customer_account_team_roles t WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = t.tpid);
CREATE VIEW active_email_customer_profile AS
SELECT p.* FROM email_customer_profile p WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = p.tpid);
CREATE VIEW active_meeting_customer_profile AS
SELECT p.* FROM meeting_customer_profile p WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = p.tpid);
CREATE VIEW active_teams_customer_profile AS
SELECT p.* FROM teams_customer_profile p WHERE EXISTS (SELECT 1 FROM tpid_config r WHERE r.tpid = p.tpid);

-- Legacy snapshots contain account names and portfolio-wide totals without a TPID
-- scope. Retain them, but never show them as the current roster's analytics.
ALTER TABLE acr_snapshot_log ADD COLUMN roster_key TEXT;
CREATE TABLE acr_portfolio_snapshots (
  roster_key TEXT NOT NULL,
  fiscal_year TEXT NOT NULL,
  service_level INTEGER NOT NULL,
  account_rows_json TEXT NOT NULL,
  service_rows_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (roster_key, fiscal_year, service_level)
);

PRAGMA user_version = 36;
