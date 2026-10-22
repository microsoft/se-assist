/**
 * workiq-auth.js — drive the WorkIQ CLI's own sign-in so users don't have to run
 * `copilot` / `workiq auth login` in a terminal by hand.
 *
 * Unlike MSX (in-app MSAL) and GitHub Copilot (in-app device flow), WorkIQ carries its
 * OWN admin-consented M365 Copilot OAuth. We shell out to the bundled `workiq` binary:
 *   - `workiq auth login`  -> triggers the Windows WAM broker (native account popup)
 *                             with a system-browser fallback. The user handles the popup;
 *                             on success the token is cached in WorkIQ's own store and the
 *                             process exits 0.
 *   - `workiq config show` -> reports the persisted `defaultAccount` (fast, offline).
 *
 * Authoritative "connected" state still comes from the WorkIQ client `probe()` (an actual
 * /me/messages read), since a cached account can exist with an expired/invalid token.
 */
const { spawn } = require('child_process');
const { resolveWorkIqBin, getWorkIqClient } = require('./workiq-client');

// Run a workiq subcommand, capturing stdout/stderr and exit code. Never rejects —
// resolves to a structured result so callers can surface honest errors. Aborting
// `signal` ends the process tree and resolves { aborted: true } once it has exited,
// so the caller knows the Windows sign-in broker is free again.
const ABORT_EXIT_WAIT_MS = 10_000;

function abortMessage(signal) {
  return signal?.reason?.message || String(signal?.reason || 'Cancelled.');
}

function runWorkiq(args, { timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, aborted: true, error: abortMessage(signal) });
      return;
    }
    const bin = resolveWorkIqBin();
    if (!bin) {
      resolve({ ok: false, error: 'WorkIQ is not installed. Run "npm install" in the desktop folder.' });
      return;
    }
    let proc;
    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    let abortWait = null;
    let abortedWith = null;
    const onAbort = () => {
      abortedWith = abortMessage(signal);
      clearTimeout(timer);
      killTree(proc);
      // Normally the exit handler resolves; this only covers a process that ignores the kill.
      abortWait = setTimeout(() => finish({ ok: false, aborted: true, error: abortedWith }), ABORT_EXIT_WAIT_MS);
      if (abortWait.unref) abortWait.unref();
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(abortWait);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    try {
      // bin is the native workiq exe — launch directly (no shell) so the packaged
      // install path (which contains a space) isn't mis-split by a shell.
      proc = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: e.message || String(e) });
      return;
    }
    timer = setTimeout(() => {
      killTree(proc);
      finish({ ok: false, timedOut: true, error: `WorkIQ "${args.join(' ')}" timed out.` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => {
      finish(abortedWith
        ? { ok: false, aborted: true, error: abortedWith }
        : { ok: false, error: e.message || String(e) });
    });
    proc.on('exit', (code) => {
      if (abortedWith) {
        finish({ ok: false, aborted: true, code, error: abortedWith });
        return;
      }
      finish({
        ok: code === 0,
        code,
        stdout: out,
        stderr: err,
        error: code === 0 ? null : (err.trim() || out.trim() || `WorkIQ exited with code ${code}.`),
      });
    });
  });
}

// Kill an abandoned workiq run AND anything it spawned. `proc.kill()` alone only
// signals the top process on Windows, which leaves the auth broker child running:
// an orphan like that holds the token cache and makes every later sign-in hang
// (observed in the wild as a workiq.exe stuck for ~19 hours, after which the CLI
// would not authenticate at all until it was killed by hand).
function killTree(proc) {
  const pid = proc?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      // PID-targeted, /t includes the child tree. Detached + ignored stdio so this
      // cleanup can never itself block.
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => { try { proc.kill(); } catch { /* ignore */ } });
      killer.unref?.();
      return;
    } catch { /* fall through to the plain kill */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
}

// Read the persisted default account (email) from `workiq config show`. Fast + offline.
// NOTE: WorkIQ REMOVES this key entirely when the session ends (verified: after a
// logout/expiry `config show` no longer emits a defaultAccount line), so a null here
// means "no usable session", not "never connected". See rememberedAccount().
async function readDefaultAccount() {
  const r = await runWorkiq(['config', 'show'], { timeoutMs: 20_000 });
  if (!r.ok) return null;
  const m = /^\s*defaultAccount\s*=\s*(.+)\s*$/im.exec(r.stdout || '');
  const acct = m ? m[1].trim() : null;
  return acct && acct.toLowerCase() !== 'none' ? acct : null;
}

// ── Remembering which account to reconnect as ────────────────────────────────
// WorkIQ drops `defaultAccount` from its own config the moment the session dies, so
// by the time we notice the disconnect the CLI can no longer tell us who to sign back
// in as. We therefore persist the account ourselves the first time we see it working.
// `workiq auth login --account <email>` succeeds silently even when the CLI's own
// cache is empty (verified: exit 0, ~12s, no prompt), so this one remembered string is
// all that's needed to heal the connection unattended.
const REMEMBERED_ACCOUNT_KEY = 'workiqAccount';

function appPrefs() {
  // Required lazily: app-prefs touches app.getPath, which is only valid after ready.
  // eslint-disable-next-line global-require
  return require('./app-prefs');
}

function rememberAccount(account) {
  const clean = String(account || '').trim();
  if (!clean || !clean.includes('@')) return;
  try {
    if (appPrefs().get(REMEMBERED_ACCOUNT_KEY, null) !== clean) {
      appPrefs().set(REMEMBERED_ACCOUNT_KEY, clean);
    }
  } catch { /* best-effort persistence */ }
}

// The account to reconnect as: WorkIQ's own config first, then the one we remembered,
// then the signed-in Microsoft identity (covers an app that was connected before this
// remembering existed). Returns '' when we genuinely have nothing to go on.
function rememberedAccount() {
  try {
    const saved = appPrefs().get(REMEMBERED_ACCOUNT_KEY, null);
    if (saved && String(saved).includes('@')) return String(saved).trim();
  } catch { /* fall through */ }
  try {
    // eslint-disable-next-line global-require
    const upn = require('./identity-store').getSavedUpn();
    if (upn && upn.includes('@')) return upn;
  } catch { /* fall through */ }
  return '';
}

// Authoritative connection status. `account` comes from config (cheap); `connected`
// comes from an actual WorkIQ read when an account exists. When probe=false we skip the
// live read (cheap path for first paint) and report connected=null (unknown).
async function status({ probe = true } = {}) {
  const account = await readDefaultAccount();
  if (!account) {
    // No live session. If we know which account to sign back in as, this is a
    // RECOVERABLE expiry, not a never-connected state — report it as such so the UI
    // says "sign-in expired" and auto-reconnect has something to work with.
    const known = rememberedAccount();
    return {
      installed: resolveWorkIqBin() != null,
      account: null,
      knownAccount: known || null,
      recoverable: Boolean(known),
      connected: false,
    };
  }
  rememberAccount(account);
  if (!probe) {
    return { installed: true, account, knownAccount: account, recoverable: true, connected: null };
  }
  try {
    const wiq = getWorkIqClient({ log: () => {} });
    const p = await wiq.probe();
    return {
      installed: true,
      account,
      knownAccount: account,
      recoverable: p.status !== 403,
      connected: Boolean(p.ok),
      status: p.status || null,
      code: p.code || null,
      error: p.ok ? null : p.error,
    };
  } catch (e) {
    return {
      installed: true,
      account,
      knownAccount: account,
      recoverable: true,
      connected: false,
      error: e.message || String(e),
    };
  }
}

// Interactive sign-in for the Connect WorkIQ button. Blocks until the user completes (or
// cancels) the WAM/browser popup, then verifies the new sign-in with a real read. Only one
// runs at a time: a second click joins the sign-in that is already open. A running silent
// reconnect is cancelled first so two logins never compete for the Windows broker.
// Resolves { success, account, state } where `state` is the verified status() result, or
// { success: false, error, timedOut }.
function login() {
  if (autoState.manual) return autoState.manual;
  const attempt = runManualLogin();
  autoState.manual = attempt;
  attempt.finally(() => { if (autoState.manual === attempt) autoState.manual = null; }).catch(() => {});
  return attempt;
}

async function runManualLogin() {
  try {
    const silent = autoState.silentRun;
    if (silent) {
      console.log('[workiq] Connect WorkIQ started; cancelling the automatic reconnect that is still running.');
      silent.controller.abort(new Error('Cancelled because Connect WorkIQ started a sign-in.'));
      await silent.done;
    }
    const r = await runWorkiq(['auth', 'login'], { timeoutMs: 5 * 60_000 });
    if (!r.ok) return { success: false, error: r.error || 'Sign-in failed.', timedOut: Boolean(r.timedOut) };
    const account = await readDefaultAccount();
    // Remember who signed in: WorkIQ drops this from its own config the moment the
    // session lapses, and it is the only thing needed to reconnect unattended later.
    rememberAccount(account);
    let state = await verifyFreshSignIn();
    if (!state.connected && !state.account && !state.error) {
      state = { ...state, error: 'WorkIQ reported a successful sign-in, but its config shows no signed-in account.' };
    }
    if (state.connected) {
      recordAutoReconnect({ ok: true, silent: false });
      // A fresh sign-in starts a new session, so a later expiry may reconnect at once.
      autoState.lastAttemptAt = null;
    }
    return { success: true, account: state.account || account, state };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

// What a caller waiting on Connect WorkIQ gets back, in ensureConnected's shape.
function manualOutcome(result) {
  const state = result?.state;
  if (result?.success && state?.connected) {
    return { connected: true, reconnected: false, account: state.account || result.account || null, reason: 'signed-in' };
  }
  return {
    connected: false,
    reconnected: false,
    account: state?.account || result?.account || null,
    reason: 'manual-sign-in-failed',
    status: state?.status || null,
    code: state?.code || null,
    error: result?.success
      ? `Signed in, but WorkIQ still cannot read your mailbox: ${clause(state?.error || 'no error detail was returned')}.`
      : `Connect WorkIQ did not complete: ${clause(result?.error || 'Sign-in failed')}.`,
  };
}

async function logout() {
  const r = await runWorkiq(['auth', 'logout'], { timeoutMs: 60_000 });
  return { success: r.ok, error: r.ok ? null : r.error };
}

// ── Verifying a new sign-in ──────────────────────────────────────────────────
// The long-running WorkIQ MCP process may keep using the session it started with, so a
// read through it can still fail right after a successful login. Restart it before the
// check when nothing is using it. When reads are in flight, check first and restart only
// if the new sign-in is not visible yet; those reads then fail with RESTART_REASON.
const RESTART_REASON = 'WorkIQ restarted to use the new sign-in, which interrupted this request. Run it again.';

async function verifyFreshSignIn() {
  const client = getWorkIqClient({ log: () => {} });
  if (!client.busy()) {
    client.stop();
    return status({ probe: true });
  }
  const first = await status({ probe: true });
  if (first.connected || !first.account || first.status === 403) return first;
  client.stop(RESTART_REASON);
  return status({ probe: true });
}

// ── Silent auto-reconnect ────────────────────────────────────────────────────
// WorkIQ's token expires on its own and the connection simply goes dead, which
// silently starves every customer-data sync until someone notices and clicks
// Connect. When an account is ALREADY cached, `workiq auth login --account <email>`
// re-acquires through the Windows broker with no prompt (verified: exits 0, no UI),
// so that case can be healed automatically.
//
// Deliberate limits:
//   • Only ever attempted when an account is already cached. With no cached account a
//     human genuinely has to choose one, so we never spawn a login that could pop a
//     window out of nowhere.
//   • One attempt at a time, and never more often than MIN_RETRY_MS.
//   • After MAX_CONSECUTIVE_FAILURES we stop trying and report that manual action is
//     needed, rather than relaunching a slow process forever.
//   • Bounded timeout: if the broker DOES need interaction, the attempt is abandoned
//     instead of hanging a background job for minutes.
// A silent re-login is slower and far more variable than it looks: measured runs on a
// healthy machine took 12s, 43s and 144s for the same command, because the broker may
// do real network work. Nothing is waiting on this (it runs in the background, and the
// UI shows a spinner at worst), so the budget is generous — a premature timeout was
// what made the first version give up on a reconnect that would have succeeded.
const SILENT_LOGIN_TIMEOUT_MS = 4 * 60_000;
const MIN_RETRY_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const autoState = {
  inFlight: null,
  // The silent `auth login` process while it runs: { controller, done }.
  silentRun: null,
  // The Connect WorkIQ sign-in while it runs (a promise of login()'s result).
  manual: null,
  lastAttemptAt: null,
  lastResultAt: null,
  lastOk: null,
  lastError: null,
  consecutiveFailures: 0,
  reconnects: 0,
};

function recordAutoReconnect({ ok, silent = true, error = null }) {
  autoState.lastResultAt = new Date().toISOString();
  autoState.lastOk = ok;
  autoState.lastError = ok ? null : (error || 'Reconnect failed.');
  if (ok) {
    autoState.consecutiveFailures = 0;
    if (silent) autoState.reconnects += 1;
  } else {
    autoState.consecutiveFailures += 1;
  }
}

function autoReconnectState() {
  return {
    lastAttemptAt: autoState.lastAttemptAt,
    lastResultAt: autoState.lastResultAt,
    lastOk: autoState.lastOk,
    lastError: autoState.lastError,
    consecutiveFailures: autoState.consecutiveFailures,
    reconnects: autoState.reconnects,
    exhausted: autoState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
  };
}

// Error text ends up inside longer sentences; drop its final period so it is not doubled.
function clause(text) {
  return String(text || '').trim().replace(/\.+$/, '');
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Some locales end a time with a period ("7:06 p.m."); do not add a second one.
function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// Why WorkIQ is unusable right now, from the status() that was just taken.
function disconnectCause(current) {
  if (!current.account) return 'WorkIQ has no active sign-in.';
  return current.error
    ? `WorkIQ cannot read your mailbox: ${clause(current.error)}.`
    : 'WorkIQ cannot read your mailbox.';
}

// Make sure WorkIQ is usable, healing an expired token in place when possible.
// Returns { connected, reconnected, account, reason } and never throws.
async function ensureConnected({ force = false, reason = 'background' } = {}) {
  // A sign-in that is already running decides the outcome; never start a second one.
  if (autoState.manual) return manualOutcome(await autoState.manual);
  if (autoState.inFlight) return autoState.inFlight;

  const current = await status({ probe: true });
  if (current.connected) {
    if (autoState.consecutiveFailures) recordAutoReconnect({ ok: true, silent: false });
    return { connected: true, reconnected: false, account: current.account, reason: 'already-connected' };
  }
  if (current.status === 403) {
    return {
      connected: false, reconnected: false, account: current.account,
      reason: 'access-denied', status: current.status, code: current.code,
      error: `${current.error} WorkIQ denied mailbox access. Verify account permissions and tenant policy; reconnecting does not grant access.`,
    };
  }
  // WorkIQ clears its own defaultAccount when the session dies, so `current.account`
  // is null on exactly the expiry we want to heal. Fall back to the account we
  // remembered while it was working — signing in with an explicit --account succeeds
  // silently even though the CLI's own cache is empty.
  const account = current.account || current.knownAccount || rememberedAccount();
  if (!account) {
    return {
      connected: false,
      reconnected: false,
      account: null,
      reason: 'no-account',
      error: 'WorkIQ has never been connected on this machine, so it cannot reconnect on its own. Click Connect WorkIQ once.',
    };
  }
  // The read above takes seconds; a sign-in may have started meanwhile.
  if (autoState.manual) return manualOutcome(await autoState.manual);
  if (autoState.inFlight) return autoState.inFlight;

  const failure = {
    connected: false,
    reconnected: false,
    account,
    status: current.status || null,
    code: current.code || null,
  };
  if (!force && autoState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const last = autoState.lastError ? ` Last error: ${clause(autoState.lastError)}.` : '';
    return {
      ...failure,
      reason: 'exhausted',
      error: `${disconnectCause(current)} Automatic reconnect failed ${autoState.consecutiveFailures} times in a row and is paused until WorkIQ is signed in again.${last}`,
    };
  }
  const lastAttempt = autoState.lastAttemptAt ? Date.parse(autoState.lastAttemptAt) : NaN;
  if (!force && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < MIN_RETRY_MS) {
    const ran = autoState.lastOk === false && autoState.lastError
      ? `Automatic reconnect last ran at ${clockTime(lastAttempt)} and failed: ${clause(autoState.lastError)}.`
      : sentence(`Automatic reconnect last ran at ${clockTime(lastAttempt)}`);
    return {
      ...failure,
      reason: 'cooling-down',
      error: `${disconnectCause(current)} ${ran} `
        + sentence(`The next automatic attempt is allowed after ${clockTime(lastAttempt + MIN_RETRY_MS)}`),
    };
  }

  // Concurrent callers (scheduler, ingestion, Deep Research, the UI) join this attempt.
  const attempt = runSilentReconnect(account, reason);
  autoState.inFlight = attempt;
  attempt.finally(() => { if (autoState.inFlight === attempt) autoState.inFlight = null; }).catch(() => {});
  return attempt;
}

async function runSilentReconnect(account, reason) {
  autoState.lastAttemptAt = new Date().toISOString();
  console.log(`[workiq] session expired — attempting silent reconnect as ${account} (${reason})`);
  const controller = new AbortController();
  const done = runWorkiq(['auth', 'login', '--account', account], {
    timeoutMs: SILENT_LOGIN_TIMEOUT_MS,
    signal: controller.signal,
  });
  const silentRun = { controller, done };
  autoState.silentRun = silentRun;
  const r = await done;
  if (autoState.silentRun === silentRun) autoState.silentRun = null;

  if (r.aborted) {
    // Only Connect WorkIQ cancels an attempt; its result is the answer for everyone waiting here.
    console.log(`[workiq] silent reconnect cancelled: ${r.error}`);
    if (autoState.manual) return manualOutcome(await autoState.manual);
    return { connected: false, reconnected: false, account, reason: 'cancelled', error: r.error };
  }
  if (!r.ok) {
    recordAutoReconnect({ ok: false, error: r.error });
    console.warn('[workiq] silent reconnect failed:', r.error);
    return {
      connected: false, reconnected: false, account,
      reason: 'login-failed', error: r.error,
    };
  }
  // A zero exit only means the CLI thinks it signed in — confirm with a real read.
  const after = await verifyFreshSignIn();
  recordAutoReconnect({ ok: after.connected, error: after.error });
  if (after.connected) {
    rememberAccount(after.account || account);
    console.log('[workiq] silent reconnect succeeded');
  }
  return {
    connected: after.connected,
    reconnected: after.connected,
    account: after.account || account,
    reason: after.connected ? 'reconnected' : 'still-disconnected',
    status: after.status || null,
    code: after.code || null,
    error: after.connected ? null : (after.error || 'Reconnect completed but WorkIQ still is not readable.'),
  };
}

module.exports = {
  status,
  login,
  logout,
  readDefaultAccount,
  ensureConnected,
  autoReconnectState,
};
