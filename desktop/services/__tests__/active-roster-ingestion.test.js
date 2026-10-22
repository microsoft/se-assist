'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { makeRosterDb } = require('./helpers/roster-db');
const { createAccountScope, saveRoster } = require('../../account-roster');

function ingestionHarness() {
  const stages = [];
  const commands = [];
  const filename = path.join(__dirname, '..', 'm365-ingest.js');
  const requireLocal = createRequire(filename);
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname) { ${fs.readFileSync(filename, 'utf8')}\n})`);
  load(name => {
    if (name === 'electron') return { app: { isPackaged: false, getPath: () => __dirname } };
    if (name === 'fs') return { ...fs,
      writeFileSync: (_file, text) => stages.push(JSON.parse(text)),
      unlinkSync() {},
    };
    if (name === './copilot-provider' || name === './workiq-client') return {};
    if (name === 'child_process') return { spawn: (_command, args) => {
      commands.push(args);
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => { proc.stdout.emit('data', 'complete'); proc.emit('exit', 0); proc.emit('close', 0); });
      return proc;
    } };
    return requireLocal(name);
  }, module, module.exports, path.dirname(filename));
  return { ...module.exports, stages, commands };
}

function scope(t) {
  const db = makeRosterDb(t);
  db.exec("INSERT INTO customers(name,tpid) VALUES('Current Finance','1000'),('Past Education','1017')");
  saveRoster(db, ['1000']);
  return createAccountScope(db);
}

test('calendar ingestion discovers metadata but never fetches or stages archived-only event bodies', async t => {
  const h = ingestionHarness();
  const detailRequests = [];
  const result = await h.ingestMeetings({
    fetchAll: async url => {
      const fields = new URL(url, 'https://graph.microsoft.com').searchParams.get('$select').split(',');
      assert.equal(fields.includes('body'), false);
      return { value: [
        { id: 'current-event', subject: 'Current Finance planning' },
        { id: 'archived-event', subject: 'Past Education planning' },
      ] };
    },
    fetchOne: async url => {
      detailRequests.push(url);
      assert.ok(url.startsWith('/me/events/current-event?'));
      return { value: [{ id: 'current-event', subject: 'Current Finance planning', body: { content: 'Full active meeting body' } }] };
    },
  }, { months: 1, futureMonths: 1, accountScope: scope(t), aiEnv: {} });
  assert.ok(detailRequests.length > 0);
  assert.equal(result.stagedEvents, detailRequests.length);
  assert.ok(h.stages.every(stage => stage.value.length === 1 && stage.value[0].body.content === 'Full active meeting body'));
});

for (const failure of ['wrong event', 'missing body', 'access denied']) {
  test(`calendar ingestion surfaces ${failure} without staging a substitute or reporting success`, async t => {
    const h = ingestionHarness();
    await assert.rejects(h.ingestMeetings({
      fetchAll: async () => ({ value: [{ id: 'current-event', subject: 'Current Finance' }] }),
      fetchOne: async () => {
        if (failure === 'access denied') throw new Error('Access denied');
        return { value: [{ id: failure === 'wrong event' ? 'other-event' : 'current-event', body: failure === 'missing body' ? undefined : { content: 'Wrong source' } }] };
      },
    }, { accountScope: scope(t), aiEnv: {} }), /Meeting pull failed/);
    assert.equal(h.stages.length, 0);
    assert.equal(h.commands.length, 0);
  });
}
