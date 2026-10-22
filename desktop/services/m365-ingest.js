/**
 * m365-ingest.js — orchestrates customer-data ingestion from WorkIQ into the local DB.
 *
 * Flow per medium: pull via the WorkIQ MCP client (deterministic Graph reads) -> write a
 * staged JSON file in the shape the existing Python ingester accepts -> run the medium's
 * pipeline (`python -m tools.<medium>.cli ...`) which links to customers (only
 * customer-related survives), builds profiles, and advances per-account watermarks.
 *
 * Two modes:
 *   - backfill({ months }):  wide historical pull (date windows / larger $top).
 *   - incremental():         recent items only (idempotent upserts catch what's new).
 *
 * The orchestrator owns NO linking logic — it reuses the battle-tested pipelines so
 * "customer-related" stays a single source of truth. Progress is reported via onProgress.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');

const { getWorkIqClient } = require('./workiq-client');
const copilotProvider = require('./copilot-provider');
const { assertActiveTpids, createAccountScope } = require('../account-roster');

// The fast/simple ingestion AI steps (customer alias generation + weak-link
// verification) run on the explicit utility-model role via the connected GitHub
// Copilot API and nothing else. We hand the Python subprocesses a Copilot bearer token,
// endpoint, and resolved model (see buildAiEnv). When Copilot isn't
// connected (or its calls fail) there is NO alternate model: the AI steps are skipped,
// ingestion continues in a degraded state on the deterministic exact-name baseline, and
// the degraded reason is surfaced loudly (result.degraded / a 'degraded' progress
// event). The larger, user-selectable report features keep using the user's chosen
// model — unaffected by this.
const DEFAULT_FAST_MODEL = 'claude-haiku-4.5';

function fastModel() {
  return copilotProvider.getModelNameForRole?.('utility')
    || (process.env.SEASSIST_FAST_MODEL || '').trim()
    || DEFAULT_FAST_MODEL;
}

// Directory that contains the `tools/` Python package. In dev this is the repo root;
// in a packaged build the pipelines are copied next to the app via extraResources
// (process.resourcesPath). Resolve to whichever actually holds `tools/`.
function resolveToolsRoot() {
  const devRoot = path.resolve(path.join(__dirname, '..', '..'));
  if (fs.existsSync(path.join(devRoot, 'tools'))) return devRoot;
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'tools'))) {
    return process.resourcesPath;
  }
  return devRoot;
}
const REPO_ROOT = resolveToolsRoot();

// Prefer the embeddable Python runtime bundled into the installer
// (resources/python, vendored by scripts/fetch-python.js) so ingestion never
// depends on a system Python being on the user's PATH. In dev (unpackaged) or if
// the bundle is somehow missing, fall back to PATH. Its `._pth` adds `..`, making
// resources/ importable so `python -m tools.*` resolves the `tools` package.
function resolvePython() {
  if (app.isPackaged && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'python', 'python.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PY = resolvePython();

const EMAIL_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'sender',
  'toRecipients', 'ccRecipients', 'sentDateTime', 'receivedDateTime',
  'bodyPreview', 'body', 'hasAttachments', 'importance', 'webLink',
].join(',');

const MEETING_SELECT = [
  'id', 'iCalUId', 'seriesMasterId', 'subject', 'bodyPreview', 'body', 'start', 'end',
  'organizer', 'attendees', 'isOnlineMeeting', 'onlineMeeting', 'onlineMeetingUrl',
  'location', 'importance', 'sensitivity', 'isCancelled', 'webLink',
].join(',');

const CHAT_SELECT = 'id,topic,chatType,createdDateTime,lastUpdatedDateTime,viewpoint';

function dbPath() {
  return path.join(app.getPath('userData'), 'seassist.db');
}

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `seassist-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

function safeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'pull';
}

// In-flight ingest pipelines. spawn() children are NOT placed in a Windows job object, so
// if the app quits mid-ingest they orphan and keep writing to seassist.db behind the user's
// back — and an orphaned writer can trip a fast relaunch with "database is locked" (WAL
// permits a single writer). Track every live child so `before-quit` can tree-kill them,
// mirroring how the WorkIQ MCP/auth children are already cleaned up (workiq-auth killTree).
const activeChildren = new Set();

// Kill a child AND anything it spawned. On Windows proc.kill() only signals the top process,
// leaving grandchildren (e.g. a re-spawned python) orphaned, so use taskkill /t on the pid.
function killTree(proc) {
  const pid = proc?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { proc.kill(); } catch { /* ignore */ } });
      killer.unref?.();
      return;
    } catch { /* fall through to the plain kill */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
}

// Tree-kill every in-flight ingest pipeline. Called from the app 'before-quit' handler so a
// running WorkIQ pull never leaves an orphaned Python process writing to the DB after quit.
// Returns the number of children signalled (0 when nothing was running).
function stopActiveIngestChildren() {
  let n = 0;
  for (const proc of activeChildren) { killTree(proc); n += 1; }
  activeChildren.clear();
  return n;
}

// Run a Python pipeline command; resolve { code, stdout, stderr }. Rejects on spawn error.
function runPython(args, { timeoutMs = 180_000, env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, SEASSIST_DB: dbPath(), PYTHONIOENCODING: 'utf-8', ...(extraEnv || {}) },
      shell: false,
      windowsHide: true,
    });
    // Track for quit-time cleanup; 'exit' fires on every termination (normal, timeout-kill,
    // or quit tree-kill), so removal is unconditional and never leaks a dead handle.
    activeChildren.add(proc);
    proc.once('exit', () => activeChildren.delete(proc));
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { proc.kill(); } catch { /* ignore */ } reject(new Error(`Python timed out: ${args.join(' ')}`)); }
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer);
      if (err.code === 'ENOENT') reject(new Error('Python was not found on PATH. Install Python 3 to enable ingestion.'));
      else reject(err);
    });
    proc.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function py(args, opts) {
  const res = await runPython(args, opts);
  if (res.code !== 0) {
    throw new Error(`pipeline ${args.slice(0, 3).join(' ')} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(-400)}`);
  }
  return res.stdout;
}

function writeStage(obj) {
  const file = tmpFile('stage');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

function pyWithUtilityAi(args, options, label) {
  if (!options?.env?.SEASSIST_COPILOT_TOKEN || typeof copilotProvider.scheduleExternalModelWork !== 'function') {
    return py(args, options);
  }
  return copilotProvider.scheduleExternalModelWork(
    () => py(args, options),
    { label, priority: 'background' },
  );
}

// ── Email ───────────────────────────────────────────────────────────────────────────
// Per-account $search pull, staged with the owning tpid, then a single refresh pass.
// Accounts whose search failed are returned so consumers of the stored mail (Secretary)
// can say which accounts the latest pull did not refresh.
async function ingestEmail(wiq, accounts, { topPerAccount = 50, onProgress, aiEnv }) {
  let staged = 0;
  const failedAccounts = [];
  for (const acct of accounts) {
    const term = String(acct.name || '').replace(/"/g, '').trim();
    if (!term) continue;
    onProgress?.({ medium: 'email', phase: 'pull', detail: acct.name });
    let value = [];
    try {
      const url = `/me/messages?$search="${encodeURIComponent(term)}"&$select=${EMAIL_SELECT}&$top=${topPerAccount}`;
      const res = await wiq.fetchAll(url, { maxPages: 3 });
      value = res.value;
    } catch (err) {
      failedAccounts.push({ account: acct.name, error: err.message });
      onProgress?.({ medium: 'email', phase: 'warn', detail: `${acct.name}: ${err.message}` });
      continue;
    }
    if (!value.length) continue;
    const file = writeStage({ value });
    try {
      await py(['-m', 'tools.email.cli', 'stage-raw', '--file', file, '--tpid', acct.tpid, '--name', `${safeName(acct.name)}`]);
      staged += value.length;
    } finally {
      cleanup(file);
    }
  }
  onProgress?.({ medium: 'email', phase: 'process', detail: 'linking + profiles' });
  const out = await pyWithUtilityAi(
    ['-m', 'tools.email.cli', 'refresh'],
    { timeoutMs: 300_000, env: aiEnv },
    'Email customer-link enrichment',
  );
  return { medium: 'email', stagedMessages: staged, summary: lastLine(out), failedAccounts };
}

// ── Meetings ────────────────────────────────────────────────────────────────────────
// Calendar windows (<=15 days to stay under Graph's 100/page cap), then a refresh pass.
// The window spans `months` into the past through `futureMonths` into the future so that
// already-planned/accepted meetings are pulled too — a calendar that stops at "today" is
// not useful.
async function ingestMeetings(wiq, { months = 1, futureMonths = 3, onProgress, aiEnv, accountScope }) {
  const now = new Date();
  const start = new Date(now.getTime());
  start.setMonth(start.getMonth() - Math.max(1, months));
  const end = new Date(now.getTime());
  end.setMonth(end.getMonth() + Math.max(1, futureMonths));
  let staged = 0;
  let windowStart = new Date(start.getTime());
  while (windowStart < end) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + 15 * 24 * 3600 * 1000, end.getTime()));
    const s = windowStart.toISOString();
    const e = windowEnd.toISOString();
    onProgress?.({ medium: 'meetings', phase: 'pull', detail: `${s.slice(0, 10)}…${e.slice(0, 10)}` });
    try {
      const inventorySelect = MEETING_SELECT.split(',').filter(field => field !== 'body').join(',');
      const url = `/me/calendarView?startDateTime=${s}&endDateTime=${e}&$select=${inventorySelect}&$top=100&$orderby=start/dateTime desc`;
      const res = await wiq.fetchAll(url, { maxPages: 6 });
      const events = accountScope
        ? res.value.filter((event) => accountScope.accepts('meeting', event.id, JSON.stringify(event)))
        : res.value;
      if (events.length) {
        const detailed = [];
        for (const event of events) {
          const response = await wiq.fetchOne(`/me/events/${encodeURIComponent(event.id)}?$select=${MEETING_SELECT}`);
          const detail = response.value?.[0];
          if (!detail || detail.id !== event.id || typeof detail.body?.content !== 'string') {
            throw new Error('WorkIQ did not return the selected active meeting. No other meeting was substituted.');
          }
          if (!accountScope || accountScope.accepts('meeting', detail.id, JSON.stringify(detail))) detailed.push(detail);
        }
        const file = writeStage({ value: detailed });
        try {
          await py(['-m', 'tools.meetings.cli', 'stage-raw', '--file', file, '--name', `win_${s.slice(0, 10)}`]);
          staged += detailed.length;
        } finally {
          cleanup(file);
        }
      }
    } catch (err) {
      onProgress?.({ medium: 'meetings', phase: 'warn', detail: err.message });
      throw new Error(`Meeting pull failed for ${s.slice(0, 10)} through ${e.slice(0, 10)}: ${err.message}`, { cause: err });
    }
    windowStart = new Date(windowEnd.getTime() + 1000);
  }
  onProgress?.({ medium: 'meetings', phase: 'process', detail: 'linking + profiles' });
  const out = await pyWithUtilityAi(
    ['-m', 'tools.meetings.cli', 'refresh'],
    { timeoutMs: 300_000, env: aiEnv },
    'Meeting customer-link enrichment',
  );
  return { medium: 'meetings', stagedEvents: staged, summary: lastLine(out) };
}

// ── Teams chats ─────────────────────────────────────────────────────────────────────
// Inventory all chats -> sync (alias + ingest + link) -> pull messages for customer chats.
// Teams staging/working dir. Must be writable, so in a packaged build it lives under
// userData (the bundled tools/ copy in resources may be read-only, e.g. Program Files).
const TEAMS_EXPORTS = app.isPackaged
  ? path.join(app.getPath('userData'), 'teams-exports')
  : path.join(REPO_ROOT, 'tools', 'teams', 'exports');

// Privacy: `stage-raw` copies each pulled chat's message bodies into
// TEAMS_EXPORTS/messages/*.json (+ _map.json) as a working set. Once ingestion
// has run, that content is already persisted (and secret-redacted) in
// teams_chat_messages, so the plaintext side-copies are redundant. The sync
// watermark lives in teams_chat_sync (the DB), not these files, so it is safe
// to purge everything except the .gitkeep placeholder after each run.
function purgeTeamsExports() {
  try {
    if (!fs.existsSync(TEAMS_EXPORTS)) return;
    for (const entry of fs.readdirSync(TEAMS_EXPORTS)) {
      if (entry === '.gitkeep') continue;
      try { fs.rmSync(path.join(TEAMS_EXPORTS, entry), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

async function ingestTeams(wiq, { maxChatPages = 20, maxChatsForMessages = 60, topPerChat = 50, onProgress, aiEnv, accountScope }) {
  fs.mkdirSync(path.join(TEAMS_EXPORTS, 'messages'), { recursive: true });
  try {
    return await ingestTeamsInner(wiq, { maxChatPages, maxChatsForMessages, topPerChat, onProgress, aiEnv, accountScope });
  } finally {
    // Always purge the plaintext staging copies, even if ingestion partially failed.
    purgeTeamsExports();
  }
}

async function ingestTeamsInner(wiq, { maxChatPages = 20, maxChatsForMessages = 60, topPerChat = 50, onProgress, aiEnv, accountScope }) {
  // 1) Inventory.
  onProgress?.({ medium: 'teams', phase: 'pull', detail: 'chat inventory' });
  const inv = await wiq.fetchAll(`/me/chats?$expand=members&$select=${CHAT_SELECT}&$top=50`, { maxPages: maxChatPages });
  const invFile = path.join(TEAMS_EXPORTS, `inventory_${Date.now()}.json`);
  const chats = accountScope
    ? inv.value.filter((chat) => accountScope.accepts('chat', chat.id, JSON.stringify(chat)))
    : inv.value;
  fs.writeFileSync(invFile, JSON.stringify({ value: chats }), 'utf8');
  let syncSummary = '';
  try {
    syncSummary = lastLine(await pyWithUtilityAi(
      ['-m', 'tools.teams.cli', 'sync', '--dir', TEAMS_EXPORTS],
      { timeoutMs: 240_000, env: aiEnv },
      'Teams customer-link enrichment',
    ));
  } finally {
    cleanup(invFile);
  }

  // 2) Which customer chats need message bodies?
  let manifest = [];
  try {
    const out = await py(['-m', 'tools.teams.cli', 'fetch-manifest', '--limit', String(maxChatsForMessages)]);
    manifest = JSON.parse(out.trim() || '[]');
  } catch (err) {
    onProgress?.({ medium: 'teams', phase: 'warn', detail: `manifest: ${err.message}` });
  }

  // 3) Pull + stage messages per chat.
  let pulled = 0;
  const emptyChatIds = [];
  for (const item of manifest) {
    const chatId = item.chat_id || item.chatId;
    if (!chatId) continue;
    onProgress?.({ medium: 'teams', phase: 'pull', detail: (item.topic || chatId).slice(0, 40) });
    try {
      const res = await wiq.fetchAll(`/me/chats/${encodeURIComponent(chatId)}/messages?$top=${topPerChat}`, { maxPages: 2 });
      if (!res.value.length) { emptyChatIds.push(chatId); continue; }
      const file = writeStage({ chatId, value: res.value });
      try {
        await py(['-m', 'tools.teams.cli', 'stage-raw', '--file', file, '--chat-id', chatId, '--name', `chat_${safeName(item.topic || chatId)}`]);
        pulled += res.value.length;
      } finally {
        cleanup(file);
      }
    } catch (err) {
      onProgress?.({ medium: 'teams', phase: 'warn', detail: err.message });
    }
  }

  if (pulled > 0) {
    onProgress?.({ medium: 'teams', phase: 'process', detail: 'ingest messages + profiles' });
    await py(['-m', 'tools.teams.cli', 'ingest-messages'], { timeoutMs: 240_000 });
  }
  if (emptyChatIds.length) {
    try { await py(['-m', 'tools.teams.cli', 'mark-pulled', ...emptyChatIds]); } catch { /* best effort */ }
  }
  await py(['-m', 'tools.teams.cli', 'build-profile', '--all'], { timeoutMs: 240_000 });

  return { medium: 'teams', inventory: inv.value.length, stagedMessages: pulled, summary: syncSummary };
}

function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : '';
}

// Build the environment handed to an AI-using Python step. Always sets the weak-link
// cap. When Copilot is connected it adds a FRESH bearer token + endpoint + resolved
// utility model. There is no alternate provider fallback: if the
// Copilot token can't be obtained, the fast-model env is omitted (Python skips AI and
// keeps the deterministic exact-name baseline) and the failure is recorded on
// ``aiState`` so runIngestion can surface a degraded-imports notice. Fetching the token
// per step keeps it from expiring mid-run on a long backfill (copilot-provider caches +
// auto-refreshes).
async function buildAiEnv(weakCap, aiState) {
  const env = { SEASSIST_WEAK_CAP: String(weakCap) };
  try {
    const token = await copilotProvider.getCopilotToken();
    const apiBase = copilotProvider.getApiBase();
    if (token && apiBase) {
      env.SEASSIST_COPILOT_TOKEN = token;
      env.SEASSIST_COPILOT_API = apiBase;
      env.SEASSIST_FAST_MODEL = fastModel();
      if (aiState && aiState.connected === null) aiState.connected = true;
    } else {
      if (aiState) {
        aiState.connected = false;
        if (!aiState.degradedReason) {
          aiState.degradedReason = 'GitHub Copilot connection error: no Copilot token/endpoint available (sign in to Copilot in Settings).';
        }
      }
    }
  } catch (err) {
    // Not connected to Copilot (or no seat). No fallback model exists — record the
    // specific error so imports proceed degraded (exact-name baseline) with a loud,
    // honest notice rather than a silent substitution.
    if (aiState) {
      aiState.connected = false;
      if (!aiState.degradedReason) {
        aiState.degradedReason = `GitHub Copilot connection error: ${err.message}`;
      }
    }
  }
  return env;
}

// ── Public entry points ───────────────────────────────────────────────────────────────
async function runIngestion({ mode = 'incremental', mediums = ['email', 'meetings', 'teams'], accounts = [], months, futureMonths, onProgress } = {}) {
  const database = require('../sqlite-ipc').openDb();
  assertActiveTpids(database, accounts.map((account) => account.tpid));
  const accountScope = createAccountScope(database);
  const wiq = getWorkIqClient({ log: () => {} });
  const ready = await wiq.probe();
  if (!ready.ok) {
    throw new Error(`WorkIQ is not available: ${ready.error}. Ensure the Copilot CLI WorkIQ sign-in is valid (run "copilot" once and use WorkIQ).`);
  }

  const isBackfill = mode === 'backfill';
  const monthsWindow = months || (isBackfill ? 6 : 1);
  const futureWindow = futureMonths || (isBackfill ? 6 : 3);
  const topPerAccount = isBackfill ? 100 : 40;
  const results = [];
  const errors = [];

  // Tracks the connected GitHub Copilot utility-model state across all AI steps. When it
  // can't be reached (or its calls fail), imports run degraded on the exact-name
  // baseline and we surface `degradedReason` — never a silent model substitution.
  const aiState = { connected: null, degradedReason: null };

  // Mode-aware AI caps. Backfill is the heavy convergence pass; "Pull new items" stays
  // light so routine pulls are quick. Both are cached, so work never repeats once done.
  const aliasMaxNew = isBackfill ? 400 : 150;
  const weakCap = isBackfill ? 150 : 60;

  // Alias step (runs first for both Backfill and Pull-new-items): ask the connected
  // GitHub Copilot utility model for short, high-precision aliases per
  // synced customer so subsidiary/short names link too. When Copilot is unavailable
  // there is no fallback model — it falls back to the exact customer name (degraded).
  // Best-effort — never blocks ingestion.
  onProgress?.({ medium: 'aliases', phase: 'start', detail: 'Generating customer aliases…' });
  try {
    const aliasEnv = await buildAiEnv(weakCap, aiState);
    const out = await pyWithUtilityAi(
      ['-m', 'tools.teams.cli', 'gen-aliases', '--max-new', String(aliasMaxNew), '--json'],
      { timeoutMs: 600_000, env: aliasEnv },
      'Customer alias enrichment',
    );
    let summary = null;
    try { summary = JSON.parse(lastLine(out)); } catch { /* non-JSON output */ }
    if (summary) {
      // Copilot was wired but its calls failed enough to trip the circuit breaker.
      if (summary.ai_error && !aiState.degradedReason) {
        aiState.connected = false;
        aiState.degradedReason = `GitHub Copilot error: ${summary.model || fastModel()} calls failed.`;
      }
      const detail = summary.model_available
        ? `AI aliases (${summary.model || fastModel()}): ${summary.ai_generated} new, ${summary.from_cache} cached${summary.remaining ? `, ${summary.remaining} deferred` : ''}`
        : `Degraded — GitHub Copilot unavailable; using exact customer names (${summary.fallback} accounts)`;
      results.push({ medium: 'aliases', ...summary });
      onProgress?.({ medium: 'aliases', phase: 'ok', detail });
    } else {
      onProgress?.({ medium: 'aliases', phase: 'ok', detail: 'Aliases refreshed.' });
    }
  } catch (err) {
    errors.push({ medium: 'aliases', error: err.message });
    onProgress?.({ medium: 'aliases', phase: 'error', detail: `Alias generation skipped: ${err.message}` });
  }

  if (mediums.includes('email')) {
    onProgress?.({ medium: 'email', phase: 'start' });
    try { results.push(await ingestEmail(wiq, accounts, { topPerAccount, onProgress, aiEnv: await buildAiEnv(weakCap, aiState) })); }
    catch (err) { errors.push({ medium: 'email', error: err.message }); onProgress?.({ medium: 'email', phase: 'error', detail: err.message }); }
  }
  if (mediums.includes('meetings')) {
    onProgress?.({ medium: 'meetings', phase: 'start' });
    try { results.push(await ingestMeetings(wiq, { months: monthsWindow, futureMonths: futureWindow, onProgress, aiEnv: await buildAiEnv(weakCap, aiState), accountScope })); }
    catch (err) { errors.push({ medium: 'meetings', error: err.message }); onProgress?.({ medium: 'meetings', phase: 'error', detail: err.message }); }
  }
  if (mediums.includes('teams')) {
    onProgress?.({ medium: 'teams', phase: 'start' });
    try { results.push(await ingestTeams(wiq, { maxChatsForMessages: isBackfill ? 120 : 40, onProgress, aiEnv: await buildAiEnv(weakCap, aiState), accountScope })); }
    catch (err) { errors.push({ medium: 'teams', error: err.message }); onProgress?.({ medium: 'teams', phase: 'error', detail: err.message }); }
  }

  // AI enrichment is degraded when Copilot couldn't be reached (connected === false) or
  // its calls failed. Surface it loudly: a dedicated progress event + a flag on the
  // result so the Settings UI can show why imports are degraded.
  const degraded = aiState.connected === false;
  const degradedReason = degraded ? aiState.degradedReason : null;
  if (degraded) {
    onProgress?.({ phase: 'degraded', detail: degradedReason });
  }

  onProgress?.({ phase: 'done' });
  return { mode, results, errors, degraded, degradedReason, ranAt: new Date().toISOString() };
}

module.exports = { runIngestion, ingestEmail, ingestMeetings, ingestTeams, purgeTeamsExports, TEAMS_EXPORTS, stopActiveIngestChildren, runPython };
