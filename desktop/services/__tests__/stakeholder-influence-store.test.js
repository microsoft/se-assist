'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const store = require('../stakeholder-influence-store');
const { buildInfluenceMap } = require('../stakeholder-influence');

const migration = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');
const NOW = '2026-01-05T09:00:00.000Z';
const BOB = 'bob@contoso.com';
const ADA = 'ada@contoso.com';
const MIGRATIONS = [
  '005_email_inventory.sql', '006_customer_account_team.sql', '007_meeting_inventory.sql',
  '011_customer_contacts.sql', '026_meeting_notes.sql', '031_stakeholder_influence.sql',
  '032_retire_stakeholder_influence_opt_in.sql',
];

function makeDb(t, migrations = MIGRATIONS) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('CREATE TABLE customers(tpid TEXT, name TEXT, parent_crm_account_id TEXT)');
  for (const name of migrations) raw.exec(migration(name));
  let depth = 0;
  return {
    raw,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      return (...args) => {
        const savepoint = `influence_test_${depth++}`;
        raw.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn(...args);
          raw.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        } finally { depth--; }
      };
    },
  };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const storedPeople = (db) => JSON.parse(
  db.prepare("SELECT result_json FROM stakeholder_assessments WHERE tpid = '1001'").get().result_json,
).people.map((person) => person.personId);

function saveSample(db) {
  store.saveAssessment(db, {
    tpid: '1001',
    provider: 'copilot',
    model: 'gpt-5.6-luna',
    analyzedAt: NOW,
    inputHash: 'hash-1',
    result: {
      version: 1,
      people: [{ personId: BOB, stance: 'blocker' }, { personId: ADA, stance: 'champion' }],
      caveats: [],
    },
  });
}

test('migration 032 drops the opt-in table and keeps every correction and AI analysis', (t) => {
  const db = makeDb(t, MIGRATIONS.filter((name) => !name.startsWith('032_')));
  db.prepare(
    `INSERT INTO stakeholder_influence_settings (id, enabled, acknowledged_at, updated_at) VALUES (1, 1, ?, ?)`,
  ).run(NOW, NOW);
  store.setOverride(db, { tpid: '1001', personId: BOB, stance: 'blocker', note: 'Met at the summit', now: NOW });
  saveSample(db);

  db.exec(migration('032_retire_stakeholder_influence_opt_in.sql'));

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stakeholder_influence_settings'").get().n,
    0,
  );
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 32);
  assert.deepEqual(store.loadAccountInputs(db, '1001').overrides, [
    { personId: BOB, stance: 'blocker', note: 'Met at the summit', hidden: false, updatedAt: NOW },
  ]);
  assert.deepEqual(storedPeople(db), [BOB, ADA]);
  for (const name of ['getSettings', 'isEnabled', 'setSettings']) assert.equal(store[name], undefined, name);
});

test('override fields are patched independently and an empty override is deleted', (t) => {
  const db = makeDb(t);
  const set = (patch) => store.setOverride(db, { tpid: '1001', personId: BOB, now: NOW, ...patch });
  assert.deepEqual(set({ stance: 'blocker' }), [
    { personId: BOB, stance: 'blocker', note: '', hidden: false, updatedAt: NOW },
  ]);
  assert.deepEqual(set({ note: '  Met at the summit  ' })[0], {
    personId: BOB, stance: 'blocker', note: 'Met at the summit', hidden: false, updatedAt: NOW,
  });
  assert.deepEqual(set({ stance: null })[0], {
    personId: BOB, stance: null, note: 'Met at the summit', hidden: false, updatedAt: NOW,
  });
  assert.deepEqual(set({ note: '' }), []);
  assert.equal(count(db, 'stakeholder_overrides'), 0);
});

test('invalid overrides are rejected and nothing is written', (t) => {
  const db = makeDb(t);
  const set = (patch) => store.setOverride(db, { tpid: '1001', personId: BOB, ...patch });
  assert.throws(() => set({ stance: 'ally' }), /Stance must be one of: champion, blocker, neutral, unclear/);
  assert.throws(() => set({ note: 'x'.repeat(store.NOTE_MAX + 1) }), /the limit is 500/);
  assert.throws(() => set({ note: 42 }), /The note must be text/);
  assert.throws(() => set({ hidden: 'yes' }), /hidden must be true or false/);
  assert.throws(() => store.setOverride(db, { personId: BOB, stance: 'blocker' }), /tpid is required/);
  assert.throws(() => store.setOverride(db, { tpid: '1001', stance: 'blocker' }), /personId is required/);
  assert.equal(count(db, 'stakeholder_overrides'), 0);
});

test("hiding a person also removes the AI's saved judgement about them", (t) => {
  const db = makeDb(t);
  saveSample(db);
  store.setOverride(db, { tpid: '1001', personId: BOB, hidden: true, now: NOW });
  assert.deepEqual(storedPeople(db), [ADA]);
  const loaded = store.loadAccountInputs(db, '1001');
  assert.deepEqual(loaded.overrides, [{ personId: BOB, stance: null, note: '', hidden: true, updatedAt: NOW }]);
  assert.equal(loaded.assessment.provider, 'copilot');
  assert.equal(loaded.assessment.inputHash, 'hash-1');
  assert.deepEqual(loaded.assessment.result.people.map((person) => person.personId), [ADA]);

  // Un-hiding does not bring the deleted judgement back.
  store.setOverride(db, { tpid: '1001', personId: BOB, hidden: false, now: NOW });
  assert.deepEqual(storedPeople(db), [ADA]);
});

test('an unreadable saved assessment loads as undefined and can be cleared', (t) => {
  const db = makeDb(t);
  db.prepare(
    `INSERT INTO stakeholder_assessments (tpid, provider, model, analyzed_at, input_hash, result_json)
     VALUES ('1001', 'copilot', NULL, ?, 'h', 'not json')`,
  ).run(NOW);
  const assessment = store.loadAccountInputs(db, '1001').assessment;
  assert.equal(assessment.result, undefined);
  assert.equal(assessment.model, null);
  // Hiding someone must not fail because the saved result is unreadable.
  store.setOverride(db, { tpid: '1001', personId: BOB, hidden: true, now: NOW });
  assert.equal(store.clearAssessment(db, '1001'), true);
  assert.equal(store.clearAssessment(db, '1001'), false);
  assert.throws(() => store.saveAssessment(db, { tpid: '1001', provider: 'copilot', inputHash: 'h' }), /are required/);
});

test('account inputs come only from this account and skip AI-rejected links and empty transcripts', (t) => {
  const db = makeDb(t);
  const attendees = JSON.stringify([
    { name: 'Bob Buyer', address: BOB, type: 'required', response: 'accepted' },
    { name: 'Mina Internal', address: 'mina@microsoft.com', type: 'optional', response: 'accepted' },
  ]);
  db.exec(`
    INSERT INTO customers VALUES ('1001', 'Contoso Child', 'parent-guid'), ('1001', 'Contoso', NULL), ('1002', 'Fabrikam', NULL);
    INSERT INTO customer_account_team (tpid, person_name, person_email, org) VALUES
      ('1001', 'Mina Internal', 'mina@microsoft.com', 'microsoft'),
      ('1002', 'Other Seller', 'other@microsoft.com', 'microsoft');
    INSERT INTO customer_contacts (contact_id, tpid, full_name, job_title, email) VALUES
      ('c1', '1001', 'Ada Customer', 'CIO', '${ADA}'),
      ('c2', '1002', 'Fay Fabrikam', 'CTO', 'fay@fabrikam.com');
    INSERT INTO emails (message_id, conversation_id, subject, from_name, from_address, to_json, cc_json, sent_at, body_text) VALUES
      ('e1', 't1', 'Budget', 'Ada Customer', '${ADA}', '[{"name":"Bob Buyer","address":"${BOB}"}]', '[]', '2026-01-02T10:00:00Z', 'Plan'),
      ('e2', 't2', 'Rejected', 'Ada Customer', '${ADA}', '[]', '[]', '2026-01-02T10:00:00Z', ''),
      ('e3', 't3', 'Other account', 'Fay Fabrikam', 'fay@fabrikam.com', '[]', '[]', '2026-01-02T10:00:00Z', '');
    INSERT INTO email_customer_links (message_id, tpid, match_method) VALUES
      ('e1', '1001', 'alias'), ('e2', '1001', 'ai-rejected'), ('e3', '1002', 'alias');
    INSERT INTO meetings (event_id, subject, organizer_name, organizer_address, attendees_json, start_at) VALUES
      ('m1', 'Architecture', 'Ada Customer', '${ADA}', '${attendees}', '2026-01-03T10:00:00Z'),
      ('m2', 'Rejected', 'Ada Customer', '${ADA}', '[]', '2026-01-03T10:00:00Z'),
      ('m3', 'No transcript', 'Ada Customer', '${ADA}', '[]', '2026-01-04T10:00:00Z');
    INSERT INTO meeting_customer_links (event_id, tpid, match_method) VALUES
      ('m1', '1001', 'alias'), ('m2', '1001', 'ai-rejected'), ('m3', '1001', 'contact');
    INSERT INTO meeting_notes (event_id, transcript) VALUES
      ('m1', 'Ada Customer: ship it\nBob Buyer: agreed'), ('m2', 'Ada Customer: secret'), ('m3', '   ');
  `);
  const loaded = store.loadAccountInputs(db, '1001');
  assert.equal(loaded.tpid, '1001');
  assert.equal(loaded.accountName, 'Contoso');
  assert.deepEqual(loaded.team.map((row) => row.person_email), ['mina@microsoft.com']);
  assert.deepEqual(loaded.contacts.map((row) => row.email), [ADA]);
  assert.deepEqual(loaded.emails.map((row) => row.message_id), ['e1']);
  assert.deepEqual(loaded.meetings.map((row) => row.event_id).sort(), ['m1', 'm3']);
  assert.deepEqual(loaded.transcripts.map((row) => row.event_id), ['m1']);
  assert.deepEqual(loaded.overrides, []);
  assert.equal(loaded.assessment, null);

  const map = buildInfluenceMap(loaded);
  assert.deepEqual(map.people.map((person) => person.name).sort(), ['Ada Customer', 'Bob Buyer']);
  assert.equal(map.people.find((person) => person.name === 'Ada Customer').title, 'CIO');
  assert.equal(map.sources.transcripts, 1);
});
