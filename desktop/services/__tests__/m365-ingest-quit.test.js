'use strict';

// Regression guard for the quit-time cleanup of in-flight ingest pipelines.
//
// The bug this protects against: ingest work runs in spawned Python child processes that
// open seassist.db directly. spawn() children are NOT in a Windows job object, so if the
// app quits mid-ingest they orphan and keep writing to the DB after the app exits (and can
// trip a fast relaunch with a locked DB). main.js 'before-quit' must tree-kill them via
// stopActiveIngestChildren(). This test verifies the tracking + kill + removal contract.
//
// m365-ingest.js requires electron and destructures child_process.spawn at load, so we
// intercept both through Module._load BEFORE requiring the module: a minimal fake `app`,
// and a fake `spawn` that returns inspectable fake procs (and records taskkill calls).

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const realCp = require('node:child_process');
const spawnCalls = [];

function fakeProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.killed = true; };
  proc.unref = () => {};
  return proc;
}

let nextPid = 1000;
function fakeSpawn(cmd, args) {
  const proc = fakeProc(nextPid++);
  spawnCalls.push({ cmd, args, proc });
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
  Module._load = origLoad; // restore immediately; the module captured what it needed at load
}

// Start a tracked child via the real runPython and return its fake proc handle. The caller
// settles the promise (emit 'close') so runPython's timeout timer is cleared and never keeps
// the test process alive.
function startChild() {
  const promise = ingest.runPython(['-m', 'tools.noop'], { timeoutMs: 5_000 });
  const call = spawnCalls[spawnCalls.length - 1];
  return { promise, proc: call.proc };
}

async function settle(child) {
  const done = child.promise.then(() => {}, () => {});
  child.proc.emit('close', 0); // resolves runPython and clears its timeout
  await done;
}

test('idle: stopActiveIngestChildren returns 0 and is a no-op', () => {
  assert.strictEqual(ingest.stopActiveIngestChildren(), 0);
});

test('an in-flight pipeline is tracked, then tree-killed and cleared on stop', async () => {
  spawnCalls.length = 0;
  const child = startChild();

  // The python child was spawned (recorded) and is now tracked for quit cleanup.
  assert.strictEqual(spawnCalls.length, 1, 'runPython should spawn exactly one child');
  assert.notStrictEqual(spawnCalls[0].cmd, 'taskkill');

  const killed = ingest.stopActiveIngestChildren();
  assert.strictEqual(killed, 1, 'exactly one in-flight child should be stopped');

  if (process.platform === 'win32') {
    const tk = spawnCalls.find((c) => c.cmd === 'taskkill' && c.args.includes(String(child.proc.pid)));
    assert.ok(tk, 'on Windows the child pid must be tree-killed via taskkill');
    assert.ok(tk.args.includes('/t') && tk.args.includes('/f'), 'taskkill must use /t and /f');
  } else {
    assert.strictEqual(child.proc.killed, true, 'non-Windows must fall back to proc.kill()');
  }

  // The tracked set is cleared, so a second stop finds nothing.
  assert.strictEqual(ingest.stopActiveIngestChildren(), 0, 'stop should clear the tracked set');

  await settle(child);
});

test('a child that exits on its own is removed from tracking', async () => {
  spawnCalls.length = 0;
  const child = startChild();

  // Emitting 'exit' is what the OS does when the pipeline finishes normally; the module's
  // once('exit') handler must untrack it so a later quit doesn't try to kill a dead pid.
  child.proc.emit('exit', 0, null);
  assert.strictEqual(ingest.stopActiveIngestChildren(), 0, 'exited child must be untracked');

  await settle(child);
});
