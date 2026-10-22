-- Retire the Deep Research Outlook folder copy.
--
-- Migration 033 stored the user's Outlook folder tree and each stored email's folder so Deep
-- Research could browse email by folder. Deep Research now lists stored email newest first and
-- filters it by customer account and keyword instead, so the folder sync is gone. It made extra
-- WorkIQ calls after every email pull only to fill these tables, and nothing else reads them.
--
-- KEPT. Every stored email, its customer account links and the email pull history (emails,
-- email_customer_links, email_sync) are untouched. Outlook itself was never changed.

DROP TABLE IF EXISTS mail_email_locations;
DROP TABLE IF EXISTS mail_folder_sync;
DROP TABLE IF EXISTS mail_folders;

PRAGMA user_version = 34;
