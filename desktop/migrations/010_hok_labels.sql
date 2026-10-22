-- Cache the CRM display labels for HoK task category and the "regarding" record name so
-- the HoK Activities tab can show them without a live lookup. Previously only the raw
-- numeric category code and the regarding GUID were stored, leaving those columns blank.
ALTER TABLE hok_tasks ADD COLUMN task_category_label TEXT;
ALTER TABLE hok_tasks ADD COLUMN regarding_name TEXT;
