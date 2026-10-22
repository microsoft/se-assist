-- Deep Research gap register: classification and research state for each open question.
--
-- WHAT. Every Deep Research output lists the questions it could not resolve ("gaps"). The
-- list of gaps itself is not stored here: it is derived on every read from the saved outputs
-- (work_output_areas.gaps_json), so it always matches what the outputs currently say. This
-- table stores only what was added to a gap afterwards: the model's classification (kind),
-- the research status, the answer with its verbatim supporting quote, and the sources.
--
-- KEY. gap_key is a hash of the normalised question text, so the same question raised by
-- several outputs is one record.
--
-- KINDS. m365 = answerable from the user's work email, meetings, chats or files;
-- public = answerable from public product documentation; person = only a person can answer;
-- limitation = a research limitation, not a question. Only m365 and public gaps are
-- researched. NULL means the gap has not been classified.
--
-- LIFECYCLE. Deleting a research subject deletes its gaps. A researched gap whose question no
-- longer appears in any output keeps its record and is shown as no longer listed. Research in
-- progress is held in memory only, so an app restart never leaves a gap half-researched.

CREATE TABLE work_output_gaps (
  investigation_id TEXT NOT NULL REFERENCES work_output_investigations(id) ON DELETE CASCADE,
  gap_key TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT CHECK (kind IS NULL OR kind IN ('m365', 'public', 'person', 'limitation')),
  kind_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'partial', 'still_open', 'blocked', 'failed')),
  answer TEXT,
  quote TEXT,
  query TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  error_json TEXT,
  model TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (investigation_id, gap_key)
);

PRAGMA user_version = 35;
