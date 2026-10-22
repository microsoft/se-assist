-- Outlook folder tree for Deep Research email search.
--
-- WHY. Deep Research lets the user traverse the same Outlook folders their stored email
-- lives in. The desktop reads the folder tree and each stored email's current folder through
-- WorkIQ (Microsoft Graph via the Microsoft 365 Copilot sign-in) and keeps the result here, so
-- the tree and the folder filter work from local data and say how old that data is.
--
-- LOCATIONS MOVE. Outlook gives a message a new id when it moves between folders, so a stored
-- message_id goes stale. Locations are therefore resolved by internet message id first (stable
-- across moves), then by the stored message id, then by conversation + received time. One row
-- covers every stored copy of the same message (location_key matches the Deep Research grouping:
-- 'internet:<internet message id>' or 'id:<message id>').
--
-- TABLES.
--   mail_folders         -- the folder tree as of the last successful folder sync. Replaced as a
--                           whole; a failed sync keeps the previous tree.
--   mail_email_locations -- per stored message: 'found' (with the folder ids it is in) or
--                           'missing' (not in the mailbox at the last check). Messages that were
--                           never checked have no row. A failed check never overwrites a row.
--   mail_folder_sync     -- single row (id = 1): when folders and locations were last synced,
--                           how many locations failed or were deferred, the first failure of the
--                           last location check, and the error that stopped the last sync.

CREATE TABLE IF NOT EXISTS mail_folders (
  folder_id          TEXT PRIMARY KEY,
  parent_folder_id   TEXT,
  display_name       TEXT NOT NULL,
  well_known_name    TEXT,
  child_folder_count INTEGER NOT NULL DEFAULT 0,
  total_item_count   INTEGER,
  unread_item_count  INTEGER,
  synced_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_folders_parent ON mail_folders(parent_folder_id);

CREATE TABLE IF NOT EXISTS mail_email_locations (
  location_key        TEXT PRIMARY KEY,
  internet_message_id TEXT,
  status              TEXT NOT NULL CHECK (status IN ('found', 'missing')),
  folder_ids_json     TEXT NOT NULL DEFAULT '[]',
  method              TEXT NOT NULL CHECK (method IN ('internet-message-id', 'message-id', 'conversation')),
  checked_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_email_locations_checked ON mail_email_locations(checked_at);

CREATE TABLE IF NOT EXISTS mail_folder_sync (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  folders_synced_at    TEXT,
  folder_count         INTEGER NOT NULL DEFAULT 0,
  locations_checked_at TEXT,
  checked_count        INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  deferred_count       INTEGER NOT NULL DEFAULT 0,
  failed_example       TEXT,
  last_attempt_at      TEXT,
  last_error           TEXT,
  last_error_at        TEXT
);

PRAGMA user_version = 33;
