'use strict';

// Native milestone "Related signal" read/write regression tests (migration 024).
// The legacy milestone_signal_links table and the reconcile/parity engine are gone:
// the finder now reads AND writes signal_links directly (target_type='milestone').
// These tests exercise the production helpers verbatim on the real SQLite engine
// (node:sqlite): addMilestoneSignal -> readMilestoneSignals ->
// removeMilestoneSignalsByKeys, plus the self-heal prune/dedupe helpers.
// Also covers the native workload comms-assignment helpers (migration 023).
//
// DDL is copied from migration 022 (signal_links) + 023 (qualifier columns) to keep
// the CHECK/UNIQUE constraints honest. No milestone_signal_links table is created —
// nothing in the code path references it any more.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  addMilestoneSignal,
  readMilestoneSignals,
  pruneRejectedMilestoneSignals,
  dedupeMilestoneEmailSignals,
  removeMilestoneSignalsByKeys,
  listWorkloadSignals,
  addWorkloadSignal,
  updateWorkloadSignalMilestone,
  removeWorkloadSignal,
} = require('../signal-links');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
  db.exec(`CREATE TABLE emails(message_id TEXT PRIMARY KEY, internet_message_id TEXT);
    CREATE TABLE meetings(event_id TEXT PRIMARY KEY);
    CREATE TABLE teams_chats(chat_id TEXT PRIMARY KEY);
    CREATE VIEW active_signal_links AS SELECT * FROM signal_links;
    CREATE VIEW active_emails AS SELECT * FROM emails;
    CREATE VIEW active_meetings AS SELECT * FROM meetings;
    CREATE VIEW active_teams_chats AS SELECT * FROM teams_chats`);
  return db;
}

// M1 gets an email, a meeting, and a two-message chat THREAD (both messages share
// one chat_id, so they collapse to a single canonical row). M2 gets one email.
function seedM1(db) {
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1', title: 'Kickoff email', subtitle: 'alice', itemDate: '2026-01-03', reason: 'mentions M1' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'meeting', refId: 'MTG1', title: 'Sync meeting', subtitle: 'bob', itemDate: '2026-01-02', reason: 'agenda' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'chat', refId: 'C1a', chatId: '19:thread@x', title: 'Planning chat', subtitle: 'carol', itemDate: '2026-01-01', reason: 'older msg' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'chat', refId: 'C1b', chatId: '19:thread@x', title: 'Planning chat', subtitle: 'dave', itemDate: '2026-01-05', reason: 'newer msg' });
  addMilestoneSignal(db, { milestoneId: 'M2', kind: 'email', refId: 'E2', title: 'M2 email', subtitle: 'erin', itemDate: '2026-01-04', reason: 'about M2' });
}

function grain(links) {
  return new Set(links.map((l) => `${l.deleteKey.kind}|${l.deleteKey.nativeId}`));
}

test('addMilestoneSignal writes signal_links; a two-message chat thread collapses to one canonical row', () => {
  const db = makeDb();
  seedM1(db);

  const m1 = readMilestoneSignals(db, 'M1');
  assert.equal(m1.length, 3, 'email + meeting + one chat thread');
  assert.deepEqual(grain(m1), new Set(['email|E1', 'meeting|MTG1', 'chat|19:thread@x']));

  const m2 = readMilestoneSignals(db, 'M2');
  assert.equal(m2.length, 1);
  assert.deepEqual(grain(m2), new Set(['email|E2']));

  // Only two physical rows back the chat thread's single card (INSERT OR IGNORE keeps
  // both because their signal_id is the shared thread id — the SECOND add no-ops).
  const chatRows = db.prepare(
    `SELECT COUNT(*) AS n FROM signal_links WHERE target_type='milestone' AND target_id='M1' AND signal_type='chat'`,
  ).get();
  assert.equal(chatRows.n, 1, 'chat thread stored as exactly one canonical row');
});

test('addMilestoneSignal is idempotent — a finder re-run never duplicates or clobbers a pick', () => {
  const db = makeDb();
  const first = addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1', reason: 'first' });
  assert.equal(first.changes, 1);
  assert.equal(first.signalId, 'email:E1');

  const again = addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1', reason: 'second' });
  assert.equal(again.changes, 0, 'repeat add is a no-op');

  const links = readMilestoneSignals(db, 'M1');
  assert.equal(links.length, 1);
  assert.equal(links[0].reason, 'first', 'original snapshot preserved, not overwritten');
});

test('readMilestoneSignals returns the renderer row shape + a natural delete key', () => {
  const db = makeDb();
  seedM1(db);
  const links = readMilestoneSignals(db, 'M1');

  const chat = links.find((l) => l.kind === 'chat');
  assert.ok(chat, 'a chat card exists');
  // Chat native id is the THREAD id, mirrored into both ref_id and chat_id.
  assert.equal(chat.ref_id, '19:thread@x');
  assert.equal(chat.chat_id, '19:thread@x');
  assert.deepEqual(chat.deleteKey, { kind: 'chat', nativeId: '19:thread@x' });
  assert.equal(chat.count, 1, 'one canonical row per thread; no N-messages roll-up');
  assert.deepEqual(chat.groupIds, [chat.id]);

  const email = links.find((l) => l.kind === 'email');
  assert.equal(email.ref_id, 'E1');
  assert.equal(email.chat_id, null);
  assert.equal(email.title, 'Kickoff email');
  assert.equal(email.subtitle, 'alice');
  assert.equal(email.item_date, '2026-01-03');
  assert.equal(email.reason, 'mentions M1');
  assert.equal(email.source, 'ai');
  assert.deepEqual(email.deleteKey, { kind: 'email', nativeId: 'E1' });
});

test('removeMilestoneSignalsByKeys deletes the whole chat thread by its thread key', () => {
  const db = makeDb();
  seedM1(db);

  const removed = removeMilestoneSignalsByKeys(db, 'M1', [{ kind: 'chat', nativeId: '19:thread@x' }]);
  assert.equal(removed, 1, 'one canonical thread row removed');

  const after = readMilestoneSignals(db, 'M1');
  assert.equal(after.length, 2, 'chat thread gone; email + meeting remain');
  assert.ok(!after.some((l) => l.kind === 'chat'));
});

test('removeMilestoneSignalsByKeys does NOT suppress a later re-suggest (no blocklist)', () => {
  const db = makeDb();
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1' });
  assert.equal(removeMilestoneSignalsByKeys(db, 'M1', [{ kind: 'email', nativeId: 'E1' }]), 1);
  assert.equal(readMilestoneSignals(db, 'M1').length, 0);

  const readd = addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1' });
  assert.equal(readd.changes, 1, 'delete did not suppress a future suggestion');
  assert.equal(readMilestoneSignals(db, 'M1').length, 1);
});

test('read/add/delete guards fail loud on bad input', () => {
  const db = makeDb();
  assert.throws(() => readMilestoneSignals(db, '  '), /milestoneId is required/);
  assert.throws(() => addMilestoneSignal(db, { kind: 'email', refId: 'E1' }), /milestoneId is required/);
  assert.throws(() => addMilestoneSignal(db, { milestoneId: 'M1', kind: 'sms', refId: 'E1' }), /unknown signal_type/);
  assert.throws(() => addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: '' }), /empty native id/);
  assert.throws(() => removeMilestoneSignalsByKeys(db, '', [{ kind: 'email', nativeId: 'E1' }]), /milestoneId is required/);
  assert.throws(() => removeMilestoneSignalsByKeys(db, 'M1', []), /at least one delete key/);
  assert.throws(() => removeMilestoneSignalsByKeys(db, 'M1', [{ kind: 'sms', nativeId: 'x' }]), /unknown signal_type/);
  assert.throws(() => removeMilestoneSignalsByKeys(db, 'M1', [{ kind: 'email', nativeId: '' }]), /empty native id/);
});

// ---------------------------------------------------------------------------
// Self-heal helpers (prune rejected + dedupe email folder-copies).
// ---------------------------------------------------------------------------

test('pruneRejectedMilestoneSignals drops an AI link the verifier rejected, keeps accepted + manual', () => {
  const db = makeDb();
  db.exec(`
    CREATE TABLE email_customer_links (
      message_id TEXT NOT NULL, tpid TEXT NOT NULL, match_method TEXT
    );
    INSERT INTO email_customer_links (message_id, tpid, match_method) VALUES
      ('REJ', '111', 'ai-rejected'),
      ('OK',  '111', 'subject-match');
  `);
  // Rejected AI link (should be pruned), an accepted AI link (kept), and a manual
  // link on the rejected id (never touched — only source='ai' is eligible).
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'REJ', tpid: '111', source: 'ai' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'OK', tpid: '111', source: 'ai' });
  addMilestoneSignal(db, { milestoneId: 'M2', kind: 'email', refId: 'REJ', tpid: '111', source: 'manual' });

  const removed = pruneRejectedMilestoneSignals(db, 'M1', '111');
  assert.equal(removed, 1);
  assert.deepEqual(grain(readMilestoneSignals(db, 'M1')), new Set(['email|OK']));
  assert.equal(readMilestoneSignals(db, 'M2').length, 1, 'manual link on a different milestone untouched');
});

test('pruneRejectedMilestoneSignals is a best-effort no-op when a source link table is absent', () => {
  const db = makeDb();
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'E1', tpid: '111', source: 'ai' });
  // No *_customer_links tables exist — must not throw, must remove nothing.
  assert.equal(pruneRejectedMilestoneSignals(db, 'M1', '111'), 0);
  assert.equal(readMilestoneSignals(db, 'M1').length, 1);
});

test('dedupeMilestoneEmailSignals collapses folder-copies sharing an internet_message_id', () => {
  const db = makeDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (message_id TEXT PRIMARY KEY, internet_message_id TEXT);
    INSERT INTO emails (message_id, internet_message_id) VALUES
      ('A', '<same@corp>'),
      ('B', '<same@corp>'),
      ('C', '<other@corp>');
  `);
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'A' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'B' });
  addMilestoneSignal(db, { milestoneId: 'M1', kind: 'email', refId: 'C' });

  const removed = dedupeMilestoneEmailSignals(db, 'M1');
  assert.equal(removed, 1, 'one of the two folder-copies dropped');
  const kept = new Set(readMilestoneSignals(db, 'M1').map((l) => l.ref_id));
  assert.ok(kept.has('C'), 'the distinct email is kept');
  assert.equal(kept.size, 2, 'exactly one copy of the duplicated email remains');
});

// ---------------------------------------------------------------------------
// Native workload comms-assignment helpers (migration 023).
// ---------------------------------------------------------------------------

test('addWorkloadSignal inserts a native workload row; listWorkloadSignals reads it back in native grain', () => {
  const db = makeDb();
  const res = addWorkloadSignal(db, {
    workloadId: 7,
    signalType: 'email',
    nativeId: 'MSG-1',
    signalTitle: 'Renewal thread',
    signalDate: '2026-02-01',
    tpid: '111',
    milestoneId: 'M1',
    opportunityId: 'OPP-1',
    source: 'manual',
    rationale: 'customer asked about renewal',
  });
  assert.equal(res.changes, 1);
  assert.equal(res.signalId, 'email:MSG-1', 'stored id is encoded');

  const stored = db.prepare(`SELECT signal_id, target_type, target_id FROM signal_links`).get();
  assert.equal(stored.signal_id, 'email:MSG-1', 'stored id is encoded');
  assert.equal(stored.target_type, 'workload');
  assert.equal(stored.target_id, '7');

  const items = listWorkloadSignals(db, 7);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: items[0].id,
    signal_type: 'email',
    signal_id: 'MSG-1', // decoded native id
    signal_title: 'Renewal thread',
    signal_date: '2026-02-01',
    assignment_source: 'manual',
    rationale: 'customer asked about renewal',
    milestone_id: 'M1',
    opportunity_id: 'OPP-1',
  });
});

test('addWorkloadSignal is idempotent per (signal, workload) and does NOT overwrite the qualifier on repeat', () => {
  const db = makeDb();
  addWorkloadSignal(db, { workloadId: 7, signalType: 'chat', nativeId: '19:t@x', milestoneId: 'M1' });

  const again = addWorkloadSignal(db, { workloadId: 7, signalType: 'chat', nativeId: '19:t@x', milestoneId: 'M2' });
  assert.equal(again.changes, 0, 'repeat assign is a no-op');

  const items = listWorkloadSignals(db, 7);
  assert.equal(items.length, 1, 'still exactly one link');
  assert.equal(items[0].milestone_id, 'M1', 'qualifier not overwritten by the repeat assign');

  addWorkloadSignal(db, { workloadId: 8, signalType: 'chat', nativeId: '19:t@x' });
  assert.equal(listWorkloadSignals(db, 8).length, 1);
  assert.equal(listWorkloadSignals(db, 7).length, 1, 'workload 7 unaffected');
});

test('updateWorkloadSignalMilestone re-tags the qualifier in place', () => {
  const db = makeDb();
  addWorkloadSignal(db, { workloadId: 7, signalType: 'email', nativeId: 'E1', milestoneId: 'M1', opportunityId: 'OPP-1' });
  const id = listWorkloadSignals(db, 7)[0].id;

  const res = updateWorkloadSignalMilestone(db, { id, milestoneId: 'M2', opportunityId: 'OPP-2' });
  assert.equal(res.changes, 1);
  const row = listWorkloadSignals(db, 7)[0];
  assert.equal(row.milestone_id, 'M2');
  assert.equal(row.opportunity_id, 'OPP-2');

  updateWorkloadSignalMilestone(db, { id, milestoneId: null, opportunityId: null });
  const cleared = listWorkloadSignals(db, 7)[0];
  assert.equal(cleared.milestone_id, null);
  assert.equal(cleared.opportunity_id, null);
});

test('removeWorkloadSignal deletes by id and does NOT suppress a later re-assign', () => {
  const db = makeDb();
  addWorkloadSignal(db, { workloadId: 7, signalType: 'email', nativeId: 'E1' });
  const id = listWorkloadSignals(db, 7)[0].id;

  const del = removeWorkloadSignal(db, { id });
  assert.equal(del.changes, 1);
  assert.equal(listWorkloadSignals(db, 7).length, 0);

  const readd = addWorkloadSignal(db, { workloadId: 7, signalType: 'email', nativeId: 'E1' });
  assert.equal(readd.changes, 1, 'delete did not suppress a future suggestion');
  assert.equal(listWorkloadSignals(db, 7).length, 1);
});

test('workload helpers fail loud on bad input', () => {
  const db = makeDb();
  assert.throws(() => listWorkloadSignals(db, '  '), /workloadId is required/);
  assert.throws(() => addWorkloadSignal(db, { signalType: 'email', nativeId: 'E1' }), /workloadId is required/);
  assert.throws(() => addWorkloadSignal(db, { workloadId: 7, signalType: 'sms', nativeId: 'E1' }));
  assert.throws(() => updateWorkloadSignalMilestone(db, { milestoneId: 'M1' }), /assignment id is required/);
  assert.throws(() => removeWorkloadSignal(db, {}), /assignment id is required/);
});
