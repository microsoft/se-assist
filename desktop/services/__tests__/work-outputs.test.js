'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createWorkOutputs } = require('../work-outputs');
const { parseOutput } = require('../work-output-contract');
const { workSearchEvidence } = require('../work-output-research');
const { createAgentRuntime, getAgentSpec } = require('../agents');
const { buildWorkOutputPrompt, buildWorkOutputQueryPrompt, buildWorkOutputGapTriagePrompt, buildWorkOutputGapAnswerPrompt } = require('../agents/prompts');
const { deleteTask, saveTask } = require('../customer-tasks');
const {
  gapQuestion, gapKey, listGaps, researchStamp, parseGapTriage, parseGapAnswer, judgedOutcome, upstreamNotice,
  NOT_FOUND_NOTE, UNVERIFIED_QUOTE_NOTE,
} = require('../work-output-gaps');
const { NO_MATCH_NOTICE } = require('../work-output-research');
const { UNCITED_WEB_WARNING } = require('../work-agent-tools');

const migration = name => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');
const source = { id: 'native-source-id', subject: 'Source subject', body: { contentType: 'text', content: 'Source decision and actions.' }, webLink: 'https://outlook.office.com/mail/read/source' };
const task = { title: 'Review the plan', sourceMessageId: source.id, subject: source.subject, account: 'Contoso', from: 'Source author', webLink: source.webLink };
const graph = data => ({ structuredContent: { results: [{ statusCode: 200, data }] } });
const action = {
  title: 'Schedule the review', description: 'Use the confirmed agenda.', owner: 'Ada',
  ownerStatus: 'confirmed', dueDate: '2026-10-02', dueDateConfirmed: true, dependsOn: ['Approve the agenda'],
  evidence: 'Source email: Ada committed to scheduling the review.',
};

function makeDb(t) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(migration('001_customer_workspace_cache.sql'));
  raw.exec(`
    CREATE TABLE customers(tpid TEXT, name TEXT, parent_crm_account_id TEXT);
    CREATE TABLE workloads(id INTEGER PRIMARY KEY, title TEXT, name TEXT, account_name TEXT, customer_name TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE email_customer_links(message_id TEXT, tpid TEXT, match_method TEXT);
    INSERT INTO cached_customer_profiles(id,tpid,display_name,updated_at) VALUES ('p1','1001','Contoso','2026-09-01'),('p2','1002','Fabrikam','2026-09-01');
    INSERT INTO workloads(id,title,name,account_name) VALUES (1,'Review plan','Review plan','Contoso');
    INSERT INTO email_customer_links VALUES ('native-source-id','1001','manual');
  `);
  raw.exec(migration('026_meeting_notes.sql'));
  raw.exec(migration('029_meeting_tasks.sql'));
  let depth = 0;
  const db = {
    prepare: sql => raw.prepare(sql), exec: sql => raw.exec(sql),
    transaction(fn) {
      return (...args) => {
        const savepoint = `output_test_${depth++}`;
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
  db.exec(migration('030_work_outputs.sql'));
  db.exec(migration('035_work_output_gaps.sql'));
  db.exec(`
    CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY);
    INSERT INTO tpid_config VALUES('1001'),('1002');
    CREATE TABLE emails(message_id TEXT PRIMARY KEY);
    CREATE TABLE teams_customer_aliases(tpid TEXT,alias TEXT,is_active INTEGER);
    CREATE TABLE customer_contacts(tpid TEXT,email TEXT);
  `);
  for (const table of ['customers', 'workloads', 'emails', 'email_customer_links', 'cached_customer_profiles', 'cached_customer_todos']) {
    db.exec(`CREATE VIEW active_${table} AS SELECT * FROM ${table}`);
  }
  return db;
}

function fixture(t, options = {}) {
  const db = options.db || makeDb(t);
  const state = {
    now: Date.parse('2026-09-23T15:00:00Z'), reads: [], models: [], web: [], progress: [],
    workError: null, modelError: null, publicError: null, providerError: null,
    source: structuredClone(source), modelGaps: [], gapKind: 'm365', technicalQuestion: null,
    judgment: { status: 'not_found' }, publicQuery: 'Official product deployment requirements and trade-offs', ...options.state,
  };
  const runtime = createAgentRuntime({
    provider: { chat: async (system, user, modelOptions) => {
      const input = JSON.parse(user);
      state.models.push({ input, system, options: modelOptions });
      if (state.modelError) throw state.modelError;
      if (options.onModel) return options.onModel(input, modelOptions, state);
      const reply = 'suggestTechnicalQuestion' in input ? {
        gaps: input.gaps.map(gap => ({ id: gap.id, kind: state.gapKind, reason: 'Answerable from the account mail.' })),
        technicalQuestion: state.technicalQuestion,
      } : typeof input.question === 'string' ? state.judgment
        : input.technicalQuestion ? { query: state.publicQuery } : {
          content: input.area === 'reply' ? 'Please confirm the remaining details before we proceed.' : `${input.area} findings`,
          gaps: state.modelGaps, needsInput: false, actions: input.area === 'actions' ? [action] : [],
        };
      return { finishReason: 'stop', model: 'selected-test-model', content: JSON.stringify(reply) };
    } },
    agents: [
      { ...getAgentSpec('work-output'), render: buildWorkOutputPrompt },
      { ...getAgentSpec('work-output-public-query'), render: buildWorkOutputQueryPrompt },
      { ...getAgentSpec('work-output-gap-triage'), render: buildWorkOutputGapTriagePrompt },
      { ...getAgentSpec('work-output-gap-answer'), render: buildWorkOutputGapAnswerPrompt },
    ],
  });
  const dependencies = {
    db, now: () => state.now, timeoutMs: options.timeoutMs,
    resolveRuntime: async () => {
      if (state.providerError) throw state.providerError;
      return { runtime, model: 'selected-test-model' };
    },
    client: { readTool: async (name, args, timeout, signal) => {
      state.reads.push({ name, args, timeout });
      if (options.onRead) return options.onRead(name, args, signal, state);
      if (name === 'fetch') return graph(state.source);
      if (state.workError) throw state.workError;
      return { structuredContent: { 'application/vnd.ms-workiq.retrieval': {
        markdown: 'Focused work evidence.', resultCount: 1, retrievalHits: [],
      } } };
    } },
    ensureConnected: async () => ({ connected: true }),
    webTool: async (name, args) => {
      state.web.push({ name, args });
      if (state.publicError) throw state.publicError;
      return { structuredContent: { type: 'output_text', text: { value: 'A useful public technical summary.', annotations: [] } } };
    },
  };
  const service = createWorkOutputs(dependencies);
  const investigation = service.open(task);
  return {
    db, state, service, dependencies, id: investigation.id,
    output: area => service.get(investigation.id).outputs.find(output => output.area === area),
    run: (area, mode = 'generate', extras = {}) => service.run({
      investigationId: investigation.id, area, mode, requestId: 'test-request', userName: 'Test user', ...extras,
    }, event => state.progress.push(event), 1),
    triage: () => service.triageGaps({ investigationId: investigation.id, requestId: 'gap-request' }, event => state.progress.push(event), 1),
    research: gapKey => service.researchGap({
      investigationId: investigation.id, gapKey, requestId: 'gap-request', userName: 'Test user',
    }, event => state.progress.push(event), 1),
    gaps: () => service.get(investigation.id).gaps,
  };
}

test('migrations 030 and 035 are additive, persist output areas, and reopen by exact source/task identity', t => {
  const f = fixture(t);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 35);
  assert.equal(f.service.get(f.id).outputs.length, 4);
  assert.deepEqual(f.service.get(f.id).defaultAreas, ['situation', 'actions', 'reply']);
  assert.equal(f.service.get(f.id).defaultProfileId, 'p1');
  assert.equal(f.service.open({ ...task, id: 'new-random-scan-id' }).id, f.id);
  assert.notEqual(f.service.open({ ...task, sourceMessageId: 'another-source' }).id, f.id);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => f.service.open({ title: 'No source' }), /Source email ID/);
});

test('shared task ownership reaches the writer and changed ownership invalidates earlier findings', async t => {
  const f = fixture(t);
  await f.run('situation');
  const shared = f.service.open({ ...task, ownership: 'shared', owner: 'Account owner', summary: 'The account owner is coordinating the open customer request.' });
  assert.equal(shared.task.ownership, 'shared');
  assert.equal(shared.task.owner, 'Account owner');
  assert.equal(shared.outputs.find(output => output.area === 'situation').needsRefresh, true);
  await f.run('situation', 'refresh');
  assert.equal(f.state.models.at(-1).input.task.ownership, 'shared');
  assert.match(f.state.models.at(-1).system, /not assigned the original commitment/);
  assert.equal(f.output('situation').needsRefresh, false);
  assert.throws(() => f.service.open({ ...task, ownership: 'inferred' }), /Invalid task ownership/);
});

test('a protected-message wrapper cannot support generated work outputs', async t => {
  const f = fixture(t);
  f.state.source.body.content = 'Sender has sent you a protected message.\nRead the message\nMicrosoft Purview Message Encryption';
  assert.equal((await f.run('situation')).ok, false);
  assert.match(f.output('situation').error.message, /protected-message notice/);
  assert.equal(f.state.models.length, 0);
});

test('default deliverables do one shared full-email read, two targeted searches, and no public research', async t => {
  const f = fixture(t);
  for (const area of ['situation', 'actions', 'reply']) assert.equal((await f.run(area)).ok, true);
  assert.equal(f.state.reads.filter(read => read.name === 'fetch').length, 1);
  assert.equal(f.state.reads.filter(read => read.name === 'retrieve').length, 2);
  assert.ok(f.state.reads.filter(read => read.name === 'retrieve').every(read => read.args.strategy === 'grounding'));
  assert.equal(f.state.web.length, 0);
  assert.equal(f.output('technical').status, 'idle');
  assert.equal(f.output('situation').status, 'ready');
  assert.equal(f.output('reply').needsRefresh, false);
  assert.equal(f.output('reply').status, 'ready');
  assert.equal(f.state.models.at(-1).input.upstream.length, 2);
  assert.ok(f.state.models.every(call => call.options.reasoningEffort === 'high' && !call.options.tools));
  assert.ok(f.state.progress.every(event => event.investigationId === f.id && event.requestId === 'test-request'));
});

test('failed work search retries only that area and reuses the successful source', async t => {
  const f = fixture(t);
  f.state.workError = new Error('Temporary search failure');
  assert.equal((await f.run('situation')).ok, false);
  assert.equal(f.output('situation').status, 'failed');
  f.state.workError = null;
  assert.equal((await f.run('actions')).ok, true);
  assert.equal((await f.run('reply')).ok, true);
  assert.equal(f.output('actions').status, 'ready_with_gaps');
  const oldActions = f.output('actions').content;
  const oldReply = f.output('reply').content;
  assert.equal((await f.run('situation', 'retry')).ok, true);
  assert.equal(f.state.reads.filter(read => read.name === 'fetch').length, 1);
  assert.deepEqual(f.output('actions').content, oldActions);
  assert.deepEqual(f.output('reply').content, oldReply);
  assert.equal(f.output('actions').needsRefresh, true);
  assert.equal(f.output('reply').needsRefresh, true);
});

test('writer failure retains research across service restart and retry calls only the writer', async t => {
  const f = fixture(t);
  f.state.modelError = new Error('Model unavailable');
  assert.equal((await f.run('situation')).ok, false);
  const readCount = f.state.reads.length;
  f.state.modelError = null;
  const restarted = createWorkOutputs(f.dependencies);
  const result = await restarted.run({ investigationId: f.id, area: 'situation', mode: 'retry' });
  assert.equal(result.ok, true);
  assert.equal(f.state.reads.length, readCount);
  assert.equal(result.investigation.outputs.find(output => output.area === 'situation').status, 'ready');
});

test('source access denial is durable, shared across areas, and never retried by generic Retry', async t => {
  let deny = true;
  const f = fixture(t, { onRead: async () => {
    if (deny) throw Object.assign(new Error('Access denied'), { statusCode: 403, code: 'Forbidden' });
    return graph(source);
  } });
  await f.run('reply');
  await f.run('actions');
  await f.run('reply', 'retry');
  assert.equal(f.state.reads.length, 1);
  assert.equal(f.output('reply').steps[0].status, 'blocked');
  assert.match(f.output('reply').error.message, /remains excluded/);
  deny = false;
  assert.equal((await f.run('reply', 'refresh')).ok, true);
  assert.equal(f.state.reads.length, 2);
  assert.equal(f.output('actions').status, 'failed');
});

test('failure after public-query generation retries public research without repeating successful steps', async t => {
  const f = fixture(t);
  f.state.publicError = Object.assign(new Error('Public search unavailable'), { statusCode: 503 });
  assert.equal((await f.run('technical', 'generate', { focus: 'How do deployment constraints affect this product?' })).ok, false);
  const reads = f.state.reads.length;
  const queries = f.state.models.length;
  f.state.publicError = null;
  assert.equal((await f.run('technical', 'retry')).ok, true);
  assert.equal(f.state.reads.length, reads);
  assert.equal(f.state.models.length, queries + 1);
  assert.equal(f.state.web.length, 2);
  assert.equal(f.output('technical').status, 'ready_with_gaps');
  assert.ok(f.output('technical').gaps.some(gap => /uncited research/.test(gap)));
});

test('model failure with cooldown cannot be bypassed by refresh or retry', async t => {
  const f = fixture(t);
  f.state.modelError = Object.assign(new Error('Provider throttled'), { statusCode: 429, retryAt: f.state.now + 60000 });
  await f.run('situation');
  assert.equal(f.output('situation').error.statusCode, 429);
  await assert.rejects(f.run('situation', 'retry'), /cooldown/);
  await assert.rejects(f.run('situation', 'refresh'), /cooldown/);
  f.state.now += 60001;
  f.state.modelError = null;
  assert.equal((await f.run('situation', 'retry')).ok, true);
});

test('refine preserves existing gaps, uses no new source calls, and does not upgrade partial research', async t => {
  const f = fixture(t);
  f.state.modelGaps = ['The requested deadline is not confirmed.'];
  await f.run('situation');
  const reads = f.state.reads.length;
  f.state.modelGaps = [];
  await f.run('situation', 'refine', { instruction: 'Make this shorter.' });
  assert.equal(f.state.reads.length, reads);
  assert.equal(f.output('situation').status, 'ready_with_gaps');
  assert.ok(f.output('situation').gaps.includes('The requested deadline is not confirmed.'));
  assert.ok(f.state.models.at(-1).input.previousOutput);
});

test('inherited qualifications retain their original area without multiplying across the dependency chain', async t => {
  const f = fixture(t);
  f.state.modelGaps = ['The deadline is not confirmed.'];
  await f.run('situation');
  f.state.modelGaps = [];
  await f.run('actions');
  await f.run('reply');
  assert.deepEqual(f.output('reply').gaps, ['Current situation: The deadline is not confirmed.']);
});

test('technical findings invalidate an earlier checklist without rerunning it', async t => {
  const f = fixture(t);
  await f.run('situation');
  await f.run('actions');
  const previous = f.output('actions');
  await f.run('technical', 'generate', { focus: 'What deployment criteria matter?' });
  assert.equal(f.output('actions').needsRefresh, true);
  assert.equal(f.output('actions').version, previous.version);
  assert.deepEqual(f.output('actions').content, previous.content);
});

test('refresh changes dependency stamps; stale replies cannot create an Outlook draft', async t => {
  const f = fixture(t);
  for (const area of ['situation', 'actions', 'reply']) await f.run(area);
  const reply = f.output('reply');
  assert.equal(f.service.draft({ investigationId: f.id, version: reply.version }).messageId, source.id);
  await f.run('situation', 'refresh');
  assert.equal(f.output('reply').needsRefresh, true);
  assert.throws(() => f.service.draft({ investigationId: f.id, version: reply.version }), /needs refresh/);
  await f.run('actions', 'refresh');
  await f.run('reply', 'refresh');
  assert.equal(f.output('reply').needsRefresh, false);
  assert.equal(f.state.reads.filter(read => read.name === 'fetch').length, 2);
  assert.throws(() => f.service.draft({ investigationId: f.id, version: reply.version }), /reply changed/);
});

test('a failed refresh leaves the old result explicitly failed and inaccessible for draft actions', async t => {
  const f = fixture(t);
  await f.run('reply');
  const previous = f.output('reply').content;
  f.state.modelError = new Error('New revision failed');
  await f.run('reply', 'refresh');
  assert.equal(f.output('reply').status, 'failed');
  assert.deepEqual(f.output('reply').content, previous);
  assert.throws(() => f.service.draft({ investigationId: f.id, version: 1 }), /reply changed, failed/);
});

test('checklist selection creates only selected local Tasks with customer and workload, idempotently', async t => {
  const f = fixture(t);
  await f.run('situation');
  await f.run('actions');
  const output = f.output('actions');
  const payload = { investigationId: f.id, version: output.version, actionKeys: [output.content.actions[0].key], workloadId: 1 };
  const created = f.service.createTasks(payload);
  assert.equal(created.created, 1);
  const saved = f.db.prepare('SELECT * FROM cached_customer_todos').get();
  assert.equal(saved.profile_id, 'p1');
  assert.equal(saved.workload_id, 1);
  assert.equal(saved.due_at, '2026-10-02');
  assert.match(saved.description, /Owner \(confirmed\): Ada/);
  assert.match(saved.description, /Prerequisites: Approve the agenda/);
  saveTask(f.db, { id: saved.id, title: 'User-edited task', status: 'done', workloadId: null });
  assert.equal(f.service.createTasks(payload).existing, 1);
  assert.equal(f.db.prepare('SELECT title FROM cached_customer_todos').get().title, 'User-edited task');
  deleteTask(f.db, { id: saved.id });
  assert.equal(f.service.createTasks(payload).created, 0);
  assert.equal(f.service.get(f.id).createdTasks[0].deleted, true);
});

test('ambiguous customers remain unselected and stale checklist actions are rejected', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO email_customer_links VALUES (?,?,?)').run(source.id, '1002', 'manual');
  assert.equal(f.service.get(f.id).defaultProfileId, null);
  await f.run('actions');
  const output = f.output('actions');
  const payload = { investigationId: f.id, version: output.version, actionKeys: [output.content.actions[0].key] };
  f.service.createTasks(payload);
  assert.equal(f.db.prepare('SELECT profile_id FROM cached_customer_todos').get().profile_id, null);
  await f.run('situation');
  assert.throws(() => f.service.createTasks(payload), /checklist changed or needs refresh/);
});

test('unsupported or altered checklist keys fail without writing a Task', async t => {
  const f = fixture(t);
  await f.run('actions');
  assert.throws(() => f.service.createTasks({ investigationId: f.id, version: 1, actionKeys: ['invented-key'] }), /Select valid checklist/);
  const key = f.output('actions').content.actions[0].key;
  assert.throws(() => f.service.createTasks({ investigationId: f.id, version: 1, actionKeys: [key], workloadId: 999 }), /workload no longer exists/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cached_customer_todos').get().n, 0);
});

test('cancellation retains saved steps, affects only the active area, and ignores a late model response', async t => {
  let finish;
  const f = fixture(t, { onModel: () => new Promise(resolve => { finish = resolve; }) });
  const running = f.run('situation');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.cancel(f.id, 'situation', 2).cancelled, 0);
  assert.equal(f.service.cancel(f.id, 'situation', 1).cancelled, 1);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(f.output('situation').status, 'failed');
  assert.equal(f.output('situation').steps.filter(step => step.status === 'ready').length, 2);
  finish({ content: JSON.stringify({ content: 'Late answer', gaps: [], needsInput: false, actions: [] }), finishReason: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.output('situation').content, null);
  assert.equal(f.output('reply').status, 'idle');
});

test('an aggregate area deadline returns even if provider setup never settles', async t => {
  const f = fixture(t, { timeoutMs: 20 });
  const service = createWorkOutputs({ ...f.dependencies, resolveRuntime: () => new Promise(() => {}) });
  const result = await service.run({ investigationId: f.id, area: 'situation' });
  assert.equal(result.ok, false);
  assert.match(result.error, /time budget/);
  assert.equal(f.state.reads.length, 0);
});

test('duplicate and overlapping area calls are rejected without starting another read', async t => {
  let finish;
  const f = fixture(t, { onModel: () => new Promise(resolve => { finish = resolve; }) });
  const running = f.run('situation');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.run('situation'), /already working/);
  await assert.rejects(f.run('actions'), /Another area/);
  f.service.cancel(f.id, null, 1);
  await running;
  finish({ content: 'ignored', finishReason: 'stop' });
});

test('interrupted persisted work is marked failed on restart and can be retried without loss', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE work_output_areas SET status='working' WHERE investigation_id=? AND area='situation'").run(f.id);
  const restarted = createWorkOutputs(f.dependencies);
  const output = restarted.get(f.id).outputs.find(item => item.area === 'situation');
  assert.equal(output.status, 'failed');
  assert.match(output.error.message, /app closed/);
  assert.equal(restarted.get(f.id).outputs.find(item => item.area === 'reply').status, 'idle');
});

test('expired evidence is not silently reused by refine; retry refreshes the expired steps', async t => {
  const f = fixture(t);
  await f.run('situation');
  const reads = f.state.reads.length;
  f.state.now += 25 * 60 * 60 * 1000;
  assert.equal((await f.run('situation', 'refine', { instruction: 'Shorten it.' })).ok, false);
  assert.equal(f.state.reads.length, reads);
  assert.match(f.output('situation').error.message, /expired/);
  await f.run('situation', 'retry');
  assert.equal(f.state.reads.length, reads + 2);
});

test('empty WorkIQ envelopes and source identity errors remain explicit area failures', async t => {
  for (const value of [{ structuredContent: {} }, { structuredContent: { 'application/vnd.ms-workiq.retrieval': {} } }, { content: [] }]) {
    assert.throws(() => workSearchEvidence(value), /no usable research envelope/);
  }
  const f = fixture(t);
  f.state.source.id = 'wrong-id';
  assert.equal((await f.run('situation')).ok, false);
  assert.match(f.output('situation').error.message, /exact full source email/);
  assert.equal(f.state.models.length, 0);
});

test('source body is not cut at 24000 characters; oversize sources fail before writing output', async t => {
  const f = fixture(t);
  f.state.source.body.content = 'a'.repeat(45000) + 'END_ACTION';
  await f.run('situation');
  assert.ok(f.state.models[0].input.evidence[0].text.includes('END_ACTION'));
  f.state.source.body.content = 'a'.repeat(161000);
  assert.equal((await f.run('situation', 'refresh')).ok, false);
  assert.match(f.output('situation').error.message, /exceeds the output research budget/);
  assert.equal(f.output('situation').content.content, 'situation findings');
});

test('technical output needs an explicit question and no background web call is made', async t => {
  const f = fixture(t);
  assert.equal((await f.run('technical')).ok, false);
  assert.equal(f.output('technical').status, 'needs_input');
  assert.equal(f.state.reads.length, 0);
  assert.equal(f.state.web.length, 0);
});

test('missing Copilot provider is retained as an explicit failure with no substituted model or research', async t => {
  const f = fixture(t);
  f.state.providerError = new Error('Work Agent requires GitHub Copilot. Connect in Settings.');
  assert.equal((await f.run('situation')).ok, false);
  assert.match(f.output('situation').error.message, /requires GitHub Copilot/);
  assert.equal(f.state.models.length, 0);
  assert.equal(f.state.reads.length, 0);
});

test('research subjects list most recent activity first and keep an unreadable saved task removable', async t => {
  const f = fixture(t);
  f.state.now = Date.parse('2026-09-23T16:00:00Z');
  const second = f.service.open({ ...task, title: 'Prepare the briefing', sourceMessageId: 'second-source-id' });
  let subjects = f.service.list();
  assert.deepEqual(subjects.map(subject => subject.id), [second.id, f.id]);
  assert.equal(subjects[0].task.title, 'Prepare the briefing');
  assert.equal(subjects[0].error, null);
  assert.deepEqual(subjects[1].areas, { situation: 'idle', reply: 'idle', actions: 'idle', technical: 'idle' });
  f.state.now = Date.parse('2026-09-23T17:00:00Z');
  await f.run('situation');
  subjects = f.service.list();
  assert.deepEqual(subjects.map(subject => subject.id), [f.id, second.id]);
  assert.equal(subjects[0].areas.situation, 'ready');
  assert.equal(subjects[0].updatedAt, '2026-09-23T17:00:00.000Z');
  assert.equal(subjects[0].createdAt, '2026-09-23T15:00:00.000Z');

  f.db.prepare('UPDATE work_output_investigations SET task_json = ? WHERE id = ?').run('{broken', second.id);
  const broken = f.service.list().find(subject => subject.id === second.id);
  assert.equal(broken.task, null);
  assert.match(broken.error, /Saved task is invalid/);
  f.db.prepare('UPDATE work_output_investigations SET task_json = ? WHERE id = ?').run('{"title":7}', second.id);
  assert.match(f.service.list().find(subject => subject.id === second.id).error, /Saved task is invalid/);
  assert.deepEqual(f.service.remove(second.id), { ok: true, removed: second.id });
  assert.deepEqual(f.service.list().map(subject => subject.id), [f.id]);
});

test('removing a research subject deletes only its saved work and keeps created Tasks', async t => {
  const f = fixture(t);
  await f.run('situation');
  await f.run('actions');
  const output = f.output('actions');
  assert.equal(f.service.createTasks({ investigationId: f.id, version: output.version, actionKeys: [output.content.actions[0].key] }).created, 1);
  const other = f.service.open({ ...task, title: 'Prepare the briefing', sourceMessageId: 'second-source-id' });
  f.db.prepare('INSERT INTO work_output_gaps(investigation_id,gap_key,text,status,updated_at) VALUES (?,?,?,?,?)')
    .run(f.id, gapKey('Who owns the migration?'), 'Who owns the migration?', 'answered', '2026-09-23T15:00:00.000Z');

  assert.deepEqual(f.service.remove(f.id), { ok: true, removed: f.id });
  for (const table of ['work_output_investigations', 'work_output_task_links', 'work_output_steps', 'work_output_gaps', 'work_output_areas']) {
    const column = table === 'work_output_investigations' ? 'id' : 'investigation_id';
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(f.id).n, 0, table);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_output_areas WHERE investigation_id = ?').get(other.id).n, 4);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cached_customer_todos').get().n, 1);
  assert.throws(() => f.service.get(f.id), /Investigation not found/);
  assert.throws(() => f.service.remove(f.id), /Investigation not found/);
  for (const value of ['', null, 42]) assert.throws(() => f.service.remove(value), /Investigation ID must be 1 to 200 characters/);

  const reopened = f.service.open(task);
  assert.notEqual(reopened.id, f.id);
  assert.equal(reopened.outputs.find(item => item.area === 'situation').status, 'idle');
});

test('a research subject cannot be removed while one of its areas is working', async t => {
  let finish;
  const f = fixture(t, { onModel: () => new Promise(resolve => { finish = resolve; }) });
  const running = f.run('situation');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => f.service.remove(f.id), /still working/);
  f.service.cancel(f.id, null, 1);
  await running;
  finish({ content: 'ignored', finishReason: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  f.db.prepare("UPDATE work_output_areas SET status='working' WHERE investigation_id=? AND area='reply'").run(f.id);
  assert.throws(() => f.service.remove(f.id), /still working/);
  f.db.prepare("UPDATE work_output_areas SET status='idle' WHERE investigation_id=? AND area='reply'").run(f.id);
  assert.equal(f.service.remove(f.id).removed, f.id);
});

test('strict outputs preserve optional citations but reject invented deadline structure and malformed JSON', () => {
  const output = { content: 'Useful uncited findings.', gaps: [], needsInput: false, actions: [] };
  assert.equal(parseOutput(JSON.stringify(output), 'situation').content, output.content);
  assert.throws(() => parseOutput('not JSON', 'situation'), /invalid output JSON/);
  assert.throws(() => parseOutput(JSON.stringify({ ...output, actions: [{ ...action, dueDateConfirmed: false }] }), 'actions'), /deadlines must be confirmed/);
  assert.throws(() => parseOutput(JSON.stringify({ ...output, actions: [{ ...action, dueDate: '2026-02-30' }] }), 'actions'), /deadlines must be confirmed/);
  assert.throws(() => parseOutput(JSON.stringify({ ...output, needsInput: true }), 'reply'), /must explain/);
});

const retrieval = (markdown = 'Focused work evidence.', resultCount = 1) => ({
  structuredContent: { 'application/vnd.ms-workiq.retrieval': { markdown, resultCount, retrievalHits: [] } },
});

async function classifiedGap(t, options = {}) {
  const f = fixture(t, { ...options, state: { modelGaps: ['Who owns the migration?'], ...options.state } });
  await f.run('situation');
  assert.equal((await f.triage()).ok, true);
  return { ...f, gap: f.gaps()[0] };
}

test('the gap register merges repeated questions under their origin and skips research notices', () => {
  assert.deepEqual(gapQuestion('Action checklist: Current situation: Who owns the migration?', 'reply'), { question: 'Who owns the migration?', origin: 'situation' });
  const outputs = [
    { area: 'situation', gaps: ['Who owns the migration?', NO_MATCH_NOTICE] },
    { area: 'technical', gaps: [] },
    { area: 'actions', gaps: ['Current situation: who owns the  migration', upstreamNotice('Technical recommendation', 'failed'), 'When is the cutover?'] },
    { area: 'reply', gaps: [UNCITED_WEB_WARNING, 'Action checklist: When is the cutover?', ' '] },
  ];
  const record = (question, status) => ({
    key: gapKey(question), text: question, kind: 'm365', status, answer: status === 'answered' ? 'Yes.' : null, sources: [], notes: [],
  });
  const gaps = listGaps(outputs, [record('Is the pilot still planned?', 'answered'), record('Is an old question open?', 'open')]);
  assert.deepEqual(gaps.map(gap => [gap.text, gap.origin, gap.areas, gap.listed, gap.kind, gap.status]), [
    ['Who owns the migration?', 'situation', ['situation', 'actions'], true, null, 'open'],
    ['When is the cutover?', 'actions', ['actions', 'reply'], true, null, 'open'],
    ['Is the pilot still planned?', null, [], false, 'm365', 'answered'],
  ]);

  const answered = record('Who owns the migration?', 'answered');
  assert.deepEqual(researchStamp(['When is the cutover?'], [answered]), {});
  assert.deepEqual(researchStamp(['Who owns the migration?'], [{ ...answered, status: 'still_open' }]), {});
  const stamped = researchStamp(['Current situation: Who owns the migration?'], [answered]);
  assert.equal(typeof stamped.research, 'string');
  assert.notDeepEqual(researchStamp(['Who owns the migration?'], [{ ...answered, answer: 'No.' }]), stamped);
});

test('gap classifications and research judgments are parsed strictly and answers need a verbatim quote', () => {
  const ids = ['G1', 'G2'];
  const valid = {
    gaps: [{ id: 'G1', kind: 'm365', reason: 'Discussed in the account mail.' }, { id: 'G2', kind: 'person', reason: 'Only Ada can decide.' }],
    technicalQuestion: 'Which SKU supports private endpoints?',
  };
  const parsed = parseGapTriage(JSON.stringify(valid), ids);
  assert.deepEqual([...parsed.classified], [['G1', { kind: 'm365', reason: 'Discussed in the account mail.' }], ['G2', { kind: 'person', reason: 'Only Ada can decide.' }]]);
  assert.equal(parsed.technicalQuestion, 'Which SKU supports private endpoints?');
  assert.equal(parseGapTriage(JSON.stringify({ gaps: valid.gaps, technicalQuestion: null }), ids).technicalQuestion, null);
  for (const [gaps, pattern] of [
    [[valid.gaps[0]], /missing G2/],
    [[...valid.gaps, valid.gaps[0]], /G1 was classified twice/],
    [[valid.gaps[0], { ...valid.gaps[1], kind: 'guess' }], /G2 has an unknown kind/],
    [[valid.gaps[0], { ...valid.gaps[1], id: 'G9' }], /unknown gap id/],
    [[valid.gaps[0], { ...valid.gaps[1], reason: '' }], /Classification reason/],
  ]) assert.throws(() => parseGapTriage(JSON.stringify({ gaps }), ids), pattern);
  assert.throws(() => parseGapTriage('not JSON', ids), /No gap was classified/);

  assert.deepEqual(parseGapAnswer('{"status":"not_found"}'), { status: 'not_found', answer: null, quote: null });
  assert.throws(() => parseGapAnswer('{"status":"answered","answer":"Ada owns it."}'), /Supporting quote/);
  assert.throws(() => parseGapAnswer('{"status":"maybe"}'), /unknown status/);
  const evidence = 'Thread: Ada confirmed she owns the migration plan.';
  assert.deepEqual(judgedOutcome({ status: 'answered', answer: 'Ada owns it.', quote: 'Ada confirmed  she owns the migration plan' }, evidence),
    { status: 'answered', answer: 'Ada owns it.', quote: 'Ada confirmed  she owns the migration plan', notes: [] });
  assert.deepEqual(judgedOutcome({ status: 'answered', answer: 'Bo owns it.', quote: 'Bo confirmed he owns the plan' }, evidence),
    { status: 'still_open', answer: null, quote: null, notes: [UNVERIFIED_QUOTE_NOTE] });
  assert.deepEqual(judgedOutcome({ status: 'not_found', answer: null, quote: null }, evidence).notes, [NOT_FOUND_NOTE]);
});

test('gap triage classifies only listed unclassified gaps, suggests a technical question once, and does no research', async t => {
  const f = fixture(t, { state: {
    modelGaps: ['Who owns the migration?', 'Which SKU supports private endpoints?'],
    technicalQuestion: 'Which SKU supports private endpoints for this workload?',
  } });
  const nothing = await f.triage();
  assert.deepEqual([nothing.ok, nothing.classified, f.state.models.length], [true, 0, 0]);
  await f.run('situation');
  const reads = f.state.reads.length;
  assert.equal(f.service.get(f.id).gapTriage.untriaged, 2);

  const result = await f.triage();
  assert.deepEqual([result.ok, result.classified], [true, 2]);
  const call = f.state.models.at(-1).input;
  assert.deepEqual(call.gaps, [
    { id: 'G1', question: 'Who owns the migration?', raisedBy: ['Current situation'] },
    { id: 'G2', question: 'Which SKU supports private endpoints?', raisedBy: ['Current situation'] },
  ]);
  assert.equal(call.suggestTechnicalQuestion, true);
  assert.deepEqual([f.state.reads.length, f.state.web.length], [reads, 0]);
  assert.deepEqual(result.investigation.gaps.map(gap => [gap.kind, gap.kindReason, gap.status]), [
    ['m365', 'Answerable from the account mail.', 'open'], ['m365', 'Answerable from the account mail.', 'open'],
  ]);
  assert.deepEqual(result.investigation.gapTriage, {
    untriaged: 0, error: null, checkedAt: '2026-09-23T15:00:00.000Z',
    technicalQuestion: 'Which SKU supports private endpoints for this workload?', model: 'selected-test-model',
  });
  assert.equal(result.investigation.gapActivity, null);
  assert.equal(f.output('technical').status, 'idle');
  assert.ok(f.state.progress.some(event => event.area === 'gaps' && event.requestId === 'gap-request' && event.phase === 'saved'));
  const calls = f.state.models.length;
  assert.equal((await f.triage()).classified, 0);
  assert.equal(f.state.models.length, calls);

  f.db.prepare("UPDATE work_output_areas SET focus='Which SKU supports private endpoints?' WHERE investigation_id=? AND area='technical'").run(f.id);
  f.state.modelGaps = ['When is the cutover?'];
  f.state.technicalQuestion = 'A different suggestion';
  await f.run('situation', 'refresh');
  const second = await f.triage();
  assert.equal(second.classified, 1);
  assert.equal(f.state.models.at(-1).input.suggestTechnicalQuestion, false);
  assert.equal(second.investigation.gapTriage.technicalQuestion, 'Which SKU supports private endpoints for this workload?');
  assert.deepEqual(second.investigation.gaps.map(gap => gap.text), ['When is the cutover?']);
});

test('an invalid gap classification saves nothing and is reported for retry', async t => {
  const f = fixture(t, { state: { modelGaps: ['Who owns the migration?', 'When is the cutover?'], gapKind: 'guess' } });
  await f.run('situation');
  const failed = await f.triage();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /G1 has an unknown kind\). No gap was classified/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_output_gaps').get().n, 0);
  assert.equal(failed.investigation.gapTriage.untriaged, 2);
  assert.match(failed.investigation.gapTriage.error.message, /No gap was classified/);
  assert.ok(f.state.progress.some(event => event.area === 'gaps' && event.phase === 'failed'));
  f.state.gapKind = 'public';
  const retried = await f.triage();
  assert.equal(retried.ok, true);
  assert.equal(retried.investigation.gapTriage.error, null);
  assert.deepEqual(retried.investigation.gaps.map(gap => gap.kind), ['public', 'public']);
});

test('a verified work-data answer resolves its gap, marks listing outputs for refresh, and reaches the writer', async t => {
  const f = await classifiedGap(t);
  await f.run('actions');
  assert.deepEqual([f.output('situation').needsRefresh, f.output('actions').needsRefresh], [false, false]);
  assert.deepEqual(f.gaps()[0].areas, ['situation', 'actions']);
  f.state.judgment = { status: 'answered', answer: 'The focused search names the owner.', quote: 'Focused work evidence' };
  const reads = f.state.reads.length;
  const result = await f.research(f.gap.key);
  assert.deepEqual([result.ok, result.status], [true, 'answered']);
  const searches = f.state.reads.slice(reads);
  assert.deepEqual(searches.map(item => item.name), ['retrieve']);
  assert.match(searches[0].args.query[0], /^Find information that answers this open question: Who owns the migration\?\n/);
  assert.match(searches[0].args.query[0], /Account: Contoso/);
  const judge = f.state.models.at(-1).input;
  assert.deepEqual([judge.question, judge.evidence.label, judge.evidence.text], ['Who owns the migration?', 'Focused Microsoft 365 search', 'Focused work evidence.']);
  const saved = result.investigation.gaps[0];
  assert.deepEqual([saved.status, saved.answer, saved.quote, saved.notes, saved.error], ['answered', 'The focused search names the owner.', 'Focused work evidence', [], null]);
  assert.equal(saved.checkedAt, '2026-09-23T15:00:00.000Z');
  assert.equal(result.investigation.gapActivity, null);
  assert.deepEqual([f.output('situation').needsRefresh, f.output('actions').needsRefresh, f.output('reply').needsRefresh], [true, true, false]);
  await assert.rejects(f.research(f.gap.key), /already answered/);

  await f.run('situation', 'refresh');
  const writer = f.state.models.at(-1).input;
  assert.deepEqual(writer.researchedGaps, [{
    question: 'Who owns the migration?', kind: 'm365', status: 'answered', answer: 'The focused search names the owner.',
    quote: 'Focused work evidence', sources: [], notes: [],
  }]);
  assert.deepEqual(writer.limitations, []);
  const situation = f.output('situation');
  assert.deepEqual([situation.status, situation.gaps, situation.needsRefresh], ['ready', [], false]);
  assert.equal(f.output('actions').needsRefresh, true);
  await f.run('actions', 'refresh');
  assert.equal(f.output('actions').needsRefresh, false);
  const after = f.gaps()[0];
  assert.deepEqual([after.key, after.listed, after.status, after.areas], [f.gap.key, false, 'answered', []]);
});

test('public gap research rejects private terms before any web call and labels an uncited summary', async t => {
  const f = await classifiedGap(t, { state: {
    modelGaps: ['Which SKU supports private endpoints?'], gapKind: 'public', publicQuery: 'Contoso private endpoint SKU support',
  } });
  const rejected = await f.research(f.gap.key);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /task-specific account, sender or email details/);
  assert.equal(f.state.web.length, 0);
  let saved = rejected.investigation.gaps[0];
  assert.deepEqual([saved.status, saved.query, saved.answer], ['failed', 'Contoso private endpoint SKU support', null]);
  const queryCall = f.state.models.at(-1).input;
  assert.deepEqual(queryCall, { technicalQuestion: 'Which SKU supports private endpoints?' });

  f.state.publicQuery = 'Azure private endpoint SKU support';
  f.state.judgment = { status: 'partial', answer: 'Premium tiers support private endpoints; the workload tier is unconfirmed.', quote: 'A useful public technical summary' };
  const partial = await f.research(f.gap.key);
  assert.deepEqual([partial.ok, partial.status], [true, 'partial']);
  assert.deepEqual(f.state.web.map(call => call.args.query), ['Azure private endpoint SKU support']);
  assert.equal(f.state.models.at(-1).input.evidence.label, 'Public technical search summary');
  saved = partial.investigation.gaps[0];
  assert.deepEqual([saved.status, saved.query, saved.notes, saved.error], ['partial', 'Azure private endpoint SKU support', [UNCITED_WEB_WARNING], null]);
  assert.equal(f.output('situation').needsRefresh, true);
});

test('unverified, unanswered and unmatched research leaves a gap still open without changing outputs', async t => {
  const f = await classifiedGap(t, {
    state: { retrieval: [] },
    onRead: (name, args, signal, state) => (name === 'fetch' ? graph(state.source) : retrieval(...state.retrieval)),
  });
  f.state.judgment = { status: 'answered', answer: 'Bo owns it.', quote: 'Bo confirmed he owns the migration' };
  let result = await f.research(f.gap.key);
  assert.deepEqual([result.ok, result.status], [true, 'still_open']);
  const saved = result.investigation.gaps[0];
  assert.deepEqual([saved.status, saved.answer, saved.quote, saved.sources, saved.notes], ['still_open', null, null, [], [UNVERIFIED_QUOTE_NOTE]]);
  assert.equal(f.output('situation').needsRefresh, false);

  f.state.judgment = { status: 'not_found' };
  result = await f.research(f.gap.key);
  assert.deepEqual(result.investigation.gaps[0].notes, [NOT_FOUND_NOTE]);

  const judged = f.state.models.length;
  f.state.retrieval = ['', 0];
  result = await f.research(f.gap.key);
  assert.equal(result.status, 'still_open');
  assert.deepEqual(result.investigation.gaps[0].notes, [NO_MATCH_NOTICE]);
  assert.equal(f.state.models.length, judged);
  assert.equal(f.output('situation').needsRefresh, false);
});

test('access denial blocks a gap, a partial answer survives later misses and failures, and only researchable kinds run', async t => {
  const f = fixture(t, { state: { modelGaps: ['Who owns the migration?'] } });
  await f.run('situation');
  await assert.rejects(f.research(f.gaps()[0].key), /Classify this gap/);
  await f.triage();
  const { key } = f.gaps()[0];
  f.state.workError = Object.assign(new Error('Access denied.'), { statusCode: 403 });
  let result = await f.research(key);
  let saved = result.investigation.gaps[0];
  assert.deepEqual([result.ok, saved.status, saved.error.statusCode, saved.checkedAt], [false, 'blocked', 403, null]);
  assert.match(saved.query, /^Find information that answers this open question/);

  f.state.workError = null;
  f.state.judgment = { status: 'partial', answer: 'Ada leads it; the backup owner is unknown.', quote: 'Focused work evidence' };
  result = await f.research(key);
  assert.deepEqual([result.ok, result.status, result.kept, result.investigation.gaps[0].error], [true, 'partial', false, null]);
  assert.equal(f.output('situation').needsRefresh, true);

  f.state.judgment = { status: 'not_found' };
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await f.research(key);
    saved = result.investigation.gaps[0];
    assert.deepEqual([result.status, result.kept, saved.status, saved.answer, saved.quote], ['partial', true, 'partial', 'Ada leads it; the backup owner is unknown.', 'Focused work evidence']);
    assert.equal(saved.notes.filter(note => note.startsWith('Searched again on ')).length, 1);
  }
  f.state.workError = Object.assign(new Error('WorkIQ is temporarily unavailable.'), { statusCode: 503 });
  result = await f.research(key);
  saved = result.investigation.gaps[0];
  assert.deepEqual([result.ok, saved.status, saved.answer, saved.error.message], [false, 'partial', 'Ada leads it; the backup owner is unknown.', 'WorkIQ is temporarily unavailable.']);

  f.db.prepare("UPDATE work_output_gaps SET kind='person'").run();
  await assert.rejects(f.research(key), /Ask a person/);
  await assert.rejects(f.research('not-a-listed-gap'), /not in the gap list/);
});

test('gap work and output runs exclude each other, block removal, and Stop is scoped to the gap job', async t => {
  let release = null;
  const f = await classifiedGap(t, {
    onRead: (name, args, signal, state) => {
      if (name === 'fetch') return graph(state.source);
      if (!state.hold) return retrieval();
      return new Promise(resolve => { release = resolve; });
    },
  });
  f.state.hold = true;
  const researching = f.research(f.gap.key);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.get(f.id).gapActivity, { type: 'research', gapKey: f.gap.key });
  await assert.rejects(f.run('situation', 'refresh'), /Gap research is running/);
  await assert.rejects(f.triage(), /already running/);
  await assert.rejects(f.research(f.gap.key), /already running/);
  assert.throws(() => f.service.remove(f.id), /still working/);
  assert.throws(() => f.service.cancel(f.id, 'bogus', 1), /Invalid output area/);
  assert.deepEqual(f.service.cancel(f.id, 'gaps', 2), { ok: true, cancelled: 0 });
  assert.deepEqual(f.service.cancel(f.id, 'gaps', 1), { ok: true, cancelled: 1 });
  const stopped = await researching;
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /Gap research was stopped/);
  assert.deepEqual([stopped.investigation.gapActivity, stopped.investigation.gaps[0].status], [null, 'failed']);
  release(retrieval());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.gaps()[0].status, 'failed');

  release = null;
  const refreshing = f.run('situation', 'refresh');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.triage(), /An output is working/);
  await assert.rejects(f.research(f.gap.key), /An output is working/);
  f.service.cancel(f.id, 'situation', 1);
  assert.equal((await refreshing).ok, false);
  release(retrieval());
  f.state.hold = false;
  const retried = await f.research(f.gap.key);
  assert.deepEqual([retried.ok, retried.status], [true, 'still_open']);
});
