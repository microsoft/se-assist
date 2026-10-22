'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRosterDb } = require('./helpers/roster-db');
const { saveRoster, getEffectiveTpids, normalizeTpids, assertActiveTpid, assertActiveSource, createAccountScope, withRosterWork, runActiveWrite } = require('../../account-roster');
const { createWorkload } = require('../workload-orchestration');
const { saveTask, listTasks } = require('../customer-tasks');
const { createWorkOutputs } = require('../work-outputs');
const { scanSecretaryInbox } = require('../secretary-scan');
const { searchEmails, readEmail } = require('../email-search');
const { createWorkAgentTools } = require('../work-agent-tools');
const signalLinks = require('../signal-links');

function seed(db) {
  const insert = db.prepare('INSERT INTO customers(name,tpid,crm_account_id) VALUES(?,?,?)');
  for (let i = 0; i < 260; i++) insert.run(i < 17 ? `FSI ${i}` : `EDU ${i}`, String(1000 + i), `account-${i}`);
  db.exec(`
    INSERT INTO opportunities(opportunity_id,parent_account_id,name) VALUES ('opp-fsi','account-0','Current'),('opp-edu','account-17','Past');
    INSERT INTO milestones(milestone_id,opportunity_id,name) VALUES ('ms-fsi','opp-fsi','Current'),('ms-edu','opp-edu','Historical');
    INSERT INTO hok_tasks(activity_id,regarding_id) VALUES ('hok-fsi','ms-fsi'),('hok-edu','ms-edu');
    INSERT INTO cached_customer_profiles(id,tpid,display_name,updated_at)
      VALUES ('profile-fsi','1000','FSI 0','2026-10-01'),('profile-edu','1017','EDU 17','2026-10-01');
    INSERT INTO workloads(id,title,name,tpid,customer_tpid) VALUES (1,'Current work','Current work','1000','1000'),(2,'Past work','Past work','1017','1017');
    INSERT INTO workloads(id,title,name,kind) VALUES (3,'Internal work','Internal work','internal');
    INSERT INTO cached_customer_todos(id,profile_id,title,updated_at) VALUES ('task-fsi','profile-fsi','Current task','2026-10-01'),('task-edu','profile-edu','Past task','2026-10-01');
    INSERT INTO meetings(event_id,subject) VALUES ('meeting-fsi','FSI 0'),('meeting-edu','EDU 17'),('meeting-shared','Shared'),('meeting-internal','Internal');
    INSERT INTO meeting_customer_links(event_id,tpid,match_method) VALUES ('meeting-fsi','1000','manual'),('meeting-edu','1017','manual'),('meeting-shared','1000','manual'),('meeting-shared','1017','manual');
    INSERT INTO emails(message_id,subject) VALUES ('email-fsi','FSI 0'),('email-edu','EDU 17');
    INSERT INTO email_customer_links(message_id,tpid,match_method) VALUES ('email-fsi','1000','manual'),('email-edu','1017','manual');
    INSERT INTO meeting_notes(event_id,personal_notes,transcript) VALUES ('meeting-edu','Do not lose this note','Do not lose this transcript');
    INSERT INTO signal_links(signal_type,signal_id,target_type,target_id,tpid) VALUES ('meeting','meeting:meeting-edu','milestone','ms-edu','1017');
    INSERT INTO workload_suggestion_dismissals(tpid,title,description,concept_key) VALUES ('1017','Dismissed idea','Keep dismissed','test');
    INSERT INTO work_output_investigations(id,task_key,task_json,created_at,updated_at)
      VALUES ('output-edu','output-edu','{"sourceMessageId":"email-edu","account":"EDU 17"}','2026-10-01','2026-10-01');
  `);
}

test('260 cached accounts are reduced to exactly the 17 saved TPIDs without deleting history', t => {
  const db = makeRosterDb(t);
  seed(db);
  const preserved = ['customers', 'opportunities', 'milestones', 'hok_tasks', 'workloads', 'cached_customer_todos', 'meeting_notes', 'signal_links', 'workload_suggestion_dismissals', 'work_output_investigations'];
  const snapshot = () => preserved.map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  saveRoster(db, Array.from({ length: 17 }, (_, i) => String(1000 + i)));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_customers').get().n, 17);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_milestones').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_hok_tasks').get().n, 1);
  assert.deepEqual(db.prepare('SELECT id FROM active_workloads ORDER BY id').all().map(row => row.id), [1, 3]);
  assert.deepEqual(listTasks(db, { profileId: 'profile-edu' }), []);
  assert.deepEqual(db.prepare('SELECT event_id FROM active_meetings ORDER BY event_id').all().map(row => row.event_id), ['meeting-fsi', 'meeting-internal', 'meeting-shared']);
  assert.throws(() => assertActiveTpid(db, '1017'), /archived/);
  assert.throws(() => assertActiveSource(db, 'email', 'email-edu'), /archived/);
  assert.throws(() => createWorkload(db, { name: 'No new work', tpid: '1017' }), /archived/);
  assert.throws(() => saveTask(db, { title: 'No new Task', profileId: 'profile-edu' }), /customer/);
  assert.deepEqual(snapshot(), before);

  saveRoster(db, ['1000', '1017']);
  assert.equal(db.prepare("SELECT name FROM active_milestones WHERE milestone_id='ms-edu'").get().name, 'Historical');
  assert.equal(db.prepare("SELECT personal_notes FROM meeting_notes WHERE event_id='meeting-edu'").get().personal_notes, 'Do not lose this note');
  assert.equal(listTasks(db, { profileId: 'profile-edu' })[0].id, 'task-edu');
  assert.doesNotThrow(() => assertActiveSource(db, 'email', 'email-edu'));
  assert.deepEqual(snapshot(), before);

  saveRoster(db, []);
  for (const table of ['active_customers', 'active_opportunities', 'active_milestones', 'active_hok_tasks', 'active_cached_customer_profiles']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(getEffectiveTpids(db), []);
});

test('roster replacement is strict, atomic, and never falls back to cached or bundled accounts', t => {
  const db = makeRosterDb(t);
  saveRoster(db, ['1000', '1000', '2000']);
  assert.deepEqual(getEffectiveTpids(db), ['1000', '2000']);
  assert.throws(() => saveRoster(db, ['1000', 'not-a-tpid']), /Invalid TPID/);
  assert.throws(() => saveRoster(db), /Supply a TPID list/);
  assert.deepEqual(getEffectiveTpids(db), ['1000', '2000']);
  assert.throws(() => normalizeTpids(Array.from({ length: 501 }, (_, i) => String(i))), /at most 500/);
  assert.throws(() => getEffectiveTpids({ prepare() { throw new Error('Database unavailable'); } }), /Database unavailable/);
});

test('archived targets and sources cannot be revived by an active annotation or new workload assignment', t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  db.exec(`INSERT INTO signal_links(signal_type,signal_id,target_type,target_id,tpid)
    VALUES('email','email:email-fsi','account','1017','1000'),
          ('email','email:email-fsi','hok_activity','hok-edu','1000'),
          ('email','email:email-fsi','workload','1','1017')`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM active_signal_links WHERE signal_id='email:email-fsi'").get().n, 0);
  assert.throws(() => signalLinks.addWorkloadSignal(db, { workloadId: 1, signalType: 'email', nativeId: 'email-edu' }), /archived/);
  const archivedLink = db.prepare("SELECT id FROM signal_links WHERE target_type='workload' AND signal_id='email:email-fsi'").get().id;
  assert.throws(() => signalLinks.linkSignal(db, { signalType: 'email', nativeId: 'email-fsi', targetType: 'workload', targetId: 1, tpid: '1000' }), /archived/);
  assert.throws(() => signalLinks.unlinkSignal(db, { signalType: 'email', nativeId: 'email-fsi', targetType: 'workload', targetId: 1 }), /archived/);
  assert.throws(() => signalLinks.removeWorkloadSignal(db, { id: archivedLink }), /archived/);
  assert.throws(() => signalLinks.updateWorkloadSignalMilestone(db, { id: archivedLink, milestoneId: 'ms-fsi' }), /archived/);
  assert.throws(() => createWorkload(db, { name: 'Invalid archived milestone', tpid: '1000', milestones: [{ milestoneId: 'ms-edu' }] }), /archived/);
  assert.throws(() => createWorkload(db, { name: 'Invalid archived source', tpid: '1000', signals: [{ signalType: 'email', nativeId: 'email-edu' }] }), /archived/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workloads').get().n, 3);
  saveRoster(db, ['1000', '1017']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM active_signal_links WHERE signal_id='email:email-fsi'").get().n, 3);
  assert.doesNotThrow(() => signalLinks.addWorkloadSignal(db, { workloadId: 1, signalType: 'email', nativeId: 'email-edu' }));
});

test('roster changes wait for in-flight work rather than allowing work to finish on archived accounts', async t => {
  const db = makeRosterDb(t);
  saveRoster(db, ['1000']);
  let finish;
  const running = withRosterWork('test model call', () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => saveRoster(db, []), /still running/);
  assert.deepEqual(getEffectiveTpids(db), ['1000']);
  finish();
  await running;
  saveRoster(db, []);
  assert.deepEqual(getEffectiveTpids(db), []);
});

test('calendar, chat, and inbox discovery exclude recognized archived-only accounts', t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  const scope = createAccountScope(db);
  assert.equal(scope.accepts('meeting', 'meeting-edu', 'EDU 17 account review'), false);
  assert.equal(scope.accepts('meeting', 'new-event', 'EDU 17 future planning'), false);
  assert.equal(scope.accepts('meeting', 'new-event', 'FSI 0 and EDU 17 shared discussion'), true);
  assert.equal(scope.accepts('meeting', 'meeting-internal', 'Internal team meeting'), true);
});

test('stale renderer writes cannot edit, delete, or add data for archived accounts', t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  assert.throws(() => runActiveWrite(db, 'UPDATE workloads SET title=? WHERE id=?', ['Stale edit', 2]), /archived/);
  assert.throws(() => runActiveWrite(db, 'DELETE FROM customers WHERE tpid=?', ['1017']), /archived/);
  assert.throws(() => runActiveWrite(db, 'INSERT INTO customers(name,tpid) VALUES(?,?)', ['Archived account', '1017']), /archived/);
  runActiveWrite(db, 'UPDATE workloads SET title=? WHERE id=?', ['Current edit', 1]);
  assert.equal(db.prepare('SELECT title FROM workloads WHERE id=1').get().title, 'Current edit');
  assert.equal(db.prepare('SELECT title FROM workloads WHERE id=2').get().title, 'Past work');
  saveRoster(db, ['1000', '1017']);
  runActiveWrite(db, 'UPDATE workloads SET title=? WHERE id=?', ['Reactivated edit', 2]);
  assert.equal(db.prepare('SELECT title FROM workloads WHERE id=2').get().title, 'Reactivated edit');
});

test('archiving and reactivation preserve a Work Output investigation and its user-edited areas', t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000', '1017']);
  const service = createWorkOutputs({ db });
  const investigation = service.open({ title: 'My saved work', sourceMessageId: 'email-edu', account: 'EDU 17' });
  db.prepare("UPDATE work_output_areas SET focus='My edited focus' WHERE investigation_id=? AND area='situation'").run(investigation.id);
  const before = JSON.stringify(db.prepare('SELECT * FROM work_output_areas WHERE investigation_id=?').all(investigation.id));
  saveRoster(db, ['1000']);
  assert.throws(() => service.get(investigation.id), /archived/);
  assert.equal(service.list().some(subject => subject.id === investigation.id), false);
  assert.throws(() => service.remove(investigation.id), /archived/);
  saveRoster(db, ['1000', '1017']);
  const restored = service.get(investigation.id);
  assert.equal(restored.outputs.find(output => output.area === 'situation').focus, 'My edited focus');
  assert.equal(service.list().some(subject => subject.id === investigation.id), true);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM work_output_areas WHERE investigation_id=?').all(investigation.id)), before);
});

test('active workload deletion still cascades, without permitting archived replacements or child deletion', t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  db.exec("INSERT INTO workload_milestone_links(workload_id,milestone_id) VALUES(1,'ms-fsi'),(2,'ms-edu')");
  assert.throws(() => runActiveWrite(db,
    'INSERT OR REPLACE INTO workloads(id,title,name,tpid,customer_tpid) VALUES(?,?,?,?,?)',
    [2, 'Wrong replacement', 'Wrong replacement', '1000', '1000']), /archived/);
  assert.throws(() => runActiveWrite(db, 'DELETE FROM workloads WHERE id=?', [2]), /archived/);
  runActiveWrite(db, 'DELETE FROM workloads WHERE id=?', [1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workload_milestone_links WHERE workload_id=1').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workload_milestone_links WHERE workload_id=2').get().n, 1);
  assert.equal(db.prepare('SELECT title FROM workloads WHERE id=2').get().title, 'Past work');
});

test('all production active views compile against the migrated schema', t => {
  const db = makeRosterDb(t);
  assert.equal(db.pragma('user_version', { simple: true }), 36);
  for (const name of ['stakeholder_overrides', 'work_output_gaps']) {
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${name} LIMIT 1`).all());
  }
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name GLOB 'active_*'").all()) {
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${name} LIMIT 1`).all(), name);
  }
});

test('local Secretary excludes archived customer email before reading bodies or calling AI without live mailbox access', async t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  const requests = [];
  const modelInputs = [];
  db.exec(`
    UPDATE emails SET received_at='2026-10-01T09:00:00Z', body_text='Please send the follow-up.', body_source='body';
    INSERT INTO email_sync(scope_key,synced_through,last_run_at)
      VALUES('1000','2026-10-01T11:00:00Z','2026-10-01T11:00:00Z'),
            ('1017','2026-10-01T11:00:00Z','unreadable archived pull time');
  `);
  const scan = () => scanSecretaryInbox({
    db, now: new Date('2026-10-01T12:00:00Z'), userName: 'Test user', parseJson: JSON.parse,
    ensureConnected: async () => { requests.push('connect'); throw new Error('Secretary must use stored email only.'); },
    client: { readTool: async () => { requests.push('read'); throw new Error('Secretary must use stored email only.'); } },
    runtime: { run: async (_agent, input) => { modelInputs.push(input.input.context.emails); return { content: '[]' }; } },
  });
  const result = await scan();

  assert.equal(result.source, 'local-customer-emails');
  assert.equal(result.scanned, 1);
  assert.equal(result.analyzed, 1);
  assert.equal(requests.length, 0);
  assert.equal(modelInputs[0][0].message_id, 'email-fsi');
  db.prepare("UPDATE email_sync SET last_run_at='2026-10-01T11:00:00Z' WHERE scope_key='1017'").run();
  saveRoster(db, ['1000', '1017']);
  assert.equal((await scan()).analyzed, 2);
  assert.deepEqual(modelInputs[1].map(email => email.message_id).sort(), ['email-edu', 'email-fsi']);
  assert.equal(requests.length, 0);
});

test('Deep Research hides archived sources and account tags and restores them when the TPID is re-added', t => {
  const db = makeRosterDb(t);
  seed(db);
  db.prepare("INSERT INTO email_customer_links(message_id,tpid,match_method) VALUES('email-fsi','1017','manual')").run();
  saveRoster(db, ['1000']);
  const before = JSON.stringify(db.prepare('SELECT * FROM emails ORDER BY message_id').all());
  const result = searchEmails(db);
  assert.deepEqual(result.results.map(email => email.messageId), ['email-fsi']);
  assert.deepEqual(result.results[0].accounts, ['FSI 0']);
  assert.deepEqual(result.accounts.map(account => account.tpid), ['1000']);
  assert.equal(result.storedCount, 1);
  assert.throws(() => readEmail(db, 'email-edu'), /archived/);
  assert.throws(() => searchEmails(db, { account: '1017' }), error => error.code === 'ACCOUNT_ARCHIVED');
  saveRoster(db, ['1000', '1017']);
  assert.deepEqual(readEmail(db, 'email-fsi').accounts, ['EDU 17', 'FSI 0']);
  assert.equal(searchEmails(db, { account: '1017' }).total, 2);
  assert.equal(readEmail(db, 'email-edu').subject, 'EDU 17');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM emails ORDER BY message_id').all()), before);
});

test('Work Agent tools enforce active queries, metadata-first discovery, and source reads', async t => {
  const db = makeRosterDb(t);
  seed(db);
  saveRoster(db, ['1000']);
  const requests = [];
  const tools = createWorkAgentTools({
    accountScope: createAccountScope(db),
    ensureConnected: async () => ({ connected: true }),
    client: { readTool: async (name, args) => {
      if (name === 'retrieve') {
        requests.push('search');
        return { structuredContent: { 'application/vnd.ms-workiq.retrieval': {
          markdown: 'Do not expose this mixed FSI 0 and EDU 17 summary.',
          retrievalHits: [
            { entityType: 'Emails', resourceId: 'email-fsi', resourceMetadata: { general: { title: 'FSI 0' } } },
            { entityType: 'Emails', resourceId: 'email-edu', resourceMetadata: { general: { title: 'EDU 17' } } },
          ],
        } } };
      }
      const url = args.entityUrls[0];
      requests.push(url);
      const data = url.startsWith('/me/messages?') ? { value: [
        { id: 'email-fsi', subject: 'FSI 0' }, { id: 'email-edu', subject: 'EDU 17' },
      ] } : { id: 'email-fsi', subject: 'FSI 0', body: { contentType: 'text', content: 'Current account context' } };
      return { structuredContent: { results: [{ statusCode: 200, data }] } };
    } },
  });
  await assert.rejects(tools.workiq_search.execute({ query: 'EDU 17 plans', scope: 'm365' }), /archived/);
  await assert.rejects(tools.workiq_read.execute({ path: '/me/messages/email-edu?$select=id,body' }), /archived/);
  await assert.rejects(tools.workiq_read.execute({ path: '/me/messages?$select=id,body' }), /metadata first/);
  for (const select of ['id, body', ' ', '*', 'id&$select=body', 'id&$expand=attachments']) {
    await assert.rejects(tools.workiq_read.execute({ path: `/me/messages?$select=${select}` }), /metadata first/);
  }
  assert.equal(requests.length, 0);
  const inventory = await tools.workiq_read.execute({ path: '/me/messages?$select=id,subject' });
  assert.equal(inventory.excludedArchivedSources, 1);
  assert.equal(inventory.emailReferences.length, 1);
  assert.doesNotMatch(inventory.text, /EDU 17|email-edu/);
  const email = await tools.workiq_read_email.execute({ messageId: inventory.emailReferences[0].reference });
  assert.match(email.text, /Current account context/);
  assert.equal(requests.length, 2);
  const search = await tools.workiq_search.execute({ query: 'Current portfolio context', scope: 'm365' });
  assert.equal(search.excludedArchivedSources, 1);
  assert.match(search.notice, /summary was omitted/);
  assert.doesNotMatch(search.text, /EDU 17|email-edu|Do not expose/);
  assert.equal(search.emailReferences.length, 1);
});
