'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const roster = require('../../account-roster');
const { makeRosterDb } = require('./helpers/roster-db');

function syncHarness(t) {
  const db = makeRosterDb(t);
  for (let i = 0; i < 260; i++) {
    db.prepare('INSERT INTO customers(name,tpid,crm_account_id) VALUES(?,?,?)').run(`Account ${i}`, String(1000 + i), `account-${i}`);
    db.prepare('INSERT INTO opportunities(opportunity_id,parent_account_id,name) VALUES(?,?,?)').run(`opp-${i}`, `account-${i}`, `Opportunity ${i}`);
    db.prepare('INSERT INTO milestones(milestone_id,opportunity_id,name) VALUES(?,?,?)').run(`ms-${i}`, `opp-${i}`, `Milestone ${i}`);
    db.prepare('INSERT INTO hok_tasks(activity_id,regarding_id) VALUES(?,?)').run(`task-${i}`, `ms-${i}`);
  }
  roster.saveRoster(db, Array.from({ length: 17 }, (_, i) => String(1000 + i)));
  const requests = [];
  let authCalls = 0;
  const dependencies = {
    dbQuery: async (sql, params = []) => db.prepare(sql).all(...params),
    dbRun: async (sql, params = []) => roster.runActiveWrite(db, sql, params.map(value => value ?? null)),
    getMsxTpids: async () => roster.getEffectiveTpids(db),
    withCrmSync: work => roster.withRosterWork('CRM regression', work),
    ensureAuth: async () => { authCalls++; },
    crmRequest: async request => {
      requests.push(request);
      if (request.path.endsWith('/WhoAmI')) return { ok: true, data: { UserId: 'user-1' } };
      if (request.path.includes('/systemusers(')) return { ok: true, data: { fullname: 'Test user' } };
      if (request.path.endsWith('/opportunities')) {
        const ids = [...request.query.$filter.matchAll(/account-(\d+)/g)].map(match => Number(match[1]));
        return { ok: true, data: { value: ids.map(i => ({ opportunityid: `opp-${i}`, name: `Opportunity ${i}`, _parentaccountid_value: `account-${i}` })) } };
      }
      if (request.path.endsWith('/msp_engagementmilestones')) {
        const ids = [...request.query.$filter.matchAll(/opp-(\d+)/g)].map(match => Number(match[1]));
        return { ok: true, data: { value: ids.map(i => ({ msp_engagementmilestoneid: `ms-${i}`, msp_name: `Milestone ${i}`, _msp_opportunityid_value: `opp-${i}` })) } };
      }
      return { ok: true, data: { value: [] } };
    },
    normId: value => String(value || '').replace(/[{}]/g, '').toLowerCase(),
    parseTeamList: value => value ? value.split(',') : [],
    chunkArray: (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size)),
    MAX_CONCURRENT_REQUESTS: 3,
    mapWithConcurrency: async (list, _limit, work) => Promise.all(list.map(work)),
    console,
  };
  function load(name, exports) {
    const filename = path.join(__dirname, '..', '..', '..', 'src', 'frontend', 'src', 'lib', name);
    const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export \{.*\};\r?$/gm, '').replace(/^export /gm, '');
    const module = { exports: {} };
    vm.runInNewContext(`${source}\nmodule.exports={${exports.join(',')}};`, { ...dependencies, module }, { filename });
    return module.exports;
  }
  const hok = load('hokActivities.js', ['syncHokTasks', 'fetchOwnedTasks', 'fetchTasksRegarding']);
  dependencies.syncHokTasks = hok.syncHokTasks;
  const sync = load('sync.js', ['syncCustomers', 'syncMilestones', 'syncContacts']);
  return { db, requests, ...sync, ...hok, authCalls: () => authCalls };
}

test('17 saved TPIDs scope CRM and HoK requests even with 260 cached accounts and years of milestones', async t => {
  const h = syncHarness(t);
  await h.syncCustomers();
  const customerCalls = h.requests.filter(request => request.path.endsWith('/accounts'));
  assert.equal(customerCalls.length, 17);
  assert.equal(customerCalls.some(request => request.query.$filter.includes("'1017'")), false);
  await h.syncMilestones();
  await h.syncContacts();
  await h.syncHokTasks();
  const accountQueries = h.requests.filter(request => /\/(opportunities|contacts)$/.test(request.path));
  for (const request of accountQueries) {
    const ids = [...request.query.$filter.matchAll(/account-(\d+)/g)].map(match => Number(match[1]));
    assert.ok(ids.length > 0 && ids.length <= 17);
    assert.ok(ids.every(id => id < 17));
  }
  for (const endpoint of ['/opportunities', '/contacts']) {
    const ids = new Set(accountQueries.filter(request => request.path.endsWith(endpoint))
      .flatMap(request => [...request.query.$filter.matchAll(/account-(\d+)/g)].map(match => Number(match[1]))));
    assert.equal(ids.size, 17);
  }
  const activityQueries = h.requests.filter(request => request.path.endsWith('/tasks'));
  const activityFilter = activityQueries.map(request => request.query.$filter).join(' ');
  assert.match(activityFilter, /ms-0'/);
  assert.doesNotMatch(activityFilter, /(?:account|opp|ms)-17'/);
  const milestoneQueries = h.requests.filter(request => request.path.endsWith('/msp_engagementmilestones'));
  assert.ok(milestoneQueries.length > 0);
  assert.doesNotMatch(milestoneQueries.map(request => request.query.$filter).join(' '), /opp-17'/);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM hok_tasks').get().n, 243, 'archived HoK rows are not replaced by an active refresh');
  await assert.rejects(h.fetchTasksRegarding(['ms-17']), /archived/);
});

test('an empty saved roster causes no CRM authentication or network requests', async t => {
  const h = syncHarness(t);
  roster.saveRoster(h.db, []);
  for (const run of [h.syncCustomers, h.syncMilestones, h.syncContacts, h.syncHokTasks]) await assert.rejects(run(), /No active|No default/);
  assert.equal(h.authCalls(), 0);
  assert.equal(h.requests.length, 0);
});

test('WorkIQ ingestion uses the saved roster and never invokes owned-account discovery', async t => {
  const h = syncHarness(t);
  const filename = path.join(__dirname, '..', '..', 'app-ipc.js');
  let discovered = 0;
  let connected = 0;
  const pulls = [];
  const stubs = {
    electron: { app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } },
    './sqlite-ipc': { openDb: () => h.db },
    './account-roster': roster,
    './services/agents': require('../agents'),
    './services/app-prefs': { set() {} },
    './services/owned-accounts': { deriveOwnedAccounts: async () => { discovered++; throw new Error('Discovery must not run during ingestion.'); } },
    './services/workiq-auth': { ensureConnected: async () => { connected++; return { connected: true }; } },
    './services/m365-ingest': { runIngestion: async options => {
      pulls.push(options.accounts.map(account => account.tpid));
      assert.throws(() => roster.saveRoster(h.db, []), /still running/);
      return { results: [], errors: [], ranAt: '2026-10-01T00:00:00Z' };
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => stubs[name] || (isBuiltin(name) ? require(name) : {}),
    process: { env: {} }, console, URL, setTimeout, clearTimeout,
  }, { filename });
  const result = await module.exports.runIngestionJob();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.accounts, 17);
  assert.equal(pulls[0].length, 17);
  assert.equal(discovered, 0);
  roster.saveRoster(h.db, []);
  const empty = await module.exports.runIngestionJob();
  assert.equal(empty.ok, false);
  assert.match(empty.error, /No active accounts/);
  assert.equal(connected, 1);
  assert.equal(pulls.length, 1);
});
