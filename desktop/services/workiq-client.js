/**
 * workiq-client.js — drives the WorkIQ M365 MCP server directly over stdio JSON-RPC.
 *
 * WorkIQ is the only auth path in this tenant that can read mailbox / calendar / chat
 * data: it carries its own admin-consented M365 Copilot OAuth (cached under
 * ~/.copilot/mcp-oauth-config), unlike the Azure CLI / MSAL Graph token the app uses
 * for CRM, which lacks Mail.Read / Calendars.Read / Chat.Read.
 *
 * The package (@microsoft/workiq) is a listed dependency in desktop/package.json and is
 * installed into node_modules at build/install time.  At runtime we resolve the local
 * binary directly — zero npm registry calls — so IT network-protection policies that
 * block registry.npmjs.org never interfere with app use.
 *
 * The PACKAGED app NEVER shells out to npx: the native binary is asarUnpack'd into
 * resources, so a correct build always finds it, and if it's somehow missing we fail
 * loudly rather than reaching the public npm registry (which corp network protection
 * blocks, surfacing a "content blocked by your IT admin" popup). npx is a dev-only
 * fallback for machines that have not yet run `npm install`, and even then it is routed
 * through the Microsoft package-feed proxy — a corp-network mirror of public npm — so
 * locked-down developer laptops are never sent to the blocked registry.npmjs.org.
 *
 * We call its `fetch` / `call_function` tools deterministically (no LLM in the loop),
 * so the app can pull customer data on a schedule.  The returned shape mirrors
 * Microsoft Graph: results[].data.value[].
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// The @microsoft/workiq platform layout (mirrors the package's lib/install.js):
// the native executable lives at bin/<platformDir>/<name>. Windows (incl. arm64)
// maps to win-x64; macOS/Linux use osx-/linux-<arch>.
function workiqPlatformDir() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return `osx-${process.arch}`;
  return `linux-${process.arch}`;
}

// Resolve the workiq **native binary** (not the node_modules/.bin shim) so it works
// both in dev and in the packaged app. We deliberately avoid the .bin/workiq.cmd
// shim: in a packaged build it resolves inside app.asar (a virtual FS) where a .cmd
// can't be executed, and electron-builder does not unpack node_modules/.bin — which
// is why the packaged app previously reported "WorkIQ is not installed".
// @microsoft/workiq is asarUnpack'd, so its real bin/ dir sits on disk next to the
// asar. We probe the packaged location first, then the dev node_modules location.
// Returns null only if the package truly isn't present.
function resolveWorkIqBin() {
  const binName = process.platform === 'win32' ? 'workiq.exe' : 'workiq';
  const relBin = path.join('bin', workiqPlatformDir(), binName);
  const roots = [];
  // Packaged: <resources>/app.asar.unpacked/node_modules/@microsoft/workiq
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@microsoft', 'workiq'));
  }
  // Dev: desktop/node_modules/@microsoft/workiq
  roots.push(path.join(__dirname, '..', 'node_modules', '@microsoft', 'workiq'));
  for (const root of roots) {
    const candidate = path.join(root, relBin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// npm registry for the DEV-ONLY npx fallback. Defaults to the Microsoft package-feed
// proxy (a corp-network mirror of the public npm registry) so locked-down developer
// machines — where registry.npmjs.org is blocked by IT network protection — can still
// bootstrap WorkIQ. Override with WORKIQ_NPM_REGISTRY if you are off the corp network.
const FALLBACK_NPM_REGISTRY = process.env.WORKIQ_NPM_REGISTRY || 'https://packagefeedproxy.microsoft.io/npm';

// True only inside a packaged Electron build. Requiring electron is guarded so this module
// stays importable in plain Node (unit tests / tooling) where 'electron' resolves to a stub.
function isPackagedApp() {
  try {
    const electron = require('electron');
    return Boolean(electron && electron.app && electron.app.isPackaged);
  } catch {
    return false;
  }
}

const READY_TIMEOUT_MS = 90_000;   // generous timeout; local binary starts in <5 s
const CALL_TIMEOUT_MS = 120_000;   // large mailbox/calendar pulls
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const RETRY_ATTEMPTS = 3;          // bounded retries for transient remote-tool faults
const RETRY_BASE_DELAY_MS = 500;   // linear backoff: 500 ms, then 1000 ms

const EMAIL_SOURCE_SELECT = [
  'id', 'conversationId', 'subject', 'from', 'toRecipients', 'ccRecipients',
  'receivedDateTime', 'sentDateTime', 'body', 'bodyPreview', 'webLink', 'importance',
].join(',');

function parseMcpPayload(result) {
  if (result?.structuredContent != null) return result.structuredContent;
  for (const part of result?.content || []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { return JSON.parse(part.text); } catch { /* Some tools return plain text. */ }
  }
  return null;
}

function getMcpError(result, label = 'WorkIQ', entityUrls = []) {
  const data = parseMcpPayload(result);
  const results = Array.isArray(data?.results) ? data.results : [];
  const failedIndex = results.findIndex((entry) => entry?.statusCode >= 400 || entry?.error || entry?.data?.error);
  const failed = results[failedIndex];
  const status = failed?.statusCode ?? data?.statusCode;
  let error = failed?.error ?? failed?.data?.error ?? data?.error;
  if (!result?.isError && !error && !(status >= 400)) return null;
  let code;
  for (let depth = 0; error && typeof error === 'object' && depth < 8; depth += 1) {
    code = typeof error.code === 'string' ? error.code : code;
    if (typeof error.message === 'string') { error = error.message; break; }
    error = error.error;
  }
  const detail = (typeof error === 'string' && error.trim())
    || (result?.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    || 'The service returned an error without details.';
  const failure = new Error(`${label} failed${status ? ` (HTTP ${status})` : ''}: ${code ? `${code}: ` : ''}${detail}`);
  failure.statusCode = status;
  failure.code = code;
  const requested = failedIndex >= 0 ? entityUrls[failedIndex] : entityUrls.length === 1 ? entityUrls[0] : null;
  failure.resource = requested || (typeof failed?.url === 'string' ? failed.url : null);
  return failure;
}

function getMcpErrorMessage(result, label = 'WorkIQ') {
  return getMcpError(result, label)?.message || null;
}

// Match only the generic backend fault, not an HTTP/policy error containing the same text.
function isTransientToolError(message, name) {
  const text = String(message || '').trim().replace(/\.$/, '').toLowerCase();
  const fault = `An error occurred invoking '${name}'`.toLowerCase();
  return text === fault || text === `workiq ${name} failed: ${fault}`;
}

function createWorkIqClient({ spawnProcess = spawn, log = () => {}, resolveBin = resolveWorkIqBin, packaged = isPackagedApp,
  retryAttempts = RETRY_ATTEMPTS, retryBaseDelayMs = RETRY_BASE_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let proc = null;
  let readyPromise = null;
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  let idleTimer = null;
  let activeCalls = 0;

  const isWin = process.platform === 'win32';

  function scheduleIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending.size === 0) stop();
    }, IDLE_SHUTDOWN_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  function rejectAll(err) {
    for (const { reject, timer, cleanup } of pending.values()) {
      clearTimeout(timer);
      cleanup?.();
      reject(err);
    }
    pending.clear();
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer, cleanup } = pending.get(msg.id);
      clearTimeout(timer);
      cleanup?.();
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  function rpc(method, params, timeoutMs = CALL_TIMEOUT_MS, signal) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (!proc || !proc.stdin.writable) {
        reject(new Error('WorkIQ process is not running.'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        cleanup();
        reject(new Error(`WorkIQ ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const onAbort = () => {
        pending.delete(id);
        clearTimeout(timer);
        cleanup();
        notify('notifications/cancelled', { requestId: id, reason: 'User stopped the investigation.' });
        reject(signal.reason);
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { resolve, reject, timer, cleanup });
      try {
        proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        pending.delete(id);
        reject(new Error(`WorkIQ write failed: ${err.message}`));
      }
    });
  }

  function notify(method, params) {
    if (proc && proc.stdin.writable) {
      try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* pipe closed */ }
    }
  }

  function start() {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const workiqBin = resolveBin();
      try {
        if (workiqBin) {
          // Launch the native exe directly (no shell) — the packaged install path
          // contains a space ("SE Assist"), which a shell would mis-split.
          proc = spawnProcess(workiqBin, ['mcp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } else if (packaged()) {
          // Packaged app with no binary: DO NOT reach the npm registry (corp network
          // protection blocks it with a scary "content blocked by your IT admin" popup).
          // The binary is asarUnpack'd, so this only happens on a corrupt/partial install.
          // Fail loudly with an actionable message instead of silently falling back to npx.
          readyPromise = null;
          reject(new Error(
            'WorkIQ is not available in this installation. The bundled WorkIQ binary was '
            + `not found (expected under resources/app.asar.unpacked/node_modules/@microsoft/workiq/bin/${workiqPlatformDir()}/). `
            + 'Reinstall SE Assist to restore it. The app will not contact the public npm registry.'));
          return;
        } else {
          // Dev fallback only (never in the packaged app): package not installed yet.
          // Route npx through the Microsoft package-feed proxy so locked-down dev laptops
          // are not sent to the blocked registry.npmjs.org.
          log(`[workiq] Local binary not found. Run \`npm install\` in desktop/. Falling back to npx via ${FALLBACK_NPM_REGISTRY}.`);
          proc = spawnProcess('npx', ['-y', '@microsoft/workiq', 'mcp'], {
            env: {
              ...process.env,
              npm_config_registry: FALLBACK_NPM_REGISTRY,
              'npm_config_@microsoft:registry': FALLBACK_NPM_REGISTRY,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: isWin,
            windowsHide: true,
          });
        }
      } catch (err) {
        readyPromise = null;
        reject(new Error(`Failed to launch WorkIQ: ${err.message}`));
        return;
      }

      // A stopped process can still emit output, errors, or its exit after a replacement has
      // started. Its events must never touch the replacement's state or requests.
      const child = proc;
      const current = () => proc === child;

      const readyTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (current()) stop();
          reject(new Error('WorkIQ did not become ready in time. Ensure the Copilot CLI WorkIQ sign-in is valid.'));
        }
      }, READY_TIMEOUT_MS);

      proc.stdout.on('data', (d) => {
        if (!current()) return;
        buffer += d.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      });
      proc.stderr.on('data', (d) => log('[workiq] ' + d.toString().slice(0, 400)));

      // Stream-level errors (broken pipe / EPIPE after the child dies) emit on the
      // stdio streams, NOT on the ChildProcess — without these handlers they would
      // escalate to an uncaughtException and crash the Electron main process.
      const onStreamError = (where) => (err) => {
        log(`[workiq] ${where} stream error: ${err.message}`);
        if (current()) rejectAll(new Error(`WorkIQ ${where} stream error: ${err.message}`));
      };
      proc.stdin.on('error', onStreamError('stdin'));
      proc.stdout.on('error', onStreamError('stdout'));
      proc.stderr.on('error', onStreamError('stderr'));

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          if (current()) readyPromise = null;
          reject(err);
        }
        if (current()) rejectAll(new Error(`WorkIQ process error: ${err.message}`));
      });
      proc.on('exit', (code) => {
        log(`[workiq] exited code=${code}`);
        if (!current()) return;
        proc = null;
        readyPromise = null;
        rejectAll(new Error('WorkIQ process exited.'));
      });

      (async () => {
        try {
          await rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'se-assist', version: '1.0' },
          }, READY_TIMEOUT_MS);
          notify('notifications/initialized', {});
          // Newer WorkIQ builds gate every tool call behind a one-time EULA acceptance;
          // an un-accepted server returns the EULA notice instead of data, which the app
          // would silently read as empty results. Accept it up front (idempotent;
          // ignored on builds that don't expose the tool).
          try {
            await rpc('tools/call', {
              name: 'accept_eula',
              arguments: { eulaUrl: 'https://github.com/microsoft/work-iq' },
            }, 15_000);
          } catch (err) {
            // Older server without the tool, or already accepted — unless this process was stopped.
            if (!current()) throw err;
          }
          settled = true;
          clearTimeout(readyTimer);
          scheduleIdleShutdown();
          resolve();
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            if (current()) readyPromise = null;
            reject(err);
          }
        }
      })();
    });

    return readyPromise;
  }

  // True while any tool call is starting WorkIQ or waiting for its answer.
  function busy() {
    return activeCalls > 0;
  }

  // `reason` is what in-flight callers are told, so a deliberate restart can say why.
  function stop(reason = 'WorkIQ client stopped.') {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    rejectAll(new Error(reason));
    if (proc) {
      const pid = proc.pid;
      try { proc.kill(); } catch { /* ignore */ }
      // On Windows the child is spawned via cmd.exe (shell:true for the .cmd npx), so
      // proc.kill() only ends the shell — kill the whole tree to avoid orphaning node.
      if (isWin && pid) {
        try { require('child_process').exec(`taskkill /pid ${pid} /T /F`, () => {}); } catch { /* ignore */ }
      }
      proc = null;
    }
    readyPromise = null;
    buffer = '';
  }

  async function callTool(name, args, timeoutMs, signal) {
    activeCalls += 1;
    try {
      signal?.throwIfAborted();
      await start();
      signal?.throwIfAborted();
      scheduleIdleShutdown();
      return await rpc('tools/call', { name, arguments: args }, timeoutMs, signal);
    } finally {
      activeCalls -= 1;
    }
  }

  // Only these read-side tools are available to the Work Agent, never Graph writes.
  async function readTool(name, args, timeoutMs = CALL_TIMEOUT_MS, signal, onRetry) {
    if (!['retrieve', 'fetch', 'ask', 'search_paths', 'get_schema'].includes(name)) {
      throw new Error(`Work Agent cannot call the WorkIQ tool "${name}". Only research tools are allowed.`);
    }
    if (args?.agentId) throw new Error('Work Agent cannot delegate to a different WorkIQ agent.');
    const attempts = Math.max(1, retryAttempts);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const result = await callTool(name, args, timeoutMs, signal);
        const error = getMcpError(result, `WorkIQ ${name}`, args?.entityUrls);
        if (!error) return result;
        lastError = error;
      } catch (err) {
        lastError = err;
      }
      signal?.throwIfAborted();
      if (!isTransientToolError(lastError?.message, name)) throw lastError;
      if (attempt >= attempts) {
        const error = new Error(`${lastError.message} WorkIQ did not recover after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.`, { cause: lastError });
        error.code = 'WORKIQ_TRANSIENT_TOOL_FAILURE';
        error.tool = name;
        error.attempts = attempts;
        throw error;
      }
      log(`WorkIQ ${name} transient fault (attempt ${attempt}/${attempts}); retrying: ${lastError.message}`);
      onRetry?.({ tool: name, attempt: attempt + 1, attempts, error: lastError.message });
      await sleep(retryBaseDelayMs * attempt);
    }
    throw lastError;
  }

  // Normalize a fetch/call_function tool result into [{ url?, value[], nextLink, status }].
  function extractResults(toolResult) {
    const sc = toolResult?.structuredContent;
    let results = sc?.results;
    if (!results && Array.isArray(toolResult?.content)) {
      // Fall back to parsing the text content block as JSON.
      const text = toolResult.content.find((c) => c.type === 'text')?.text;
      if (text) {
        try { results = JSON.parse(text).results; } catch { /* ignore */ }
      }
    }
    if (!Array.isArray(results)) return [];
    return results.map((r) => {
      const data = r?.data || {};
      // Collections return { value: [...] }; single entities (e.g. /me, /manager,
      // /users/{id}) return the resource object DIRECTLY. Detect the latter by an `id`
      // or an `@odata.context` ending in `/$entity` and wrap it so callers see one shape.
      let value;
      if (Array.isArray(data.value)) {
        value = data.value;
      } else if (data.value !== undefined && data.value !== null) {
        value = [data.value];
      } else if (data && typeof data === 'object'
        && (data.id || /\$entity\b/.test(String(data['@odata.context'] || '')))) {
        value = [data];
      } else {
        value = [];
      }
      return {
        value,
        nextLink: data['@odata.nextLink'] || null,
        status: r?.statusCode || null,
        raw: r,
      };
    });
  }

  // Fetch one entity URL, returning { value, nextLink, status, raw }.
  async function fetchOne(entityUrl, timeoutMs) {
    const res = await callTool('fetch', { entityUrls: [entityUrl] }, timeoutMs);
    const parsed = extractResults(res);
    return parsed[0] || { value: [], nextLink: null, status: null, raw: null };
  }

  // WorkIQ's fetch tool requires RELATIVE paths, but Graph's @odata.nextLink is an
  // absolute URL — strip the host/version prefix so pagination past page 1 works.
  function toRelativeGraphPath(url) {
    return String(url || '').replace(/^https:\/\/graph\.microsoft\.com\/(v1\.0|beta)/i, '');
  }

  // Fetch an entity URL and follow @odata.nextLink up to maxPages, concatenating values.
  async function fetchAll(entityUrl, { maxPages = 20, timeoutMs } = {}) {
    const all = [];
    let url = entityUrl;
    let pages = 0;
    let lastStatus = null;
    while (url && pages < maxPages) {
      const page = await fetchOne(url, timeoutMs);
      lastStatus = page.status;
      if (page.value.length) all.push(...page.value);
      url = page.nextLink ? toRelativeGraphPath(page.nextLink) : null;
      pages += 1;
      if (!page.value.length && !page.nextLink) break;
    }
    return { value: all, pages, status: lastStatus, truncated: Boolean(url) };
  }

  async function callFunction(functionUrl, timeoutMs) {
    const res = await callTool('call_function', { functionUrl }, timeoutMs);
    return extractResults(res);
  }

  // Parse a `do_action` (POST) tool result into { status, data, error }. Unlike fetch/
  // call_function (which wrap results in { results: [...] }), do_action returns the action
  // payload directly as { statusCode, data }. Prefer structuredContent; fall back to the
  // JSON text content block. A non-JSON text block (or an isError result) becomes an error.
  function extractActionResult(toolResult) {
    let payload = toolResult?.structuredContent;
    const looksWrapped = payload && typeof payload === 'object'
      && (payload.statusCode !== undefined || payload.data !== undefined || payload.error !== undefined);
    if (!looksWrapped) {
      const text = Array.isArray(toolResult?.content)
        ? toolResult.content.find((c) => c?.type === 'text')?.text
        : null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { error: text }; }
      }
    }
    if (!payload || typeof payload !== 'object') {
      return { status: null, data: null, error: toolResult?.isError ? 'WorkIQ returned an error.' : null };
    }
    const error = payload.error ?? (toolResult?.isError ? (payload.message || 'WorkIQ returned an error.') : null);
    return {
      status: payload.statusCode ?? null,
      data: payload.data !== undefined ? payload.data : (payload.statusCode !== undefined ? null : payload),
      error,
    };
  }

  // Invoke a Graph action (POST), e.g. /search/query, /me/calendar/getSchedule,
  // /me/findMeetingTimes. Returns { status, data, error }.
  async function doAction(actionUrl, jsonBody, timeoutMs) {
    const res = await callTool('do_action', { actionUrl, jsonBody }, timeoutMs);
    return extractActionResult(res);
  }

  // A process response alone does not prove the mailbox is readable.
  async function probe() {
    try {
      const result = await readTool('fetch', { entityUrls: ['/me/messages?$select=id&$top=1'] });
      const payload = parseMcpPayload(result);
      const page = payload?.results?.[0];
      if (payload?.results?.length !== 1 || page?.statusCode !== 200 || !Array.isArray(page.data?.value)) {
        throw Object.assign(new Error('WorkIQ did not return a valid mailbox readiness response.'), {
          code: 'WORKIQ_INVALID_PROBE_RESPONSE', statusCode: page?.statusCode,
        });
      }
      return { ok: true, status: 200 };
    } catch (err) {
      return { ok: false, error: err.message, status: err.statusCode ?? null, code: err.code ?? null };
    }
  }

  return { start, stop, busy, fetchOne, fetchAll, callFunction, doAction, probe, extractResults, readTool };
}

// Module-level singleton so the whole app shares one WorkIQ process.
let singleton = null;
function getWorkIqClient(opts) {
  if (!singleton) singleton = createWorkIqClient(opts);
  return singleton;
}

module.exports = {
  createWorkIqClient, getWorkIqClient, resolveWorkIqBin,
  EMAIL_SOURCE_SELECT, parseMcpPayload, getMcpErrorMessage,
};
