'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// workiq-auth shells out to the workiq CLI. Stub child_process.spawn and the client
// module so the reconnect policy can be exercised without a real binary or network.
const AUTH_PATH = require.resolve('../workiq-auth');
const CLIENT_PATH = require.resolve('../workiq-client');
const PREFS_PATH = require.resolve('../app-prefs');
const IDENTITY_PATH = require.resolve('../identity-store');

// A command spec is { code, stdout, stderr } plus optional { hang: true } (never exits
// unless killed) or { gate: Promise } (exits once the gate resolves).
function loadAuth({ commands = {}, probeResults = [], prefs = {}, savedUpn = '', clientBusy = () => false } = {}) {
  const calls = [];
  const kills = [];
  const timeline = [];
  const clientEvents = [];
  const live = new Map();
  const prefStore = { ...prefs };
  let probeIndex = 0;
  let nextPid = 1000;

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'child_process') {
      return {
        spawn(bin, args) {
          if (bin === 'taskkill') {
            const pid = Number(args[args.indexOf('/pid') + 1]);
            kills.push(pid);
            setImmediate(() => live.get(pid)?.end(1));
            return { on() {}, unref() {} };
          }
          const key = args.join(' ');
          calls.push({ bin, args, key });
          timeline.push(`start:${key}`);
          const handlers = {};
          const pid = nextPid++;
          let ended = false;
          const end = (code) => {
            if (ended) return;
            ended = true;
            live.delete(pid);
            timeline.push(`end:${key}`);
            if (handlers.exit) handlers.exit(code);
          };
          live.set(pid, { end });
          const proc = {
            pid,
            stdout: { on: (e, cb) => { handlers[`out:${e}`] = cb; } },
            stderr: { on: (e, cb) => { handlers[`err:${e}`] = cb; } },
            on: (e, cb) => { handlers[e] = cb; },
            kill: () => { kills.push(pid); setImmediate(() => end(1)); },
          };
          const result = typeof commands[key] === 'function' ? commands[key]() : commands[key];
          const finish = () => {
            if (ended) return;
            if (result?.stdout && handlers['out:data']) handlers['out:data'](Buffer.from(result.stdout));
            if (result?.stderr && handlers['err:data']) handlers['err:data'](Buffer.from(result.stderr));
            end(result?.code ?? 0);
          };
          if (result?.gate) result.gate.then(() => setImmediate(finish));
          else if (!result?.hang) setImmediate(finish);
          return proc;
        },
      };
    }
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
    })();
    if (resolved === CLIENT_PATH) {
      return {
        resolveWorkIqBin: () => path.join('stub', 'workiq.exe'),
        getWorkIqClient: () => ({
          busy: () => clientBusy(),
          stop: (reason) => { clientEvents.push(reason ? `stop:${reason}` : 'stop'); },
          probe: async () => {
            clientEvents.push('probe');
            const next = probeResults[Math.min(probeIndex, probeResults.length - 1)];
            probeIndex += 1;
            return next ?? { ok: false, error: 'no probe configured' };
          },
        }),
      };
    }
    return originalLoad.apply(this, arguments);
  };

  // app-prefs and identity-store are required LAZILY (they touch Electron's app
  // paths), i.e. after the _load patch is torn down — so stub them through the
  // module cache, which a lazy require still consults.
  const stubModule = (filename, exports) => {
    require.cache[filename] = {
      id: filename, filename, loaded: true, exports, children: [], paths: [],
    };
  };
  stubModule(PREFS_PATH, {
    get: (k, d) => (Object.prototype.hasOwnProperty.call(prefStore, k) ? prefStore[k] : d),
    set: (k, v) => { prefStore[k] = v; },
  });
  stubModule(IDENTITY_PATH, { getSavedUpn: () => savedUpn });

  delete require.cache[AUTH_PATH];
  let auth;
  try {
    auth = require('../workiq-auth');
  } finally {
    Module._load = originalLoad;
    delete require.cache[AUTH_PATH];
  }
  return {
    auth,
    calls,
    kills,
    timeline,
    clientEvents,
    prefStore,
    loginCalls: () => calls.filter((c) => c.key.startsWith('auth login')),
  };
}

async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const CONFIG_WITH_ACCOUNT = { code: 0, stdout: 'defaultAccount=ada@microsoft.com\nI-accept-EULA=true\n' };
const CONFIG_NO_ACCOUNT = { code: 0, stdout: 'defaultAccount=none\n' };
// What WorkIQ actually emits once the session lapses: the key is gone entirely.
const CONFIG_CLEARED = { code: 0, stdout: 'I-accept-EULA=true\nisMSITTenant=true\n' };

test('a healthy connection is left alone — no login is spawned', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT },
    probeResults: [{ ok: true }],
  });
  const result = await auth.ensureConnected();
  assert.equal(result.connected, true);
  assert.equal(result.reconnected, false);
  assert.equal(loginCalls().length, 0, 'must not re-login while the token still works');
});

test('a real HTTP 403 is not treated as an expired token, even when forced', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT },
    probeResults: [{ ok: false, status: 403, code: 'Forbidden', error: 'InsufficientPrivileges' }],
  });
  const status = await auth.status();
  assert.equal(status.connected, false);
  assert.equal(status.recoverable, false);
  assert.equal(status.code, 'Forbidden');
  for (const force of [false, true]) {
    const result = await auth.ensureConnected({ force });
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'access-denied');
    assert.equal(result.status, 403);
    assert.match(result.error, /InsufficientPrivileges.*reconnecting does not grant access/);
  }
  assert.equal(loginCalls().length, 0);
  assert.equal(auth.autoReconnectState().consecutiveFailures, 0);
});

test('an expired token with a cached account is renewed silently', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login --account ada@microsoft.com': { code: 0, stdout: 'Logged in as ada@microsoft.com' },
    },
    // disconnected first, connected after the re-login
    probeResults: [{ ok: false, error: '401' }, { ok: true }],
  });
  const result = await auth.ensureConnected({ reason: 'test' });
  assert.equal(result.connected, true);
  assert.equal(result.reconnected, true);
  const logins = loginCalls();
  assert.equal(logins.length, 1);
  // The cached account MUST be passed — a bare `auth login` can prompt.
  assert.deepEqual(logins[0].args, ['auth', 'login', '--account', 'ada@microsoft.com']);
});

test('never auto-logs-in when nothing identifies the account (that needs a human)', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: { 'config show': CONFIG_NO_ACCOUNT },
    probeResults: [{ ok: false }],
  });
  const result = await auth.ensureConnected();
  assert.equal(result.connected, false);
  assert.equal(result.reason, 'no-account');
  assert.equal(loginCalls().length, 0, 'must never spawn a login that could pop a window unprompted');
  assert.match(result.error, /Connect WorkIQ/);
});

// ── Regression: the expiry we actually see in the wild ───────────────────────
// WorkIQ REMOVES defaultAccount from its own config when the session lapses, so at
// the moment we want to reconnect the CLI can no longer tell us who to sign in as.
// Bailing out there is what made auto-reconnect never fire.

test('a lapsed session whose config was cleared still reconnects using the remembered account', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_CLEARED,
      'auth login --account ada@microsoft.com': { code: 0, stdout: 'Logged in as ada@microsoft.com' },
    },
    prefs: { workiqAccount: 'ada@microsoft.com' },
    // dead, then alive after the re-login (and config now reports the account again)
    probeResults: [{ ok: false, error: '401' }, { ok: true }],
  });
  const result = await auth.ensureConnected({ reason: 'test' });
  const logins = loginCalls();
  assert.equal(logins.length, 1, 'a cleared config must NOT stop the reconnect');
  assert.deepEqual(logins[0].args, ['auth', 'login', '--account', 'ada@microsoft.com']);
  assert.equal(result.account, 'ada@microsoft.com');
});

test('falls back to the signed-in Microsoft identity when nothing was remembered yet', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_CLEARED,
      'auth login --account ada@microsoft.com': { code: 0, stdout: 'Logged in' },
    },
    savedUpn: 'ada@microsoft.com',
    probeResults: [{ ok: false }, { ok: true }],
  });
  await auth.ensureConnected();
  assert.deepEqual(loginCalls()[0].args, ['auth', 'login', '--account', 'ada@microsoft.com']);
});

test('a working account is remembered so it survives WorkIQ clearing its own config', async () => {
  const { auth, prefStore } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT },
    probeResults: [{ ok: true }],
  });
  await auth.status({ probe: true });
  assert.equal(prefStore.workiqAccount, 'ada@microsoft.com');
});

test('a cleared config is reported as a recoverable expiry, not "never connected"', async () => {
  const { auth } = loadAuth({
    commands: { 'config show': CONFIG_CLEARED },
    prefs: { workiqAccount: 'ada@microsoft.com' },
    probeResults: [{ ok: false }],
  });
  const state = await auth.status({ probe: true });
  assert.equal(state.connected, false);
  assert.equal(state.account, null, 'WorkIQ genuinely has no live session');
  assert.equal(state.knownAccount, 'ada@microsoft.com');
  assert.equal(state.recoverable, true, 'the UI must offer expiry wording, not first-run wording');
});

test('a login that exits 0 but still cannot read is reported as NOT connected', async () => {
  const { auth } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login --account ada@microsoft.com': { code: 0, stdout: 'Logged in' },
    },
    probeResults: [{ ok: false, error: '401' }, { ok: false, error: '401' }],
  });
  const result = await auth.ensureConnected();
  assert.equal(result.connected, false, 'a zero exit code alone must not be trusted');
  assert.equal(result.reason, 'still-disconnected');
});

test('repeated attempts back off, then stop and ask for manual action', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login --account ada@microsoft.com': { code: 1, stderr: 'broker unavailable' },
    },
    probeResults: [{ ok: false, error: '401' }],
  });
  // First attempt runs.
  const first = await auth.ensureConnected();
  assert.equal(first.reason, 'login-failed');
  assert.equal(loginCalls().length, 1);

  // Immediately after, the cooldown suppresses another spawn.
  const second = await auth.ensureConnected();
  assert.equal(second.reason, 'cooling-down');
  assert.equal(loginCalls().length, 1, 'must not relaunch a slow login back-to-back');

  // Forced attempts bypass the cooldown but still count failures.
  await auth.ensureConnected({ force: true });
  await auth.ensureConnected({ force: true });
  assert.equal(loginCalls().length, 3);

  const state = auth.autoReconnectState();
  assert.equal(state.consecutiveFailures, 3);
  assert.equal(state.exhausted, true);

  // Exhausted: stop trying automatically and say why.
  const after = await auth.ensureConnected();
  assert.equal(after.reason, 'exhausted');
  assert.match(after.error, /failed 3 times in a row/);
  assert.match(after.error, /Last error: broker unavailable\./);
  assert.equal(loginCalls().length, 3, 'must give up rather than retry forever');
});

test('concurrent callers share a single reconnect attempt', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login --account ada@microsoft.com': { code: 0, stdout: 'Logged in' },
    },
    probeResults: [{ ok: false }, { ok: false }, { ok: true }],
  });
  const [a, b] = await Promise.all([
    auth.ensureConnected({ reason: 'ingest' }),
    auth.ensureConnected({ reason: 'watchdog' }),
  ]);
  assert.equal(loginCalls().length, 1, 'the scheduler and an ingest must not both log in');
  assert.equal(a.connected, true);
  assert.equal(b.connected, true, 'the caller that joined must get the shared result');
});

// ── Regression: Connect WorkIQ reported "A reconnect was attempted moments ago" ──
// Deep Research started a silent reconnect; the user then clicked Connect WorkIQ. The
// post-sign-in check hit the 5-minute cooldown left by the silent attempt, and the UI
// showed that cooldown note instead of the actual read error.

const UNAUTHORIZED = { ok: false, status: 401, error: 'HTTP 401 Unauthorized.' };
const SILENT_LOGIN = 'auth login --account ada@microsoft.com';

test('the cooldown message names the real cause and when the next attempt is allowed', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      [SILENT_LOGIN]: { code: 1, stderr: 'broker unavailable' },
    },
    probeResults: [UNAUTHORIZED],
  });
  assert.equal((await auth.ensureConnected()).reason, 'login-failed');
  const cooling = await auth.ensureConnected();
  assert.equal(cooling.reason, 'cooling-down');
  assert.equal(cooling.status, 401);
  assert.ok(cooling.error.startsWith('WorkIQ cannot read your mailbox: HTTP 401 Unauthorized. '), cooling.error);
  assert.match(cooling.error, /failed: broker unavailable\./);
  assert.match(cooling.error, /allowed after \d{1,2}[:.]\d{2}/);
  assert.doesNotMatch(cooling.error, /moments ago|\.\./);
  assert.equal(loginCalls().length, 1);
});

test('a caller that arrives during a reconnect waits for it instead of reporting a cooldown', async () => {
  const release = gate();
  const { auth, loginCalls, clientEvents } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      [SILENT_LOGIN]: { code: 0, stdout: 'Logged in', gate: release.promise },
    },
    probeResults: [UNAUTHORIZED, { ok: true }],
  });
  const first = auth.ensureConnected({ reason: 'work-output' });
  await waitFor(() => loginCalls().length === 1, 'the silent login');
  const second = auth.ensureConnected({ reason: 'settings' });
  release.open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.reason, 'reconnected');
  assert.equal(b.reason, 'reconnected');
  assert.equal(loginCalls().length, 1);
  assert.equal(clientEvents.filter((e) => e === 'probe').length, 2, 'the joining caller must not probe again');
});

test('Connect WorkIQ restarts an idle WorkIQ process before checking the new sign-in', async () => {
  const { auth, loginCalls, clientEvents } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login': { code: 0, stdout: 'Logged in' },
    },
    probeResults: [{ ok: true }],
  });
  const result = await auth.login();
  assert.equal(result.success, true);
  assert.equal(result.account, 'ada@microsoft.com');
  assert.equal(result.state.connected, true);
  assert.deepEqual(clientEvents, ['stop', 'probe']);
  assert.deepEqual(loginCalls().map((c) => c.key), ['auth login']);
});

test('after a failed automatic attempt, Connect WorkIQ reports the real read error', async () => {
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      [SILENT_LOGIN]: { code: 1, stderr: 'broker unavailable' },
      'auth login': { code: 0, stdout: 'Logged in' },
    },
    probeResults: [UNAUTHORIZED],
  });
  assert.equal((await auth.ensureConnected({ reason: 'work-output' })).reason, 'login-failed');
  const result = await auth.login();
  assert.equal(result.success, true);
  assert.equal(result.state.connected, false);
  assert.equal(result.state.error, 'HTTP 401 Unauthorized.');
  assert.doesNotMatch(JSON.stringify(result), /moments ago|Automatic reconnect/);
  assert.equal(auth.autoReconnectState().consecutiveFailures, 1);
  assert.equal(loginCalls().length, 2);
});

test('a busy WorkIQ process is restarted only when it cannot see the new sign-in', async () => {
  const { auth, clientEvents } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT, 'auth login': { code: 0 } },
    probeResults: [UNAUTHORIZED, { ok: true }],
    clientBusy: () => true,
  });
  const result = await auth.login();
  assert.equal(result.state.connected, true);
  assert.equal(clientEvents.length, 3, clientEvents.join(', '));
  assert.equal(clientEvents[0], 'probe');
  assert.match(clientEvents[1], /^stop:WorkIQ restarted to use the new sign-in/);
  assert.equal(clientEvents[2], 'probe');
});

test('a busy WorkIQ process that already sees the new sign-in is not interrupted', async () => {
  const { auth, clientEvents } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT, 'auth login': { code: 0 } },
    probeResults: [{ ok: true }],
    clientBusy: () => true,
  });
  const result = await auth.login();
  assert.equal(result.state.connected, true);
  assert.deepEqual(clientEvents, ['probe']);
});

test('Connect WorkIQ cancels a running automatic sign-in before opening its own', async () => {
  const { auth, loginCalls, kills, timeline } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      [SILENT_LOGIN]: { hang: true },
      'auth login': { code: 0, stdout: 'Logged in' },
    },
    probeResults: [UNAUTHORIZED, { ok: true }],
  });
  const background = auth.ensureConnected({ reason: 'work-output' });
  await waitFor(() => loginCalls().length === 1, 'the silent login');
  const manual = await auth.login();
  const waited = await background;
  assert.equal(manual.success, true);
  assert.equal(manual.state.connected, true);
  assert.equal(waited.connected, true, 'the cancelled caller gets the sign-in result');
  assert.equal(waited.reason, 'signed-in');
  assert.equal(kills.length, 1, 'the silent login process tree is ended');
  const silentEnd = timeline.indexOf(`end:${SILENT_LOGIN}`);
  const manualStart = timeline.indexOf('start:auth login');
  assert.ok(silentEnd !== -1 && silentEnd < manualStart, `two logins overlapped: ${timeline.join(', ')}`);
  const state = auth.autoReconnectState();
  assert.equal(state.consecutiveFailures, 0, 'a cancelled attempt is not a failure');
  assert.equal(state.lastAttemptAt, null, 'a fresh sign-in clears the cooldown');
});

test('background callers wait for an open Connect WorkIQ sign-in instead of starting their own', async () => {
  const release = gate();
  const { auth, loginCalls, clientEvents } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login': { code: 0, gate: release.promise },
    },
    probeResults: [{ ok: true }],
  });
  const manual = auth.login();
  await waitFor(() => loginCalls().length === 1, 'the manual login');
  const background = auth.ensureConnected({ reason: 'ingest' });
  release.open();
  const [m, b] = await Promise.all([manual, background]);
  assert.equal(m.state.connected, true);
  assert.equal(b.connected, true);
  assert.equal(b.reason, 'signed-in');
  assert.deepEqual(loginCalls().map((c) => c.key), ['auth login']);
  assert.equal(clientEvents.filter((e) => e === 'probe').length, 1);
});

test('a second Connect WorkIQ click joins the sign-in that is already open', async () => {
  const release = gate();
  const { auth, loginCalls } = loadAuth({
    commands: { 'config show': CONFIG_WITH_ACCOUNT, 'auth login': { code: 0, gate: release.promise } },
    probeResults: [{ ok: true }],
  });
  const first = auth.login();
  const second = auth.login();
  assert.equal(first, second);
  release.open();
  assert.equal((await first).state.connected, true);
  assert.equal(loginCalls().length, 1);
});

test('a caller waiting on Connect WorkIQ gets its failure, not a cooldown note', async () => {
  const release = gate();
  const { auth, loginCalls } = loadAuth({
    commands: {
      'config show': CONFIG_WITH_ACCOUNT,
      'auth login': { code: 1, stderr: 'User cancelled the sign-in.', gate: release.promise },
    },
    probeResults: [UNAUTHORIZED],
  });
  const manual = auth.login();
  const background = auth.ensureConnected({ reason: 'ingest' });
  release.open();
  const [m, b] = await Promise.all([manual, background]);
  assert.equal(m.success, false);
  assert.equal(b.connected, false);
  assert.equal(b.reason, 'manual-sign-in-failed');
  assert.equal(b.error, 'Connect WorkIQ did not complete: User cancelled the sign-in.');
  assert.equal(loginCalls().length, 1);
});
