-- Customer CRM contacts cache (with LinkedIn deep links).
--
-- The Dynamics ↔ LinkedIn Sales Navigator integration does NOT mirror LinkedIn
-- profiles or org charts into Dataverse — the rich profile renders live in an embedded
-- widget and is never persisted. What IS stored on CRM records are LinkedIn *identifier*
-- fields: contact.msp_linkedinprofileurl (a real linkedin.com/in/... URL) and
-- contact/account.li_companyid. This table caches those, alongside name/title/email, so
-- the customer profile can surface a "Key Contacts" list with clickable "View on
-- LinkedIn" deep links (CRM-stored hyperlinks — no scraping, ToS-safe).
--
-- Populated by the "Sync from MSX" action (src/frontend/src/lib/sync.js -> syncContacts).
CREATE TABLE IF NOT EXISTS customer_contacts (
  contact_id      TEXT PRIMARY KEY,
  tpid            TEXT,
  account_id      TEXT,
  account_name    TEXT,
  full_name       TEXT,
  job_title       TEXT,
  email           TEXT,
  linkedin_url    TEXT,
  li_company_id   TEXT,
  last_synced_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_tpid ON customer_contacts(tpid);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_account ON customer_contacts(account_id);
