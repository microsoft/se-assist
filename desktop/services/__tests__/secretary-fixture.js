'use strict';

// In-memory SQLite for Secretary tests: the real email-inventory and triage migrations, filled the
// way the WorkIQ pull stores Graph messages (tools/email/ingest_emails.py and tools/email/sync.py).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const migration = name => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');

function secretaryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('005_email_inventory.sql'));
  db.exec('ALTER TABLE email_customer_links ADD COLUMN tier TEXT');
  db.exec(migration('021_email_triage.sql'));
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tpid TEXT, parent_crm_account_id TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tpid_config (tpid TEXT PRIMARY KEY);
    CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config);
    CREATE VIEW active_email_customer_links AS SELECT * FROM email_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config);
    CREATE VIEW active_emails AS SELECT e.* FROM emails e
      WHERE EXISTS (SELECT 1 FROM active_email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')
         OR NOT EXISTS (SELECT 1 FROM email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected');
  `);
  return db;
}

// A Graph message as the pull receives it.
const message = (id, received = '2026-09-21T09:00:00.000Z', extra = {}) => ({
  id, conversationId: `thread-${id}`, internetMessageId: `<${id}@example.com>`, subject: `Subject ${id}`,
  from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
  receivedDateTime: received, sentDateTime: received,
  body: { contentType: 'text', content: `Please complete task ${id}.` },
  bodyPreview: `Preview ${id}`, webLink: `https://outlook.office.com/mail/item/${id}`,
  toRecipients: [], ccRecipients: [], importance: 'normal', ...extra,
});

const collapse = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// Mirrors _project_email: cleaned body text, else the preview; flat recipients; the full message as raw_json.
function projectEmail(m) {
  const content = typeof m.body?.content === 'string' ? m.body.content : '';
  const html = String(m.body?.contentType || '').toLowerCase() === 'html';
  let bodyText = collapse(html ? content.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ') : content);
  let bodySource = 'body';
  if (!bodyText) {
    bodyText = collapse(m.bodyPreview);
    bodySource = 'preview';
  }
  const people = list => (list || []).map(r => ({ name: r?.emailAddress?.name ?? null, address: r?.emailAddress?.address ?? null }));
  const sender = (m.from || m.sender)?.emailAddress || {};
  return {
    message_id: m.id,
    conversation_id: m.conversationId ?? null,
    internet_message_id: m.internetMessageId ?? null,
    subject: String(m.subject || '').trim(),
    from_name: sender.name ?? null,
    from_address: sender.address ?? null,
    to_json: JSON.stringify(people(m.toRecipients)),
    cc_json: JSON.stringify(people(m.ccRecipients)),
    sent_at: m.sentDateTime ?? null,
    received_at: m.receivedDateTime || m.sentDateTime || null,
    body_text: bodyText,
    body_source: bodySource,
    has_attachments: m.hasAttachments ? 1 : 0,
    importance: m.importance ?? null,
    web_link: m.webLink ?? null,
    raw_json: JSON.stringify(m),
  };
}

function addLink(db, messageId, tpid, method = 'alias') {
  db.prepare('INSERT INTO email_customer_links (message_id, tpid, match_method) VALUES (?, ?, ?)').run(messageId, tpid, method);
}

// Column overrides model rows the pull stored differently, for example without raw_json.
function storeEmail(db, m, { tpids = ['T-1'], method = 'alias', ...columns } = {}) {
  const row = {
    ...projectEmail(m),
    is_customer_related: tpids.length && method !== 'ai-rejected' ? 1 : 0,
    ...columns,
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO emails (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map(name => row[name] ?? null));
  for (const tpid of tpids) addLink(db, row.message_id, tpid, method);
  return row;
}

function addCustomer(db, tpid, name, parent = null) {
  db.prepare('INSERT INTO customers (name, tpid, parent_crm_account_id) VALUES (?, ?, ?)').run(name, tpid, parent);
  db.prepare('INSERT OR IGNORE INTO tpid_config VALUES (?)').run(tpid);
}

// sync.py records last_run_at as SQLite CURRENT_TIMESTAMP (UTC, no zone) after each account's email refresh.
function markPulled(db, at = '2026-09-21 11:30:00', scope = 'T-1') {
  db.prepare('INSERT OR REPLACE INTO email_sync (scope_key, synced_through, last_run_at) VALUES (?, ?, ?)').run(scope, at, at);
}

function setUser(db, address) {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('signed_in_user_upn', ?)").run(address);
}

function markDone(db, conversationId) {
  db.prepare("INSERT INTO email_triage (conversation_id, status) VALUES (?, 'done')").run(conversationId);
}

module.exports = { secretaryDb, message, storeEmail, addLink, addCustomer, markPulled, setUser, markDone };
