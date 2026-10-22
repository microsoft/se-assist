/**
 * account-roster.js — the effective customer/TPID roster the app operates on.
 *
 * tpid_config is the authoritative active portfolio. Removing a TPID archives its
 * existing data in place; re-adding it makes that same history active again.
 */
const { EventEmitter } = require('node:events');
const changes = new EventEmitter();
const activeWork = new Set();
const guardedDatabases = new WeakMap();

// TPIDs are numeric account identifiers. Accept digit strings only; dedupe; cap the count.
const MAX_ROSTER_SIZE = 500;

function normalizeTpids(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || "").split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tpid = String(raw == null ? "" : raw).trim();
    if (!tpid) continue;
    if (!/^\d{1,20}$/.test(tpid)) throw new Error(`Invalid TPID "${tpid}". Use numeric account identifiers only.`);
    if (seen.has(tpid)) continue;
    seen.add(tpid);
    out.push(tpid);
    if (out.length > MAX_ROSTER_SIZE) throw new Error(`The active roster supports at most ${MAX_ROSTER_SIZE} accounts.`);
  }
  return out;
}

function getEffectiveTpids(db) {
  return normalizeTpids(db.prepare("SELECT tpid FROM tpid_config ORDER BY tpid").all().map((r) => r.tpid));
}

// True when the user has saved a custom roster (tpid_config has rows).
function hasCustomRoster(db) {
  return getEffectiveTpids(db).length > 0;
}

function saveRoster(db, input) {
  if (!Array.isArray(input) && typeof input !== 'string') throw new Error('Supply a TPID list. Use an explicit empty list to archive all accounts.');
  const tpids = normalizeTpids(input);
  const before = getEffectiveTpids(db);
  if (JSON.stringify([...tpids].sort()) === JSON.stringify(before)) return before;
  if (activeWork.size) {
    const error = new Error('Account work is still running. Wait for sync, ingestion, or AI work to finish before changing the active roster.');
    error.code = 'ROSTER_BUSY';
    throw error;
  }
  const replace = db.transaction((list) => {
    db.prepare("DELETE FROM tpid_config").run();
    const insert = db.prepare("INSERT OR IGNORE INTO tpid_config (tpid) VALUES (?)");
    for (const tpid of list) insert.run(tpid);
  });
  replace(tpids);
  const effective = getEffectiveTpids(db);
  if (JSON.stringify(before) !== JSON.stringify(effective)) {
    changes.emit('changed', { tpids: effective, isCustom: effective.length > 0 });
  }
  return effective;
}

function assertActiveTpids(db, input) {
  const tpids = normalizeTpids(input);
  const active = new Set(getEffectiveTpids(db));
  if (!tpids.length) {
    const error = new Error('No active accounts. Save your TPIDs in User Home before running account work.');
    error.code = 'NO_ROSTER';
    throw error;
  }
  const archived = tpids.filter((tpid) => !active.has(tpid));
  if (archived.length) {
    const error = new Error(`Account ${archived.join(', ')} is archived. Re-add it to the saved accounts in User Home before opening or working on it.`);
    error.code = 'ACCOUNT_ARCHIVED';
    throw error;
  }
  return tpids;
}

function assertActiveTpid(db, tpid) {
  return assertActiveTpids(db, [tpid])[0];
}

function assertActiveRecord(db, table, column, id) {
  const sources = {
    profiles: ['active_cached_customer_profiles', 'id'],
    workloads: ['active_workloads', 'id'],
    opportunities: ['active_opportunities', 'opportunity_id'],
    milestones: ['active_milestones', 'milestone_id'],
    meetings: ['active_meetings', 'event_id'],
    signals: ['active_signal_links', 'id'],
  };
  const source = sources[table];
  if (!source || source[1] !== column) throw new Error('Invalid active-account lookup.');
  const row = db.prepare(`SELECT * FROM ${source[0]} WHERE ${column} = ?${table === 'profiles' ? ' AND deleted_at IS NULL' : ''}`).get(id);
  if (!row) {
    const error = new Error('This record is unavailable or belongs to an archived account. Re-add its TPID in User Home to restore access.');
    error.code = 'ACCOUNT_ARCHIVED';
    throw error;
  }
  return row;
}

// Temporary guards protect renderer writes without changing archive data or
// preventing trusted migrations, ingestion, and explicit recovery operations.
function runActiveWrite(db, sql, params) {
  if (!guardedDatabases.has(db)) {
    db.exec(`CREATE TEMP TABLE roster_write_context(enabled INTEGER NOT NULL); INSERT INTO roster_write_context VALUES(0);
      CREATE TEMP TABLE roster_delete_allowed(view_name TEXT, row_key TEXT, PRIMARY KEY(view_name,row_key))`);
    const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name GLOB 'active_*'").all();
    const snapshots = [];
    for (const { name } of views) {
      if (!/^active_[a-z_]+$/.test(name)) throw new Error('Invalid active-roster view.');
      const table = name.slice('active_'.length);
      const keys = db.prepare(`PRAGMA table_info("${table}")`).all().filter(column => column.pk);
      if (!keys.length) throw new Error(`Cannot protect account writes: ${table} has no primary key.`);
      const key = prefix => `json_array(${keys.map(column => `${prefix}."${column.name}"`).join(',')})`;
      snapshots.push(db.prepare(`INSERT INTO roster_delete_allowed SELECT '${name}', ${key('a')} FROM "${name}" a`));
      const existing = keys.map(column => `a."${column.name}" IS NEW."${column.name}"`).join(' AND ');
      db.exec(`CREATE TEMP TRIGGER "roster_guard_${table}_INSERT_BEFORE" BEFORE INSERT ON main."${table}"
        WHEN (SELECT enabled FROM roster_write_context)=1
          AND EXISTS(SELECT 1 FROM main."${table}" a WHERE ${existing})
          AND NOT EXISTS(SELECT 1 FROM "${name}" a WHERE ${existing})
        BEGIN SELECT RAISE(ABORT,'This account is archived. Re-add its TPID in User Home before changing its data.'); END`);
      for (const [event, timing, row] of [['INSERT', 'AFTER', 'NEW'], ['UPDATE', 'BEFORE', 'OLD'], ['UPDATE', 'AFTER', 'NEW'], ['DELETE', 'BEFORE', 'OLD']]) {
        const match = keys.map(column => `a."${column.name}" IS ${row}."${column.name}"`).join(' AND ');
        const cascade = event === 'DELETE'
          ? `AND NOT EXISTS(SELECT 1 FROM roster_delete_allowed WHERE view_name='${name}' AND row_key=${key(row)})`
          : '';
        db.exec(
          `CREATE TEMP TRIGGER "roster_guard_${table}_${event}_${timing}" ${timing} ${event} ON main."${table}"
           WHEN (SELECT enabled FROM roster_write_context)=1 AND NOT EXISTS(SELECT 1 FROM "${name}" a WHERE ${match}) ${cascade}
           BEGIN SELECT RAISE(ABORT,'This account is archived. Re-add its TPID in User Home before changing its data.'); END`,
        );
      }
    }
    guardedDatabases.set(db, snapshots);
  }
  // Cascades run after the parent leaves its active view. Capture eligibility
  // before destructive statements, not on the much more frequent CRM upserts.
  if (/\b(?:DELETE|REPLACE)\b/i.test(sql)) {
    db.transaction(() => {
      for (const snapshot of guardedDatabases.get(db)) snapshot.run();
    })();
  }
  db.exec('UPDATE roster_write_context SET enabled=1');
  try {
    return db.prepare(sql).run(...params);
  } finally {
    db.exec('UPDATE roster_write_context SET enabled=0; DELETE FROM roster_delete_allowed');
  }
}

function onRosterChanged(listener) {
  changes.on('changed', listener);
  return () => changes.off('changed', listener);
}

function beginRosterWork(label) {
  const token = { label };
  activeWork.add(token);
  return () => activeWork.delete(token);
}

function withRosterWork(label, work) {
  const release = beginRosterWork(label);
  try {
    const result = work();
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

function assertActiveSource(db, medium, id) {
  const sources = { email: ['emails', 'message_id'], meeting: ['meetings', 'event_id'], chat: ['teams_chats', 'chat_id'] };
  const source = sources[medium];
  if (!source) throw new Error('Invalid communication medium.');
  const [table, column] = source;
  if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(id)
    && !db.prepare(`SELECT 1 FROM active_${table} WHERE ${column} = ?`).get(id)) {
    const error = new Error('This communication belongs only to archived accounts. Re-add its account in User Home before working on it.');
    error.code = 'ACCOUNT_ARCHIVED';
    throw error;
  }
}

function createAccountScope(db) {
  const active = new Set(getEffectiveTpids(db));
  const rows = db.prepare(
    `SELECT tpid, name AS term FROM customers
     UNION SELECT tpid, alias AS term FROM teams_customer_aliases WHERE is_active = 1
     UNION SELECT tpid, email AS term FROM customer_contacts WHERE email IS NOT NULL`,
  ).all();
  const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const terms = rows.map((row) => ({ tpid: String(row.tpid), term: normalize(row.term) })).filter((row) => row.term.length >= 3);
  const media = { email: ['email_customer_links', 'message_id'], meeting: ['meeting_customer_links', 'event_id'], chat: ['teams_chat_customer_links', 'chat_id'] };
  return {
    isArchivedText(value) {
      const text = ` ${normalize(value)} `;
      let archived = false;
      for (const row of terms) {
        if (!text.includes(` ${row.term} `)) continue;
        if (active.has(row.tpid)) return false;
        archived = true;
      }
      return archived;
    },
    assertText(value) {
      if (this.isArchivedText(value)) {
        const error = new Error('This account is archived. Re-add its TPID in User Home before requesting new work or source pulls.');
        error.code = 'ACCOUNT_ARCHIVED';
        throw error;
      }
    },
    accepts(medium, id, value) {
      try { assertActiveSource(db, medium, id); }
      catch (error) {
        if (error.code === 'ACCOUNT_ARCHIVED') return false;
        throw error;
      }
      const source = media[medium];
      const activeLink = db.prepare(`SELECT 1 FROM active_${source[0]} WHERE ${source[1]}=? AND match_method <> 'ai-rejected'
        UNION ALL SELECT 1 FROM active_signal_links WHERE signal_type=? AND signal_id=? LIMIT 1`).get(id, medium, `${medium}:${id}`);
      return Boolean(activeLink) || !this.isArchivedText(value);
    },
  };
}

function assertActiveAccountTask(db, task) {
  if (!task || typeof task !== 'object') return;
  if (task.tpid) assertActiveTpid(db, task.tpid);
  if (task.profileId) assertActiveRecord(db, 'profiles', 'id', task.profileId);
  if (task.workloadId) assertActiveRecord(db, 'workloads', 'id', task.workloadId);
  if (task.sourceMessageId) assertActiveSource(db, 'email', task.sourceMessageId);
  if (task.account && createAccountScope(db).isArchivedText(task.account)) {
    const error = new Error('This account is archived. Re-add its TPID in User Home to restore its saved outputs and resume work.');
    error.code = 'ACCOUNT_ARCHIVED';
    throw error;
  }
}

module.exports = {
  DEFAULT_TPIDS: [],
  getEffectiveTpids,
  hasCustomRoster,
  saveRoster,
  normalizeTpids,
  assertActiveTpid,
  assertActiveTpids,
  assertActiveRecord,
  onRosterChanged,
  beginRosterWork,
  withRosterWork,
  assertActiveSource,
  createAccountScope,
  runActiveWrite,
  assertActiveAccountTask,
};
