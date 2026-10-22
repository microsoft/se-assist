'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { searchEmails, readEmail } = require('../email-search');

const migration = name => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');
const NOTICE = 'Sender (sender@example.com) has sent you a protected message.\n\nRead the message [https://outlook.office.com/]\nLearn about messages protected by Microsoft Purview Message Encryption.';
const NOTICE_TEXT = NOTICE.replace(/\s+/g, ' ');

function makeDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(migration('005_email_inventory.sql'));
  db.exec(`
    CREATE TABLE customers(tpid TEXT, name TEXT, parent_crm_account_id TEXT);
    INSERT INTO customers VALUES ('1001','Contoso Ltd',NULL),('1001','Contoso Child','parent-1'),('1003','Tailspin Toys',NULL);
    CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY);
    INSERT INTO tpid_config VALUES ('1001'),('1003');
    CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config);
    CREATE VIEW active_email_customer_links AS SELECT * FROM email_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config);
    CREATE VIEW active_emails AS SELECT e.* FROM emails e
      WHERE EXISTS (SELECT 1 FROM active_email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')
         OR NOT EXISTS (SELECT 1 FROM email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected');
  `);
  return db;
}

function addEmail(db, values) {
  const row = {
    internet_message_id: null, subject: null, from_name: null, from_address: null, to_json: null, cc_json: null,
    sent_at: null, received_at: null, body_text: null, body_source: 'body', has_attachments: 0, importance: 'normal',
    web_link: null, raw_json: null, ...values,
  };
  if (row.raw_json && typeof row.raw_json === 'object') row.raw_json = JSON.stringify(row.raw_json);
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO emails(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column]));
}

const link = (db, messageId, tpid, method = 'manual') => {
  db.prepare('INSERT OR IGNORE INTO tpid_config VALUES (?)').run(tpid);
  return db.prepare('INSERT INTO email_customer_links(message_id, tpid, match_method) VALUES (?,?,?)').run(messageId, tpid, method);
};
const ids = result => result.results.map(item => item.messageId);
const days = (from, to) => Array.from({ length: from - to + 1 }, (_, index) => `m${from - index}`);
const cursorOf = value => Buffer.from(value, 'utf8').toString('base64url');

test('search matches subject, people, recipients, body and linked account names, with every word required', t => {
  const db = makeDb(t);
  addEmail(db, {
    message_id: 'pricing', subject: 'Contoso pricing review', from_name: 'Ada Lovelace', from_address: 'ada@contoso.com',
    to_json: JSON.stringify([{ name: 'Grace Hopper', address: 'grace@fabrikam.com' }]),
    body_text: 'We need the AKS quote by Friday.', received_at: '2026-09-20T10:00:00Z',
  });
  addEmail(db, { message_id: 'sync', subject: 'Weekly sync', from_name: 'Bob', from_address: 'bob@northwind.com', body_text: 'Agenda attached.', received_at: '2026-09-21T10:00:00Z' });
  addEmail(db, { message_id: 'lunch', subject: 'Lunch', body_text: 'Contoso came up in passing.', received_at: '2026-09-19T10:00:00Z' });
  addEmail(db, { message_id: 'rejected', subject: 'Unrelated', body_text: 'Nothing here.', received_at: '2026-09-22T10:00:00Z' });
  link(db, 'sync', '1001');
  link(db, 'rejected', '1003', 'ai-rejected');

  const contoso = searchEmails(db, { query: '  contoso  ' });
  assert.equal(contoso.mode, 'search');
  assert.equal(contoso.query, 'contoso');
  assert.deepEqual(ids(contoso), ['sync', 'pricing', 'lunch']);
  assert.deepEqual(contoso.results[0].accounts, ['Contoso Ltd']);
  assert.equal(contoso.results[0].accountLabel, 'Contoso Ltd');
  assert.equal(contoso.results[1].accountLabel, null);
  assert.deepEqual(contoso.results[1].from, { name: 'Ada Lovelace', address: 'ada@contoso.com' });
  assert.equal(contoso.results[1].bodySource, 'condensed');
  assert.deepEqual(ids(searchEmails(db, { query: 'GRACE' })), ['pricing']);
  assert.deepEqual(ids(searchEmails(db, { query: 'northwind' })), ['sync']);
  assert.deepEqual(ids(searchEmails(db, { query: 'contoso aks' })), ['pricing']);
  assert.deepEqual(ids(searchEmails(db, { query: 'contoso missing' })), []);
  assert.deepEqual(ids(searchEmails(db, { query: 'tailspin' })), [], 'an AI-rejected account link is not a match');
  assert.deepEqual(searchEmails(db, { query: 'unrelated' }).results[0].accounts, []);
});

test('search treats LIKE wildcards and backslashes as literal text and centres the snippet on a match', t => {
  const db = makeDb(t);
  addEmail(db, { message_id: 'percent', subject: '100% uptime_target', body_text: 'Plan', received_at: '2026-09-20T10:00:00Z' });
  addEmail(db, { message_id: 'plain', subject: '1000 cores uptimeXtarget', body_text: 'Plan', received_at: '2026-09-21T10:00:00Z' });
  addEmail(db, { message_id: 'path', subject: 'Logs', body_text: 'Saved to C:\\temp\\run.log for review.', received_at: '2026-09-22T10:00:00Z' });
  addEmail(db, {
    message_id: 'long', subject: 'Long', received_at: '2026-09-23T10:00:00Z',
    body_text: `${'filler '.repeat(40)}the decisive milestone ${'tail '.repeat(80)}`,
  });

  assert.deepEqual(ids(searchEmails(db, { query: '%' })), ['percent']);
  assert.deepEqual(ids(searchEmails(db, { query: '100%' })), ['percent']);
  assert.deepEqual(ids(searchEmails(db, { query: 'uptime_target' })), ['percent']);
  assert.deepEqual(ids(searchEmails(db, { query: 'C:\\temp' })), ['path']);
  const snippet = searchEmails(db, { query: 'decisive' }).results[0].snippet;
  assert.match(snippet, /^….*the decisive milestone.*…$/);
  assert.ok(snippet.length <= 222);
});

test('copies of one message are grouped and represented by the fullest stored body', t => {
  const db = makeDb(t);
  addEmail(db, { message_id: 'copy-preview', internet_message_id: '<same@x>', body_source: 'preview', body_text: 'Short', received_at: '2026-09-22T09:00:00Z', subject: 'Shared thread' });
  addEmail(db, { message_id: 'copy-body', internet_message_id: ' <same@x> ', body_text: 'A longer stored body', sent_at: '2026-09-22T08:59:00Z', subject: 'Shared thread' });
  addEmail(db, {
    message_id: 'copy-raw', raw_json: { internetMessageId: '<same@x>' }, body_text: 'A longer stored body with more detail',
    received_at: '2026-09-22T09:00:00Z', subject: 'Shared thread',
  });
  addEmail(db, { message_id: 'other', internet_message_id: '<other@x>', body_text: 'Shared thread notes', received_at: '2026-09-21T09:00:00Z', subject: 'Other' });
  link(db, 'copy-preview', '1001');

  const result = searchEmails(db, { query: 'shared thread' });
  assert.equal(result.total, 2);
  assert.deepEqual(ids(result), ['copy-raw', 'other']);
  assert.equal(result.results[0].copies, 3);
  assert.deepEqual(result.results[0].accounts, ['Contoso Ltd'], 'accounts come from every stored copy');
  const preview = searchEmails(db, { query: 'short' });
  assert.deepEqual(ids(preview), ['copy-preview'], 'a search shows the stored copy that matched');
  assert.equal(preview.results[0].copies, 3, 'and still counts every stored copy');
  assert.deepEqual(ids(searchEmails(db)), ['copy-raw', 'other']);
  assert.equal(readEmail(db, 'copy-preview').copies, 3);
  assert.deepEqual(readEmail(db, 'copy-body').accounts, ['Contoso Ltd']);
  assert.equal(readEmail(db, 'other').copies, 1);
});

test('an empty search lists stored email newest first, 20 at a time, with explicit pull freshness', t => {
  const db = makeDb(t);
  for (let day = 1; day <= 30; day++) {
    addEmail(db, { message_id: `m${day}`, subject: `Update ${day}`, received_at: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z` });
  }
  addEmail(db, { message_id: 'undated', subject: 'No date' });

  const first = searchEmails(db);
  assert.equal(first.mode, 'recent');
  assert.equal(first.account, null);
  assert.equal(first.total, 31);
  assert.deepEqual(ids(first), days(30, 11));
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.storedCount, 31);
  assert.equal(first.pulledAt, null);
  assert.equal(first.unreadablePullTimes, 0);
  assert.deepEqual(first.accounts, []);
  assert.deepEqual(ids(searchEmails(db, { cursor: '' })), ids(first));

  addEmail(db, { message_id: 'newer', subject: 'Pulled between pages', received_at: '2026-09-30T09:00:00Z' });
  const second = searchEmails(db, { cursor: first.nextCursor });
  assert.deepEqual(ids(second), [...days(10, 1), 'undated'], 'email pulled between pages neither repeats nor skips an email');
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, 32);
  assert.equal(second.storedCount, 32);
  assert.equal(searchEmails(db).results[0].messageId, 'newer');

  const all = searchEmails(db, { limit: 100 });
  assert.equal(all.results.length, 32);
  assert.equal(all.results.at(-1).messageId, 'undated');
  assert.equal(all.nextCursor, null);
  const update = searchEmails(db, { query: 'update' });
  assert.equal(update.mode, 'search');
  assert.equal(update.total, 30);
  assert.deepEqual(ids(update), days(30, 11));
  assert.deepEqual(ids(searchEmails(db, { query: 'update', cursor: update.nextCursor })), days(10, 1));
  assert.equal(searchEmails(db, { query: 'update', limit: 5 }).results.length, 5);

  db.exec(`INSERT INTO email_sync(scope_key, last_run_at) VALUES ('global','2026-09-22 10:00:00'),('1001','2026-09-23T07:30:00Z'),('1003','yesterday')`);
  const pulled = searchEmails(db, { query: '' });
  assert.equal(pulled.pulledAt, '2026-09-23T07:30:00.000Z');
  assert.equal(pulled.unreadablePullTimes, 1);

  for (const limit of [0, 101, 2.5, '5']) assert.throws(() => searchEmails(db, { limit }), /whole number from 1 to 100/);
  assert.throws(() => searchEmails(db, { query: 'a b c d e f g h i' }), /at most 8 search words/);
  assert.throws(() => searchEmails(db, { query: 'x'.repeat(201) }), /at most 200 characters/);
  assert.throws(() => searchEmails(db, { query: 42 }), /as text/);
  for (const cursor of [42, 'not a cursor!', 'x'.repeat(16385), cursorOf('nope'), cursorOf('{"time":1}'), cursorOf('[1]'),
    cursorOf('[1,""]'), cursorOf('["soon","id:m1"]'), cursorOf('[1e999,"id:m1"]')]) {
    assert.throws(() => searchEmails(db, { cursor }), /“See more” position could not be read\. Refresh the email list/);
  }
  for (const account of [42, '   ', 'x'.repeat(201)]) {
    assert.throws(() => searchEmails(db, { account }), /Choose a customer account from the list/);
  }
});

test('a customer account narrows the list to email linked to it, alone or with search words', t => {
  const db = makeDb(t);
  db.exec(`INSERT INTO customers VALUES ('1004','Fabrikam',NULL),('1005','Fabrikam',NULL),('1006','Woodgrove',NULL)`);
  addEmail(db, { message_id: 'contoso-new', subject: 'Contoso renewal', received_at: '2026-09-25T10:00:00Z' });
  addEmail(db, { message_id: 'contoso-old', subject: 'Contoso kickoff', body_text: 'AKS sizing', received_at: '2026-09-20T10:00:00Z' });
  addEmail(db, { message_id: 'copy-a', internet_message_id: '<joint@x>', subject: 'Joint plan', received_at: '2026-09-24T10:00:00Z' });
  addEmail(db, { message_id: 'copy-b', internet_message_id: '<joint@x>', subject: 'Joint plan', sent_at: '2026-09-24T09:59:00Z' });
  addEmail(db, { message_id: 'fabrikam-east', subject: 'East region', received_at: '2026-09-23T10:00:00Z' });
  addEmail(db, { message_id: 'fabrikam-west', subject: 'West region', received_at: '2026-09-22T10:00:00Z' });
  addEmail(db, { message_id: 'unnamed', subject: 'Mystery account', received_at: '2026-09-21T10:00:00Z' });
  addEmail(db, { message_id: 'rejected', subject: 'False match', received_at: '2026-09-26T10:00:00Z' });
  addEmail(db, { message_id: 'unlinked', subject: 'No account', received_at: '2026-09-27T10:00:00Z' });
  link(db, 'contoso-new', '1001');
  link(db, 'contoso-old', '1001', 'alias');
  link(db, 'copy-b', '1001');
  link(db, 'copy-a', '1003');
  link(db, 'fabrikam-east', '1004');
  link(db, 'fabrikam-west', '1005');
  link(db, 'unnamed', '1009');
  link(db, 'rejected', '1003', 'ai-rejected');
  db.exec('PRAGMA foreign_keys = OFF');
  link(db, 'no-longer-stored', '1006');

  const contoso = searchEmails(db, { account: '1001' });
  assert.equal(contoso.mode, 'recent');
  assert.deepEqual(contoso.account, { tpid: '1001', label: 'Contoso Ltd' });
  assert.deepEqual(ids(contoso), ['contoso-new', 'copy-a', 'contoso-old'], 'a link on any stored copy puts the email in the account');
  assert.deepEqual(contoso.results[1].accounts, ['Contoso Ltd', 'Tailspin Toys']);
  assert.equal(contoso.results[1].accountLabel, 'Contoso Ltd, Tailspin Toys');
  assert.equal(contoso.results[1].copies, 2);
  const first = searchEmails(db, { account: '1001', limit: 2 });
  assert.deepEqual(ids(first), ['contoso-new', 'copy-a']);
  const rest = searchEmails(db, { account: '1001', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(ids(rest), ['contoso-old']);
  assert.equal(rest.nextCursor, null);

  assert.deepEqual(ids(searchEmails(db, { account: '1001', query: 'aks' })), ['contoso-old']);
  const contosoWord = searchEmails(db, { account: '1001', query: 'contoso' });
  assert.equal(contosoWord.mode, 'search');
  assert.deepEqual(ids(contosoWord), ['contoso-new', 'copy-b', 'contoso-old'], 'a search shows the copy that matched');
  assert.deepEqual(ids(searchEmails(db, { account: '1004', query: 'contoso' })), []);
  assert.deepEqual(ids(searchEmails(db, { account: '1003' })), ['copy-a'], 'an AI-rejected link does not put an email in the account');

  const fabrikam = searchEmails(db, { account: '1004' });
  assert.deepEqual(fabrikam.account, { tpid: '1004', label: 'Fabrikam (TPID 1004)' }, 'accounts with the same name show their TPIDs');
  assert.deepEqual(fabrikam.results[0].accounts, ['Fabrikam (TPID 1004)']);
  assert.deepEqual(searchEmails(db, { account: '1009' }).results[0].accounts, ['Unnamed account (TPID 1009)']);

  const all = searchEmails(db);
  assert.equal(all.total, 8);
  assert.deepEqual(all.accounts, [
    { tpid: '1001', label: 'Contoso Ltd', emailCount: 3 },
    { tpid: '1004', label: 'Fabrikam (TPID 1004)', emailCount: 1 },
    { tpid: '1005', label: 'Fabrikam (TPID 1005)', emailCount: 1 },
    { tpid: '1003', label: 'Tailspin Toys', emailCount: 1 },
    { tpid: '1009', label: 'Unnamed account (TPID 1009)', emailCount: 1 },
  ], 'only accounts linked to stored email are listed, each with its email count');
  assert.deepEqual(all.results[0].accounts, []);
  assert.equal(all.results[0].accountLabel, null);

  assert.throws(() => searchEmails(db, { account: '9999' }), error => error.code === 'ACCOUNT_ARCHIVED');
  for (const tpid of ['1006']) {
    const none = searchEmails(db, { account: tpid });
    assert.deepEqual(none.account, { tpid, label: null });
    assert.equal(none.total, 0);
    assert.deepEqual(none.results, []);
    assert.equal(none.nextCursor, null);
    assert.equal(none.accounts.length, 5);
  }

  assert.deepEqual(readEmail(db, 'copy-a').accounts, ['Contoso Ltd', 'Tailspin Toys']);
  assert.deepEqual(readEmail(db, 'fabrikam-west').accounts, ['Fabrikam (TPID 1005)']);
  assert.equal(readEmail(db, 'unnamed').accountLabel, 'Unnamed account (TPID 1009)');
  assert.deepEqual(readEmail(db, 'rejected').accounts, []);
});

test('detail shows the full stored body and recipients, and labels condensed or preview text', t => {
  const db = makeDb(t);
  addEmail(db, {
    message_id: 'AAMk/full+id=', subject: 'Full body', from_name: null, from_address: null, has_attachments: 1, importance: 'high',
    body_text: 'Hello team Second paragraph', received_at: '2026-09-20T10:00:00Z',
    web_link: 'https://outlook.office365.com/owa/?ItemID=AAMk%2Ffull%2Bid%3D&exvsurl=1&viewmodel=ReadMessageItem',
    raw_json: {
      body: { contentType: 'html', content: '<p>Hello <b>team</b></p><p>Second paragraph</p>' },
      from: { emailAddress: { name: 'Ada', address: 'ada@contoso.com' } },
      toRecipients: [{ emailAddress: { name: 'Grace', address: 'grace@fabrikam.com' } }], ccRecipients: [],
    },
  });
  addEmail(db, { message_id: 'condensed', subject: 'Condensed', body_text: 'Condensed text', to_json: '[{"name":"Ada","address":"ada@contoso.com"}]', cc_json: 'null' });
  addEmail(db, { message_id: 'preview', subject: 'Preview', body_text: 'Preview only', body_source: 'preview' });
  addEmail(db, { message_id: 'empty', subject: null });
  link(db, 'condensed', '1001');

  const full = readEmail(db, 'AAMk/full+id=');
  assert.equal(full.body.source, 'full');
  assert.match(full.body.text, /Hello\s+team[\s\S]*Second paragraph/);
  assert.equal(full.body.truncated, false);
  assert.deepEqual(full.from, { name: 'Ada', address: 'ada@contoso.com' });
  assert.deepEqual(full.to, [{ name: 'Grace', address: 'grace@fabrikam.com' }]);
  assert.deepEqual(full.cc, []);
  assert.equal(full.hasAttachments, true);
  assert.equal(full.importance, 'high');
  assert.equal(full.webLink, 'https://outlook.office.com/mail/deeplink/read/AAMk%2Ffull%2Bid%3D?ItemID=AAMk%2Ffull%2Bid%3D&exvsurl=1');
  assert.deepEqual(full.warnings, []);
  assert.equal(full.isProtected, false);

  const condensed = readEmail(db, 'condensed');
  assert.deepEqual(condensed.body, { text: 'Condensed text', source: 'condensed', truncated: false });
  assert.deepEqual(condensed.to, [{ name: 'Ada', address: 'ada@contoso.com' }]);
  assert.deepEqual(condensed.cc, []);
  assert.equal(condensed.accountLabel, 'Contoso Ltd');
  assert.equal(condensed.webLink, 'https://outlook.office.com/mail/deeplink/read/condensed?ItemID=condensed&exvsurl=1');
  assert.equal(readEmail(db, 'preview').body.source, 'preview');
  assert.deepEqual(readEmail(db, 'empty').body, { text: '', source: null, truncated: false });
  assert.equal(readEmail(db, 'empty').subject, '');
});

test('detail reports unreadable stored data instead of hiding it', t => {
  const db = makeDb(t);
  addEmail(db, { message_id: 'bad-to', body_text: 'Text', to_json: 'not json', cc_json: '{"name":"Not a list"}' });
  addEmail(db, { message_id: 'bad-entry', body_text: 'Text', to_json: '["plain string"]' });
  addEmail(db, { message_id: 'two-ids', body_text: 'Text', web_link: 'https://outlook.office365.com/owa/?ItemID=a&ItemID=b&viewmodel=ReadMessageItem' });
  addEmail(db, { message_id: 'script', body_text: 'Text', web_link: 'javascript:alert(1)' });
  addEmail(db, {
    message_id: 'huge', body_text: 'Condensed fallback text',
    raw_json: { body: { contentType: 'html', content: `<p>${'x'.repeat(2_000_001)}</p>` } },
  });
  addEmail(db, { message_id: 'long', body_text: 'y'.repeat(60_010) });

  const badTo = readEmail(db, 'bad-to');
  assert.deepEqual(badTo.to, []);
  assert.deepEqual(badTo.cc, []);
  assert.equal(badTo.warnings.length, 2);
  assert.match(badTo.warnings[0], /unreadable To recipients/);
  assert.match(badTo.warnings[1], /unreadable Cc recipients/);
  assert.match(readEmail(db, 'bad-entry').warnings[0], /unreadable To recipients/);
  for (const id of ['two-ids', 'script']) {
    const email = readEmail(db, id);
    assert.equal(email.webLink, `https://outlook.office.com/mail/deeplink/read/${id}?ItemID=${id}&exvsurl=1`);
    assert.match(email.warnings[0], /stored Outlook link for this email is invalid/);
  }
  const huge = readEmail(db, 'huge');
  assert.deepEqual(huge.body, { text: 'Condensed fallback text', source: 'condensed', truncated: false });
  assert.match(huge.warnings[0], /full stored body could not be read \(The email HTML exceeds the safe processing limit\. No body text was silently truncated\)\. The condensed text/);
  const long = readEmail(db, 'long');
  assert.equal(long.body.text.length, 60_000);
  assert.equal(long.body.truncated, true);

  assert.throws(() => readEmail(db, 'missing'), /no longer stored in SE Assist/);
  for (const value of ['', '  ', 42, null, 'x'.repeat(2001)]) assert.throws(() => readEmail(db, value), /Choose an email/);
});

test('protected-message notices are flagged in search results and detail', t => {
  const db = makeDb(t);
  addEmail(db, { message_id: 'stored-notice', subject: 'Protected', body_text: NOTICE_TEXT, received_at: '2026-09-20T10:00:00Z' });
  addEmail(db, {
    message_id: 'raw-notice', subject: 'Protected raw', body_text: 'Unrelated condensed text', received_at: '2026-09-19T10:00:00Z',
    raw_json: { body: { contentType: 'text', content: NOTICE } },
  });
  addEmail(db, { message_id: 'normal', subject: 'Protected word only', body_text: 'This plan is protected by policy.', received_at: '2026-09-18T10:00:00Z' });

  const results = searchEmails(db, { query: 'protected' }).results;
  assert.deepEqual(results.map(item => [item.messageId, item.isProtected]), [
    ['stored-notice', true], ['raw-notice', false], ['normal', false],
  ]);
  assert.equal(readEmail(db, 'stored-notice').isProtected, true);
  assert.equal(readEmail(db, 'raw-notice').isProtected, true);
  assert.equal(readEmail(db, 'normal').isProtected, false);
});
