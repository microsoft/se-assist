/**
 * acr-ipc.js — IPC bridge for the Azure Consumed Revenue (ACR) integration.
 *
 * Exposes per-customer / per-month / per-service-level dollar ACR to the
 * renderer, sourced live from the MSX-I Power BI semantic model via
 * acr-querydata. Auth reuses the app's existing Microsoft sign-in: it mints a
 * Power BI-scoped token through msx-ipc.getAccessTokenForResource (MSAL first,
 * Azure CLI fallback) — no separate sign-in and no Azure CLI requirement when
 * the user is signed in via Settings → Sign in with Microsoft.
 */
const { ipcMain, app, webContents } = require('electron');
const path = require('path');
const { createAcrService, POWERBI_RESOURCE } = require('./services/acr-querydata');
const { getAccessTokenForResource, getSignedInIdentity } = require('./msx-ipc');
const { openDb } = require('./sqlite-ipc');
const { computePortfolioInsights } = require('./services/acr-insights');
const { currentFiscalMonth } = require('./services/acr-schema');
const { createAcrFileLogger } = require('./services/acr-request-log');
const { assertActiveTpids, getEffectiveTpids, withRosterWork, beginRosterWork } = require('./account-roster');

let acr = null;

// Persist the ACR query engine's request trail (429/503 throttles + their
// backoff waits, transient retries, per-window progress) to a small rotating
// file under userData/logs so a slow load can be diagnosed after the fact.
// Best-effort: if userData is unavailable, return undefined so createAcrService
// falls back to its default console-only logger (never blocks ACR from loading).
function buildAcrLogger() {
  try {
    const filePath = path.join(app.getPath('userData'), 'logs', 'acr-querydata.log');
    return createAcrFileLogger({ filePath });
  } catch {
    return undefined;
  }
}

// Push the ACR query engine's live-progress events (start / rows-so-far /
// throttle countdown / done) to every renderer window so a slow pull shows an
// accurate, ticking status instead of an indeterminate spinner. Best-effort:
// a send failure must never disturb the fetch that produced the event.
function broadcastAcrProgress(evt) {
  for (const contents of webContents.getAllWebContents()) {
    try {
      // The React app lives in a webview, not the shell BrowserWindow.
      if (!contents.isDestroyed() && isAllowedSender({ senderFrame: { url: contents.getURL() } })) {
        contents.send('acr-progress', evt);
      }
    } catch { /* ignore a dead/closing window */ }
  }
}

// Lazily build the ACR service so it binds to the initialized MSX auth services.
function getAcr() {
  if (acr) return acr;
  acr = createAcrService({
    getPowerBiToken: async () => {
      const res = await getAccessTokenForResource(POWERBI_RESOURCE);
      if (!res?.token) {
        const err = new Error('Could not acquire a Power BI token. Sign in with Microsoft in Settings, and ensure you are on corpnet/VPN.');
        err.code = 'NO_ACCOUNT';
        throw err;
      }
      return res.token;
    },
    getCacheIdentity: () => getSignedInIdentity(),
    // Persistent read-through row cache lives in the app's SQLite DB so ACR
    // surfaces populate from local tables across restarts and only re-pull from
    // Power BI when the cached rows are older than the freshness window.
    getDb: () => openDb(),
    logger: buildAcrLogger(),
    onProgress: broadcastAcrProgress,
    validateTpids: (tpids) => assertActiveTpids(openDb(), tpids),
    beginAccountWork: beginRosterWork,
  });
  return acr;
}

// Only allow calls from the app's own renderer (file:// or localhost dev origins).
function isAllowedSender(event) {
  const url = event?.senderFrame?.url || '';
  return url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
}

function toIntList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  if (v == null) return [];
  return [String(v).trim()].filter(Boolean);
}

function toActiveTpids(value) {
  return assertActiveTpids(openDb(), toIntList(value));
}

function registerAcrHandler(channel, handler) {
  ipcMain.handle(channel, (event, payload) => withRosterWork(channel, () => handler(event, payload)));
}

function registerAcrIpc() {
  // Per-customer, per-month, per-service-level dollar ACR (the primary shape).
  registerAcrHandler('acr-account-services', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids ?? payload.tpid);
      if (tpids.length === 0) return { ok: false, error: 'No TPID for this customer. Sync customers from MSX first.' };
      const level = Number(payload.level) || 2;
      const data = await getAcr().getAccountMonthlyServiceAcr({
        tpids,
        level,
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        services: payload.services,
        serviceFilterLevel: payload.serviceFilterLevel,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Per-model (Azure OpenAI / AI Foundry) monthly ACR — the multi-line chart.
  registerAcrHandler('acr-models', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids ?? payload.tpid);
      if (tpids.length === 0) return { ok: false, error: 'No TPID for this customer. Sync customers from MSX first.' };
      const data = await getAcr().getModelMonthlyAcr({
        tpids,
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        modelLevel: payload.modelLevel,
        categories: payload.categories,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  registerAcrHandler('acr-anthropic-spend', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const data = await getAcr().getAnthropicMonthlySpend({
        tpids: toActiveTpids(payload.tpids ?? payload.tpid),
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Full Service-Level hierarchy tree (L1 › … › Ln) for one or more accounts.
  registerAcrHandler('acr-service-hierarchy', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids ?? payload.tpid);
      if (tpids.length === 0) return { ok: false, error: 'No TPID for this customer. Sync customers from MSX first.' };
      const data = await getAcr().getAccountServiceHierarchy({
        tpids,
        level: payload.level,
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        services: payload.services,
        serviceFilterLevel: payload.serviceFilterLevel,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Distinct Service-Level values (default L2 products) for the product-filter picker.
  registerAcrHandler('acr-service-values', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids ?? payload.tpid);
      if (tpids.length === 0) return { ok: false, error: 'No TPIDs. Sync customers from MSX first.' };
      const data = await getAcr().getServiceValues({
        tpids,
        level: payload.level,
        parentLevel: payload.parentLevel,
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Generic ACR aggregation (group by any dimensions, any measures).
  registerAcrHandler('acr-query', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids ?? payload.tpid);
      if (tpids.length === 0) return { ok: false, error: 'No TPIDs supplied.' };
      const data = await getAcr().queryAcr({
        tpids,
        groupBy: payload.groupBy,
        measures: payload.measures,
        period: payload.period,
        fiscalYears: payload.fiscalYears,
        sortBy: payload.sortBy,
        sortDir: payload.sortDir,
        topN: payload.topN,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Portfolio-wide ACR across the whole territory (Consumption dashboard).
  registerAcrHandler('acr-portfolio', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids);
      if (tpids.length === 0) return { ok: false, error: 'No TPIDs supplied. Sync customers from MSX first.' };
      const data = await getAcr().getPortfolio({
        tpids,
        fiscalYear: payload.fiscalYear,
        fiscalYears: payload.fiscalYears,
        level: Number(payload.level) || 2,
        services: payload.services,
        serviceFilterLevel: payload.serviceFilterLevel,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null, retryAt: err.retryAt || null };
    }
  });

  // Download FY snapshots (default FY26 + FY27) into the local analytics store.
  // Explicit, user-triggered persistence — no silent background writes.
  registerAcrHandler('acr-snapshot', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpids = toActiveTpids(payload.tpids);
      if (tpids.length === 0) return { ok: false, error: 'No TPIDs supplied. Sync customers from MSX first.' };
      const fiscalYears = (Array.isArray(payload.fiscalYears) && payload.fiscalYears.length
        ? payload.fiscalYears
        : ['FY26', 'FY27'])
        .map((y) => String(y || '').trim().toUpperCase())
        .filter((y) => /^FY\d{2}$/.test(y));
      if (fiscalYears.length === 0) return { ok: false, error: 'No valid fiscal years to snapshot.' };
      const level = Number(payload.level) || 2;
      const svc = getAcr();
      const db = openDb();
      const rosterKey = JSON.stringify([...tpids].sort());

      let accountRows = 0;
      let serviceRows = 0;
      const perYear = [];

      for (const fy of fiscalYears) {
        // Account x month (territory) and service x month (territory).
        const portfolio = await svc.getPortfolio({ tpids, fiscalYear: fy, level, force: true });
        const svcSeries = await svc.getAccountMonthlyServiceAcr({ tpids, fiscalYear: fy, level, force: true });

        const persist = db.transaction(() => {
          const accountData = [];
          for (const a of portfolio.accounts || []) {
            for (const m of portfolio.months || []) {
              const amount = a.monthly?.[m] || 0;
              if (!amount) continue;
              accountData.push({ fiscal_month: m, account: a.account, acr: amount });
              accountRows++;
            }
          }

          const serviceData = [];
          for (const s of svcSeries.services || []) {
            for (const m of svcSeries.months || []) {
              const amount = s.monthly?.[m] || 0;
              if (!amount) continue;
              serviceData.push({ fiscal_month: m, service: s.service, acr: amount });
              serviceRows++;
            }
          }
          db.prepare(
            `INSERT INTO acr_portfolio_snapshots(roster_key,fiscal_year,service_level,account_rows_json,service_rows_json,checked_at)
             VALUES(?,?,?,?,?,?) ON CONFLICT(roster_key,fiscal_year,service_level) DO UPDATE SET
             account_rows_json=excluded.account_rows_json,service_rows_json=excluded.service_rows_json,checked_at=excluded.checked_at`,
          ).run(rosterKey, fy, level, JSON.stringify(accountData), JSON.stringify(serviceData), new Date().toISOString());
        });
        persist();
        perYear.push({ fiscalYear: fy, months: (portfolio.months || []).length, accounts: (portfolio.accounts || []).length, grandTotal: portfolio.totals?.grandTotal ?? 0 });
      }

      db.prepare(
        'INSERT INTO acr_snapshot_log (fiscal_years, service_level, tpid_count, account_rows, service_rows, roster_key) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(fiscalYears.join(','), level, tpids.length, accountRows, serviceRows, rosterKey);

      return { ok: true, fiscalYears, level, tpidCount: tpids.length, accountRows, serviceRows, perYear, ranAt: new Date().toISOString() };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  });

  // Latest snapshot metadata for the analytics store (freshness display).
  registerAcrHandler('acr-snapshot-status', async (event) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const db = openDb();
      const rosterKey = JSON.stringify(getEffectiveTpids(db).sort());
      const last = db.prepare('SELECT fiscal_years, service_level, tpid_count, account_rows, service_rows, ran_at FROM acr_snapshot_log WHERE roster_key = ? ORDER BY id DESC LIMIT 1').get(rosterKey);
      return { ok: true, last: last || null };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Deterministic portfolio insights (analysis engine) computed from the local
  // snapshot store — trends, growth opportunities, risks. Reads the latest
  // snapshot rows for the requested fiscal years (default: whatever is stored).
  registerAcrHandler('acr-insights', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const db = openDb();
      const fys = (Array.isArray(payload.fiscalYears) ? payload.fiscalYears : [])
        .map((y) => String(y || '').trim().toUpperCase())
        .filter((y) => /^FY\d{2}$/.test(y));
      const level = [1, 2, 3, 4, 5].includes(Number(payload.serviceLevel)) ? Number(payload.serviceLevel) : 2;

      const rosterKey = JSON.stringify(assertActiveTpids(db, getEffectiveTpids(db)).sort());
      const snapshots = db.prepare(
        `SELECT account_rows_json,service_rows_json FROM acr_portfolio_snapshots WHERE roster_key=? AND service_level=?
         ${fys.length ? `AND fiscal_year IN (${fys.map(() => '?').join(',')})` : ''}`,
      ).all(rosterKey, level, ...fys);
      if (!snapshots.length) throw new Error('No analytics snapshot exists for the active roster. Create a snapshot to calculate active-portfolio insights.');
      const accountRows = snapshots.flatMap((row) => JSON.parse(row.account_rows_json));
      const serviceRows = snapshots.flatMap((row) => JSON.parse(row.service_rows_json));

      // The current, in-progress fiscal month has only partial actuals, so exclude
      // it from the insight engine — otherwise "latest month" MoM/trend cards would
      // report a false decline, mirroring the nosedive the ACR charts already hide.
      const hideMonth = currentFiscalMonth().fiscalMonth;
      const completeAccountRows = accountRows.filter((r) => String(r.fiscal_month || '').trim() !== hideMonth);
      const completeServiceRows = serviceRows.filter((r) => String(r.fiscal_month || '').trim() !== hideMonth);

      const insights = computePortfolioInsights({
        accountRows: completeAccountRows,
        serviceRows: completeServiceRows,
        topN: Number(payload.topN) > 0 ? Number(payload.topN) : 5,
      });
      return { ...insights, fiscalYears: fys, serviceLevel: level };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Period options for a UI dropdown.
  registerAcrHandler('acr-periods', async (event) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      return { ok: true, ...getAcr().getPeriods() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  console.log('[acr-ipc] IPC handlers registered');
}

module.exports = { registerAcrIpc, getAcrService: getAcr };
