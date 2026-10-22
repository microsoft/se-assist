'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const filename = path.join(__dirname, '..', '..', 'scripts', 'run-electron-test.cjs');
const source = fs.readFileSync(filename, 'utf8');
const script = 'test-work-outputs-electron.cjs';
const userData = path.join(__dirname, 'virtual-test-user-data');

function fixture({ argv = [script], exists = true, cleanupError, electronError } = {}) {
  const child = new EventEmitter();
  const state = { directories: [], removed: [], errors: [], signals: new Map(), kills: [], spawn: null };
  const process = {
    argv: ['node', filename, ...argv],
    env: { ELECTRON_RUN_AS_NODE: '1', TEST_SETTING: 'preserved' },
    once: (signal, listener) => state.signals.set(signal, listener),
  };
  child.kill = signal => { state.kills.push(signal); return true; };
  const modules = {
    'node:fs': {
      existsSync: () => exists,
      mkdtempSync: prefix => { state.directories.push(prefix); return userData; },
      rmSync: (directory, options) => {
        state.removed.push({ directory, options });
        if (cleanupError) throw cleanupError;
      },
    },
    'node:os': { tmpdir: () => path.dirname(userData) },
    'node:path': path,
    'node:child_process': {
      spawn: (executable, args, options) => { state.spawn = { executable, args, options }; return child; },
    },
  };
  const load = () => vm.runInNewContext(source, {
    __dirname: path.dirname(filename), process,
    console: { log() {}, error: (...args) => state.errors.push(args) },
    require(name) {
      if (name === 'electron') {
        if (electronError) throw electronError;
        return 'fixture-electron.exe';
      }
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected runner dependency: ${name}`);
      return modules[name];
    },
  }, { filename });
  return { load, child, process, state };
}

test('Electron test runner isolates user data, clears only child run-as-node and cleans up after success', () => {
  const f = fixture();
  f.load();
  assert.equal(f.state.spawn.executable, 'fixture-electron.exe');
  assert.deepEqual(Array.from(f.state.spawn.args), [path.join(path.dirname(filename), script), `--user-data-dir=${userData}`]);
  assert.equal(f.state.spawn.options.stdio, 'inherit');
  assert.equal(f.state.spawn.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.state.spawn.options.env.TEST_SETTING, 'preserved');
  assert.equal(f.process.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(f.state.removed.length, 0);
  f.child.emit('close', 0, null);
  assert.equal(f.process.exitCode, 0);
  assert.equal(f.state.removed[0].directory, userData);
  assert.equal(f.state.removed[0].options.recursive, true);
  assert.equal(f.state.removed.length, 1);
});

test('Electron test runner propagates a failing test and still removes its own data', () => {
  const f = fixture();
  f.load();
  f.child.emit('close', 1, null);
  assert.equal(f.process.exitCode, 1);
  assert.equal(f.state.removed[0].directory, userData);
});

test('Electron test runner reports a spawn failure rather than returning success', () => {
  const f = fixture();
  f.load();
  f.child.emit('error', new Error('Executable could not start'));
  f.child.emit('close', -2, null);
  assert.equal(f.process.exitCode, 1);
  assert.match(f.state.errors[0][0], /Could not start/);
  assert.equal(f.state.removed[0].directory, userData);
});

test('Electron test runner forwards termination to its child and reports cancellation', () => {
  const f = fixture();
  f.load();
  f.state.signals.get('SIGTERM')();
  f.child.emit('close', null, 'SIGTERM');
  assert.deepEqual(f.state.kills, ['SIGTERM']);
  assert.equal(f.process.exitCode, 1);
  assert.match(f.state.errors[0][0], /terminated by SIGTERM/);
  assert.equal(f.state.removed[0].directory, userData);
});

test('Electron test runner fails explicitly if owned-directory cleanup fails', () => {
  const f = fixture({ cleanupError: new Error('Directory is locked') });
  f.load();
  f.child.emit('close', 0, null);
  assert.equal(f.process.exitCode, 1);
  assert.match(f.state.errors[0][0], /Could not remove the isolated test directory/);
  assert.match(f.state.errors[0][1].message, /locked/);
});

test('Electron test runner rejects path traversal and user-data overrides before creating directories', () => {
  for (const argv of [[], ['..\\main.js'], [script, '--user-data-dir=existing-installation']]) {
    const f = fixture({ argv });
    assert.throws(f.load, /Supply one Electron test filename/);
    assert.equal(f.state.directories.length, 0);
    assert.equal(f.state.spawn, null);
  }
});

test('Electron test runner rejects a missing test before creating directories', () => {
  const f = fixture({ exists: false });
  assert.throws(f.load, /Electron test not found/);
  assert.equal(f.state.directories.length, 0);
});

test('Electron test runner resolves its Electron dependency before creating directories', () => {
  const f = fixture({ electronError: new Error('Electron dependency is missing') });
  assert.throws(f.load, /Electron dependency is missing/);
  assert.equal(f.state.directories.length, 0);
});
