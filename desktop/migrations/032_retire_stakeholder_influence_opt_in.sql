-- Retire the Stakeholder Influence Map opt-in.
--
-- Migration 031 shipped the map off by default behind a legal / privacy acknowledgement stored
-- in stakeholder_influence_settings. That review is now complete and the clearance is permanent,
-- so the map is always available and the opt-in record is no longer read or written.
--
-- KEPT. stakeholder_overrides (the user's stance, note and exclusion per person) and
-- stakeholder_assessments (the latest AI analysis per account) are untouched. Excluded people
-- stay out of the map and out of AI input, and the signal scores are still never stored.

DROP TABLE IF EXISTS stakeholder_influence_settings;

PRAGMA user_version = 32;
