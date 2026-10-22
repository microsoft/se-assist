'use strict';

// ingestEmail must report which account searches failed. email_sync.last_run_at still
// advances after the refresh pass, so without this list a consumer of the stored mail
// (the Action Center Secretary) could not tell the user that some accounts were not
// refreshed by the latest pull.
//
// m365-ingest.js requires electron and destructures child_process.spawn at load, so both
// are intercepted through Module._load before the module is required. The fake spawn
// completes every Python pipeline step successfully on the next tick.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const realCp = require('node:child_process');
const spawnCalls = [];

function fakeSpawn(cmd, args) {
  const proc = new EventEmitter();
  proc.pid = 2000 + spawnCalls.length;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  proc.unref = () => {};
  spawnCalls.push({ cmd, args });
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from('refresh complete\n'));
    proc.emit('exit', 0, null);
    proc.emit('close', 0);
  });
  return proc;
}

const fakeApp = {
  isPackaged: false,
  getPath: () => os.tmpdir(),
  getName: () => 'se-assist',
  on: () => {},
  whenReady: () => Promise.resolve(),
};

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return { app: fakeApp };
  if (request === 'child_process' || request === 'node:child_process') {
    return { ...realCp, spawn: fakeSpawn };
  }
  return origLoad.call(this, request, parent, isMain);
};

let ingest;
try {
  ingest = require('../m365-ingest');
} finally {
  Module._load = origLoad;
}

test('ingestEmail returns the accounts whose mailbox search failed', async () => {
  spawnCalls.length = 0;
  const searched = [];
  const wiq = {
    async fetchAll(url) {
      searched.push(decodeURIComponent(url));
      if (url.includes('Fabrikam')) throw new Error('WorkIQ request failed (429): throttled');
      return { value: [{ id: 'm1', subject: 'Contoso renewal' }] };
    },
  };
  const progress = [];

  const res = await ingest.ingestEmail(wiq, [
    { name: 'Contoso', tpid: '111' },
    { name: 'Fabrikam', tpid: '222' },
    { name: '   ', tpid: '333' },
  ], { topPerAccount: 40, onProgress: (p) => progress.push(p) });

  assert.strictEqual(searched.length, 2, 'blank account names are not searched');
  assert.strictEqual(res.medium, 'email');
  assert.strictEqual(res.stagedMessages, 1);
  assert.deepStrictEqual(res.failedAccounts, [
    { account: 'Fabrikam', error: 'WorkIQ request failed (429): throttled' },
  ]);
  assert.ok(progress.some((p) => p.phase === 'warn' && /Fabrikam: WorkIQ request failed/.test(p.detail)));
  const pipeline = spawnCalls.map((c) => c.args.slice(0, 4).join(' '));
  assert.ok(pipeline.some((a) => a.includes('tools.email.cli stage-raw')), 'the successful account is staged');
  assert.ok(pipeline.some((a) => a.includes('tools.email.cli refresh')), 'the refresh pass still runs');
});

test('ingestEmail reports no failed accounts when every search succeeds', async () => {
  const wiq = { async fetchAll() { return { value: [] }; } };
  const res = await ingest.ingestEmail(wiq, [{ name: 'Contoso', tpid: '111' }], {});
  assert.deepStrictEqual(res.failedAccounts, []);
  assert.strictEqual(res.stagedMessages, 0);
});
