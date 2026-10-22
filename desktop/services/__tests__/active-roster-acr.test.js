'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makeRosterDb } = require('./helpers/roster-db');
const roster = require('../../account-roster');

test('portfolio snapshots are scoped to the exact roster and retain archived and legacy snapshots', async t => {
  const db = makeRosterDb(t);
  roster.saveRoster(db, ['1000', '2000']);
  db.exec("INSERT INTO acr_account_metrics(fiscal_year,fiscal_month,account,acr) VALUES('FY26','FY26-Jun','Legacy EDU',999)");
  const handlers = new Map();
  const selections = [];
  const service = {
    getPortfolio: async ({ tpids }) => {
      selections.push(tpids);
      return { months: ['FY26-Jun'], accounts: tpids.map(tpid => ({ account: `Account ${tpid}`, monthly: { 'FY26-Jun': 100 } })) };
    },
    getAccountMonthlyServiceAcr: async () => ({ months: ['FY26-Jun'], services: [{ service: 'Azure', monthly: { 'FY26-Jun': 200 } }] }),
  };
  const filename = path.join(__dirname, '..', '..', 'acr-ipc.js');
  const local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: name => {
      if (name === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { getPath: () => { throw new Error('Test logger is unavailable'); } } };
      if (name === './sqlite-ipc') return { openDb: () => db };
      if (name === './msx-ipc') return {};
      if (name === './services/acr-querydata') return { createAcrService: () => service };
      return local(name);
    },
    console,
  }, { filename });
  module.exports.registerAcrIpc();
  const event = { senderFrame: { url: 'http://localhost:5173' } };
  const call = (channel, payload) => handlers.get(channel)(event, payload);
  const snapshot = await call('acr-snapshot', { tpids: ['2000', '1000'], fiscalYears: ['FY26'] });
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.accountRows, 2);
  assert.equal((await call('acr-insights')).ok, true);
  roster.saveRoster(db, ['1000']);
  assert.equal((await call('acr-snapshot-status')).last, null);
  assert.match((await call('acr-insights')).error, /active roster/);
  const current = await call('acr-snapshot', { tpids: ['1000'], fiscalYears: ['FY26'] });
  assert.equal(current.ok, true, current.error);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acr_portfolio_snapshots').get().n, 2);
  assert.equal(db.prepare('SELECT acr FROM acr_account_metrics').get().acr, 999);
  assert.deepEqual(Array.from(selections[1]), ['1000']);
  roster.saveRoster(db, ['1000', '2000']);
  assert.equal((await call('acr-snapshot-status')).last.tpid_count, 2);
  assert.equal((await call('acr-insights')).ok, true);
});

test('Anthropic and Foundry IPC preserve the archive boundary and hold roster leases across pending work', async t => {
  for (const fixture of [
    { file: 'acr-ipc.js', channel: 'acr-anthropic-spend', payload: { tpids: ['1000'], fiscalYears: ['FY27'] } },
    { file: 'foundry-usage-ipc.js', channel: 'foundry-usage-customer', payload: { tpid: '1000' } },
    { file: 'foundry-usage-ipc.js', channel: 'foundry-usage-portfolio', payload: {} },
  ]) {
    const db = makeRosterDb(t);
    roster.saveRoster(db, ['1000']);
    const handlers = new Map();
    const selections = [];
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const load = async selection => { selections.push(selection); return pending; };
    const service = { getAnthropicMonthlySpend: load, getCustomer: load, getPortfolio: load };
    const filename = path.join(__dirname, '..', '..', fixture.file);
    const local = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, __dirname: path.dirname(filename), URL, process,
      require: name => {
        if (name === 'electron') return {
          ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
          app: { isPackaged: false, getPath: () => { throw new Error('Test logger is unavailable'); } },
        };
        if (name === './sqlite-ipc') return { openDb: () => db };
        if (name === './msx-ipc') return {};
        if (name === './services/acr-querydata') return { createAcrService: () => service };
        if (name === './services/foundry-usage') return { createFoundryUsageService: () => service };
        return local(name);
      },
      console,
    }, { filename });
    if (fixture.file === 'acr-ipc.js') module.exports.registerAcrIpc();
    else module.exports.registerFoundryUsageIpc();
    const event = { senderFrame: { url: 'http://localhost:5173' } };
    const handler = handlers.get(fixture.channel);
    const denied = await handler({ senderFrame: { url: 'https://example.com' } }, fixture.payload);
    assert.equal(denied.ok, false);
    assert.equal(selections.length, 0);
    const running = handler(event, fixture.payload);
    assert.throws(() => roster.saveRoster(db, []), error => error.code === 'ROSTER_BUSY');
    finish({ grandTotal: 12.34 });
    assert.equal((await running).ok, true);
    assert.equal(selections.length, 1);
    assert.deepEqual(Array.from(selections[0].tpids || [selections[0].tpid]), ['1000']);
    roster.saveRoster(db, []);
    const archived = await handler(event, fixture.payload);
    assert.equal(archived.ok, false);
    assert.ok(['ACCOUNT_ARCHIVED', 'NO_ROSTER'].includes(archived.code));
    assert.equal(selections.length, 1, 'archived selections cannot reuse a cached result or start a pull');
  }
});
