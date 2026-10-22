/**
 * SQLite IPC handlers for SE Assist.
 * Provides CRUD operations over better-sqlite3, exposed via Electron IPC.
 */
const { ipcMain, app, dialog, shell, BrowserWindow, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { getEffectiveTpids, hasCustomRoster, saveRoster, onRosterChanged, runActiveWrite, assertActiveRecord, assertActiveTpid, beginRosterWork } = require('./account-roster');
const workloadOrchestration = require('./services/workload-orchestration');
const signalLinks = require('./services/signal-links');
const dbBackup = require('./services/db-backup');

let db = null;
let stopRosterEvents = null;
const crmSyncLeases = new Map();

function getDbPath() {
  return path.join(app.getPath('userData'), 'seassist.db');
}

// Backups live in %APPDATA%/se-assist/backups (sibling of seassist.db).
function backupsDir() {
  return dbBackup.getBackupsDir(app.getPath('userData'));
}

// Backup preferences are stored in app_settings (key/value). Defaults: auto-backup ON,
// keep the newest 10 snapshots.
function getBackupSettings(database = db) {
  const out = { enabled: true, retention: dbBackup.DEFAULT_RETENTION };
  try {
    const rows = database
      .prepare("SELECT key, value FROM app_settings WHERE key IN ('backup_auto_enabled','backup_retention')")
      .all();
    for (const r of rows || []) {
      if (r.key === 'backup_auto_enabled') out.enabled = r.value !== '0' && r.value !== 'false';
      if (r.key === 'backup_retention') {
        const n = Number(r.value);
        if (Number.isFinite(n) && n >= 1) out.retention = Math.min(50, Math.floor(n));
      }
    }
  } catch { /* defaults */ }
  return out;
}

function setBackupSettings(patch = {}) {
  const stmt = db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    stmt.run('backup_auto_enabled', patch.enabled ? '1' : '0');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'retention')) {
    const n = Math.min(50, Math.max(1, Math.floor(Number(patch.retention) || dbBackup.DEFAULT_RETENTION)));
    stmt.run('backup_retention', String(n));
  }
  return getBackupSettings();
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      industry_segment TEXT,
      tier TEXT DEFAULT 'Standard',
      notes TEXT,
      tpid TEXT,
      crm_account_id TEXT UNIQUE,
      parent_crm_account_id TEXT,
      segment TEXT,
      country TEXT,
      city TEXT,
      phone TEXT,
      website TEXT,
      revenue REAL,
      employees INTEGER,
      description TEXT,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    DROP TABLE IF EXISTS engagements;

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT UNIQUE,
      name TEXT,
      opportunity_number TEXT,
      estimated_close_date TEXT,
      owner_id TEXT,
      parent_account_id TEXT,
      customer_name TEXT,
      sales_play TEXT,
      customer_commitment TEXT,
      customer_need TEXT,
      owner_name TEXT,
      state_code INTEGER DEFAULT 0,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id TEXT UNIQUE,
      milestone_number TEXT,
      name TEXT,
      opportunity_id TEXT,
      workload TEXT,
      milestone_category INTEGER,
      milestone_date TEXT,
      milestone_status INTEGER,
      status_reason INTEGER,
      commitment_recommendation INTEGER,
      customer_commitment TEXT,
      status_label TEXT,
      monthly_use REAL,
      non_recurring REAL,
      non_recurring_months INTEGER,
      owner_id TEXT,
      forecast_comments TEXT,
      owner_name TEXT,
      deal_team_json TEXT,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    DROP TABLE IF EXISTS pocs;

    CREATE TABLE IF NOT EXISTS tpid_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tpid TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_account_team_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tpid TEXT NOT NULL,
      role TEXT NOT NULL,
      person_name TEXT,
      person_email TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tpid, role)
    );
  `);

  // Migrate existing tables — add columns that may be missing from older schema
  const migrateColumn = (table, column, type) => {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[sqlite-ipc] Added column ${table}.${column}`);
    } catch (e) {
      // "duplicate column name" means it already exists — safe to ignore
    }
  };

  const customerCols = [
    ['tpid', 'TEXT'], ['crm_account_id', 'TEXT'], ['parent_crm_account_id', 'TEXT'],
    ['segment', 'TEXT'], ['country', 'TEXT'], ['city', 'TEXT'], ['phone', 'TEXT'],
    ['website', 'TEXT'], ['revenue', 'REAL'], ['employees', 'INTEGER'],
    ['description', 'TEXT'], ['last_synced_at', 'TIMESTAMP'],
    ['parenting_level', 'INTEGER'],
    ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
  ];
  for (const [col, type] of customerCols) {
    migrateColumn('customers', col, type);
  }

  // Migrate milestones table
  migrateColumn('milestones', 'customer_commitment', 'TEXT');
  migrateColumn('milestones', 'status_label', 'TEXT');
  migrateColumn('milestones', 'comments_json', 'TEXT');
  migrateColumn('milestones', 'task_count', 'INTEGER DEFAULT 0');
  migrateColumn('milestones', 'owner_name', 'TEXT');
  migrateColumn('milestones', 'deal_team_json', 'TEXT');
  // CRM record creation date (msp_engagementmilestone.createdon) — drives the
  // Milestone Timeline Gantt bar start. Populated on the next "Sync from CRM".
  migrateColumn('milestones', 'created_on', 'TEXT');

  // Migrate opportunities table
  migrateColumn('opportunities', 'customer_commitment', 'TEXT');
  migrateColumn('opportunities', 'owner_name', 'TEXT');
  // Free-text "Customer Need" captured on the MSX opportunity (customerneed).
  migrateColumn('opportunities', 'customer_need', 'TEXT');
  // CRM record creation date (opportunity.createdon) — drives the Milestone
  // Timeline Gantt bar start. Populated on the next "Sync from CRM".
  migrateColumn('opportunities', 'created_on', 'TEXT');

  // Add unique index on crm_account_id (separate from ALTER TABLE)
  try {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_crm_account_id ON customers(crm_account_id)`);
  } catch (e) { /* index may already exist */ }

  runVersionedMigrations(database);
}

function runVersionedMigrations(database) {
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const currentVersion = Number(database.pragma('user_version', { simple: true }) || 0);
  const migrations = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .map((file) => ({
      file,
      version: Number(file.split('_')[0]),
      path: path.join(migrationsDir, file),
    }))
    .filter((migration) => migration.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  // Safety net: before mutating an EXISTING datastore's schema/data, drop a consistent
  // snapshot next to it. Skipped on a first-ever DB (currentVersion === 0) — there is nothing
  // to protect yet. Best-effort: a snapshot failure must never block the upgrade itself.
  if (migrations.length && currentVersion > 0) {
    try {
      const snap = dbBackup.snapshotSync(database, {
        dbPath: getDbPath(),
        backupsDir: backupsDir(),
        reason: `pre-migration-v${currentVersion}`,
        keep: getBackupSettings(database).retention,
      });
      console.log('[sqlite-ipc] Pre-migration backup created:', snap.name);
    } catch (err) {
      console.warn('[sqlite-ipc] Pre-migration backup failed (continuing):', err.message);
    }
  }

  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.path, 'utf8');
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      database.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
    console.log(`[sqlite-ipc] Applied migration ${migration.file}`);
  }
}

function openDb() {
  if (!db) {
    const dbPath = getDbPath();
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    console.log('[sqlite-ipc] Database opened at', dbPath);
  }
  return db;
}

function registerSqliteIpc() {
  openDb();
  stopRosterEvents?.();
  stopRosterEvents = onRosterChanged((roster) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send('se-account-roster-changed', roster);
    }
  });

  // Launch-time safety backup (throttled). Fire-and-forget: never block startup, and a
  // failure is logged, not fatal. Skipped when the newest snapshot is recent enough or the
  // user disabled auto-backup.
  try {
    const settings = getBackupSettings();
    if (dbBackup.shouldAutoBackup(backupsDir(), { enabled: settings.enabled })) {
      dbBackup
        .createBackup(db, { backupsDir: backupsDir(), reason: 'auto', keep: settings.retention })
        .then((b) => console.log('[sqlite-ipc] Auto-backup created:', b.name))
        .catch((err) => console.warn('[sqlite-ipc] Auto-backup failed:', err.message));
    }
  } catch (err) {
    console.warn('[sqlite-ipc] Auto-backup check failed:', err.message);
  }

  // Read query — returns array of row objects
  ipcMain.handle('se-db-query', (_event, sql, params = []) => {
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...(Array.isArray(params) ? params : [params]));
    } catch (err) {
      console.error('[sqlite-ipc] Query error:', err.message, '\nSQL:', sql);
      throw new Error(err.message);
    }
  });

  // Write operation — returns { changes, lastInsertRowid }
  ipcMain.handle('se-db-run', (_event, sql, params = []) => {
    try {
      const result = runActiveWrite(db, sql, Array.isArray(params) ? params : [params]);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    } catch (err) {
      console.error('[sqlite-ipc] Run error:', err.message, '\nSQL:', sql);
      throw new Error(err.message);
    }
  });

  ipcMain.handle('se-crm-sync-begin', (event) => {
    const token = randomUUID();
    const release = beginRosterWork('CRM sync');
    const finish = () => {
      release();
      event.sender.removeListener('destroyed', finish);
      crmSyncLeases.delete(token);
    };
    crmSyncLeases.set(token, { senderId: event.sender.id, finish });
    event.sender.once('destroyed', finish);
    return token;
  });
  ipcMain.handle('se-crm-sync-end', (event, token) => {
    const lease = crmSyncLeases.get(token);
    if (!lease || lease.senderId !== event.sender.id) throw new Error('CRM sync ownership is invalid.');
    lease.finish();
  });

  // Workload "Communication assignments" — native canonical read/write on signal_links
  // (target_type='workload'), migration 023. These bypass the legacy reconcile path
  // entirely; they are the authoritative writer for workload-target rows. Each throws
  // loudly on bad input, which the renderer surfaces as an error (fail loud).
  ipcMain.handle('se-workload-signal-list', (_event, payload = {}) => {
    assertActiveRecord(db, 'workloads', 'id', payload.workloadId);
    return { ok: true, items: signalLinks.listWorkloadSignals(db, payload.workloadId) };
  });

  ipcMain.handle('se-workload-signal-assign', (_event, payload = {}) => {
    assertActiveRecord(db, 'workloads', 'id', payload.workloadId);
    if (payload.tpid) assertActiveTpid(db, payload.tpid);
    if (payload.milestoneId) assertActiveRecord(db, 'milestones', 'milestone_id', payload.milestoneId);
    if (payload.opportunityId) assertActiveRecord(db, 'opportunities', 'opportunity_id', payload.opportunityId);
    return { ok: true, ...signalLinks.addWorkloadSignal(db, payload) };
  });

  ipcMain.handle('se-workload-signal-update', (_event, payload = {}) => {
    const link = db.prepare("SELECT target_id FROM active_signal_links WHERE id=? AND target_type='workload'").get(payload.id);
    if (!link) throw new Error('This assignment is unavailable or belongs to an archived account.');
    assertActiveRecord(db, 'workloads', 'id', link.target_id);
    if (payload.milestoneId) assertActiveRecord(db, 'milestones', 'milestone_id', payload.milestoneId);
    if (payload.opportunityId) assertActiveRecord(db, 'opportunities', 'opportunity_id', payload.opportunityId);
    return { ok: true, ...signalLinks.updateWorkloadSignalMilestone(db, payload) };
  });

  ipcMain.handle('se-workload-signal-unlink', (_event, payload = {}) => {
    const link = db.prepare("SELECT target_id FROM active_signal_links WHERE id=? AND target_type='workload'").get(payload.id);
    if (!link) throw new Error('This assignment is unavailable or belongs to an archived account.');
    assertActiveRecord(db, 'workloads', 'id', link.target_id);
    return { ok: true, ...signalLinks.removeWorkloadSignal(db, payload) };
  });

  ipcMain.handle('se-workload-create', (_event, payload = {}) => {
    return workloadOrchestration.createWorkload(db, payload);
  });

  ipcMain.handle('se-workload-apply-template', (_event, payload = {}) => {
    return workloadOrchestration.applyTemplate(db, payload);
  });

  ipcMain.handle('se-workload-save-template', (_event, payload = {}) => {
    return workloadOrchestration.saveTemplate(db, payload);
  });

  ipcMain.handle('se-workload-approve-suggestion', (_event, payload = {}) => {
    return workloadOrchestration.approveSuggestion(db, payload);
  });

  // Empty means no active accounts. Historical rows are never removed here.
  ipcMain.handle('se-get-account-roster', () => {
    return { tpids: getEffectiveTpids(db), isCustom: hasCustomRoster(db) };
  });

  // Replacing membership archives/reactivates accounts without changing their data.
  ipcMain.handle('se-save-account-roster', (_event, tpids) => {
    try {
      const effective = saveRoster(db, tpids);
      return { ok: true, tpids: effective, isCustom: hasCustomRoster(db) };
    } catch (err) {
      console.error('[sqlite-ipc] Save roster error:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // ── Database backups (data safety for locally-authored notes / links) ──────
  // Status: where the DB lives, its size, the snapshot list and current settings.
  ipcMain.handle('se-db-backup-list', () => {
    try {
      const dbPath = getDbPath();
      let dbSize = 0;
      try { dbSize = fs.statSync(dbPath).size; } catch { dbSize = 0; }
      const dir = backupsDir();
      return {
        ok: true,
        dbPath,
        dbSize,
        backupsDir: dir,
        userVersion: Number(db.pragma('user_version', { simple: true }) || 0),
        settings: getBackupSettings(),
        backups: dbBackup.listBackups(dir),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Manual "Back up now".
  ipcMain.handle('se-db-backup-now', async () => {
    try {
      const settings = getBackupSettings();
      const b = await dbBackup.createBackup(db, { backupsDir: backupsDir(), reason: 'manual', keep: settings.retention });
      return { ok: true, backup: b, backups: dbBackup.listBackups(backupsDir()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Export a copy to a user-chosen location (e.g. OneDrive / a network share) so a copy
  // survives loss of this machine. Uses the online backup API (consistent mid-session).
  ipcMain.handle('se-db-backup-export', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const stamp = dbBackup.backupFileName('export').replace(/^seassist-export-/, 'seassist-').replace(/\.db$/, '');
      const res = await dialog.showSaveDialog(win, {
        title: 'Export SE Assist data',
        defaultPath: `${stamp}.db`,
        filters: [{ name: 'SE Assist database', extensions: ['db'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await dbBackup.exportTo(db, res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Open the backups folder in the OS file explorer.
  ipcMain.handle('se-db-backup-open-folder', async () => {
    try {
      const dir = backupsDir();
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Update auto-backup on/off + retention count.
  ipcMain.handle('se-db-backup-settings', (_event, patch = {}) => {
    try {
      return { ok: true, settings: setBackupSettings(patch) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Restore the live DB from one of the snapshots. Composes the safe primitives: validate
  // the chosen file, snapshot the CURRENT db first (so a bad restore is itself recoverable),
  // then swap the file and reopen. `fileName` selects a managed snapshot; `filePath` allows
  // restoring from an external file chosen via a dialog. The renderer reloads on success so
  // every cached query re-reads the restored data.
  ipcMain.handle('se-db-backup-restore', async (_event, payload = {}) => {
    try {
      const dir = backupsDir();
      let source = '';
      if (payload && payload.filePath) {
        source = String(payload.filePath);
      } else if (payload && payload.fileName) {
        source = path.join(dir, path.basename(String(payload.fileName)));
      } else {
        throw new Error('A backup fileName or filePath is required to restore.');
      }
      const { userVersion } = dbBackup.validateBackupFile(source); // fail loud on bad file
      const result = restoreFromFile(source);
      // The DB file was swapped and the sqlite-ipc handle reopened, but long-lived main-process
      // services (e.g. app-ipc handlers) captured the ORIGINAL handle at registration and would
      // now read/write a closed connection. A full relaunch is the only reliable way to rebind
      // every service to the restored database. Delay briefly so this IPC response reaches the
      // renderer first; the renderer shows a "restarting" state instead of reloading itself.
      setTimeout(() => {
        try { app.relaunch(); app.exit(0); } catch (err) { console.error('[sqlite-ipc] relaunch after restore failed:', err); }
      }, 300);
      return { ok: true, restoredFrom: source, fromUserVersion: userVersion, userVersion: result.userVersion, relaunching: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  console.log('[sqlite-ipc] IPC handlers registered');
}

// Swap the live database file for `source` and reopen. MUST only be called after the source
// has been validated. Order guarantees safety: (0) read the chosen snapshot into memory FIRST
// so the pre-restore rotation below can never delete the very file we're restoring from (it can,
// when restoring the OLDEST managed snapshot at the retention limit); (1) snapshot the current db
// as 'pre-restore' so this operation is itself reversible; (2) close the handle and remove the
// WAL/SHM sidecars (stale sidecars against a swapped main file would corrupt reads); (3) write the
// buffered bytes over the live path and reopen — reopen runs in a `finally` so a failed write
// never leaves the app with a closed DB. Reassigns the module-level `db`.
function restoreFromFile(source) {
  const dbPath = getDbPath();
  // 0) Buffer the source before anything can rotate/delete it.
  const sourceBytes = fs.readFileSync(source);
  // 1) Safety snapshot of the current data before we overwrite it.
  try {
    dbBackup.snapshotSync(db, {
      dbPath,
      backupsDir: backupsDir(),
      reason: 'pre-restore',
      keep: getBackupSettings().retention,
    });
  } catch (err) {
    console.warn('[sqlite-ipc] Pre-restore snapshot failed (continuing):', err.message);
  }
  // 2) Close and clear sidecars.
  try { db.close(); } catch { /* ignore */ }
  db = null;
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* ignore */ }
  }
  // 3) Overwrite the live file with the buffered snapshot, then reopen. Reopen in `finally` so
  //    that even if the write throws, the app never ends up with a null/closed database handle.
  try {
    fs.writeFileSync(dbPath, sourceBytes);
  } finally {
    openDb(); // reruns migrations / schema init on whatever is now at dbPath
  }
  return { userVersion: Number(db.pragma('user_version', { simple: true }) || 0) };
}

function closeSqliteDb() {
  for (const lease of crmSyncLeases.values()) lease.finish();
  stopRosterEvents?.();
  stopRosterEvents = null;
  if (db) {
    db.close();
    db = null;
    console.log('[sqlite-ipc] Database closed');
  }
}

module.exports = { registerSqliteIpc, closeSqliteDb, openDb, initSchema };
