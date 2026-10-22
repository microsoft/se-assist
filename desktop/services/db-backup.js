/**
 * Local database backup / restore for SE Assist.
 *
 * WHY THIS EXISTS. Until meeting notes (migration 026) the SQLite datastore was a pure
 * CACHE — every table could be rebuilt by re-syncing from Microsoft Graph / Dynamics. That
 * is no longer true: meeting notes (prep / transcript / summary / personal), manual
 * meeting↔milestone links (signal_links source='manual'), locally-created workloads and
 * suggestions, and manual account-tag decisions are AUTHORED here and have no upstream
 * source. If the single seassist.db file is lost or corrupted, that work is gone. Windows
 * File History / OneDrive do not cover %APPDATA%\Roaming by default, so nothing else is
 * protecting it. This module gives the app its own safety net.
 *
 * WHAT IT DOES.
 *   • createBackup()  — a consistent point-in-time snapshot using SQLite's ONLINE backup
 *                       API (better-sqlite3 db.backup()), which is safe on a live WAL
 *                       database while the app is running. Snapshots are timestamped and
 *                       self-describe their reason in the filename.
 *   • snapshotSync()  — a synchronous checkpoint+copy used only at startup / pre-migration,
 *                       when the DB is quiescent, so an upgrade always leaves a pre-change
 *                       copy behind before any schema change touches the data.
 *   • listBackups()   — enumerate the snapshots with size + timestamp + reason.
 *   • rotate()        — keep only the newest N so backups can't grow unbounded.
 *   • validateBackupFile() — prove a candidate file is a real SE Assist DB before a restore
 *                       is ever allowed to overwrite the live one (fail loud, never clobber
 *                       with garbage).
 *   • exportTo()      — write a snapshot to a user-chosen path (e.g. OneDrive / a network
 *                       share) so a copy lives OFF this machine.
 *
 * Restore itself is orchestrated in sqlite-ipc.js because it must close, swap and reopen the
 * module-level database handle; this file provides the safe primitives it composes.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BACKUPS_DIRNAME = 'backups';
const DEFAULT_RETENTION = 10;
// Minimum age of the newest snapshot before an automatic (launch-time) backup is taken, so
// launching the app many times a day does not spam near-identical copies.
const AUTO_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
// A sentinel table every real SE Assist DB has, used to reject a wrong / corrupt file.
const SENTINEL_TABLE = 'customers';

function getBackupsDir(userDataDir) {
  const dir = path.join(userDataDir, BACKUPS_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeReason(reason) {
  const r = String(reason || 'manual').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return r || 'manual';
}

// Local-time compact stamp, e.g. 20260909-114233. Sorting is done by mtime, not name, so the
// stamp is purely for human readability in the file list / folder.
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupFileName(reason, d = new Date()) {
  return `seassist-${sanitizeReason(reason)}-${timestamp(d)}.db`;
}

// Parse "seassist-<reason>-<YYYYMMDD-HHMMSS>.db" back into its reason (best-effort; used only
// for display). Everything between the fixed prefix and the trailing timestamp is the reason.
function parseReason(fileName) {
  const m = /^seassist-(.+)-\d{8}-\d{6}\.db$/i.exec(fileName);
  return m ? m[1] : null;
}

function isBackupFile(fileName) {
  return /^seassist-.+\.db$/i.test(fileName);
}

// Newest-first list of snapshots with size + mtime + parsed reason.
function listBackups(backupsDir) {
  let names = [];
  try {
    names = fs.readdirSync(backupsDir).filter(isBackupFile);
  } catch {
    return [];
  }
  const rows = names.map((name) => {
    const full = path.join(backupsDir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch { stat = null; }
    return {
      name,
      path: full,
      size: stat ? stat.size : 0,
      created_at: stat ? stat.mtime.toISOString() : null,
      reason: parseReason(name),
    };
  });
  rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return rows;
}

// Keep only the newest `keep` snapshots; delete the rest. Returns the number removed.
function rotate(backupsDir, keep = DEFAULT_RETENTION) {
  const max = Math.max(1, Number(keep) || DEFAULT_RETENTION);
  const rows = listBackups(backupsDir);
  const doomed = rows.slice(max);
  let removed = 0;
  for (const r of doomed) {
    try { fs.rmSync(r.path, { force: true }); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

// Point-in-time snapshot of a LIVE database via the online backup API. Safe while the app is
// running and writing. Returns the created backup's metadata. Rotates afterwards.
async function createBackup(db, { backupsDir, reason = 'manual', keep = DEFAULT_RETENTION } = {}) {
  if (!db) throw new Error('db-backup: no open database to back up');
  if (!backupsDir) throw new Error('db-backup: backupsDir is required');
  fs.mkdirSync(backupsDir, { recursive: true });
  const name = backupFileName(reason);
  const dest = path.join(backupsDir, name);
  await db.backup(dest); // online backup — consistent snapshot even under concurrent writes
  let size = 0;
  try { size = fs.statSync(dest).size; } catch { size = 0; }
  rotate(backupsDir, keep);
  return { name, path: dest, size, created_at: new Date().toISOString(), reason: sanitizeReason(reason) };
}

// Synchronous, consistent snapshot for the quiescent startup / pre-migration moment: fold the
// WAL back into the main file (TRUNCATE checkpoint) then copy the single file. Only safe when
// nothing else is writing (true during openDb before handlers are registered).
function snapshotSync(db, { dbPath, backupsDir, reason = 'pre-migration', keep = DEFAULT_RETENTION } = {}) {
  if (!db) throw new Error('db-backup: no open database to snapshot');
  if (!dbPath || !backupsDir) throw new Error('db-backup: dbPath and backupsDir are required');
  fs.mkdirSync(backupsDir, { recursive: true });
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* checkpoint best-effort */ }
  const name = backupFileName(reason);
  const dest = path.join(backupsDir, name);
  fs.copyFileSync(dbPath, dest);
  let size = 0;
  try { size = fs.statSync(dest).size; } catch { size = 0; }
  rotate(backupsDir, keep);
  return { name, path: dest, size, created_at: new Date().toISOString(), reason: sanitizeReason(reason) };
}

// Prove a candidate file is a genuine, openable SE Assist database before any restore is
// allowed to overwrite the live DB. Opens it read-only, checks user_version and the sentinel
// table. Throws (fail loud) on anything that isn't a real DB so we never clobber good data
// with a corrupt or unrelated file. Returns { userVersion }.
function validateBackupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Backup file does not exist.');
  let probe = null;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const uv = Number(probe.pragma('user_version', { simple: true }) || 0);
    const row = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(SENTINEL_TABLE);
    if (!row) throw new Error(`Not a SE Assist database (missing "${SENTINEL_TABLE}" table).`);
    return { userVersion: uv };
  } catch (err) {
    throw new Error(`Selected file is not a valid SE Assist backup: ${err.message || String(err)}`);
  } finally {
    if (probe) { try { probe.close(); } catch { /* ignore */ } }
  }
}

// Write a snapshot of the live DB to an arbitrary user-chosen path (Save dialog target). Uses
// the online backup API so it is consistent even mid-session. Returns the destination path.
async function exportTo(db, destPath) {
  if (!db) throw new Error('db-backup: no open database to export');
  if (!destPath) throw new Error('db-backup: a destination path is required');
  await db.backup(destPath);
  return destPath;
}

// Should an automatic launch-time backup run? Only when auto-backup is enabled and the newest
// snapshot is missing or older than the throttle window.
function shouldAutoBackup(backupsDir, { enabled = true } = {}) {
  if (!enabled) return false;
  const rows = listBackups(backupsDir);
  if (!rows.length) return true;
  const newest = rows[0].created_at ? Date.parse(rows[0].created_at) : 0;
  return !newest || (Date.now() - newest) >= AUTO_MIN_INTERVAL_MS;
}

module.exports = {
  BACKUPS_DIRNAME,
  DEFAULT_RETENTION,
  AUTO_MIN_INTERVAL_MS,
  getBackupsDir,
  backupFileName,
  listBackups,
  rotate,
  createBackup,
  snapshotSync,
  validateBackupFile,
  exportTo,
  shouldAutoBackup,
};
