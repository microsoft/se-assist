'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const customerTasks = require('../customer-tasks');
const meetingTasks = require('../meeting-tasks');
const agents = require('../agents');
const prompts = require('../agents/prompts');

const migration = name => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');
const transcript = 'Ada: I will schedule the review. Bob: I will send the deck by October 9.';
const actions = [
  { title: 'Schedule the review', description: 'Include the architecture team.', owner: 'Ada', dueDate: null },
  { title: 'Send the deck', description: '', owner: 'Bob', dueDate: '2026-10-09' },
];
const modelRecap = (todos = actions) => ({
  summary: 'The team agreed on the next review and follow-up materials.',
  keyPoints: ['The design is ready for review.'], decisions: [], todos, risks: [],
});

function makeDb(t, { migrate = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(migration('001_customer_workspace_cache.sql'));
  raw.exec(`
    CREATE TABLE customers (tpid TEXT, name TEXT, parent_crm_account_id TEXT);
    CREATE TABLE workloads (
      id INTEGER PRIMARY KEY, title TEXT, name TEXT, account_name TEXT, customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE meetings (
      event_id TEXT PRIMARY KEY, subject TEXT, start_at TEXT, is_online_meeting INTEGER,
      online_meeting_url TEXT
    );
    CREATE TABLE meeting_customer_links (event_id TEXT, tpid TEXT, match_method TEXT NOT NULL DEFAULT 'manual');
    CREATE TABLE cached_customer_teams_refs (id TEXT, profile_id TEXT, deleted_at TEXT, created_at TEXT);
    INSERT INTO customers VALUES ('1001', 'Contoso', NULL), ('2002', 'Fabrikam', NULL);
    INSERT INTO cached_customer_profiles (id, tpid, display_name, updated_at)
      VALUES ('p1', '1001', 'Contoso', '2026-10-01'), ('p2', '2002', 'Fabrikam', '2026-10-01');
    INSERT INTO workloads (id, title, name, account_name) VALUES (1, 'Architecture review', 'Architecture review', 'Contoso');
    INSERT INTO workloads (id, title, name, account_name, status) VALUES (2, 'Migration', 'Migration', 'Fabrikam', 'delivered');
    INSERT INTO meetings (event_id, subject, start_at, is_online_meeting)
      VALUES ('m1', 'Architecture planning', '2026-10-01T09:00:00Z', 1), ('m2', 'Another meeting', '2026-10-02T09:00:00Z', 1);
    INSERT INTO meeting_customer_links (event_id, tpid) VALUES ('m1', '1001');
  `);
  raw.exec(migration('026_meeting_notes.sql'));
  raw.exec('PRAGMA user_version = 28');
  // These focused fixtures contain only active accounts. Archive behavior is
  // exercised against the production schema in active-roster.test.js.
  raw.exec("CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY); INSERT INTO tpid_config VALUES('1001'),('2002')");
  for (const table of ['customers', 'workloads', 'meetings', 'meeting_customer_links', 'cached_customer_profiles', 'cached_customer_todos', 'cached_customer_assets', 'cached_customer_timeline_events', 'cached_customer_transcripts', 'cached_customer_email_refs', 'cached_customer_meeting_refs', 'cached_customer_teams_refs']) {
    raw.exec(`CREATE VIEW active_${table} AS SELECT * FROM ${table}`);
  }
  if (migrate) raw.exec(`BEGIN; ${migration('029_meeting_tasks.sql')} COMMIT;`);
  let depth = 0;
  return {
    prepare: sql => raw.prepare(sql),
    exec: sql => raw.exec(sql),
    transaction(fn) {
      return (...args) => {
        const outer = depth === 0;
        const savepoint = `meeting_test_${depth++}`;
        raw.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        try {
          const result = fn(...args);
          raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        } finally {
          depth--;
        }
      };
    },
  };
}

function saveRecap(db, todos = actions, eventId = 'm1', input = transcript) {
  const recap = meetingTasks.parseTranscriptSummary(JSON.stringify(modelRecap(todos)));
  const previous = db.prepare('SELECT * FROM meeting_notes WHERE event_id = ?').get(eventId);
  meetingTasks.saveSummary(db, eventId, input, recap, previous);
  return recap;
}

const taskCount = db => db.prepare('SELECT COUNT(*) AS n FROM cached_customer_todos').get().n;

test('migration 029 preserves old Tasks and notes, and adds nullable indexed associations', t => {
  const db = makeDb(t, { migrate: false });
  db.exec(`
    INSERT INTO cached_customer_todos (id, profile_id, title, updated_at) VALUES ('old', 'p1', 'Existing task', '2026-10-01');
    INSERT INTO meeting_notes (event_id, personal_notes, summary) VALUES ('m1', 'Private note', 'Old recap');
    BEGIN;
  `);
  db.exec(migration('029_meeting_tasks.sql'));
  db.exec('COMMIT');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 29);
  const todo = customerTasks.getTask(db, 'old');
  assert.equal(todo.title, 'Existing task');
  assert.equal(todo.workloadId, null);
  assert.equal(todo.meetingEventId, null);
  const notes = db.prepare("SELECT * FROM meeting_notes WHERE event_id = 'm1'").get();
  assert.equal(notes.personal_notes, 'Private note');
  assert.equal(notes.summary, 'Old recap');
  assert.equal(notes.summary_actions_json, null);
  assert.ok(db.prepare("PRAGMA index_list('cached_customer_todos')").all().some(index => index.name === 'idx_cached_todos_meeting_action' && index.unique === 1));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('Tasks support independent nullable customer/workload and preserve omitted fields on update', t => {
  const db = makeDb(t);
  let task = customerTasks.saveTask(db, { title: 'Local follow-up', workloadId: '1' });
  assert.equal(task.profileId, null);
  assert.equal(task.workloadId, 1);
  assert.equal(task.workloadName, 'Architecture review');
  task = customerTasks.saveTask(db, { id: task.id, profileId: 'p2', description: 'Keep context', dueAt: '2026-10-10' });
  assert.equal(task.customerName, 'Fabrikam');
  assert.equal(task.workloadId, 1, 'Changing customer must not silently replace the workload.');
  task = customerTasks.saveTask(db, { id: task.id, status: 'done' });
  assert.equal(task.description, 'Keep context');
  assert.equal(task.dueAt, '2026-10-10');
  assert.equal(task.profileId, 'p2');
  assert.equal(task.workloadId, 1);
  assert.equal(task.version, 3);
  assert.equal(customerTasks.listTasks(db, { workloadId: 1 })[0].id, task.id);
  task = customerTasks.saveTask(db, { id: task.id, profileId: null, workloadId: null });
  assert.equal(task.profileId, null);
  assert.equal(task.workloadId, null);
  assert.equal(task.workloadName, null);
});

test('deleting a workload clears its association without deleting the Task', t => {
  const db = makeDb(t);
  const task = customerTasks.saveTask(db, { title: 'Keep me', profileId: 'p1', workloadId: 1 });
  db.prepare('DELETE FROM workloads WHERE id = ?').run(1);
  const kept = customerTasks.getTask(db, task.id);
  assert.equal(kept.workloadId, null);
  assert.equal(kept.profileId, 'p1');
  assert.equal(taskCount(db), 1);
});

test('invalid assignments, empty titles and unknown IDs fail without creating or changing Tasks', t => {
  const db = makeDb(t);
  for (const payload of [
    { title: '' }, { title: 'x', profileId: 'missing' }, { title: 'x', workloadId: 999 },
    { title: 'x', workloadId: 'oops' }, { title: 'x', status: 'not-a-status' }, { id: 'missing', title: 'x' },
  ]) assert.throws(() => customerTasks.saveTask(db, payload));
  assert.equal(taskCount(db), 0);
  const task = customerTasks.saveTask(db, { title: 'Keep title', workloadId: 1 });
  assert.throws(() => customerTasks.saveTask(db, { id: task.id, workloadId: 7 }), /selected workload/);
  assert.equal(customerTasks.getTask(db, task.id).workloadId, 1);
  assert.throws(() => customerTasks.deleteTask(db, { id: task.id, profileId: 'p1' }), /customer has changed/);
  customerTasks.deleteTask(db, { id: task.id });
  assert.throws(() => customerTasks.saveTask(db, { id: task.id, title: 'Resurrect' }), /deleted/);
  assert.throws(() => customerTasks.getTask(db, task.id), /deleted/);
  assert.deepEqual(customerTasks.listTasks(db, { workloadId: 1 }), []);
});

test('assignment options resolve placeholder customer names and include non-active workloads explicitly', t => {
  const db = makeDb(t);
  db.exec("UPDATE cached_customer_profiles SET display_name = 'TPID 1001' WHERE id = 'p1'");
  const options = customerTasks.getAssignmentOptions(db);
  assert.equal(options.customers.find(customer => customer.id === 'p1').displayName, 'Contoso');
  assert.deepEqual(options.workloads.map(workload => workload.status), ['active', 'delivered']);
  db.exec("UPDATE cached_customer_profiles SET deleted_at = '2026-10-02' WHERE id = 'p2'");
  assert.equal(customerTasks.getAssignmentOptions(db).customers.length, 1);
});

test('recaps have a concise to-do section from the same validated items used for Tasks', () => {
  const result = meetingTasks.parseTranscriptSummary(JSON.stringify(modelRecap()));
  assert.deepEqual(result.actionItems, actions);
  assert.match(result.summary, /To-do items:\n- Schedule the review: Include the architecture team.; Owner: Ada/);
  assert.match(result.summary, /Send the deck; Owner: Bob; Due: 2026-10-09/);
  assert.match(result.summary, /Decisions:\n- None recorded/);
  const empty = meetingTasks.parseTranscriptSummary(JSON.stringify(modelRecap([])));
  assert.deepEqual(empty.actionItems, []);
  assert.match(empty.summary, /To-do items:\n- None recorded/);
});

test('malformed and incomplete recaps fail instead of guessing or making placeholder Tasks', () => {
  for (const content of ['not JSON', '```json\n{}\n```', 'null', '[]', '{}',
    JSON.stringify({ ...modelRecap(), todos: null }),
    JSON.stringify({ ...modelRecap(), keyPoints: [''] }),
    JSON.stringify(modelRecap([{ title: ' ', owner: null, dueDate: null }])),
    JSON.stringify(modelRecap([{ title: 'x'.repeat(241) }])),
    JSON.stringify(modelRecap([{ title: 'Follow up', dueDate: '2026-02-30' }])),
    JSON.stringify(modelRecap([{ title: 'Follow up', dueDate: 'tomorrow' }])),
  ]) assert.throws(() => meetingTasks.parseTranscriptSummary(content));
});

test('matching normalized actions are deduplicated but distinct owners are retained', () => {
  const result = meetingTasks.parseTranscriptSummary(JSON.stringify(modelRecap([
    actions[0], { ...actions[0], title: 'SCHEDULE the review!', owner: 'ada' }, { ...actions[0], owner: 'Bob' },
  ])));
  assert.equal(result.actionItems.length, 2);
});

test('summary persistence preserves full transcript text, prep and personal notes and supports exact retry reuse', t => {
  const db = makeDb(t);
  db.exec("INSERT INTO meeting_notes (event_id, preparation_notes, personal_notes) VALUES ('m1', 'Prep', 'Personal')");
  const rawTranscript = `  ${transcript}\n`;
  const recap = saveRecap(db, actions, 'm1', rawTranscript);
  const notes = db.prepare("SELECT * FROM meeting_notes WHERE event_id = 'm1'").get();
  assert.equal(notes.transcript, rawTranscript);
  assert.equal(notes.preparation_notes, 'Prep');
  assert.equal(notes.personal_notes, 'Personal');
  assert.deepEqual(meetingTasks.getReusableSummary(notes, transcript), recap);
  assert.equal(meetingTasks.getReusableSummary(notes, 'Changed transcript'), null);
  assert.equal(taskCount(db), 0, 'Saving a recap must not silently skip the explicit Task creation stage.');
});

test('concurrent transcript or summary edits are not overwritten by a late AI result', t => {
  const db = makeDb(t);
  saveRecap(db);
  const previous = db.prepare("SELECT * FROM meeting_notes WHERE event_id = 'm1'").get();
  db.exec("UPDATE meeting_notes SET summary = 'My newer summary' WHERE event_id = 'm1'");
  assert.throws(() => meetingTasks.saveSummary(db, 'm1', transcript, { summary: 'Stale recap', actionItems: actions }, previous), /notes changed/);
  assert.equal(db.prepare("SELECT summary FROM meeting_notes WHERE event_id = 'm1'").get().summary, 'My newer summary');
});

test('new meeting Tasks use the single tagged real customer and no workload', t => {
  const db = makeDb(t);
  db.exec("DELETE FROM cached_customer_profiles WHERE id = 'p1'");
  saveRecap(db);
  const result = meetingTasks.createMeetingTasks(db, 'm1');
  assert.equal(result.createdCount, 2);
  assert.equal(result.tasks.length, 2);
  for (const task of result.tasks) {
    assert.equal(task.customerTpid, '1001');
    assert.equal(task.customerName, 'Contoso');
    assert.equal(task.workloadId, null);
    assert.equal(task.meetingEventId, 'm1');
    assert.equal(task.sourceRef, 'meeting:m1');
  }
  const deck = result.tasks.find(task => task.title === 'Send the deck');
  assert.equal(deck.dueAt, '2026-10-09');
  assert.equal(deck.description, 'Owner: Bob');
  assert.equal(customerTasks.listTasks(db, { profileId: deck.profileId }).length, 2);
});

for (const kind of ['untagged', 'multiple', 'rejected']) {
  test(`${kind} meeting customer context leaves new Tasks explicitly Unselected`, t => {
    const db = makeDb(t);
    if (kind === 'untagged') db.exec('DELETE FROM meeting_customer_links');
    if (kind === 'multiple') db.exec("INSERT INTO meeting_customer_links (event_id, tpid) VALUES ('m1', '2002')");
    if (kind === 'rejected') db.exec("UPDATE meeting_customer_links SET match_method = 'ai-rejected'");
    saveRecap(db);
    const result = meetingTasks.createMeetingTasks(db, 'm1');
    assert.ok(result.tasks.every(task => task.profileId === null));
    assert.match(result.customerNote, /Unselected/);
  });
}

test('repeated creation preserves user edits, assignments, completion and deletion without duplicates', t => {
  const db = makeDb(t);
  saveRecap(db);
  const first = meetingTasks.createMeetingTasks(db, 'm1');
  const kept = customerTasks.saveTask(db, {
    id: first.tasks[0].id, title: 'User title', profileId: 'p2', workloadId: 1, status: 'done',
  });
  customerTasks.deleteTask(db, { id: first.tasks[1].id });
  const retry = meetingTasks.createMeetingTasks(db, 'm1');
  assert.equal(retry.createdCount, 0);
  assert.equal(retry.existingCount, 1);
  assert.equal(retry.deletedCount, 1);
  assert.deepEqual(retry.tasks, [kept]);
  assert.equal(taskCount(db), 2);
  saveRecap(db, [{ ...actions[0], title: 'SCHEDULE the review!' }, actions[1], { title: 'Share the minutes' }]);
  const updated = meetingTasks.createMeetingTasks(db, 'm1');
  assert.equal(updated.createdCount, 1);
  assert.equal(taskCount(db), 3);
});

test('same actions in a different meeting are not suppressed', t => {
  const db = makeDb(t);
  saveRecap(db);
  saveRecap(db, actions, 'm2');
  meetingTasks.createMeetingTasks(db, 'm1');
  assert.equal(meetingTasks.createMeetingTasks(db, 'm2').createdCount, 2);
  assert.equal(taskCount(db), 4);
});

test('an empty to-do list is a successful no-op, not a placeholder Task or customer', t => {
  const db = makeDb(t);
  db.exec('DELETE FROM cached_customer_profiles');
  saveRecap(db, []);
  const result = meetingTasks.createMeetingTasks(db, 'm1');
  assert.equal(result.actionItemCount, 0);
  assert.equal(result.createdCount, 0);
  assert.equal(taskCount(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cached_customer_profiles').get().n, 0);
});

test('Task creation is all-or-nothing, including automatic customer profile creation', t => {
  const db = makeDb(t);
  db.exec(`
    DELETE FROM cached_customer_profiles;
    CREATE TRIGGER fail_second_task BEFORE INSERT ON cached_customer_todos
      WHEN NEW.title = 'Send the deck' BEGIN SELECT RAISE(ABORT, 'Simulated disk failure'); END;
  `);
  saveRecap(db);
  assert.throws(() => meetingTasks.createMeetingTasks(db, 'm1'), /Simulated disk failure/);
  assert.equal(taskCount(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cached_customer_profiles').get().n, 0);
  assert.ok(db.prepare("SELECT summary FROM meeting_notes WHERE event_id = 'm1'").get().summary);
  db.exec('DROP TRIGGER fail_second_task');
  assert.equal(meetingTasks.createMeetingTasks(db, 'm1').createdCount, 2);
});

test('missing or changed transcripts and invalid saved actions fail without creating Tasks', t => {
  const db = makeDb(t);
  assert.throws(() => meetingTasks.createMeetingTasks(db, 'missing'), /Meeting not found/);
  assert.throws(() => meetingTasks.createMeetingTasks(db, 'm1'), /Generate a summary/);
  saveRecap(db);
  db.exec("UPDATE meeting_notes SET transcript = 'New content' WHERE event_id = 'm1'");
  assert.equal(meetingTasks.getMeetingTasks(db, 'm1').canCreateTasks, false);
  assert.throws(() => meetingTasks.createMeetingTasks(db, 'm1'), /summarized again/);
  db.exec("UPDATE meeting_notes SET summary_actions_json = 'broken' WHERE event_id = 'm1'");
  assert.throws(() => meetingTasks.createMeetingTasks(db, 'm1'), /Saved meeting to-do items are invalid/);
  assert.equal(taskCount(db), 0);
});

function ipcHarness(t, {
  signedIn = true,
  probeError,
  content,
  finishReason = 'stop',
  onModel,
  env = {},
  fetchImpl,
} = {}) {
  const db = makeDb(t);
  const handlers = new Map();
  const calls = [];
  const appIpcPath = path.join(__dirname, '..', '..', 'app-ipc.js');
  const stubs = {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { isPackaged: false } },
    './sqlite-ipc': { openDb: () => db },
    './account-roster': require('../../account-roster'),
    './services/github-auth': { isSignedIn: () => signedIn },
    './services/copilot-provider': {
      probe: async () => probeError ? { ok: false, error: probeError } : { ok: true }, getModelName: () => 'test-model',
      chat: async (system, user, options) => {
        calls.push({ system, user, options });
        if (onModel) await onModel(db);
        return { content: content ?? JSON.stringify(modelRecap()), finishReason, model: 'test-model' };
      },
    },
    './services/model-request-scheduler': require('../model-request-scheduler'),
    './services/agents': agents,
    './services/agents/prompts': prompts,
    './services/customer-tasks': customerTasks,
    './services/meeting-tasks': meetingTasks,
    './services/row-mappers': require('../row-mappers'),
    './services/workiq-client': { getWorkIqClient: () => ({}) },
    './services/meeting-transcript': { fetchTranscript: async (_client, meeting) => {
      assert.equal(meeting.event_id, 'm1');
      return { ok: true, hasTranscript: true, transcript, speakers: ['Ada', 'Bob'] };
    } },
  };
  const unused = new Set([
    './msx-ipc', './acr-ipc', './capacity-ipc', './services/app-prefs', './services/owned-accounts',
    './services/m365-ingest', './services/outlook-link', './services/workiq-auth', './services/teams-chat-message',
    './services/work-agent-tools', './services/work-outputs', './services/secretary-scan', './services/email-search', './services/research-dossier',
    './services/signal-links', './services/workload-suggestion-dedup', './services/workload-concept-key',
    './services/customer-insights', './services/customer-relationship-graph', './services/html-render',
    './services/safe-json', './services/intelligence',
    './services/stakeholder-influence', './services/stakeholder-influence-store',
  ]);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(appIpcPath, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(appIpcPath),
    require: name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (unused.has(name)) return Object.freeze({});
      if (isBuiltin(name)) return require(name);
      throw new Error(`Unexpected meeting IPC test dependency: ${name}`);
    },
    process: { env, platform: process.platform, resourcesPath: path.dirname(appIpcPath) },
    URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    console: { ...console, log: () => {} },
  }, { filename: appIpcPath });
  module.exports.registerAppIpc();
  return {
    db, calls,
    invoke: (channel, payload, url = 'http://localhost:5173') => handlers.get(channel)({ senderFrame: { url } }, payload),
  };
}

test('actual meeting IPC completes fetch, structured summary, Task creation and workload editing', async t => {
  const client = ipcHarness(t);
  const fetched = await client.invoke('se-meeting-fetch-transcript', { eventId: 'm1' });
  await client.invoke('se-meeting-notes-save', { eventId: 'm1', patch: { transcript: fetched.transcript, personal_notes: 'Keep this' } });
  const recap = await client.invoke('se-meeting-summarize-transcript', { eventId: 'm1' });
  assert.equal(recap.ok, true);
  assert.equal(recap.actionItems.length, 2);
  assert.equal(taskCount(client.db), 0);
  assert.equal(client.calls[0].options.maxTokens, 4000);
  assert.match(client.calls[0].user, /Meeting date: 2026-10-01/);
  const created = await client.invoke('se-meeting-tasks-create', { eventId: 'm1' });
  assert.equal(created.createdCount, 2);
  const saved = await client.invoke('se-workspace-save-todo', { id: created.tasks[0].id, workloadId: 1 });
  assert.equal(saved.todo.workloadId, 1);
  assert.equal(saved.todos.length, 2);
  const repeated = await client.invoke('se-meeting-summarize-transcript', { eventId: 'm1' });
  assert.equal(repeated.meta.reused, true);
  assert.equal(client.calls.length, 1, 'An unchanged transcript must not rerun the AI and paraphrase the action keys.');
  assert.equal((await client.invoke('se-meeting-tasks-create', { eventId: 'm1' })).createdCount, 0);
  assert.equal((await client.invoke('se-meeting-notes-get', { eventId: 'm1' })).notes.personal_notes, 'Keep this');
  assert.equal((await client.invoke('se-task-assignment-options')).workloads.length, 2);
});

test('actual Task IPC supports unassigned Tasks and completion without clearing workload or origin', async t => {
  const client = ipcHarness(t);
  const result = await client.invoke('se-workspace-save-todo', { title: 'Unassigned', workloadId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.todo.profileId, null);
  const done = await client.invoke('se-workspace-save-todo', { id: result.todo.id, status: 'done' });
  assert.equal(done.todo.workloadId, 1);
  assert.equal(done.todo.status, 'done');
  const deleted = await client.invoke('se-workspace-delete-todo', { id: result.todo.id });
  assert.equal(deleted.ok, true);
});

test('actual summary IPC fails clearly without a provider; persisted Task creation still works offline', async t => {
  const client = ipcHarness(t, { signedIn: false });
  await assert.rejects(client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript }), /No AI model provider is configured/);
  assert.equal(client.calls.length, 0);
  assert.equal(taskCount(client.db), 0);
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM meeting_notes').get().n, 0);
  saveRecap(client.db);
  assert.equal((await client.invoke('se-meeting-tasks-create', { eventId: 'm1' })).createdCount, 2);
});

test('a connected but unavailable Copilot provider never silently switches to configured Foundry', async t => {
  let foundryCalls = 0;
  const client = ipcHarness(t, {
    probeError: 'Copilot entitlement expired',
    env: {
      AI_FOUNDRY_ENDPOINT: 'https://example.openai.azure.com',
      AI_FOUNDRY_DEPLOYMENT: 'fallback-deployment',
      AI_FOUNDRY_API_KEY: 'test-key',
    },
    fetchImpl: async () => {
      foundryCalls += 1;
      throw new Error('Foundry must not be called');
    },
  });
  await assert.rejects(
    client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript }),
    /GitHub Copilot is unavailable: Copilot entitlement expired/,
  );
  assert.equal(foundryCalls, 0);
  assert.equal(client.calls.length, 0);
});

test('Foundry requests use the shared scheduler and coalesce identical in-flight summaries', async t => {
  const scheduler = require('../model-request-scheduler').modelRequestScheduler;
  scheduler.resetForTests({ minIntervalMs: 0 });
  t.after(() => scheduler.resetForTests({ minIntervalMs: 750 }));
  let foundryCalls = 0;
  let release;
  const client = ipcHarness(t, {
    signedIn: false,
    env: {
      AI_FOUNDRY_ENDPOINT: 'https://example.openai.azure.com',
      AI_FOUNDRY_DEPLOYMENT: 'summary-deployment',
      AI_FOUNDRY_API_KEY: 'test-key',
    },
    fetchImpl: async () => {
      foundryCalls += 1;
      await new Promise(resolve => { release = resolve; });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          choices: [{ message: { content: JSON.stringify(modelRecap()) }, finish_reason: 'stop' }],
          usage: { total_tokens: 100 },
        }),
      };
    },
  });
  const first = client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript });
  const second = client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(foundryCalls, 1);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Meeting notes changed/);
  assert.equal(foundryCalls, 1);
  assert.equal(scheduler.snapshot().coalesced, 1);
});

for (const failure of [{ content: 'invalid JSON' }, { finishReason: 'length' }, { finishReason: 'content_filter' }, { content: JSON.stringify({ summary: 'Missing actions' }) }]) {
  test(`actual summary IPC rejects ${failure.finishReason || failure.content} without writes`, async t => {
    const client = ipcHarness(t, failure);
    client.db.exec("INSERT INTO meeting_notes (event_id, summary) VALUES ('m1', 'Keep old summary')");
    await assert.rejects(client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript }), /Transcript summarization failed/);
    assert.equal(client.db.prepare("SELECT summary FROM meeting_notes WHERE event_id = 'm1'").get().summary, 'Keep old summary');
    assert.equal(taskCount(client.db), 0);
  });
}

test('explicit empty transcripts never fall back to stored text; clipping is disclosed and full text is saved', async t => {
  const client = ipcHarness(t);
  saveRecap(client.db);
  const empty = await client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no_transcript');
  assert.equal(client.calls.length, 0);
  const long = `${'x'.repeat(48000)}TAIL_NOT_FOR_MODEL`;
  const result = await client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript: long });
  assert.equal(result.meta.clipped, true);
  assert.doesNotMatch(client.calls[0].user, /TAIL_NOT_FOR_MODEL/);
  assert.equal(client.db.prepare("SELECT transcript FROM meeting_notes WHERE event_id = 'm1'").get().transcript, long);
});

test('actual notes IPC invalidates edited transcript/summary actions, but not identical saves or personal notes', async t => {
  const client = ipcHarness(t);
  const recap = saveRecap(client.db);
  await client.invoke('se-meeting-notes-save', { eventId: 'm1', patch: { summary: recap.summary, personal_notes: 'My notes' } });
  assert.equal((await client.invoke('se-meeting-tasks-get', { eventId: 'm1' })).canCreateTasks, true);
  await client.invoke('se-meeting-notes-save', { eventId: 'm1', patch: { summary: 'An edited summary' } });
  assert.equal((await client.invoke('se-meeting-tasks-get', { eventId: 'm1' })).canCreateTasks, false);
  assert.throws(() => client.invoke('se-meeting-tasks-create', { eventId: 'm1' }), /summarized again/);
  assert.equal(taskCount(client.db), 0);
});

test('actual summary IPC preserves concurrent user edits and propagates persistence failures', async t => {
  const client = ipcHarness(t, { onModel: async db => {
    db.exec("UPDATE meeting_notes SET transcript = 'Edited during AI generation' WHERE event_id = 'm1'");
  } });
  client.db.prepare("INSERT INTO meeting_notes (event_id, transcript) VALUES ('m1', ?)").run(transcript);
  await assert.rejects(client.invoke('se-meeting-summarize-transcript', { eventId: 'm1' }), /notes changed/);
  assert.equal(client.db.prepare("SELECT transcript FROM meeting_notes WHERE event_id = 'm1'").get().transcript, 'Edited during AI generation');
  const failing = ipcHarness(t);
  failing.db.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON meeting_notes BEGIN SELECT RAISE(ABORT, 'Disk full'); END;");
  await assert.rejects(failing.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript }), /Disk full/);
  assert.equal(taskCount(failing.db), 0);
});

test('all new Task IPC handlers retain trusted-renderer enforcement', async t => {
  const client = ipcHarness(t);
  for (const channel of ['se-task-assignment-options', 'se-meeting-tasks-get', 'se-meeting-tasks-create', 'se-workspace-save-todo']) {
    const result = await client.invoke(channel, { eventId: 'm1', title: 'Must not save' }, 'https://untrusted.example');
    assert.equal(result.ok, false);
    assert.match(result.error, /Unauthorized/);
  }
  assert.equal(taskCount(client.db), 0);
  assert.equal(client.calls.length, 0);
});

test('renderer Task payloads cannot replace meeting provenance or action identity', t => {
  const db = makeDb(t);
  saveRecap(db);
  const task = meetingTasks.createMeetingTasks(db, 'm1').tasks[0];
  const original = db.prepare('SELECT meeting_action_key FROM cached_customer_todos WHERE id = ?').get(task.id);
  const updated = customerTasks.saveTask(db, {
    id: task.id, meetingEventId: 'm2', meetingActionKey: 'forged', workloadId: 1,
  });
  assert.equal(updated.meetingEventId, 'm1');
  assert.equal(db.prepare('SELECT meeting_action_key FROM cached_customer_todos WHERE id = ?').get(task.id).meeting_action_key, original.meeting_action_key);
});

test('cached summary reuse preserves newly supplied whitespace and its retryable actions', async t => {
  const client = ipcHarness(t);
  saveRecap(client.db);
  const updatedTranscript = `  ${transcript}\n`;
  const recap = await client.invoke('se-meeting-summarize-transcript', { eventId: 'm1', transcript: updatedTranscript });
  assert.equal(recap.meta.reused, true);
  assert.equal(client.calls.length, 0);
  assert.equal(client.db.prepare("SELECT transcript FROM meeting_notes WHERE event_id = 'm1'").get().transcript, updatedTranscript);
  assert.equal((await client.invoke('se-meeting-tasks-create', { eventId: 'm1' })).createdCount, 2);
});

test('Task IPC rolls back writes if it cannot return the updated customer workspace', async t => {
  const client = ipcHarness(t);
  const task = customerTasks.saveTask(client.db, { profileId: 'p1', title: 'Original' });
  client.db.exec('DROP TABLE cached_customer_assets');
  assert.throws(() => client.invoke('se-workspace-save-todo', { id: task.id, title: 'Must roll back' }), /cached_customer_assets/);
  assert.equal(customerTasks.getTask(client.db, task.id).title, 'Original');
  assert.throws(() => client.invoke('se-workspace-delete-todo', { id: task.id }), /cached_customer_assets/);
  assert.equal(customerTasks.getTask(client.db, task.id).deletedAt, null);
});
