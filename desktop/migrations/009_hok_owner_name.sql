-- Cache the HoK task owner's display name alongside the GUID so the Milestones table
-- and Milestone Map detail card can show who owns each activity without a live lookup.
ALTER TABLE hok_tasks ADD COLUMN owner_name TEXT;
