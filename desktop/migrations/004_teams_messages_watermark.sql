-- Per-chat message-sync watermark, enabling differential pulls.
-- A chat needs a message re-pull when teams_chats.last_message_at (refreshed by
-- re-ingesting the ListChats inventory) advances past messages_synced_at.

CREATE TABLE IF NOT EXISTS teams_chat_sync (
  chat_id TEXT PRIMARY KEY,
  messages_synced_at TEXT,                       -- chat's last activity timestamp at the time messages were last pulled
  last_pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES teams_chats(chat_id)
);

-- Seed watermarks for chats whose messages were already ingested, so they are
-- not reported as stale on first run of the differential workflow.
INSERT OR IGNORE INTO teams_chat_sync (chat_id, messages_synced_at)
SELECT chat_id, last_message_at FROM teams_chats WHERE messages_synced = 1;
