'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { approveSuggestion, createWorkload } = require('../workload-orchestration');

// The app's real handle is better-sqlite3 (built for Electron's ABI, so it can't load under the
// test runner's Node). node:sqlite gives a real SQLite engine with the same positional statement
// API; this thin adapter adds the two extra methods the orchestration relies on: pragma() and
// transaction() with better-sqlite3-style savepoint nesting (createWorkload runs inside
// approveSuggestion's transaction).
function adapt(db) {
  let depth = 0;
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (directive) => db.exec(`PRAGMA ${directive}`),
    transaction(fn) {
      return (...args) => {
        const outer = depth === 0;
        const name = `sp_${depth}`;
        db.exec(outer ? 'BEGIN' : `SAVEPOINT ${name}`);
        depth += 1;
        try {
          const result = fn(...args);
          depth -= 1;
          db.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
          return result;
        } catch (err) {
          depth -= 1;
          if (outer) {
            db.exec('ROLLBACK');
          } else {
            db.exec(`ROLLBACK TO ${name}`);
            db.exec(`RELEASE ${name}`);
          }
          throw err;
        }
      };
    },
  };
}

// A real in-memory SQLite handle with just the tables the orchestration touches, so we can
// exercise the suggestion -> approve conversion end to end (nested transactions, FK cascade).
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE customers (
      crm_account_id TEXT UNIQUE,
      tpid TEXT,
      name TEXT
    );
    CREATE TABLE opportunities (
      opportunity_id TEXT UNIQUE,
      name TEXT,
      owner_name TEXT,
      parent_account_id TEXT,
      state_code INTEGER DEFAULT 0
    );
    CREATE TABLE workloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      name TEXT,
      description TEXT,
      category TEXT,
      tpid TEXT,
      account_name TEXT,
      customer_tpid TEXT,
      customer_name TEXT,
      ssp_name TEXT,
      opportunity_id TEXT,
      opportunity_name TEXT,
      template_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      is_reusable INTEGER NOT NULL DEFAULT 0,
      is_shared INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workload_milestone_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workload_id INTEGER NOT NULL,
      milestone_id TEXT NOT NULL,
      milestone_name TEXT,
      account_name TEXT,
      status_label TEXT,
      opportunity_id TEXT,
      opportunity_name TEXT,
      customer_tpid TEXT,
      customer_name TEXT,
      UNIQUE (workload_id, milestone_id),
      FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE
    );
    CREATE TABLE workload_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tpid TEXT NOT NULL,
      account_name TEXT,
      ssp_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      source_json TEXT,
      status TEXT NOT NULL DEFAULT 'suggested'
    );
    CREATE TABLE workload_suggestion_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id INTEGER NOT NULL,
      opportunity_id TEXT NOT NULL,
      opportunity_name TEXT,
      included INTEGER NOT NULL DEFAULT 1,
      UNIQUE (suggestion_id, opportunity_id),
      FOREIGN KEY (suggestion_id) REFERENCES workload_suggestions(id) ON DELETE CASCADE
    );
    CREATE TABLE workload_suggestion_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id INTEGER NOT NULL,
      opportunity_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      milestone_name TEXT,
      status_label TEXT,
      included INTEGER NOT NULL DEFAULT 1,
      UNIQUE (suggestion_id, milestone_id),
      FOREIGN KEY (suggestion_id) REFERENCES workload_suggestions(id) ON DELETE CASCADE
    );
    CREATE TABLE signal_links (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type     TEXT NOT NULL,
      signal_id       TEXT NOT NULL,
      target_type     TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      tpid            TEXT,
      signal_title    TEXT,
      signal_subtitle TEXT,
      signal_date     TEXT,
      source          TEXT NOT NULL DEFAULT 'manual',
      confidence      REAL,
      rationale       TEXT,
      qualifier_milestone_id  TEXT,
      qualifier_opportunity_id TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (signal_type IN ('email','meeting','chat')),
      CHECK (target_type IN ('account','milestone','opportunity','workload','action','hok_activity')),
      CHECK (signal_id LIKE signal_type || ':%'),
      UNIQUE (signal_type, signal_id, target_type, target_id)
    );
  `);
  db.prepare('INSERT INTO customers (crm_account_id, tpid, name) VALUES (?, ?, ?)')
    .run('CRM-1', '1001', 'Contoso Bank');
  db.prepare(
    'INSERT INTO opportunities (opportunity_id, name, owner_name, parent_account_id, state_code) VALUES (?, ?, ?, ?, 0)',
  ).run('OPP-1', 'Azure AI Platform', 'Dana SSP', 'CRM-1');
  db.exec("CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY); INSERT INTO tpid_config VALUES('1001')");
  db.exec(`CREATE TABLE milestones(milestone_id TEXT PRIMARY KEY, opportunity_id TEXT);
    INSERT INTO milestones VALUES('MS-1','OPP-1'),('MS-9','OPP-1');
    CREATE TABLE emails(message_id TEXT PRIMARY KEY);
    CREATE TABLE meetings(event_id TEXT PRIMARY KEY);
    CREATE TABLE teams_chats(chat_id TEXT PRIMARY KEY)`);
  for (const table of ['customers', 'opportunities', 'milestones', 'workloads', 'workload_milestone_links', 'workload_suggestions', 'workload_suggestion_opportunities', 'workload_suggestion_milestones', 'signal_links']) {
    db.exec(`CREATE VIEW active_${table} AS SELECT * FROM ${table}`);
  }
  return adapt(db);
}

function seedSuggestion(db, { withOpportunity = true, withMilestone = true } = {}) {
  const suggestionId = Number(db.prepare(
    `INSERT INTO workload_suggestions (tpid, account_name, ssp_name, title, description)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('1001', 'Contoso Bank', null, 'Fraud detection PoC', 'Stand up a fraud detection proof of concept.').lastInsertRowid);
  if (withOpportunity) {
    db.prepare(
      `INSERT INTO workload_suggestion_opportunities (suggestion_id, opportunity_id, opportunity_name, included)
       VALUES (?, ?, ?, 1)`,
    ).run(suggestionId, 'OPP-1', 'Azure AI Platform');
  }
  if (withMilestone) {
    db.prepare(
      `INSERT INTO workload_suggestion_milestones
         (suggestion_id, opportunity_id, milestone_id, milestone_name, status_label, included)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(suggestionId, 'OPP-1', 'MS-1', 'PoC kickoff', 'On track');
  }
  return suggestionId;
}

test('approveSuggestion converts a draft into a real workload with milestone links', () => {
  const db = makeDb();
  const suggestionId = seedSuggestion(db);

  const result = approveSuggestion(db, { suggestionId });

  assert.ok(result.workloadId > 0);
  assert.equal(result.opportunityCount, 1);
  assert.equal(result.milestoneCount, 1);

  const workload = db.prepare('SELECT * FROM workloads WHERE id = ?').get(result.workloadId);
  assert.equal(workload.title, 'Fraud detection PoC');
  assert.equal(workload.description, 'Stand up a fraud detection proof of concept.');
  // Customer + SSP resolved from the chosen opportunity.
  assert.equal(workload.opportunity_id, 'OPP-1');
  assert.equal(workload.opportunity_name, 'Azure AI Platform');
  assert.equal(workload.customer_tpid, '1001');
  assert.equal(workload.customer_name, 'Contoso Bank');
  assert.equal(workload.ssp_name, 'Dana SSP');

  const links = db.prepare('SELECT * FROM workload_milestone_links WHERE workload_id = ?').all(result.workloadId);
  assert.equal(links.length, 1);
  assert.equal(links[0].milestone_id, 'MS-1');
  assert.equal(links[0].milestone_name, 'PoC kickoff');
  assert.equal(links[0].opportunity_id, 'OPP-1');
  assert.equal(links[0].opportunity_name, 'Azure AI Platform');
  assert.equal(links[0].customer_tpid, '1001');

  // Draft rows are consumed (children cascade), so the suggestion cannot be double-approved.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workload_suggestions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workload_suggestion_opportunities').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workload_suggestion_milestones').get().n, 0);
});

test('approveSuggestion with no opportunities still carries the account from the draft', () => {
  const db = makeDb();
  // Give the draft an explicit SSP since there is no opportunity to derive it from.
  const suggestionId = Number(db.prepare(
    `INSERT INTO workload_suggestions (tpid, account_name, ssp_name, title, description)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('1001', 'Contoso Bank', 'Pat SSP', 'Enablement workshop', 'Run an enablement workshop.').lastInsertRowid);

  const result = approveSuggestion(db, { suggestionId });
  const workload = db.prepare('SELECT * FROM workloads WHERE id = ?').get(result.workloadId);
  assert.equal(result.opportunityCount, 0);
  assert.equal(result.milestoneCount, 0);
  assert.equal(workload.opportunity_id, null);
  assert.equal(workload.customer_tpid, '1001');
  assert.equal(workload.account_name, 'Contoso Bank');
  assert.equal(workload.ssp_name, 'Pat SSP');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workload_milestone_links').get().n, 0);
});

test('approveSuggestion rejects an unknown suggestion id', () => {
  const db = makeDb();
  assert.throws(() => approveSuggestion(db, { suggestionId: 999 }), /no longer exists/);
});

test('createWorkload account fallbacks do not override a resolved opportunity customer', () => {
  const db = makeDb();
  const { workloadId } = createWorkload(db, {
    name: 'Direct workload',
    opportunityId: 'OPP-1',
    tpid: '9999',
    accountName: 'Wrong Account',
  });
  const workload = db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  // The opportunity's customer wins over the supplied fallback tpid/name.
  assert.equal(workload.customer_tpid, '1001');
  assert.equal(workload.customer_name, 'Contoso Bank');
});

test('createWorkload attaches discovered milestones + communication signals atomically', () => {
  const db = makeDb();
  const result = createWorkload(db, {
    name: 'Fabric PoC',
    description: 'Stand up a Fabric proof of concept.',
    category: 'Demo / PoC',
    tpid: '1001',
    accountName: 'Contoso Bank',
    milestones: [
      { milestoneId: 'MS-9', milestoneName: 'PoC kickoff', statusLabel: 'On track', opportunityId: 'OPP-1', opportunityName: 'Azure AI Platform' },
    ],
    signals: [
      { signalType: 'email', nativeId: 'MSG-1', signalTitle: 'Fabric scoping', signalDate: '2026-02-01', milestoneId: 'MS-9', opportunityId: 'OPP-1', rationale: 'scoping thread' },
      { signalType: 'chat', nativeId: '19:thread@x', signalTitle: 'Fabric chat', rationale: 'design chat' },
    ],
  });

  assert.ok(result.workloadId > 0);
  assert.equal(result.milestoneCount, 1);
  assert.equal(result.signalCount, 2);

  // Milestone carried the workload's account snapshot.
  const links = db.prepare('SELECT * FROM workload_milestone_links WHERE workload_id = ?').all(result.workloadId);
  assert.equal(links.length, 1);
  assert.equal(links[0].milestone_id, 'MS-9');
  assert.equal(links[0].customer_tpid, '1001');
  assert.equal(links[0].opportunity_name, 'Azure AI Platform');

  // Signals landed in signal_links as workload-target rows, encoded + qualifier-tagged.
  const sig = db.prepare(
    "SELECT signal_type, signal_id, target_type, target_id, tpid, qualifier_milestone_id FROM signal_links WHERE target_type='workload' ORDER BY signal_id",
  ).all();
  assert.equal(sig.length, 2);
  const email = sig.find((s) => s.signal_type === 'email');
  assert.equal(email.signal_id, 'email:MSG-1');
  assert.equal(email.target_id, String(result.workloadId));
  assert.equal(email.tpid, '1001');
  assert.equal(email.qualifier_milestone_id, 'MS-9');
  const chat = sig.find((s) => s.signal_type === 'chat');
  assert.equal(chat.signal_id, 'chat:19:thread@x'); // chat keyed by thread id (colons preserved)
});

test('createWorkload with a malformed signal rolls back the whole create (fail loud, atomic)', () => {
  const db = makeDb();
  assert.throws(() => createWorkload(db, {
    name: 'Bad signal workload',
    tpid: '1001',
    signals: [{ signalType: 'sms', nativeId: 'X1' }], // unknown signal type
  }), /discovered sms signal|unknown signal_type/);
  // Nothing was committed — the workload insert rolled back with the bad signal.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workloads WHERE name='Bad signal workload'").get().n, 0);
});
