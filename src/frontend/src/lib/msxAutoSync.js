/**
 * msxAutoSync.js — background auto-sync for MSX milestones + HoK activities.
 *
 * The manual "Sync from CRM" button (lib/sync.js → syncAll) runs the full pipeline
 * customers → milestones → HoK → contacts in the renderer. This module mirrors the
 * WorkIQ auto-ingest experience for the CRM side: an opt-in background job that keeps
 * the two fastest-moving datasets — milestones and HoK activities — fresh on a fixed
 * cadence, and records a one-line log (when it ran, how long it took, how many items it
 * pulled) so the user can actually see it working.
 *
 * Scope note: auto-sync intentionally refreshes ONLY milestones + HoK activities (what
 * the user asked for). It does not re-derive customers or contacts — those change rarely
 * and stay under the manual "Sync from CRM" button. Milestone sync depends on customers
 * already being synced, so a first-ever run before any manual sync will fail loudly with
 * a clear message rather than silently doing nothing.
 *
 * Config and the latest log line are persisted in localStorage (renderer-local, same as
 * the manual sync's "last run" stamp) and shared between the App-level scheduler and the
 * Settings UI via a window CustomEvent.
 */
import { syncMilestones, syncHok, syncInProgress, beginSync, endSync } from './sync';

const CONFIG_KEY = 'se-assist:msxAutoSync';
const LOG_KEY = 'se-assist:msxAutoSyncLog';
const MANUAL_LASTRUN_KEY = 'se-assist:syncLastRun';
export const MSX_AUTOSYNC_EVENT = 'se-assist:msx-autosync-updated';

const DEFAULT_CONFIG = { enabled: false, intervalMin: 180 };
const MIN_INTERVAL_MIN = 30;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

export function getMsxAutoSyncConfig() {
  const cfg = readJson(CONFIG_KEY, null) || {};
  return {
    enabled: Boolean(cfg.enabled),
    intervalMin: Math.max(MIN_INTERVAL_MIN, Number(cfg.intervalMin) || DEFAULT_CONFIG.intervalMin),
  };
}

export function setMsxAutoSyncConfig(patch = {}) {
  const cur = getMsxAutoSyncConfig();
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    intervalMin: patch.intervalMin != null
      ? Math.max(MIN_INTERVAL_MIN, Number(patch.intervalMin) || cur.intervalMin)
      : cur.intervalMin,
  };
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function getMsxAutoSyncLog() {
  return readJson(LOG_KEY, null);
}

function recordLog(entry = {}) {
  const record = {
    at: new Date().toISOString(),
    trigger: 'auto',
    ok: Boolean(entry.ok),
    durationMs: Math.max(0, Number(entry.durationMs) || 0),
    milestones: Math.max(0, Number(entry.milestones) || 0),
    opportunities: Math.max(0, Number(entry.opportunities) || 0),
    hok: Math.max(0, Number(entry.hok) || 0),
    items: Math.max(0, Number(entry.items) || 0),
    failedRequests: Math.max(0, Number(entry.failedRequests) || 0),
    error: entry.ok ? null : (entry.error || 'Unknown error'),
  };
  const secs = (record.durationMs / 1000).toFixed(1);
  console.log(record.ok
    ? `[msx-auto-sync] ${record.at} — synced ${record.items} item(s) (${record.milestones} milestones · ${record.hok} HoK) in ${secs}s`
    : `[msx-auto-sync] ${record.at} — failed after ${secs}s: ${record.error}`);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(record)); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(MSX_AUTOSYNC_EVENT, { detail: record })); } catch { /* ignore */ }
  return record;
}

// Most recent point at which the CRM data was refreshed, by any means (a prior auto-sync
// OR a manual "Sync from CRM"). Used to gate the interval so auto-sync doesn't fire right
// after the user just synced manually.
function lastRefreshAt() {
  const times = [];
  const log = getMsxAutoSyncLog();
  if (log?.at) times.push(new Date(log.at).getTime());
  try {
    const manual = localStorage.getItem(MANUAL_LASTRUN_KEY);
    if (manual) times.push(new Date(manual).getTime());
  } catch { /* ignore */ }
  const valid = times.filter((t) => Number.isFinite(t));
  return valid.length ? Math.max(...valid) : null;
}

// Run milestones + HoK now, under the shared sync lock, and record a log line. Returns the
// log record. Exposed for a "run now" affordance and used by runMsxAutoSyncIfDue.
export async function runMsxAutoSyncNow() {
  if (!beginSync()) return { skipped: 'busy' };
  const startedAt = Date.now();
  try {
    const ms = await syncMilestones();
    const hok = await syncHok();
    const milestones = Number(ms?.milestones || 0);
    const opportunities = Number(ms?.opportunities || 0);
    const hokTasks = Number(hok?.tasks || 0);
    const failedRequests = Number(ms?.failedRequests || 0) + Number(hok?.failedRequests || 0);
    return recordLog({
      ok: true,
      durationMs: Date.now() - startedAt,
      milestones, opportunities, hok: hokTasks,
      items: milestones + hokTasks,
      failedRequests,
    });
  } catch (err) {
    return recordLog({ ok: false, durationMs: Date.now() - startedAt, error: err?.message || String(err) });
  } finally {
    endSync();
  }
}

// Scheduler entry point. No-op unless auto-sync is enabled, nothing else is syncing, and
// the configured interval has elapsed since the last refresh. Called on a fixed cadence
// from the always-mounted App scheduler.
export async function runMsxAutoSyncIfDue() {
  const cfg = getMsxAutoSyncConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (syncInProgress()) return { skipped: 'busy' };
  const last = lastRefreshAt();
  if (last && (Date.now() - last) < cfg.intervalMin * 60_000) return { skipped: 'not-due' };
  return runMsxAutoSyncNow();
}
