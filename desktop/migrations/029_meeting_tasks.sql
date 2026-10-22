-- SE Assist Tasks remain local customer todos; they are not CRM HoK activities.
ALTER TABLE cached_customer_todos ADD COLUMN workload_id INTEGER REFERENCES workloads(id) ON DELETE SET NULL;
-- Keep meeting provenance across calendar inventory refreshes.
ALTER TABLE cached_customer_todos ADD COLUMN meeting_event_id TEXT;
ALTER TABLE cached_customer_todos ADD COLUMN meeting_action_key TEXT;

CREATE INDEX idx_cached_todos_workload ON cached_customer_todos(workload_id, status);
CREATE INDEX idx_cached_todos_meeting ON cached_customer_todos(meeting_event_id);
-- Include soft-deleted tasks so repeating a meeting action never restores a deleted task.
CREATE UNIQUE INDEX idx_cached_todos_meeting_action
  ON cached_customer_todos(meeting_event_id, meeting_action_key)
  WHERE meeting_event_id IS NOT NULL AND meeting_action_key IS NOT NULL;

-- A saved, structured recap makes task creation independently retryable.
ALTER TABLE meeting_notes ADD COLUMN summary_actions_json TEXT;
ALTER TABLE meeting_notes ADD COLUMN summary_transcript_hash TEXT;

PRAGMA user_version = 29;
