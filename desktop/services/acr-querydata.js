/**
 * acr-querydata.js — Direct Power BI querydata (DSR) client for Azure Consumed
 * Revenue (ACR).
 *
 * Ported from mcaps-microsoft/frontier-solution-engineer
 * (src/main/services/acr-querydata.ts). Instead of a natural-language DataAgent,
 * it queries the underlying Power BI semantic model directly via the
 * `/explore/querydata` endpoint — the exact path the official MSXI ACR Power BI
 * report uses. The response is a deterministic DSR document, so there is no LLM
 * parsing and no aggregate-vs-per-account ambiguity.
 *
 * The query/decoder/period primitives live in `acr-schema.js` (pure,
 * unit-tested). This module owns the IO concerns: the windowed HTTP fetch loop,
 * a short-lived cache, and the public query surface. Auth (a Power BI bearer
 * token) is injected via `getPowerBiToken` so this stays decoupled from
 * SE Assist's MSAL/Azure-CLI plumbing.
 */

const {
  buildAcrQuery,
  buildRequestBody,
  decodeDSRPage,
  DIMENSIONS,
  MEASURES,
  isDimensionKey,
  isMeasureKey,
  resolvePeriod,
  availableFiscalMonths,
  availableFiscalYears,
  shapeRows,
  nestServiceHierarchy,
  orderFiscalMonths,
  currentFiscalMonth,
  previousFiscalMonth,
  fiscalMonthToCalendar,
  fyMonthOf,
  ACR_MODEL_ID,
} = require('./acr-schema');
const {
  readRowCache,
  writeRowCache,
  deleteRowCacheByPrefix,
  listRowCacheKeysByPrefix,
  claimLegacyRowCache,
  invalidateCacheOnModelChange,
  parseSqliteUtc,
} = require('./acr-row-cache');
const { createHash } = require('node:crypto');
const { projectCachedAcr } = require('./acr-cache-projection');
const { sharedAcrScheduler } = require('./acr-request-scheduler');

// ─── Endpoint & request constants (from msxi-snap) ───────────────
const QUERYDATA_URL =
  'https://df-msit-scus-redirect.analysis.windows.net/explore/querydata?synchronous=true';

// OAuth resource for the Power BI API (scope becomes `${resource}/.default`).
const POWERBI_RESOURCE = 'https://analysis.windows.net/powerbi/api';

const MAX_WINDOWS = 600;
const MAX_ROWS = 2_000_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 5;

// Cached data is always served, even when old. After 22 hours it is refreshed in
// the background and the active chart is notified; an explicit `force` waits for live
// data. Historical rows therefore remain available permanently in SQLite.
const BACKGROUND_REFRESH_AFTER_MS = 22 * 60 * 60 * 1000;
const CLOSED_MONTH_FINALIZATION_DELAY_MS = 22 * 60 * 60 * 1000;
const ROW_CACHE_MAX_ENTRIES = 32;
const CACHE_INFO = Symbol('acr-cache-info');
const CACHE_INTERNAL = Symbol('acr-cache-internal');
const queryId = key => createHash('sha256').update(key).digest('hex').slice(0, 16);

const defaultLogger = {
  info: (m) => console.log(`[acr-querydata] ${m}`),
  warn: (m) => console.warn(`[acr-querydata] ${m}`),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setCacheInfo(rows, info) {
  Object.defineProperty(rows, CACHE_INFO, {
    value: info,
    configurable: true,
    enumerable: false,
  });
  return rows;
}

function cacheInfo(rows) {
  return rows?.[CACHE_INFO] || {
    status: 'missing',
    dataAsOf: null,
    ageMs: null,
    refreshing: false,
    source: 'none',
    incompleteMonths: [],
  };
}

function setCacheInternal(rows, internal) {
  Object.defineProperty(rows, CACHE_INTERNAL, {
    value: internal,
    configurable: true,
    enumerable: false,
  });
  return rows;
}

function cacheInternal(rows) {
  return rows?.[CACHE_INTERNAL] || null;
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function accessTokenIdentity(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'),
    );
    return normalizeIdentity(
      payload.preferred_username || payload.upn || payload.unique_name || '',
    );
  } catch {
    return null;
  }
}

function mergeCacheInfo(...rowsLists) {
  const infos = rowsLists.map(cacheInfo);
  const dated = infos.filter((info) => info.dataAsOf);
  const oldest = dated.sort((left, right) => (
    Date.parse(left.dataAsOf) - Date.parse(right.dataAsOf)
  ))[0];
  const refreshing = infos.some((info) => info.refreshing);
  const hasMissing = infos.some((info) => info.status === 'missing');
  const hasUsable = infos.some((info) => info.status !== 'missing');
  const status = hasMissing && hasUsable
    ? 'partial'
    : hasMissing
      ? 'missing'
    : infos.some((info) => info.status === 'stale')
      ? 'stale'
      : infos.some((info) => info.status === 'live')
        ? 'live'
        : 'fresh';
  return {
    status,
    dataAsOf: oldest?.dataAsOf || null,
    ageMs: oldest?.ageMs ?? null,
    refreshing,
    source: infos.map((info) => info.source).filter(Boolean).join('+') || 'none',
    error: infos.find((info) => info.error)?.error || null,
    incompleteMonths: [...new Set(infos.flatMap((info) => info.incompleteMonths || []))],
    refreshKeys: [...new Set(infos.flatMap((info) => info.refreshKeys || []))],
    queryKeys: [...new Set(infos.flatMap((info) => info.queryKeys || []))],
  };
}

// Exponential backoff with full jitter (50–100% of the base delay) so a burst
// of requests that failed together retries at staggered times instead of
// re-colliding in lockstep.
function backoffWithJitter(attempt) {
  const base = Math.min(5000 * 2 ** (attempt - 1), 120_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(header, attempt) {
  if (header != null && String(header).trim()) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(5000 * 2 ** (attempt - 1), 120_000);
}

function rowsEqual(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function connectionCode(error) {
  const code = error?.cause?.code || error?.cause?.errno || error?.code;
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : null;
}

function expectedColCount(body) {
  const select = body?.queries?.[0]?.Query?.Commands?.[0]?.SemanticQueryDataShapeCommand?.Query?.Select;
  return Array.isArray(select) ? select.length : 0;
}

// Pull the most informative Power BI error out of a 200-but-empty querydata envelope. Power BI's
// querydata endpoint sometimes returns HTTP 200 with an error-shaped or incomplete body (a soft
// backend query timeout, model mid-refresh/eviction, or a throttle surfaced as 200 rather than
// 429/503) instead of a real result. Without this, all of those collapse into the opaque
// "empty DSR" transient, so the logs can never tell you which one actually happened.
function extractPbiError(j) {
  const candidates = [
    j?.error,
    j?.results?.[0]?.result?.error,
    j?.results?.[0]?.error,
    j?.results?.[0]?.result?.data?.dsr?.DataShapeError,
    ...(j?.results?.[0]?.result?.data?.dsr?.DataShapes || []).map((shape) => shape?.['odata.error']),
  ];
  for (const e of candidates) {
    if (!e) continue;
    if (typeof e === 'string') return e;
    const code = e.code || e.Code || e['pbi.error']?.code;
    const msg = e.message || e.Message
      || e['pbi.error']?.parameters?.Message?.value
      || e['pbi.error']?.details?.[0]?.detail?.value;
    const joined = [code, msg].filter(Boolean).join(': ');
    if (joined) return joined;
  }
  return null;
}

function parsePage(text, body) {
  const clean = text.replace(/^\uFEFF/, '');
  const j = JSON.parse(clean);
  const result = j?.results?.[0]?.result?.data;
  const dsr = result?.dsr;
  const serviceError = extractPbiError(j);
  if (serviceError) {
    const error = new Error(/CapacityLimitExceeded/i.test(serviceError)
      ? 'The Power BI capacity serving ACR is overloaded. Waiting before retrying the same data.'
      : `Power BI could not execute the ACR query: ${serviceError}`);
    error.code = /CapacityLimitExceeded/i.test(serviceError) ? 'ACR_CAPACITY_LIMIT' : 'ACR_QUERY_ERROR';
    error.serviceCode = /CapacityLimitExceeded/i.test(serviceError) ? 'CapacityLimitExceeded' : null;
    throw error;
  }
  if (!dsr?.DS?.length) {
    // A well-formed response envelope — the query compiled and returned a column
    // `descriptor` — with an empty/absent DS means the query executed and matched
    // zero rows. That is a legitimate empty slice (e.g. a fiscal year with no ACR
    // for these accounts), NOT a transient Power BI failure. The querydata
    // endpoint is synchronous (?synchronous=true), so a well-formed result
    // reflects the real, complete answer — there is no warmup/partial empty state
    // to retry past. Return a synthetic complete, empty dataset so the caller
    // yields zero rows instead of burning the full retry schedule and then
    // hard-failing. Only a missing envelope (no descriptor) is genuinely
    // malformed/transient and kept as a retryable error.
    if (result?.descriptor) return { PH: [], IC: true };
    // Missing descriptor: genuinely malformed/transient. Surface the real Power BI error (or a
    // short raw preview) alongside the transient marker so the cause is diagnosable next time,
    // rather than a bare "empty DSR". Classification is unchanged — still thrown, still retried.
    const detail = extractPbiError(j) || clean.slice(0, 200);
    throw new Error(`querydata: empty DSR${detail ? ` (${detail})` : ''}`);
  }
  const want = expectedColCount(body);
  const got = result?.descriptor?.Select?.length ?? 0;
  if (want > 0 && got !== want) throw new Error(`querydata: descriptor has ${got} columns, query defines ${want}`);
  return dsr.DS[0];
}

/**
 * Create an ACR query client bound to a Power BI token getter.
 *
 * @param {object} opts
 * @param {() => Promise<string>} opts.getPowerBiToken  Resolves a Power BI bearer token.
 * @param {() => object} [opts.getDb]  Returns a better-sqlite3 handle for the persistent
 *   row cache (acr_row_cache). Optional — when omitted (e.g. in unit tests) the
 *   service runs with the in-memory cache only.
 * @param {{info:Function,warn:Function}} [opts.logger]
 * @param {(evt:object)=>void} [opts.onProgress] Best-effort live-progress sink.
 *   Receives {phase,id,label,...} events (start/window/throttle/retry/done/error)
 *   so a slow pull can show accurate, ticking status instead of a dead spinner.
 */
function createAcrService({
  getPowerBiToken,
  logger = defaultLogger,
  getDb = null,
  fetchImpl = globalThis.fetch,
  getCacheIdentity = () => 'test-identity',
  clock = () => new Date(),
  onProgress = null,
  scheduler = sharedAcrScheduler,
  sleepImpl = sleep,
  validateTpids = null,
  beginAccountWork = null,
} = {}) {
  if (typeof getPowerBiToken !== 'function') {
    throw new Error('createAcrService: getPowerBiToken function is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createAcrService: fetch implementation is required.');
  }
  if (typeof clock !== 'function') {
    throw new Error('createAcrService: clock must be a function.');
  }

  // Best-effort live-progress emitter. Fires structured events (start / window /
  // throttle / retry / done / error) so the renderer can show an accurate,
  // ticking status for a slow pull instead of an indeterminate spinner. Wrapped
  // so a bad listener can never break — or slow — an actual data fetch.
  const emitProgress = typeof onProgress === 'function'
    ? (evt) => { try { onProgress(evt); } catch { /* progress is best-effort */ } }
    : () => {};
  let progressSeq = 0;

  function clockDate() {
    const value = clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function clockMs() {
    return clockDate().getTime();
  }

  // Resolve the SQLite handle for the persistent cache, tolerating any failure
  // (locked/unavailable DB) by disabling persistence rather than breaking fetches.
  function safeGetDb() {
    if (typeof getDb !== 'function') return null;
    try {
      return getDb() || null;
    } catch {
      return null;
    }
  }

  async function postPage(ctx, bearer, body) {
    const payload = JSON.stringify(body);
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Delay (ms) to wait before the *next* attempt; null means "succeeded or
      // threw". Set inside the gated section, consumed after releasing the slot.
      let throttleWait = null;

      const admission = await scheduler.acquire(waitMs => emitProgress({
        phase: 'throttle', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label,
        code: 'ACR_CAPACITY_LIMIT', retryInMs: waitMs, attempt, maxAttempts: MAX_ATTEMPTS,
      }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const started = Date.now();
      let requestId = null;
      let activityId = null;
      let retryAfter = null;
      try {
        const resp = await fetchImpl(QUERYDATA_URL, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'Content-Type': 'application/json;charset=UTF-8',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://msit.powerbi.com',
            Referer: 'https://msit.powerbi.com/',
            'X-Powerbi-Hostenv': 'Embed for Organization',
          },
          body: payload,
          signal: controller.signal,
        });
        requestId = resp.headers?.get('requestid') || resp.headers?.get('x-ms-request-id');
        activityId = resp.headers?.get('activityid') || resp.headers?.get('x-ms-activity-id');
        retryAfter = resp.headers?.get('Retry-After');

        if (resp.status === 429 || resp.status === 503) {
          // Consume the body to release the connection before other queries proceed.
          await resp.text();
          const error = new Error(`Power BI temporarily rejected the ACR query (HTTP ${resp.status}).`);
          error.code = resp.status === 429 ? 'ACR_CAPACITY_LIMIT' : 'ACR_SERVICE_UNAVAILABLE';
          error.statusCode = resp.status;
          throw error;
        } else if (resp.status === 401 || resp.status === 403) {
          const preview = (await resp.text()).slice(0, 300);
          const rlsDenied = /RLSNotAuthorizedForModel/i.test(preview);
          const err = new Error(rlsDenied
            ? `Your signed-in Microsoft account is not authorized for the MSX-I ACR Power BI model (model ${ACR_MODEL_ID}). Request access in Power BI, or sign out in User Home and sign in with an authorized account.`
            : 'The current Microsoft sign-in is not authorized for the ACR Power BI model. Sign out in User Home, sign in again, and retry.');
          err.code = rlsDenied ? 'ACR_RLS_UNAUTHORIZED' : 'ACR_UNAUTHORIZED';
          throw err;
        } else if (resp.status !== 200) {
          const preview = (await resp.text()).slice(0, 500);
          throw new Error(`HTTP ${resp.status}: ${preview}`);
        } else {
          const text = await resp.text();
          const parsed = parsePage(text, body);
          admission.succeeded();
          logger.info(`query ${ctx.queryKey} attempt ${attempt} succeeded in ${Date.now() - started}ms requestId=${requestId || 'unavailable'} activityId=${activityId || 'unavailable'}`);
          return parsed;
        }
      } catch (err) {
        lastErr = err;
        lastErr.requestId = requestId;
        lastErr.activityId = activityId;
        if (['ACR_UNAUTHORIZED', 'ACR_RLS_UNAUTHORIZED'].includes(err?.code)) throw err;
        if (err?.name === 'AbortError') {
          lastErr = Object.assign(new Error(`Power BI did not finish the ACR query within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, { cause: err }), { code: 'ACR_TIMEOUT' });
        } else if (connectionCode(err)) {
          const code = connectionCode(err);
          lastErr = Object.assign(new Error(`The Power BI connection failed (${code}). Check connectivity if it persists; this does not establish that VPN is disconnected.`, { cause: err }), {
            code: ['ENOTFOUND', 'ECONNREFUSED'].includes(code) ? 'ACR_OFFLINE' : 'ACR_CONNECTION_ERROR',
            networkCode: code,
          });
          if (lastErr.code === 'ACR_OFFLINE') throw lastErr;
        }
        if (['ACR_CAPACITY_LIMIT', 'ACR_SERVICE_UNAVAILABLE'].includes(lastErr.code)) {
          throttleWait = retryAfter == null ? Math.min(30000 * attempt, 120000) : parseRetryAfter(retryAfter, attempt);
          lastErr.retryAt = Date.now() + throttleWait;
          admission.throttle(throttleWait, lastErr);
          logger.warn(`query ${ctx.queryKey} ${lastErr.code}: shared cooldown ${throttleWait}ms (attempt ${attempt}/${MAX_ATTEMPTS}), requestId=${requestId || 'unavailable'}`);
          if (attempt < MAX_ATTEMPTS) emitProgress({ phase: 'throttle', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, code: lastErr.code, status: lastErr.statusCode, attempt, maxAttempts: MAX_ATTEMPTS, retryInMs: throttleWait });
          if (throttleWait > 120000) throw lastErr;
        }
      } finally {
        clearTimeout(timer);
        admission.release();
      }

      // Backoff happens *outside* the concurrency gate so a request that is
      // sleeping between attempts never occupies a live-connection slot.
      if (attempt < MAX_ATTEMPTS) {
        if (throttleWait == null) {
          const wait = backoffWithJitter(attempt);
          logger.warn(`query ${ctx.queryKey} transient error (${lastErr?.message}), retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
          emitProgress({ phase: 'retry', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, attempt, maxAttempts: MAX_ATTEMPTS, waitMs: wait, reason: lastErr?.message || 'transient error' });
          await sleepImpl(wait);
        }
      }
    }
    throw Object.assign(new Error(`ACR query did not recover after ${MAX_ATTEMPTS} attempts: ${lastErr?.message ?? 'unknown'}`, { cause: lastErr }), {
      code: lastErr?.code || 'ACR_QUERY_FAILED', retryAt: lastErr?.retryAt,
      requestId: lastErr?.requestId, activityId: lastErr?.activityId, networkCode: lastErr?.networkCode,
    });
  }

  async function executeAcrQuery(
    ctx,
    cols,
    tpids,
    fiscalYear,
    month,
    serviceFilter,
    expectedIdentity,
    adjustmentScope = 'actuals',
  ) {
    const bearer = await getPowerBiToken();
    const tokenIdentity = accessTokenIdentity(bearer);
    if (
      expectedIdentity
      && expectedIdentity !== 'signed-out'
      && tokenIdentity
      && tokenIdentity !== expectedIdentity
    ) {
      const error = new Error('Microsoft account changed while refreshing ACR data.');
      error.code = 'ACR_IDENTITY_CHANGED';
      throw error;
    }
    const all = [];
    let restart = null;
    let prevRT = null;

    for (let w = 0; w < MAX_WINDOWS; w++) {
      const body = buildRequestBody(buildAcrQuery(cols, tpids, fiscalYear, month, { serviceFilter, adjustmentScope }), cols.length, restart);
      const ds = await postPage(ctx, bearer, body);
      let pageRows = decodeDSRPage(ds, cols);

      // RestartTokens are inclusive: drop the boundary row re-emitted each window.
      if (restart != null && all.length > 0 && pageRows.length > 0 && rowsEqual(all[all.length - 1], pageRows[0])) {
        pageRows = pageRows.slice(1);
      }
      if (restart != null && pageRows.length === 0) {
        throw new Error(`querydata: continuation window ${w} added no new rows`);
      }
      // Append without a spread: a spread passes every row as a function
      // argument, which overflows the call stack on large pages (30k).
      for (const row of pageRows) all.push(row);
      if (all.length > MAX_ROWS) throw new Error(`querydata: result exceeds ${MAX_ROWS} rows`);

      if (ds.IC === true) return all;
      if (ds.RT == null) {
        if (ds.IC === false) throw new Error('querydata: result incomplete but no restart token');
        return all; // single, non-windowed page
      }
      const rt = JSON.stringify(ds.RT);
      if (prevRT !== null && prevRT === rt) throw new Error('querydata: restart token did not advance');
      prevRT = rt;
      restart = ds.RT;
      logger.info(`… windowing: ${all.length} rows so far`);
      emitProgress({ phase: 'window', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, rows: all.length });
    }
    throw new Error(`querydata: result not complete after ${MAX_WINDOWS} windows`);
  }

  // ─── Row fetch with short-lived spec-keyed cache ───────────────
  const rowCache = new Map();
  const backgroundRefreshes = new Map();
  const backgroundErrors = new Map();
  const legacyClaimAttempts = new Set();
  // The most recent live access denial (RLS/authorization) per identity. Live
  // queries against Power BI can start failing mid-session when a user's model
  // access is revoked; recording that lets cached-data views disclose honestly
  // that a live refresh is currently impossible, instead of promising an update
  // that will never arrive. Cleared as soon as any live query succeeds again.
  const identityAuthErrors = new Map();

  const AUTH_DENIED_CODES = ['ACR_RLS_UNAUTHORIZED', 'ACR_UNAUTHORIZED'];

  function recordAuthError(identity, error) {
    if (!identity || !AUTH_DENIED_CODES.includes(error?.code)) return;
    identityAuthErrors.set(identity, {
      message: error.message || String(error),
      code: error.code,
      at: clockDate().toISOString(),
    });
  }

  function recentAuthError(identity) {
    return identity ? (identityAuthErrors.get(identity) || null) : null;
  }

  function claimLegacyRows(identity) {
    if (!identity || legacyClaimAttempts.has(identity)) return;
    legacyClaimAttempts.add(identity);
    const result = claimLegacyRowCache(safeGetDb(), identity);
    if (result.claimed > 0) {
      logger.info(`claimed ${result.claimed} legacy ACR cache entr${result.claimed === 1 ? 'y' : 'ies'} for ${identity}`);
    } else if (result.error) {
      logger.warn(`legacy ACR cache ownership migration failed: ${result.error}`);
    }
  }

  let modelInvalidationDone = false;
  // One-time reset when the ACR Power BI model id changed since the last run
  // (e.g. the MSXI SL5 migration 6307665 → 6670867 retires the old model and its
  // cached values). Runs before any cache read so stale numbers never surface.
  function invalidateStaleModelCache() {
    if (modelInvalidationDone) return;
    modelInvalidationDone = true;
    const result = invalidateCacheOnModelChange(safeGetDb(), ACR_MODEL_ID);
    if (result.cleared) {
      rowCache.clear();
      logger.info(`ACR model changed (was ${result.previous || 'unset'}, now ${ACR_MODEL_ID}); cleared ${result.removed || 0} cached row set(s) so values re-pull from the new model`);
    } else if (result.error) {
      logger.warn(`ACR model-change cache check failed: ${result.error}`);
    }
  }

  function identityKeyPrefix(identity) {
    return `{"identity":${JSON.stringify(identity)},`;
  }

  function invalidateIdentityCache(identity) {
    if (!identity) return;
    const prefix = identityKeyPrefix(identity);
    for (const key of rowCache.keys()) {
      if (key.startsWith(prefix)) rowCache.delete(key);
    }
    for (const key of backgroundErrors.keys()) {
      if (key.startsWith(prefix)) backgroundErrors.delete(key);
    }
    deleteRowCacheByPrefix(safeGetDb(), prefix);
  }

  function cacheKey(cols, tpids, fy, month, serviceFilter, identity, adjustmentScope = 'actuals') {
    const fyKey = Array.isArray(fy) ? [...fy].map((y) => String(y)).sort() : String(fy ?? '');
    const sfKey = serviceFilter && serviceFilter.values && serviceFilter.values.length
      ? { level: serviceFilter.level, values: [...serviceFilter.values].sort() }
      : '';
    return JSON.stringify({
      identity,
      fy: fyKey,
      month: month ?? '',
      tpids: [...tpids].sort(),
      cols: cols.map((c) => c.name),
      sf: sfKey,
      ...(adjustmentScope === 'actuals' ? {} : { adjustmentScope }),
    });
  }

  function rememberRows(key, rows, pulledAt) {
    const pulledMs = parseSqliteUtc(pulledAt);
    const normalizedPulledAt = Number.isFinite(pulledMs)
      ? new Date(pulledMs).toISOString()
      : clockDate().toISOString();
    const entry = {
      rows,
      pulledAt: normalizedPulledAt,
      pulledMs: Number.isFinite(pulledMs) ? pulledMs : clockMs(),
    };
    rowCache.set(key, entry);
    if (rowCache.size > ROW_CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [candidateKey, value] of rowCache) {
        if (value.pulledMs < oldestAt) {
          oldestAt = value.pulledMs;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) rowCache.delete(oldestKey);
    }
    return entry;
  }

  async function fetchLiveRows(args) {
    const release = beginAccountWork?.('ACR refresh');
    try {
      validateTpids?.(args.tpids);
      return await fetchLiveAccountRows(args);
    } finally {
      release?.();
    }
  }

  async function fetchLiveAccountRows({
    cols,
    tpids,
    fiscalYear,
    month,
    serviceFilter,
    key,
    identity,
    forced = false,
    adjustmentScope = 'actuals',
  }) {
    const fyLabel = Array.isArray(fiscalYear) ? fiscalYear.join('+') : fiscalYear;
    logger.info(`fetching ACR rows [${cols.map((c) => c.name).join(', ')}] for ${tpids.length} account(s), ${month ?? fyLabel}${serviceFilter ? ` [${serviceFilter.values.length} L${serviceFilter.level} product(s)]` : ''}${forced ? ' (forced)' : ' (background)'}`);
    const ctx = { id: ++progressSeq, queryKey: queryId(key), label: `${adjustmentScope === 'anthropic' ? 'Anthropic · ' : ''}${tpids.length} account(s) · ${month ?? fyLabel}`, forced };
    emitProgress({ phase: 'start', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, forced });
    let rows;
    try {
      rows = await executeAcrQuery(
        ctx,
        cols,
        tpids,
        fiscalYear,
        month,
        serviceFilter,
        identity,
        adjustmentScope,
      );
      if (!rows.length) {
        const prior = readCachedEntry(key) || (month == null && cols.some(column => column.name === 'fiscalMonth')
          ? readCompatibleFiscalEntry({ cols, tpids, fiscalYears: fiscalYear, serviceFilter, identity, adjustmentScope }) : null);
        if (prior?.rows.length) {
          throw Object.assign(new Error('Power BI returned no rows for a previously populated selection. Retaining the prior data, not reporting zero consumption.'), {
            code: 'ACR_UNEXPECTED_EMPTY',
          });
        }
      }
    } catch (error) {
      logger.warn(`query ${ctx.queryKey} failed code=${error?.code || 'unknown'} network=${error?.networkCode || 'none'} requestId=${error?.requestId || 'unavailable'}: ${error.message || String(error)}`);
      // Identity-scoped rows remain safe to show to the same signed-in user when
      // a live refresh is denied. Only an actual account change invalidates them.
      if (error?.code === 'ACR_IDENTITY_CHANGED') {
        invalidateIdentityCache(identity);
      }
      // Remember an access denial so cached-data views can disclose that a live
      // refresh is currently impossible for this identity.
      recordAuthError(identity, error);
      backgroundErrors.set(key, {
        message: error.message || String(error), code: error.code || null,
        at: clockDate().toISOString(), retryAt: error.retryAt,
        requestId: error.requestId, activityId: error.activityId, networkCode: error.networkCode,
      });
      emitProgress({ phase: 'error', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, code: error?.code || null, message: error?.message || String(error) });
      throw error;
    }
    logger.info(`fetched ${rows.length} rows`);
    const pulledAt = clockDate().toISOString();
    // An empty live result is NOT cacheable. The ACR model can legitimately answer
    // "0 rows" while it is mid-refresh or while row-level security is not resolving
    // the signed-in user (both observed: every RLS-scoped table returns nothing while
    // the shared dimensions still have data). Persisting that emptiness made the app
    // replay "$0" from cache on every later visit — so one bad moment pinned a whole
    // fiscal-year selection at zero, and any selection cached earlier kept showing
    // real numbers. Skipping the write leaves any previously-good rows intact and
    // makes the next visit retry live, so the page heals itself the moment ACR does.
    if (rows.length > 0) {
      rememberRows(key, rows, pulledAt);
      const writeDb = safeGetDb();
      if (writeDb) writeRowCache(writeDb, key, rows);
    }
    backgroundErrors.delete(key);
    if (identity) identityAuthErrors.delete(identity);
    emitProgress({ phase: 'done', id: ctx.id, queryKey: ctx.queryKey, label: ctx.label, rows: rows.length });
    setCacheInternal(rows, { key, identity });
    return setCacheInfo(rows, {
      status: 'live',
      dataAsOf: pulledAt,
      ageMs: 0,
      refreshing: false,
      source: 'live',
      queryKeys: [ctx.queryKey],
    });
  }

  function scheduleBackgroundRefresh(args) {
    if (backgroundRefreshes.has(args.key)) return backgroundRefreshes.get(args.key);
    const task = Promise.resolve()
      .then(() => fetchLiveRows(args))
      .catch((error) => {
        logger.warn(`background ACR refresh failed for ${args.month ?? args.fiscalYear}: ${error.message || String(error)}`);
        return null;
      })
      .finally(() => {
        if (backgroundRefreshes.get(args.key) === task) {
          backgroundRefreshes.delete(args.key);
        }
      });
    backgroundRefreshes.set(args.key, task);
    return task;
  }

  function canBackgroundRefresh(key) {
    const error = backgroundErrors.get(key);
    if (!error) return true;
    if (['ACR_UNAUTHORIZED', 'ACR_RLS_UNAUTHORIZED', 'NO_ACCOUNT'].includes(error.code)) return false;
    return clockMs() >= Math.max(Date.parse(error.at) + 60000, error.retryAt || 0);
  }

  function scheduleServiceMixWarmup({
    accountKey,
    serviceDim,
    tpids,
    fiscalYears,
    serviceFilter,
    identity,
  }) {
    const chainKey = `service-mix:${accountKey}:L${serviceDim.name}`;
    if (backgroundRefreshes.has(chainKey)) return;
    const accountTask = backgroundRefreshes.get(accountKey)
      || Promise.resolve(rowCache.get(accountKey)?.rows || []);
    let chain;
    chain = accountTask
      .then((rows) => {
        if (!rows?.length) return null;
        const shaped = shapeRowsVisible(
          rows,
          [DIMENSIONS.account, DIMENSIONS.fiscalMonth],
          [MEASURES.acr],
        );
        const months = orderFiscalMonths([
          ...new Set(shaped.map((row) => String(row.fiscalMonth || '').trim()).filter(Boolean)),
        ]);
        const latestMonth = months[months.length - 1];
        if (!latestMonth) return null;
        const cols = [serviceDim, MEASURES.acr];
        const key = cacheKey(
          cols,
          tpids,
          fiscalYears,
          latestMonth,
          serviceFilter,
          identity,
        );
        return scheduleBackgroundRefresh({
          cols,
          tpids,
          fiscalYear: fiscalYears,
          month: latestMonth,
          serviceFilter,
          key,
          identity,
          forced: false,
        });
      })
      .catch((error) => {
        logger.warn(`background service-mix warmup failed: ${error.message || String(error)}`);
        return null;
      })
      .finally(() => {
        if (backgroundRefreshes.get(chainKey) === chain) {
          backgroundRefreshes.delete(chainKey);
        }
      });
    backgroundRefreshes.set(chainKey, chain);
  }

  function readCachedEntry(key) {
    // Empty sets are never a usable stand-in — see fetchLiveRows.
    const memory = rowCache.get(key);
    if (memory && memory.rows.length > 0) return { ...memory, source: 'memory' };
    const database = safeGetDb();
    if (!database) return null;
    const cached = readRowCache(database, key, null);
    if (!cached || cached.rows.length === 0) return null;
    return { ...rememberRows(key, cached.rows, cached.pulledAt), source: 'sqlite' };
  }

  // Reuse a complete same-identity/account superset before contacting Power BI.
  // Only additive ACR projections with provable product and fiscal coverage qualify.
  function readCompatibleFiscalEntry({ cols, tpids, fiscalYears, serviceFilter, identity, adjustmentScope = 'actuals' }) {
    const database = safeGetDb();
    const requested = JSON.parse(cacheKey(cols, tpids, fiscalYears, undefined, serviceFilter, identity, adjustmentScope));

    const prefix = identityKeyPrefix(identity);
    const seen = new Set();
    const candidates = [];
    for (const key of rowCache.keys()) {
      if (key.startsWith(prefix)) { seen.add(key); candidates.push({ key, pulledAt: rowCache.get(key)?.pulledAt }); }
    }
    for (const meta of listRowCacheKeysByPrefix(database, prefix)) {
      if (!seen.has(meta.key)) candidates.push(meta);
    }

    let best = null;
    for (const { key } of candidates) {
      let parsed;
      try { parsed = JSON.parse(key); } catch { continue; }
      if (!parsed || !Array.isArray(parsed.cols)) continue;
      if (projectCachedAcr([], parsed, requested) === null) continue;

      const entry = readCachedEntry(key);
      if (!entry || !Array.isArray(entry.rows)) continue;
      const rows = projectCachedAcr(entry.rows, parsed, requested);
      if (!rows) continue;
      if (!best || entry.pulledMs > best.pulledMs) {
        best = { rows, pulledAt: entry.pulledAt, pulledMs: entry.pulledMs, source: `${entry.source}-derived`, sourceKey: key };
      }
    }
    return best;
  }

  async function refreshRowsNow(args) {
    const existing = backgroundRefreshes.get(args.key);
    if (existing) {
      const refreshed = await existing;
      if (refreshed) return refreshed;
      const replacement = backgroundRefreshes.get(args.key);
      if (replacement && replacement !== existing) return replacement;
    }
    let forcedTask;
    forcedTask = fetchLiveRows({ ...args, forced: true })
      .finally(() => {
        if (backgroundRefreshes.get(args.key) === forcedTask) {
          backgroundRefreshes.delete(args.key);
        }
      });
    backgroundRefreshes.set(args.key, forcedTask);
    return forcedTask;
  }

  function monthFinalizationMs(fiscalMonth) {
    const { year, monthIdx } = fiscalMonthToCalendar(fiscalMonth);
    return Date.UTC(year, monthIdx + 1, 1) + CLOSED_MONTH_FINALIZATION_DELAY_MS;
  }

  function overlayMonthsSinceBase(fiscalYears, basePulledAt) {
    const pulledMs = parseSqliteUtc(basePulledAt);
    if (!Number.isFinite(pulledMs)) return [];
    const selected = new Set(
      (Array.isArray(fiscalYears) ? fiscalYears : [fiscalYears]).map(String),
    );
    const startLabel = currentFiscalMonth(new Date(pulledMs)).fiscalMonth;
    const endLabel = previousFiscalMonth(clockDate()).fiscalMonth;
    const startParts = fiscalMonthToCalendar(startLabel);
    const endParts = fiscalMonthToCalendar(endLabel);
    const cursor = new Date(startParts.year, startParts.monthIdx, 1);
    const end = new Date(endParts.year, endParts.monthIdx, 1);
    const months = [];
    while (cursor <= end) {
      const fiscalMonth = fyMonthOf(cursor);
      if (selected.has(fiscalMonth.slice(0, 4))) months.push(fiscalMonth);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  }

  function isFinalizedMonthEntry(fiscalMonth, entry) {
    if (!entry) return false;
    const cutoff = monthFinalizationMs(fiscalMonth);
    return clockMs() >= cutoff && entry.pulledMs >= cutoff;
  }

  function mergeSeriesRows(baseRows, entries) {
    const replacedMonths = new Set(
      [...entries.entries()]
        .filter(([, entry]) => entry)
        .map(([fiscalMonth]) => fiscalMonth),
    );
    const rows = baseRows.filter((row) => (
      !replacedMonths.has(String(row.fiscalMonth || '').trim())
    ));
    for (const entry of entries.values()) {
      if (!entry) continue;
      for (const row of entry.rows) rows.push(row);
    }
    return rows;
  }

  async function fetchFiscalSeriesRows(
    cols,
    tpids,
    fiscalYears,
    serviceFilter,
    identity,
    force,
    adjustmentScope = 'actuals',
  ) {
    const baseKey = cacheKey(cols, tpids, fiscalYears, undefined, serviceFilter, identity, adjustmentScope);
    const baseArgs = {
      cols,
      tpids,
      fiscalYear: fiscalYears,
      month: undefined,
      serviceFilter,
      key: baseKey,
      identity,
      forced: Boolean(force),
      adjustmentScope,
    };
    let baseEntry = readCachedEntry(baseKey) || readCompatibleFiscalEntry({ cols, tpids, fiscalYears, serviceFilter, identity, adjustmentScope });
    let baseWasLive = false;
    if (!baseEntry) {
      // A cold cache has nothing useful to render, so first load waits for live
      // Power BI data. Background refresh is reserved for stale/partial data.
      try {
        const rows = await refreshRowsNow(baseArgs);
        const info = cacheInfo(rows);
        baseEntry = {
          rows,
          pulledAt: info.dataAsOf,
          pulledMs: parseSqliteUtc(info.dataAsOf),
          source: 'live',
        };
        baseWasLive = true;
      } catch (liveError) {
        // Live Power BI is unavailable for this exact query (most often the
        // signed-in user has lost RLS access on the model). Rather than blanking
        // a page we can otherwise populate, fall back to a related cached series
        // (same accounts/projection, a wider fiscal-year span) filtered to the
        // requested years, and disclose the live error alongside it. If there is
        // no compatible cache at all, surface the real error — a first-time,
        // never-pulled view has genuinely nothing to show. The exact key is left
        // cold so the next visit retries live and self-heals once access returns.
        const related = readCompatibleFiscalEntry({ cols, tpids, fiscalYears, serviceFilter, identity, adjustmentScope });
        if (!related) throw liveError;
        logger.warn(`live ACR refresh failed (${liveError.code || liveError.message || liveError}); serving related cached series as of ${related.pulledAt}`);
        setCacheInternal(related.rows, { key: baseKey, identity });
        return setCacheInfo(related.rows, {
          status: 'stale',
          dataAsOf: related.pulledAt,
          ageMs: related.pulledMs ? Math.max(0, clockMs() - related.pulledMs) : null,
          refreshing: false,
          source: related.source,
          error: {
            message: liveError.message || String(liveError),
            code: liveError.code || null,
            at: clockDate().toISOString(),
          },
          incompleteMonths: [],
          queryKeys: [queryId(baseKey), ...(related.sourceKey ? [queryId(related.sourceKey)] : [])],
        });
      }
    }

    const overlayMonths = overlayMonthsSinceBase(fiscalYears, baseEntry.pulledAt);
    if (force && !baseWasLive && !overlayMonths.length) {
      try {
        const fresh = await refreshRowsNow(baseArgs);
        return fresh;
      } catch (error) {
        return setCacheInfo([...baseEntry.rows], {
          status: 'stale', dataAsOf: baseEntry.pulledAt,
          ageMs: Math.max(0, clockMs() - baseEntry.pulledMs), source: baseEntry.source,
          refreshing: false, incompleteMonths: [],
          queryKeys: [queryId(baseKey), ...(baseEntry.sourceKey ? [queryId(baseEntry.sourceKey)] : [])],
          error: { message: error.message, code: error.code, retryAt: error.retryAt, requestId: error.requestId, activityId: error.activityId, networkCode: error.networkCode },
        });
      }
    }
    const entries = new Map();
    const monthArgs = new Map();
    for (const fiscalMonth of overlayMonths) {
      const fiscalYear = fiscalMonth.slice(0, 4);
      const key = cacheKey(cols, tpids, fiscalYear, fiscalMonth, serviceFilter, identity, adjustmentScope);
      entries.set(fiscalMonth, readCachedEntry(key));
      monthArgs.set(fiscalMonth, {
        cols,
        tpids,
        fiscalYear,
        month: fiscalMonth,
        serviceFilter,
        key,
        identity,
        forced: Boolean(force),
        adjustmentScope,
      });
    }

    if (force) {
      await Promise.all(overlayMonths.map(async (fiscalMonth) => {
        const entry = entries.get(fiscalMonth);
        if (isFinalizedMonthEntry(fiscalMonth, entry)) return;
        const args = monthArgs.get(fiscalMonth);
        let rows;
        try { rows = await refreshRowsNow(args); }
        catch { return; } // fetchLiveRows retained the exact error alongside the prior data.
        const info = cacheInfo(rows);
        entries.set(fiscalMonth, {
          rows,
          pulledAt: info.dataAsOf,
          pulledMs: parseSqliteUtc(info.dataAsOf),
          source: 'live',
        });
      }));
    }

    const incompleteMonths = [];
    let refreshing = false;
    let missingOverlay = false;
    const errors = [];
    const scheduled = [];
    for (const fiscalMonth of overlayMonths) {
      const args = monthArgs.get(fiscalMonth);
      const entry = entries.get(fiscalMonth);
      if (isFinalizedMonthEntry(fiscalMonth, entry)) continue;
      incompleteMonths.push(fiscalMonth);
      if (!entry) missingOverlay = true;
      const ageMs = entry ? Math.max(0, clockMs() - entry.pulledMs) : Infinity;
      if (!force && (!entry || ageMs >= BACKGROUND_REFRESH_AFTER_MS) && canBackgroundRefresh(args.key)) {
        const task = scheduleBackgroundRefresh(args);
        scheduled.push({ fiscalMonth, task });
        refreshing = true;
      }
      const error = backgroundErrors.get(args.key);
      if (error) errors.push(error);
    }

    if (scheduled.length > 0 && !backgroundRefreshes.has(baseKey)) {
      let seriesTask;
      seriesTask = Promise.all(scheduled.map(async ({ fiscalMonth, task }) => {
        const refreshedRows = await task;
        if (!refreshedRows) return;
        const info = cacheInfo(refreshedRows);
        entries.set(fiscalMonth, {
          rows: refreshedRows,
          pulledAt: info.dataAsOf,
          pulledMs: parseSqliteUtc(info.dataAsOf),
          source: 'live',
        });
      }))
        .then(() => mergeSeriesRows(baseEntry.rows, entries))
        .finally(() => {
          if (backgroundRefreshes.get(baseKey) === seriesTask) {
            backgroundRefreshes.delete(baseKey);
          }
        });
      backgroundRefreshes.set(baseKey, seriesTask);
    }
    const rows = mergeSeriesRows(baseEntry.rows, entries);
    const timestamps = [
      baseEntry.pulledAt,
      ...[...entries.values()].map((entry) => entry?.pulledAt),
    ].filter(Boolean);
    const latestPulledAt = timestamps.sort((left, right) => (
      parseSqliteUtc(right) - parseSqliteUtc(left)
    ))[0] || null;
    const sources = [
      baseEntry.source,
      ...[...entries.values()].map((entry) => entry?.source),
    ].filter(Boolean);
    setCacheInternal(rows, { key: baseKey, identity });
    return setCacheInfo(rows, {
      status: incompleteMonths.length
        ? (missingOverlay ? 'partial' : 'stale')
        : (force || baseWasLive)
          ? 'live'
          : 'fresh',
      dataAsOf: latestPulledAt,
      ageMs: latestPulledAt ? Math.max(0, clockMs() - parseSqliteUtc(latestPulledAt)) : null,
      refreshing,
      source: [...new Set(sources)].join('+') || 'none',
      error: errors[0] || backgroundErrors.get(baseKey) || null,
      incompleteMonths,
      refreshKeys: scheduled.map(({ fiscalMonth }) => queryId(monthArgs.get(fiscalMonth).key)),
      queryKeys: [queryId(baseKey), ...(baseEntry.sourceKey ? [queryId(baseEntry.sourceKey)] : [])],
    });
  }

  async function fetchRows(cols, tpids, fiscalYear, month, opts = {}) {
    validateTpids?.(tpids);
    if (!tpids || tpids.length === 0) {
      throw new Error('No account TPIDs supplied. Sync customers first, then open a customer with a TPID.');
    }
    const serviceFilter = opts.serviceFilter || null;
    const adjustmentScope = opts.adjustmentScope ?? 'actuals';
    const identity = normalizeIdentity(getCacheIdentity());
    if (!identity) {
      if (opts.force) {
        const error = new Error('Sign in with Microsoft to refresh Azure consumption.');
        error.code = 'NO_ACCOUNT';
        throw error;
      }
      const rows = [];
      return setCacheInfo(rows, {
        status: 'missing',
        dataAsOf: null,
        ageMs: null,
        refreshing: false,
        source: 'none',
        error: {
          message: 'Sign in with Microsoft to load Azure consumption.',
          code: 'NO_ACCOUNT',
        },
      });
    }
    invalidateStaleModelCache();
    claimLegacyRows(identity);
    const isFiscalSeries = month == null
      && cols.some((column) => column?.name === DIMENSIONS.fiscalMonth.name);
    if (isFiscalSeries) {
      return fetchFiscalSeriesRows(
        cols,
        tpids,
        fiscalYear,
        serviceFilter,
        identity,
        Boolean(opts.force),
        adjustmentScope,
      );
    }
    const key = cacheKey(
      cols,
      tpids,
      fiscalYear,
      month,
      serviceFilter,
      identity,
      adjustmentScope,
    );
    const refreshArgs = {
      cols,
      tpids,
      fiscalYear,
      month,
      serviceFilter,
      key,
      identity,
      forced: Boolean(opts.force),
      adjustmentScope,
    };

    if (opts.force) {
      return refreshRowsNow(refreshArgs);
    }

    const hit = rowCache.get(key);
    // A cached EMPTY set is treated as a miss: it is never authoritative (see
    // fetchLiveRows) and entries written by earlier builds would otherwise keep
    // replaying "$0" for this selection. Re-querying live lets it self-heal.
    if (hit && hit.rows.length > 0) {
      const ageMs = Math.max(0, clockMs() - hit.pulledMs);
      const stale = ageMs >= BACKGROUND_REFRESH_AFTER_MS;
      const refreshing = stale && canBackgroundRefresh(key);
      if (refreshing) scheduleBackgroundRefresh(refreshArgs);
      logger.info(`using ${stale ? 'stale ' : ''}cached rows (${hit.rows.length}) for ${month ?? fiscalYear}`);
      setCacheInternal(hit.rows, { key, identity });
      return setCacheInfo(hit.rows, {
        status: stale ? 'stale' : 'fresh',
        dataAsOf: hit.pulledAt,
        ageMs,
        refreshing,
        source: 'memory',
        error: backgroundErrors.get(key) || null,
        refreshKeys: refreshing ? [queryId(key)] : [],
        queryKeys: [queryId(key)],
      });
    }

    // Persistent rows are never discarded because of age. A stale row still
    // renders immediately and schedules one coalesced refresh for the next visit.
    const db = safeGetDb();
    if (db) {
      const cached = readRowCache(db, key, null);
      if (cached && cached.rows.length > 0) {
        const remembered = rememberRows(key, cached.rows, cached.pulledAt);
        const ageMs = Math.max(0, clockMs() - remembered.pulledMs);
        const stale = ageMs >= BACKGROUND_REFRESH_AFTER_MS;
        const refreshing = stale && canBackgroundRefresh(key);
        if (refreshing) scheduleBackgroundRefresh(refreshArgs);
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        logger.info(`using ${stale ? 'stale ' : ''}local rows (${cached.rows.length}) for ${month ?? fiscalYear}, pulled ${remembered.pulledAt} (${ageHours}h ago)`);
        setCacheInternal(cached.rows, { key, identity });
        return setCacheInfo(cached.rows, {
          status: stale ? 'stale' : 'fresh',
          dataAsOf: remembered.pulledAt,
          ageMs,
          refreshing,
          source: 'sqlite',
          error: backgroundErrors.get(key) || null,
          refreshKeys: refreshing ? [queryId(key)] : [],
          queryKeys: [queryId(key)],
        });
      }
    }

    // No local rows exist for this query shape, so keep the caller in its loading
    // state until live data (including a valid empty result) is available.
    return refreshRowsNow(refreshArgs);
  }

  // The current, in-progress fiscal month has only partial ACR actuals (the model
  // is billed monthly), so every whole-FY monthly series would nosedive on its
  // final point. Shape the rows as usual, then — for any time series that carries
  // a fiscalMonth dimension — drop that in-progress month so charts, hierarchy
  // tables, and totals reflect complete months only. Non-time-series shapes (no
  // fiscalMonth dimension, e.g. a single-month service mix or the product catalog
  // ranking) pass through unchanged. Computed against the wall clock on every call
  // so the hidden month advances automatically as the fiscal calendar rolls over.
  function shapeRowsVisible(rows, dims, measures) {
    const shaped = shapeRows(rows, dims, measures);
    const hasMonth = dims.some((d) => d && d.name === DIMENSIONS.fiscalMonth.name);
    if (!hasMonth) return shaped;
    const hiddenMonths = new Set([
      currentFiscalMonth(clockDate()).fiscalMonth,
      ...(cacheInfo(rows).incompleteMonths || []),
    ]);
    return shaped.filter((r) => !hiddenMonths.has(String(r.fiscalMonth || '').trim()));
  }

  // ─── Generic query surface ─────────────────────────────────────
  const DEFAULT_MEASURES = ['acr'];

  // Normalize a fiscal-year selection (opts.fiscalYears array, opts.fiscalYear
  // string, or a comma-separated string) into a de-duplicated, in-window list of
  // "FYnn" anchors. Falls back to the latest complete month's FY when none valid.
  function resolveFiscalYears(opts = {}) {
    const raw = opts.fiscalYears != null ? opts.fiscalYears : opts.fiscalYear;
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const fy = String(item || '').trim().toUpperCase();
      if (!/^FY\d{2}$/.test(fy) || seen.has(fy)) continue;
      seen.add(fy);
      out.push(fy);
    }
    if (out.length === 0) out.push(resolvePeriod('latest').fiscalYear);
    return out;
  }

  // Build a validated serviceFilter (a product scope) from user input, or null.
  function resolveServiceFilter(opts = {}) {
    const values = Array.isArray(opts.services)
      ? [...new Set(opts.services.map((s) => String(s || '').trim()).filter(Boolean))]
      : [];
    if (values.length === 0) return null;
    const level = [1, 2, 3, 4, 5].includes(Number(opts.serviceFilterLevel)) ? Number(opts.serviceFilterLevel) : 2;
    return { level, values };
  }

  /**
   * Generic ACR aggregation against the live Power BI semantic model. Projects
   * the requested dimensions + measures at the chosen period (a single fiscal
   * month, or a whole fiscal year as a time series) for the supplied TPIDs.
   *
   * @param {object} params
   * @param {string[]} params.tpids       Top-parent account IDs to filter on.
   * @param {string[]} params.groupBy     ≥1 dimension key.
   * @param {string[]} [params.measures]  Measure keys (default ["acr"]).
   * @param {string}   [params.period]    "latest" | "FY26-Mar" | "FY26" | "2026-03".
   * @param {string[]} [params.fiscalYears] One or more "FYnn" anchors projected
   *                                       together as a whole-year monthly series.
   *                                       Takes precedence over `period` when set.
   * @param {string}   [params.sortBy]    Measure to sort by (default first measure).
   * @param {"asc"|"desc"} [params.sortDir]
   * @param {number}   [params.topN]
   * @param {boolean}  [params.force]     Bypass the row cache.
   */
  async function queryAcr(params = {}) {
    const tpids = [...new Set((params.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];
    const groupBy = params.groupBy ?? [];
    if (groupBy.length === 0) throw new Error('queryAcr: groupBy must list at least one dimension.');
    const badDim = groupBy.find((k) => !isDimensionKey(k));
    if (badDim) throw new Error(`queryAcr: unknown dimension "${badDim}". Valid: ${Object.keys(DIMENSIONS).join(', ')}.`);

    const measures = params.measures && params.measures.length > 0 ? params.measures : DEFAULT_MEASURES;
    const badMeasure = measures.find((k) => !isMeasureKey(k));
    if (badMeasure) throw new Error(`queryAcr: unknown measure "${badMeasure}". Valid: ${Object.keys(MEASURES).join(', ')}.`);

    // A `fiscalYears` selection projects one or more whole fiscal years as a
    // monthly time series (mirrors the other multi-FY charts); otherwise fall
    // back to a single resolved period (a month or a single whole year).
    const hasFyList = params.fiscalYears != null
      && (Array.isArray(params.fiscalYears) ? params.fiscalYears.length > 0 : String(params.fiscalYears).trim() !== '');
    let fiscalYear;
    let fiscalMonth;
    let label;
    if (hasFyList) {
      const fys = resolveFiscalYears({ fiscalYears: params.fiscalYears });
      fiscalYear = fys;
      fiscalMonth = null;
      label = fys.join(' + ');
    } else {
      ({ fiscalYear, fiscalMonth, label } = resolvePeriod(params.period));
    }

    const dimCols = groupBy.map((k) => DIMENSIONS[k]);
    const measureCols = measures.map((k) => MEASURES[k]);
    const rows = await fetchRows([...dimCols, ...measureCols], tpids, fiscalYear, fiscalMonth, { force: params.force });

    let shaped = shapeRowsVisible(rows, dimCols, measureCols);

    const sortBy = params.sortBy && isMeasureKey(params.sortBy) ? params.sortBy : measures[0];
    const dir = params.sortDir === 'asc' ? 1 : -1;
    shaped.sort((a, b) => (Number(a[sortBy] ?? 0) - Number(b[sortBy] ?? 0)) * dir);

    const topN = params.topN && params.topN > 0 ? params.topN : 500;
    const limited = shaped.slice(0, topN);

    return {
      fiscalYear,
      fiscalMonth: label,
      groupBy,
      measures,
      rowCount: limited.length,
      rows: limited,
      cache: cacheInfo(rows),
    };
  }

  /**
   * Per-customer, per-month, per-service-level dollar ACR — the primary shape
   * SE Assist renders. Projects account × ServiceLevelN × fiscalMonth with the
   * `$ ACR` measure across a whole fiscal year (a monthly time series), then
   * nests it as: services[] → { service, total, monthly: { [fiscalMonth]: $ } }.
   *
   * @param {object} opts
   * @param {string[]} opts.tpids   Top-parent account IDs.
   * @param {1|2|3|4|5} [opts.level]  Service level to break down by (default 2).
   * @param {string} [opts.fiscalYear]  e.g. "FY26"; defaults to the latest month's FY.
   * @param {boolean} [opts.force]
   */
  async function getAccountMonthlyServiceAcr(opts = {}) {
    const level = [1, 2, 3, 4, 5].includes(Number(opts.level)) ? Number(opts.level) : 2;
    const serviceDim = DIMENSIONS[`serviceLevel${level}`];

    // Anchor on whole fiscal year(s) so we get every month as a series. Accept an
    // explicit fiscalYear(s), else derive from the resolved "latest" period.
    const fiscalYears = resolveFiscalYears(opts);
    const serviceFilter = resolveServiceFilter(opts);

    const tpids = [...new Set((opts.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];
    const cols = [serviceDim, DIMENSIONS.fiscalMonth, MEASURES.acr];
    const rows = await fetchRows(cols, tpids, fiscalYears, undefined, { force: opts.force, serviceFilter });
    const shaped = shapeRowsVisible(rows, [serviceDim, DIMENSIONS.fiscalMonth], [MEASURES.acr]);

    // Nest: service → { monthly: {fiscalMonth: $}, total }.
    const byService = new Map();
    const monthSet = new Set();
    for (const r of shaped) {
      const service = String(r[serviceDim.name] || '').trim() || '(Unassigned)';
      const month = String(r.fiscalMonth || '').trim();
      const amount = Number(r.acr || 0);
      if (!month) continue;
      monthSet.add(month);
      if (!byService.has(service)) byService.set(service, { service, monthly: {}, total: 0 });
      const entry = byService.get(service);
      entry.monthly[month] = (entry.monthly[month] || 0) + amount;
      entry.total += amount;
    }

    const months = orderFiscalMonths([...monthSet]);
    const services = [...byService.values()]
      .map((s) => ({ ...s, total: Math.round(s.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    const grandTotal = Math.round(services.reduce((sum, s) => sum + s.total, 0) * 100) / 100;

    return {
      fiscalYear: fiscalYears.join(' + '),
      fiscalYears,
      level,
      months,
      services,
      grandTotal,
      services_filter: serviceFilter ? serviceFilter.values : null,
      cache: cacheInfo(rows),
    };
  }

  /**
   * Full Service-Level hierarchy (L1 › … › Ln) for the supplied accounts as a
   * nested tree with a monthly series + subtotal at every level — the data
   * behind the expandable "Service hierarchy" matrix. Honors the optional
   * product scope (serviceFilter) like the flat breakdown.
   *
   * @param {object} opts
   * @param {string[]} opts.tpids
   * @param {1|2|3|4|5} [opts.level]   Depth of the hierarchy (default 2).
   * @param {string|string[]} [opts.fiscalYear] / [opts.fiscalYears]
   * @param {string[]} [opts.services] + [opts.serviceFilterLevel]  Product scope.
   * @param {boolean} [opts.force]
   */
  async function getAccountServiceHierarchy(opts = {}) {
    const level = [1, 2, 3, 4, 5].includes(Number(opts.level)) ? Number(opts.level) : 2;
    const fiscalYears = resolveFiscalYears(opts);
    const serviceFilter = resolveServiceFilter(opts);
    const tpids = [...new Set((opts.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];

    const levelDims = [];
    for (let i = 1; i <= level; i += 1) levelDims.push(DIMENSIONS[`serviceLevel${i}`]);
    const cols = [...levelDims, DIMENSIONS.fiscalMonth, MEASURES.acr];
    const rows = await fetchRows(cols, tpids, fiscalYears, undefined, { force: opts.force, serviceFilter });
    const shaped = shapeRowsVisible(rows, [...levelDims, DIMENSIONS.fiscalMonth], [MEASURES.acr]);

    const { tree, months, grandTotal } = nestServiceHierarchy(shaped, levelDims.map((d) => d.name));

    return {
      fiscalYear: fiscalYears.join(' + '),
      fiscalYears,
      level,
      months,
      tree,
      grandTotal,
      services_filter: serviceFilter ? serviceFilter.values : null,
      cache: cacheInfo(rows),
    };
  }

  /**
   * Distinct Service-Level values (default L2 "products") across the supplied
   * accounts, ranked by total ACR — powers the persistent product-filter picker
   * so it always lists the full global product catalog, not just one account's.
   *
   * When `parentLevel` is supplied (and shallower than `level`), the members are
   * also nested under their parent level as `groups[] → { parent, total,
   * children: [{ name, total }] }` — the data behind the tiered product picker
   * (e.g. every Service Level 1 with its Service Level 2 items grouped beneath).
   * The flat `values` list is always returned for backward compatibility.
   *
   * @param {object} opts
   * @param {string[]} opts.tpids
   * @param {1|2|3|4|5} [opts.level]  (default 2)
   * @param {1|2|3|4} [opts.parentLevel]  Group members under this shallower level.
   * @param {string|string[]} [opts.fiscalYear] / [opts.fiscalYears]
   * @param {boolean} [opts.force]
   */
  async function getServiceValues(opts = {}) {
    const level = [1, 2, 3, 4, 5].includes(Number(opts.level)) ? Number(opts.level) : 2;
    const parentLevel = [1, 2, 3, 4].includes(Number(opts.parentLevel)) && Number(opts.parentLevel) < level
      ? Number(opts.parentLevel)
      : null;
    const fiscalYears = resolveFiscalYears(opts);
    const tpids = [...new Set((opts.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];
    const dim = DIMENSIONS[`serviceLevel${level}`];
    const round2 = (n) => Math.round(n * 100) / 100;

    // Tiered path: project parent × member so the picker can group members under
    // their parent (e.g. Service Level 1 › Service Level 2).
    if (parentLevel) {
      const parentDim = DIMENSIONS[`serviceLevel${parentLevel}`];
      const cols = [parentDim, dim, MEASURES.acr];
      const rows = await fetchRows(cols, tpids, fiscalYears, undefined, { force: opts.force });
      const shaped = shapeRows(rows, [parentDim, dim], [MEASURES.acr]);

      const byParent = new Map(); // parent → Map(member → total)
      const byName = new Map();   // member → total (flat, de-duped across parents)
      for (const r of shaped) {
        const member = String(r[dim.name] || '').trim();
        if (!member) continue;
        const parent = String(r[parentDim.name] || '').trim() || '(Uncategorized)';
        const amount = Number(r.acr || 0);
        byName.set(member, (byName.get(member) || 0) + amount);
        if (!byParent.has(parent)) byParent.set(parent, new Map());
        const kids = byParent.get(parent);
        kids.set(member, (kids.get(member) || 0) + amount);
      }

      const groups = [...byParent.entries()]
        .map(([parent, kids]) => {
          const children = [...kids.entries()]
            .map(([name, total]) => ({ name, total: round2(total) }))
            .sort((a, b) => b.total - a.total);
          const total = round2(children.reduce((s, c) => s + c.total, 0));
          return { parent, total, children };
        })
        .sort((a, b) => b.total - a.total);

      const values = [...byName.entries()]
        .map(([name, total]) => ({ name, total: round2(total) }))
        .sort((a, b) => b.total - a.total);

      return {
        level,
        parentLevel,
        fiscalYears,
        values,
        groups,
        cache: cacheInfo(rows),
      };
    }

    const cols = [dim, MEASURES.acr];
    const rows = await fetchRows(cols, tpids, fiscalYears, undefined, { force: opts.force });
    const shaped = shapeRows(rows, [dim], [MEASURES.acr]);

    const byName = new Map();
    for (const r of shaped) {
      const name = String(r[dim.name] || '').trim();
      if (!name) continue;
      byName.set(name, (byName.get(name) || 0) + Number(r.acr || 0));
    }
    const values = [...byName.entries()]
      .map(([name, total]) => ({ name, total: round2(total) }))
      .sort((a, b) => b.total - a.total);

    return { level, fiscalYears, values, cache: cacheInfo(rows) };
  }

  // Service Level 2 categories that represent Azure OpenAI / AI Foundry model
  // consumption. Used to scope the per-model multi-line chart. "Foundry Models"
  // is the current MSXI L2 that parents the individual models (projected at L5);
  // the Azure OpenAI variants are kept for older/standalone taxonomies. Callers
  // can override via opts.categories.
  const AI_MODEL_L2_CATEGORIES = [
    'Foundry Models',
    'Azure OpenAI',
    'Azure OpenAI Service',
    'Azure AI Foundry',
    'AI Foundry',
  ];

  /**
   * Per-model monthly ACR for Azure OpenAI + AI Foundry — the data behind the
   * per-account "Foundry Models" multi-line chart. Scopes the fact rows to the
   * AOAI / Foundry Service-Level-2 categories, then projects a chosen service
   * level (the granularity — e.g. L4 model-family or L5 individual model) ×
   * fiscalMonth, and nests it as models[] → { model, total, monthly: {…} }.
   * Models with no usage (rounded total of 0) are dropped so the legend stays
   * readable.
   *
   * @param {object} opts
   * @param {string[]} opts.tpids
   * @param {string|string[]} [opts.fiscalYear]  or opts.fiscalYears
   * @param {2|3|4|5} [opts.modelLevel]          Service level / granularity (default 4).
   * @param {string[]} [opts.categories]         Override the AOAI/Foundry L2 list.
   * @param {boolean} [opts.force]
   */
  async function getModelMonthlyAcr(opts = {}) {
    const tpids = [...new Set((opts.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];
    const fiscalYears = resolveFiscalYears(opts);
    const modelLevel = [2, 3, 4, 5].includes(Number(opts.modelLevel)) ? Number(opts.modelLevel) : 4;
    const categories = Array.isArray(opts.categories) && opts.categories.length
      ? [...new Set(opts.categories.map((c) => String(c || '').trim()).filter(Boolean))]
      : AI_MODEL_L2_CATEGORIES;
    const modelDim = DIMENSIONS[`serviceLevel${modelLevel}`];
    const serviceFilter = { level: 2, values: categories };

    const cols = [modelDim, DIMENSIONS.fiscalMonth, MEASURES.acr];
    const identity = normalizeIdentity(getCacheIdentity());
    let rows;
    // Keep usable legacy chart caches. New cold chart requests share one
    // product/detail/month cube, then filter and sum exactly the requested L2s.
    if (identity) { invalidateStaleModelCache(); claimLegacyRows(identity); }
    const detailDim = DIMENSIONS[`serviceLevel${modelLevel === 2 ? 4 : modelLevel}`];
    const sharedCols = [DIMENSIONS.serviceLevel2, detailDim, DIMENSIONS.fiscalMonth, MEASURES.acr];
    const cached = identity && (readCachedEntry(cacheKey(cols, tpids, fiscalYears, undefined, serviceFilter, identity))
      || readCompatibleFiscalEntry({ cols, tpids, fiscalYears, serviceFilter, identity }));
    const sharedCached = identity && (readCachedEntry(cacheKey(sharedCols, tpids, fiscalYears, undefined, null, identity))
      || readCompatibleFiscalEntry({ cols: sharedCols, tpids, fiscalYears, serviceFilter: null, identity }));
    if (cached && !sharedCached) {
      rows = await fetchRows(cols, tpids, fiscalYears, undefined, { force: opts.force, serviceFilter });
    } else {
      const shared = await fetchRows(sharedCols, tpids, fiscalYears, undefined, { force: opts.force });
      const projected = projectCachedAcr(shared,
        JSON.parse(cacheKey(sharedCols, tpids, fiscalYears, undefined, null, identity)),
        JSON.parse(cacheKey(cols, tpids, fiscalYears, undefined, serviceFilter, identity)));
      if (!projected) throw new Error('The shared ACR data does not contain the required product dimensions. No approximate chart was returned.');
      rows = setCacheInfo(projected, cacheInfo(shared));
    }
    const shaped = shapeRowsVisible(rows, [modelDim, DIMENSIONS.fiscalMonth], [MEASURES.acr]);

    const byModel = new Map();
    const monthSet = new Set();
    for (const r of shaped) {
      const model = String(r[modelDim.name] || '').trim() || '(Unattributed)';
      const month = String(r.fiscalMonth || '').trim();
      const amount = Number(r.acr || 0);
      if (!month) continue;
      monthSet.add(month);
      if (!byModel.has(model)) byModel.set(model, { model, monthly: {}, total: 0 });
      const entry = byModel.get(model);
      entry.monthly[month] = (entry.monthly[month] || 0) + amount;
      entry.total += amount;
    }

    const months = orderFiscalMonths([...monthSet]);
    const models = [...byModel.values()]
      .map((m) => ({ ...m, total: Math.round(m.total * 100) / 100 }))
      .filter((m) => m.total !== 0) // drop models with no usage in the window
      .sort((a, b) => b.total - a.total);
    const grandTotal = Math.round(models.reduce((sum, m) => sum + m.total, 0) * 100) / 100;

    return {
      fiscalYear: fiscalYears.join(' + '),
      fiscalYears,
      modelLevel,
      categories,
      months,
      models,
      grandTotal,
      cache: cacheInfo(rows),
    };
  }

  async function getAnthropicMonthlySpend(opts = {}) {
    const tpids = [...new Set((opts.tpids || []).map((t) => String(t ?? '').trim()).filter(Boolean))];
    if (!tpids.length || tpids.some((tpid) => !/^\d+$/.test(tpid))) {
      throw new Error('Anthropic spend requires numeric customer TPIDs.');
    }
    const fiscalYears = resolveFiscalYears(opts);
    const rows = await fetchRows(
      [DIMENSIONS.tpid, DIMENSIONS.account, DIMENSIONS.fiscalMonth, MEASURES.acr],
      tpids,
      fiscalYears,
      undefined,
      { force: opts.force, adjustmentScope: 'anthropic' },
    );
    const cache = cacheInfo(rows);
    const incompleteMonths = new Set(cache.incompleteMonths || []);
    const months = cache.status === 'missing' ? [] : availableFiscalMonths(clockDate())
      .filter((month) => fiscalYears.includes(month.slice(0, 4)) && !incompleteMonths.has(month));
    const monthSet = new Set(months);
    const requestedTpids = new Set(tpids);
    const monthly = Object.fromEntries(months.map((month) => [month, 0]));
    const byAccount = new Map();
    let grandTotal = 0;
    for (const row of rows) {
      const tpid = String(row.tpid ?? '').trim();
      const month = String(row.fiscalMonth ?? '').trim();
      const amount = Number(row.acr);
      if (!requestedTpids.has(tpid)
        || !/^FY\d{2}-(Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun)$/.test(month)
        || !fiscalYears.includes(month.slice(0, 4))
        || row.acr == null || row.acr === '' || !Number.isFinite(amount)) {
        throw Object.assign(new Error('Power BI returned an invalid account, month, or amount for Anthropic spend. No spend total was returned.'), {
          code: 'ACR_INVALID_DATA',
        });
      }
      if (!monthSet.has(month)) continue;
      if (!byAccount.has(tpid)) byAccount.set(tpid, {
        tpid,
        account: String(row.account || '').trim() || `TPID ${tpid}`,
        monthly: {},
        total: 0,
      });
      const account = byAccount.get(tpid);
      account.monthly[month] = (account.monthly[month] || 0) + amount;
      account.total += amount;
      monthly[month] += amount;
      grandTotal += amount;
    }
    const round2 = (amount) => Math.round(amount * 100) / 100;
    const latestMonth = months[months.length - 1] || null;
    const accounts = [...byAccount.values()].map((account) => ({
      ...account,
      monthly: Object.fromEntries(Object.entries(account.monthly).map(([month, amount]) => [month, round2(amount)])),
      total: round2(account.total),
      latest: latestMonth ? round2(account.monthly[latestMonth] || 0) : null,
    })).sort((a, b) => b.total - a.total || a.account.localeCompare(b.account) || a.tpid.localeCompare(b.tpid));
    return {
      fiscalYear: fiscalYears.join(' + '),
      fiscalYears,
      source: { modelId: ACR_MODEL_ID, adjustmentFlag: 'XCR - Anthropic', measure: '$ ACR', currency: 'USD' },
      months,
      monthly: Object.fromEntries(Object.entries(monthly).map(([month, amount]) => [month, round2(amount)])),
      grandTotal: cache.status === 'missing' ? null : round2(grandTotal),
      latestMonth,
      latest: latestMonth ? round2(monthly[latestMonth]) : null,
      accounts,
      cache,
    };
  }

  /**
   * Portfolio-wide ACR view across every supplied TPID — the data behind the
   * Consumption dashboard. Two cached queries:
   *   1) account × fiscalMonth → per-account monthly series (trend, leaderboard,
   *      sparklines, and each account's latest-vs-previous MoM).
   *   2) serviceLevelN → portfolio service mix for the latest month.
   *
   * Returns ordered months, per-account rows (with total/latest/previous/MoM),
   * the service mix, and territory totals with a monthly series + MoM.
   *
   * @param {object} opts
   * @param {string[]} opts.tpids       Top-parent account IDs (whole territory).
   * @param {string|string[]} [opts.fiscalYear]  e.g. "FY26" or ["FY26","FY27"];
   *   defaults to latest month's FY. `opts.fiscalYears` (array) is also accepted.
   * @param {1|2|3|4|5} [opts.level]    Service level for the mix (default 2).
   * @param {string[]} [opts.services]  Optional product scope (values at
   *   `serviceFilterLevel`, default L2) — narrows the whole ACR calculation.
   * @param {boolean} [opts.force]
   */
  async function getPortfolio(opts = {}) {
    const tpids = [...new Set((opts.tpids || []).map((t) => String(t || '').trim()).filter(Boolean))];
    if (tpids.length === 0) throw new Error('No account TPIDs supplied. Sync customers first.');
    const level = [1, 2, 3, 4, 5].includes(Number(opts.level)) ? Number(opts.level) : 2;
    const serviceDim = DIMENSIONS[`serviceLevel${level}`];

    const fiscalYears = resolveFiscalYears(opts);
    const serviceFilter = resolveServiceFilter(opts);

    // Q1 — per-account monthly series across the fiscal year(s).
    const acctCols = [DIMENSIONS.account, DIMENSIONS.fiscalMonth, MEASURES.acr];
    const acctRawRows = await fetchRows(
      acctCols,
      tpids,
      fiscalYears,
      undefined,
      { force: opts.force, serviceFilter },
    );
    const accountCache = cacheInternal(acctRawRows);
    const acctKey = accountCache?.key;
    const acctRows = shapeRowsVisible(
      acctRawRows,
      [DIMENSIONS.account, DIMENSIONS.fiscalMonth], [MEASURES.acr],
    );

    const byAccount = new Map();
    const monthSet = new Set();
    for (const r of acctRows) {
      const account = String(r.account || '').trim() || '(Unattributed)';
      const month = String(r.fiscalMonth || '').trim();
      const amount = Number(r.acr || 0);
      if (!month) continue;
      monthSet.add(month);
      if (!byAccount.has(account)) byAccount.set(account, { account, monthly: {}, total: 0 });
      const entry = byAccount.get(account);
      entry.monthly[month] = (entry.monthly[month] || 0) + amount;
      entry.total += amount;
    }

    const months = orderFiscalMonths([...monthSet]);
    const latestMonth = months[months.length - 1] || null;
    const prevMonth = months.length > 1 ? months[months.length - 2] : null;
    if (acctKey && cacheInfo(acctRawRows).refreshing) {
      scheduleServiceMixWarmup({
        accountKey: acctKey,
        serviceDim,
        tpids,
        fiscalYears,
        serviceFilter,
        identity: accountCache.identity,
      });
    }

    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const momPct = (cur, prev) => (prev ? round2(((cur - prev) / Math.abs(prev)) * 100) : null);

    const accounts = [...byAccount.values()].map((a) => {
      const latest = round2(latestMonth ? a.monthly[latestMonth] || 0 : 0);
      const previous = round2(prevMonth ? a.monthly[prevMonth] || 0 : 0);
      const monthly = {};
      for (const m of months) monthly[m] = round2(a.monthly[m] || 0);
      return {
        account: a.account,
        monthly,
        total: round2(a.total),
        latest,
        previous,
        momDollar: round2(latest - previous),
        momPct: momPct(latest, previous),
      };
    }).sort((x, y) => y.latest - x.latest);

    // Territory totals + monthly series.
    const totalsMonthly = {};
    for (const m of months) totalsMonthly[m] = round2(accounts.reduce((s, a) => s + (a.monthly[m] || 0), 0));
    const tLatest = latestMonth ? totalsMonthly[latestMonth] : 0;
    const tPrev = prevMonth ? totalsMonthly[prevMonth] : 0;
    const grandTotal = round2(accounts.reduce((s, a) => s + a.total, 0));

    // Q2 — portfolio service mix for the latest complete month.
    let serviceMix = [];
    let serviceRawRows = setCacheInfo([], {
      status: 'missing',
      dataAsOf: null,
      ageMs: null,
      refreshing: false,
      source: 'none',
    });
    try {
      if (latestMonth) {
        serviceRawRows = await fetchRows(
          [serviceDim, MEASURES.acr],
          tpids,
          fiscalYears,
          latestMonth,
          { force: opts.force, serviceFilter },
        );
        const svcRows = shapeRows(
          serviceRawRows,
          [serviceDim], [MEASURES.acr],
        );
        const byService = new Map();
        for (const r of svcRows) {
          const service = String(r[serviceDim.name] || '').trim() || '(Unassigned)';
          byService.set(service, round2((byService.get(service) || 0) + Number(r.acr || 0)));
        }
        serviceMix = [...byService.entries()]
          .map(([service, total]) => ({ service, total }))
          .sort((a, b) => b.total - a.total);
      } else {
        serviceRawRows = setCacheInfo([], cacheInfo(acctRawRows));
      }
    } catch (e) {
      if (opts.force) throw e;
      logger.warn(`service mix query failed: ${e.message}`);
    }

    // If neither query reported an error but this identity has recently been
    // denied live access, surface that denial so the page discloses the page is
    // showing cached data and cannot refresh — rather than silently implying a
    // refresh is in flight.
    const portfolioCache = mergeCacheInfo(acctRawRows, serviceRawRows);
    if (!portfolioCache.error) {
      const authErr = recentAuthError(accountCache?.identity);
      if (authErr) portfolioCache.error = authErr;
    }

    return {
      fiscalYear: fiscalYears.join(' + '),
      fiscalYears,
      level,
      months,
      latestMonth,
      previousMonth: prevMonth,
      accounts,
      serviceMix,
      servicesFilter: serviceFilter ? serviceFilter.values : null,
      totals: {
        monthly: totalsMonthly,
        grandTotal,
        latest: round2(tLatest),
        previous: round2(tPrev),
        momDollar: round2(tLatest - tPrev),
        momPct: momPct(tLatest, tPrev),
        growing: accounts.filter((a) => a.momDollar > 0).length,
        declining: accounts.filter((a) => a.momDollar < 0).length,
        accountCount: accounts.length,
      },
      cache: portfolioCache,
    };
  }

  /** Period options for a UI dropdown (fiscal years + latest complete month). */
  function getPeriods(now = new Date()) {
    return {
      fiscalYears: availableFiscalYears(now),
      fiscalMonths: [...availableFiscalMonths(now)].reverse(),
      latest: resolvePeriod('latest', now).label,
    };
  }

  function clearCache() {
    rowCache.clear();
  }

  async function waitForBackgroundRefreshes() {
    while (backgroundRefreshes.size > 0) {
      await Promise.allSettled([...backgroundRefreshes.values()]);
    }
  }

  return {
    queryAcr,
    getAccountMonthlyServiceAcr,
    getAccountServiceHierarchy,
    getServiceValues,
    getModelMonthlyAcr,
    getAnthropicMonthlySpend,
    getPortfolio,
    getPeriods,
    clearCache,
    waitForBackgroundRefreshes,
  };
}

module.exports = {
  createAcrService,
  POWERBI_RESOURCE,
  QUERYDATA_URL,
  BACKGROUND_REFRESH_AFTER_MS,
};
