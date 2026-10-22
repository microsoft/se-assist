'use strict';

// Runs the real app-ipc.js influence handlers in a vm with the real engine, store, agent
// catalog and prompts, a migrated in-memory database and a recording Copilot stub. Any
// network call fails the test: the analysis runs only on GitHub Copilot, never Foundry.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const agents = require('../agents');
const prompts = require('../agents/prompts');
const secretaryScan = require('../secretary-scan');
const influence = require('../stakeholder-influence');
const store = require('../stakeholder-influence-store');

const appIpcPath = path.join(__dirname, '..', '..', 'app-ipc.js');
const migration = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8');
// Foundry settings left over in the environment must never be used by the influence map.
const LEFTOVER_FOUNDRY_ENV = Object.freeze({
  AI_FOUNDRY_ENDPOINT: 'https://example.openai.azure.com',
  AI_FOUNDRY_DEPLOYMENT: 'foundry-deployment',
  AI_FOUNDRY_API_KEY: 'test-key',
});
const unusedDependencies = new Set([
  './msx-ipc', './acr-ipc', './capacity-ipc', './services/owned-accounts',
  './services/m365-ingest', './services/outlook-link', './services/meeting-transcript', './services/teams-chat-message',
  './services/customer-tasks', './services/meeting-tasks', './services/work-outputs', './services/email-search', './services/work-agent-tools',
  './services/research-dossier', './services/signal-links', './services/workload-suggestion-dedup',
  './services/workload-concept-key', './services/customer-insights', './services/customer-relationship-graph',
  './services/html-render', './services/row-mappers', './services/safe-json', './services/intelligence',
]);
const EMAIL_ADDRESS = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const ADA = 'ada@contoso.com';
const BOB = 'bob@contoso.com';
const MINA = 'mina@microsoft.com';
// Handler results are built inside the vm realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

const databases = [];
after(() => {
  for (const raw of databases) raw.close();
});

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('CREATE TABLE customers(tpid TEXT, name TEXT, parent_crm_account_id TEXT)');
  for (const name of [
    '001_customer_workspace_cache.sql', '005_email_inventory.sql', '006_customer_account_team.sql',
    '007_meeting_inventory.sql', '011_customer_contacts.sql', '026_meeting_notes.sql', '031_stakeholder_influence.sql',
    '032_retire_stakeholder_influence_opt_in.sql',
  ]) raw.exec(migration(name));
  raw.exec('CREATE VIEW active_cached_customer_profiles AS SELECT * FROM cached_customer_profiles');
  let depth = 0;
  return {
    raw,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      return (...args) => {
        const savepoint = `influence_ipc_${depth++}`;
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

function seed(db) {
  const recipients = (...people) => JSON.stringify(people.map(([name, address]) => ({ name, address })));
  const attendees = JSON.stringify([
    { emailAddress: { name: 'Bob Buyer', address: BOB }, type: 'required' },
    { emailAddress: { name: 'Mina Internal', address: MINA }, type: 'required' },
  ]);
  const transcript = [
    'Ada Customer: I want the pilot live before the board meeting',
    'Bob Buyer: I cannot approve spend until security signs off',
    'Mina Internal: I will schedule the security review',
  ].join('\n');
  db.prepare("INSERT INTO customers VALUES ('T-1', 'Contoso', NULL), ('T-2', 'Fabrikam', NULL)").run();
  db.prepare(
    "INSERT INTO customer_account_team (tpid, person_name, person_email, org) VALUES ('T-1', 'Mina Internal', ?, 'microsoft')",
  ).run(MINA);
  db.prepare(
    `INSERT INTO customer_contacts (contact_id, tpid, full_name, job_title, email) VALUES
       ('c1', 'T-1', 'Ada Customer', 'CIO', ?), ('c2', 'T-1', 'Bob Buyer', 'Procurement Lead', ?)`,
  ).run(ADA, BOB);
  const email = db.prepare(
    `INSERT INTO emails (message_id, conversation_id, subject, from_name, from_address, to_json, cc_json, sent_at, body_text)
     VALUES (?, 'budget', 'Fabric pilot budget', ?, ?, ?, ?, ?, ?)`,
  );
  email.run('e1', 'Ada Customer', ADA, recipients(['Bob Buyer', BOB]), recipients(['Mina Internal', MINA]),
    '2026-01-01T10:00:00Z', 'We will fund the Fabric pilot from the Q3 budget.');
  email.run('e2', 'Bob Buyer', BOB, recipients(['Ada Customer', ADA]), '[]',
    '2026-01-02T10:00:00Z', 'Procurement needs the security review before signing.');
  db.prepare("INSERT INTO email_customer_links (message_id, tpid, match_method) VALUES ('e1', 'T-1', 'alias'), ('e2', 'T-1', 'alias')").run();
  db.prepare(
    `INSERT INTO meetings (event_id, subject, organizer_name, organizer_address, attendees_json, start_at)
     VALUES ('arch', 'Architecture review', 'Ada Customer', ?, ?, '2026-01-03T10:00:00Z')`,
  ).run(ADA, attendees);
  db.prepare("INSERT INTO meeting_customer_links (event_id, tpid, match_method) VALUES ('arch', 'T-1', 'alias')").run();
  db.prepare("INSERT INTO meeting_notes (event_id, transcript) VALUES ('arch', ?)").run(transcript);
}

// The model is shown P#/M#/E# handles only; the reply names people by the handles it was given.
function defaultReply(context) {
  const ref = (name) => context.people.find((person) => person.name === name)?.ref;
  const people = [];
  if (ref('Ada Customer')) {
    people.push({
      personRef: ref('Ada Customer'), stance: 'champion', confidence: 'high', decisionRole: 'Budget owner',
      reason: 'Budget owner who is pushing for the pilot.',
      evidence: [{ sourceRef: 'M1', quote: 'I want the pilot live before the board meeting' }],
      adoptedSuggestions: [],
    });
  }
  if (ref('Bob Buyer')) {
    people.push({
      personRef: ref('Bob Buyer'), stance: 'blocker', confidence: 'medium', decisionRole: 'Procurement',
      reason: 'Holds spend until the security review is done.',
      evidence: [{ sourceRef: 'E1', quote: 'I will approve spend immediately' }],
      adoptedSuggestions: [{
        suggestion: 'Run a security review before signing', adoptedAs: 'Microsoft scheduled the security review',
        sourceRefs: ['M1'], quote: 'I will schedule the security review',
      }],
    });
  }
  return JSON.stringify({ people, caveats: ['Only one meeting transcript.'] });
}

function harness({ signedIn = true, probe = { ok: true }, env = {} } = {}) {
  const handlers = new Map();
  const modelCalls = [];
  const fetchCalls = [];
  const db = makeDb();
  seed(db);
  // Tests change the reply, finish reason or mid-run behaviour through this object.
  const state = { reply: defaultReply, finishReason: 'stop', beforeReply: null };
  const prefs = new Map();
  const stubs = {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { isPackaged: false } },
    './sqlite-ipc': { openDb: () => db },
    './account-roster': { getEffectiveTpids: () => ['T-1'], withRosterWork: require('../../account-roster').withRosterWork },
    './services/app-prefs': {
      get: (key, fallback) => (prefs.has(key) ? prefs.get(key) : fallback),
      set: (key, value) => prefs.set(key, value),
    },
    './services/github-auth': { isSignedIn: () => signedIn },
    './services/copilot-provider': {
      probe: async () => probe,
      getModelName: () => 'settings-model',
      chat: async (system, user, options) => {
        // The same context the handler just built, so the reply can use its handles.
        const { context } = influence.buildAnalystContext(store.loadAccountInputs(db, 'T-1'));
        modelCalls.push({ system, user, options, context });
        if (state.beforeReply) await state.beforeReply();
        return { content: state.reply(context), finishReason: state.finishReason, model: 'copilot-test-model' };
      },
    },
    './services/model-request-scheduler': require('../model-request-scheduler'),
    './services/identity-store': { getSavedName: () => '' },
    './services/workiq-client': { getWorkIqClient: () => { throw new Error('The influence map must not use WorkIQ.'); } },
    './services/workiq-auth': { ensureConnected: async () => { throw new Error('The influence map must not use WorkIQ.'); } },
    './services/secretary-scan': secretaryScan,
    './services/agents': agents,
    './services/agents/prompts': prompts,
    './services/stakeholder-influence': influence,
    './services/stakeholder-influence-store': store,
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname: path.dirname(appIpcPath),
    require: (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (unusedDependencies.has(name)) return Object.freeze({});
      if (isBuiltin(name)) return require(name);
      throw new Error(`Unexpected influence IPC test dependency: ${name}`);
    },
    process: { env, platform: process.platform, resourcesPath: path.dirname(appIpcPath) },
    URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: init?.body });
      throw new Error('The influence map must not make network calls (Foundry is not used).');
    },
    console: { ...console, log: () => {} },
  };
  vm.runInNewContext(fs.readFileSync(appIpcPath, 'utf8'), context, { filename: appIpcPath });
  module.exports.registerAppIpc();
  const event = { senderFrame: { url: 'http://localhost:5173' } };
  const call = async (channel, payload) => plain(await handlers.get(channel)(event, payload));
  return { call, db, modelCalls, fetchCalls, state, channels: [...handlers.keys()] };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const person = (result, id) => result.people.find((item) => item.id === id);
const INFLUENCE_CHANNELS = [
  'influence-map-get', 'influence-map-analyze', 'influence-override-set', 'influence-assessment-clear',
];

test('the influence map is always available: there is no opt-in step, setting or channel', async () => {
  const client = harness();
  assert.deepEqual(client.channels.filter((channel) => channel.startsWith('influence-')).sort(), [...INFLUENCE_CHANNELS].sort());
  assert.equal(
    client.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stakeholder_influence_settings'").get().n,
    0,
    'migration 032 removed the opt-in table',
  );

  const map = await client.call('influence-map-get', { tpid: 'T-1' });
  assert.equal(map.ok, true, map.error);
  assert.deepEqual(map.people.map((item) => item.id).sort(), [ADA, BOB]);
  const corrected = await client.call('influence-override-set', { tpid: 'T-1', personId: ADA, stance: 'champion' });
  assert.equal(corrected.ok, true, corrected.error);
  const analyzed = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(analyzed.ok, true, analyzed.error);
  assert.equal(client.modelCalls.length, 1);
  const cleared = await client.call('influence-assessment-clear', { tpid: 'T-1' });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(cleared.cleared, true);
});

test('the influence map serves only roster accounts and profiles only people outside Microsoft', async () => {
  const client = harness();
  assert.deepEqual(await client.call('influence-map-get', {}), { ok: false, error: 'tpid is required' });
  const other = await client.call('influence-map-get', { tpid: 'T-2' });
  assert.equal(other.ok, false);
  assert.match(other.error, /not in the signed-in user's roster/);

  const map = await client.call('influence-map-get', { tpid: 'T-1' });
  assert.equal(map.ok, true);
  assert.equal(map.analyzing, false);
  assert.equal(map.copilotConnected, true);
  assert.equal(map.account, 'Contoso');
  assert.deepEqual(map.people.map((item) => item.id).sort(), [ADA, BOB]);
  assert.ok(map.people.every((item) => item.affiliation === 'customer'));
  assert.equal(map.people.some((item) => item.id === MINA), false);
  assert.equal(map.sources.emails, 2);
  assert.equal(map.sources.meetings, 1);
  assert.equal(map.sources.transcripts, 1);
  assert.equal(map.assessment, null);
  assert.equal(person(map, ADA).scoreBasis, 'with-transcripts');
  assert.equal(person(map, ADA).stance, null);
  assert.ok(person(map, ADA).evidence.length > 0);
  assert.equal(client.modelCalls.length, 0, 'reading the map never calls a model');
});

test('Analyze saves a verified, email-free Copilot assessment that the map then shows', async () => {
  const client = harness({ env: LEFTOVER_FOUNDRY_ENV });
  const result = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.meta, { provider: 'github-copilot', model: 'copilot-test-model', people: 2, transcripts: 1, emailThreads: 1 });
  assert.equal(client.fetchCalls.length, 0, 'leftover Foundry settings are never used');

  assert.equal(client.modelCalls.length, 1);
  const [{ system, user, options }] = client.modelCalls;
  assert.equal(options.requestLabel, 'Stakeholder Influence Analyst');
  assert.equal(options.modelPinned, undefined);
  assert.doesNotMatch(system, EMAIL_ADDRESS);
  assert.doesNotMatch(user, EMAIL_ADDRESS);
  assert.match(user, /Ada Customer \[P\d\]/);
  assert.match(user, /Mina Internal \[Microsoft\]/);

  const ada = person(result, ADA);
  assert.equal(ada.stance, 'champion');
  assert.equal(ada.stanceSource, 'ai');
  assert.equal(ada.ai.confidence, 'high');
  assert.equal(ada.ai.evidence[0].verified, true);
  assert.equal(ada.ai.evidence[0].source.kind, 'transcript');
  assert.equal(ada.ai.evidence[0].source.id, 'arch');
  const bob = person(result, BOB);
  assert.equal(bob.stance, 'blocker');
  assert.equal(bob.ai.evidence[0].verified, false, 'a quote that is not in the source is flagged, not trusted');
  assert.equal(bob.ai.adoptedSuggestions[0].verified, true);
  assert.equal(result.assessment.provider, 'github-copilot');
  assert.equal(result.assessment.model, 'copilot-test-model');
  assert.equal(result.assessment.stale, false);
  assert.deepEqual(result.assessment.caveats, ['Only one meeting transcript.']);

  const map = await client.call('influence-map-get', { tpid: 'T-1' });
  assert.equal(map.assessment.stale, false);
  assert.equal(person(map, ADA).stance, 'champion');

  const cleared = await client.call('influence-assessment-clear', { tpid: 'T-1' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.assessment, null);
  assert.equal(person(cleared, ADA).stance, null);
  assert.equal((await client.call('influence-assessment-clear', { tpid: 'T-1' })).cleared, false);
});

test('an unreadable or cut-off AI response saves nothing', async () => {
  const client = harness();
  client.state.reply = () => 'Here is my analysis: Ada is a champion.';
  const invalid = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /^Influence analysis failed: The AI returned an invalid stakeholder assessment \(not valid JSON\)\. Nothing was saved\./);

  client.state.reply = defaultReply;
  client.state.finishReason = 'length';
  const cutOff = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(cutOff.ok, false);
  assert.match(cutOff.error, /The AI response was cut off before it finished\. Nothing was saved\./);

  client.state.finishReason = 'content_filter';
  assert.match((await client.call('influence-map-analyze', { tpid: 'T-1' })).error, /did not finish \(content_filter\)/);

  client.state.finishReason = 'stop';
  client.state.reply = (context) => JSON.stringify({ people: [{ personRef: 'P9', stance: 'champion', confidence: 'high', reason: 'x' }], caveats: [] });
  assert.match((await client.call('influence-map-analyze', { tpid: 'T-1' })).error, /unknown person "P9"/);

  assert.equal(count(client.db, 'stakeholder_assessments'), 0);
  assert.equal((await client.call('influence-map-get', { tpid: 'T-1' })).analyzing, false);
});

test('Analyze stops before any model call when the only text is a broadcast email and an all-hands transcript', async () => {
  const client = harness();
  const crowd = Array.from({ length: 21 }, (_, index) => ({ name: `Crowd ${index + 1}`, address: `crowd${index + 1}@contoso.com` }));
  client.db.prepare("DELETE FROM email_customer_links WHERE tpid = 'T-1'").run();
  client.db.prepare("DELETE FROM meeting_notes WHERE event_id = 'arch'").run();
  client.db.prepare(
    `INSERT INTO emails (message_id, conversation_id, subject, from_name, from_address, to_json, cc_json, sent_at, body_text)
     VALUES ('news', 'news', 'Company newsletter', 'Ada Customer', ?, ?, '[]', '2026-01-04T10:00:00Z', 'Quarterly newsletter for everyone')`,
  ).run(ADA, JSON.stringify(crowd));
  client.db.prepare("INSERT INTO email_customer_links (message_id, tpid, match_method) VALUES ('news', 'T-1', 'alias')").run();
  client.db.prepare(
    `INSERT INTO meetings (event_id, subject, organizer_name, organizer_address, attendees_json, start_at)
     VALUES ('all-hands', 'All hands', 'Ada Customer', ?, ?, '2026-01-05T10:00:00Z')`,
  ).run(ADA, JSON.stringify(crowd.map((item) => ({ emailAddress: item, type: 'required' }))));
  client.db.prepare("INSERT INTO meeting_customer_links (event_id, tpid, match_method) VALUES ('all-hands', 'T-1', 'alias')").run();
  client.db.prepare("INSERT INTO meeting_notes (event_id, transcript) VALUES ('all-hands', 'Ada Customer: welcome everyone')").run();

  const map = await client.call('influence-map-get', { tpid: 'T-1' });
  assert.equal(map.ok, true);
  assert.deepEqual(map.people.map((item) => item.id).sort(), [ADA, BOB]);
  assert.equal(map.sources.broadcastEmails, 1);
  assert.equal(map.sources.broadcastMeetings, 1);
  assert.equal(map.sources.broadcastTranscripts, 1);
  assert.equal(map.sources.transcripts, 0);

  const result = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_text');
  assert.match(result.error, /no linked meeting transcripts or readable email text/);
  assert.equal(client.modelCalls.length, 0);
  assert.equal(count(client.db, 'stakeholder_assessments'), 0);
});

test('the AI analysis runs only on GitHub Copilot and never reaches Foundry', async () => {
  for (const env of [{}, LEFTOVER_FOUNDRY_ENV]) {
    const offline = harness({ signedIn: false, env });
    const map = await offline.call('influence-map-get', { tpid: 'T-1' });
    assert.equal(map.ok, true);
    assert.equal(map.copilotConnected, false);
    assert.equal(map.people.length, 2, 'the signal map itself needs no model');
    assert.deepEqual(await offline.call('influence-map-analyze', { tpid: 'T-1' }), {
      ok: false,
      reason: 'copilot_required',
      error: 'The Stakeholder Influence Map analysis runs only on GitHub Copilot. Connect GitHub Copilot in User Home → GitHub sign-in.',
    });
    assert.equal(offline.fetchCalls.length, 0, 'Foundry settings are never used');
    assert.equal(offline.modelCalls.length, 0);
    assert.equal(count(offline.db, 'stakeholder_assessments'), 0);
    assert.equal((await offline.call('influence-map-get', { tpid: 'T-1' })).analyzing, false);
  }

  const expired = harness({ probe: { ok: false, error: 'Token expired.' }, env: LEFTOVER_FOUNDRY_ENV });
  assert.deepEqual(await expired.call('influence-map-analyze', { tpid: 'T-1' }), {
    ok: false,
    error: 'Influence analysis failed: GitHub Copilot is unavailable: Token expired.',
  });
  assert.equal(expired.fetchCalls.length, 0, 'an unavailable Copilot session never switches to Foundry');
  assert.equal(expired.modelCalls.length, 0);
  assert.equal(count(expired.db, 'stakeholder_assessments'), 0);
});

test('corrections are validated and allowed only for people on this account\'s map', async () => {
  const client = harness();
  const cases = [
    [{ personId: MINA, stance: 'champion' }, /not on this account's influence map/],
    [{ personId: 'nobody@contoso.com', stance: 'champion' }, /not on this account's influence map/],
    [{ stance: 'champion' }, /^personId is required$/],
    [{ personId: ADA }, /^Nothing to change/],
    [{ personId: ADA, stance: 'kingmaker' }, /^Stance must be one of:/],
    [{ personId: ADA, hidden: 'yes' }, /^hidden must be true or false\.$/],
    [{ personId: ADA, note: 42 }, /^The note must be text\.$/],
    [{ personId: ADA, note: 'x'.repeat(501) }, /^The note is 501 characters; the limit is 500\.$/],
  ];
  for (const [payload, error] of cases) {
    const result = await client.call('influence-override-set', { tpid: 'T-1', ...payload });
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.match(result.error, error, JSON.stringify(payload));
  }
  assert.equal(count(client.db, 'stakeholder_overrides'), 0);
});

test('your stance wins over the AI, and excluding a person removes them from the map and the model input', async () => {
  const client = harness();
  const analyzed = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(analyzed.ok, true, analyzed.error);
  const touchesBob = (map) => map.map.edges.some((edge) => edge.source === BOB || edge.target === BOB);
  assert.ok(touchesBob(analyzed));

  const corrected = await client.call('influence-override-set', { tpid: 'T-1', personId: BOB, stance: 'champion', note: 'Signed off in the hallway.' });
  assert.equal(corrected.ok, true, corrected.error);
  const bob = person(corrected, BOB);
  assert.equal(bob.stance, 'champion');
  assert.equal(bob.stanceSource, 'you');
  assert.deepEqual(bob.override, { stance: 'champion', note: 'Signed off in the hallway.' });
  assert.equal(bob.ai.stance, 'blocker', 'the AI judgement stays visible next to your correction');
  assert.equal(corrected.assessment.stale, false, 'a stance or note does not change the model input');

  const hidden = await client.call('influence-override-set', { tpid: 'T-1', personId: BOB, hidden: true });
  assert.equal(hidden.ok, true, hidden.error);
  assert.equal(person(hidden, BOB), undefined);
  assert.deepEqual(hidden.hiddenPeople, [{ id: BOB, name: 'Bob Buyer', affiliation: 'customer' }]);
  assert.equal(hidden.map.nodes.some((node) => node.id === BOB), false);
  assert.equal(touchesBob(hidden), false);
  assert.equal(hidden.assessment.stale, true);

  const reanalyzed = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(reanalyzed.ok, true, reanalyzed.error);
  assert.equal(reanalyzed.meta.people, 1);
  assert.doesNotMatch(client.modelCalls.at(-1).user, /Bob Buyer/);
  assert.match(client.modelCalls.at(-1).user, /Hidden participant: \[omitted\]/);
  assert.equal(reanalyzed.assessment.stale, false);

  const restored = await client.call('influence-override-set', { tpid: 'T-1', personId: BOB, hidden: false });
  assert.equal(restored.ok, true, restored.error);
  assert.deepEqual(restored.hiddenPeople, []);
  const back = person(restored, BOB);
  assert.equal(back.stance, 'champion');
  assert.equal(back.stanceSource, 'you');
  assert.equal(back.ai, null, 'the analysis made while Bob was excluded has no judgement about him');
  assert.equal(restored.assessment.stale, true);

  const cleared = await client.call('influence-override-set', { tpid: 'T-1', personId: BOB, stance: null, note: '' });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(count(client.db, 'stakeholder_overrides'), 0);
  assert.equal(person(cleared, BOB).stanceSource, null);
});

test('an analysis drops people excluded while it was running', async () => {
  const client = harness();
  client.state.beforeReply = async () => {
    await client.call('influence-override-set', { tpid: 'T-1', personId: BOB, hidden: true });
  };
  const excluded = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(excluded.ok, true, excluded.error);
  assert.equal(excluded.meta.people, 2);
  assert.equal(person(excluded, BOB), undefined);
  const saved = JSON.parse(client.db.prepare('SELECT result_json FROM stakeholder_assessments WHERE tpid = ?').get('T-1').result_json);
  assert.deepEqual(saved.people.map((item) => item.personId), [ADA]);
  assert.equal(excluded.assessment.stale, true);
});

test('one analysis per account at a time; while it runs, delete is refused and the map shows it', async () => {
  const client = harness();
  const during = {};
  client.state.beforeReply = async () => {
    client.state.beforeReply = null;
    during.second = await client.call('influence-map-analyze', { tpid: 'T-1' });
    during.clear = await client.call('influence-assessment-clear', { tpid: 'T-1' });
    during.map = await client.call('influence-map-get', { tpid: 'T-1' });
  };
  const first = await client.call('influence-map-analyze', { tpid: 'T-1' });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.analyzing, false);
  assert.deepEqual(during.second, { ok: false, reason: 'busy', error: 'An influence analysis is already running for this account.' });
  assert.deepEqual(during.clear, {
    ok: false, reason: 'busy', error: 'An analysis is running for this account. Wait for it to finish, then delete it.',
  });
  assert.equal(during.map.analyzing, true);
  assert.equal(client.modelCalls.length, 1);
  assert.equal(count(client.db, 'stakeholder_assessments'), 1);
});
