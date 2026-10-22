// Resolver + link helpers for the unified signal_links table (migration 022).
//
// A "signal" is an email, meeting, or Teams chat. The canonical association model links a
// signal to any target entity in the app (account, milestone, opportunity, workload, action,
// hok_activity) through signal_links. This module is the ONLY place that should encode/decode
// signal ids and route lookups by type, so a Teams id can never be resolved against the email
// table (or vice versa).
//
// Identity rules (must match desktop/migrations/022_signal_links.sql):
//   * signal_id is self-describing / namespaced: '<signal_type>:<native id>'
//       email   -> 'email:'   + emails.message_id
//       meeting -> 'meeting:' + meetings.event_id
//       chat    -> 'chat:'    + teams_chats.chat_id   (chat_id itself contains colons)
//   * a link is identified by the COMPOSITE (signal_type, signal_id, target_type, target_id) --
//     never by signal_id alone.
//
// Fail loud: every function validates its inputs and throws on an unknown type, an empty
// native id, or a malformed signal id rather than silently returning nothing or guessing a
// table. This is deliberate -- a type-less or cross-namespace lookup is a bug, not a fallback.

const { assertActiveSource, assertActiveRecord } = require('../account-roster');

const SIGNAL_TYPES = Object.freeze(['email', 'meeting', 'chat']);
const TARGET_TYPES = Object.freeze([
  'account',
  'milestone',
  'opportunity',
  'workload',
  'action',
  'hok_activity',
]);

// Per-signal-type resolution: which table/columns describe the underlying signal. Keeping this
// as data (not scattered SQL) means adding a source type is a one-line change and the router
// can never send a chat id to the emails table.
const SIGNAL_SOURCES = Object.freeze({
  email: {
    table: 'active_emails',
    idColumn: 'message_id',
    titleColumn: 'subject',
    subtitleColumn: 'from_name',
    dateColumn: 'received_at',
    linkColumn: 'web_link',
  },
  meeting: {
    table: 'active_meetings',
    idColumn: 'event_id',
    titleColumn: 'subject',
    subtitleColumn: 'organizer_name',
    dateColumn: 'start_at',
    linkColumn: 'web_link',
  },
  chat: {
    table: 'active_teams_chats',
    idColumn: 'chat_id',
    titleColumn: 'topic',
    subtitleColumn: 'last_message_from',
    dateColumn: 'last_message_at',
    linkColumn: null, // Teams chats have no stable deep link column in the local cache.
  },
});

function assertSignalType(signalType) {
  if (!SIGNAL_TYPES.includes(signalType)) {
    throw new Error(
      `signal-links: unknown signal_type "${signalType}" (expected one of ${SIGNAL_TYPES.join(', ')})`,
    );
  }
  return signalType;
}

function assertTargetType(targetType) {
  if (!TARGET_TYPES.includes(targetType)) {
    throw new Error(
      `signal-links: unknown target_type "${targetType}" (expected one of ${TARGET_TYPES.join(', ')})`,
    );
  }
  return targetType;
}

// Build the namespaced signal id. nativeId is the source's native primary key (message_id /
// event_id / chat_id). Chat ids legitimately contain colons, so we NEVER re-split on encode.
function encodeSignalId(signalType, nativeId) {
  assertSignalType(signalType);
  const native = nativeId == null ? '' : String(nativeId).trim();
  if (!native) {
    throw new Error(`signal-links: empty native id for signal_type "${signalType}"`);
  }
  return `${signalType}:${native}`;
}

// Split a namespaced signal id into { signalType, nativeId }. Splits on the FIRST colon only,
// because a chat native id (e.g. '19:abc...@thread.tacv2') itself contains colons. Throws on a
// missing prefix or a prefix that is not a known signal type -- a malformed id is a hard error.
function decodeSignalId(signalId) {
  const raw = signalId == null ? '' : String(signalId);
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new Error(`signal-links: malformed signal_id "${signalId}" (expected '<type>:<native id>')`);
  }
  const signalType = raw.slice(0, idx);
  const nativeId = raw.slice(idx + 1);
  assertSignalType(signalType);
  if (!nativeId) {
    throw new Error(`signal-links: signal_id "${signalId}" has an empty native id`);
  }
  return { signalType, nativeId };
}

// Look up the underlying signal row and return a normalized snapshot, routing strictly by
// signal_type. Returns null when the signal is not in the local cache (a legitimately absent
// row -- distinct from a malformed id, which throws). Never queries more than the one table
// that owns the given type.
function resolveSignal(db, signalId) {
  const { signalType, nativeId } = decodeSignalId(signalId);
  const src = SIGNAL_SOURCES[signalType];
  const cols = [
    `${src.idColumn} AS nativeId`,
    `${src.titleColumn} AS title`,
    `${src.subtitleColumn} AS subtitle`,
    `${src.dateColumn} AS date`,
    src.linkColumn ? `${src.linkColumn} AS webLink` : `NULL AS webLink`,
  ].join(', ');
  const row = db
    .prepare(`SELECT ${cols} FROM ${src.table} WHERE ${src.idColumn} = ?`)
    .get(nativeId);
  if (!row) return null;
  return {
    signalId,
    signalType,
    nativeId: String(row.nativeId),
    title: row.title ?? null,
    subtitle: row.subtitle ?? null,
    date: row.date ?? null,
    webLink: row.webLink ?? null,
  };
}

function assertNotArchivedLink(db, where, params) {
  const existing = db.prepare(`SELECT id FROM signal_links WHERE ${where}`).get(...params);
  if (existing) assertActiveRecord(db, 'signals', 'id', existing.id);
}

// Upsert a link. Accepts either a pre-encoded signalId OR a (signalType + nativeId) pair.
// Re-linking the same (signal, target) refreshes the snapshot/source fields instead of
// duplicating (matches the UNIQUE composite in the migration).
function linkSignal(
  db,
  {
    signalId,
    signalType,
    nativeId,
    targetType,
    targetId,
    tpid = null,
    signalTitle = null,
    signalSubtitle = null,
    signalDate = null,
    source = 'manual',
    confidence = null,
    rationale = null,
  } = {},
) {
  const encoded = signalId ? signalId : encodeSignalId(signalType, nativeId);
  const { signalType: type, nativeId: native } = decodeSignalId(encoded); // validates prefix + type
  assertTargetType(targetType);
  const target = targetId == null ? '' : String(targetId).trim();
  if (!target) {
    throw new Error(`signal-links: empty target_id for target_type "${targetType}"`);
  }
  assertActiveSource(db, type, native);
  assertNotArchivedLink(db, 'signal_type=? AND signal_id=? AND target_type=? AND target_id=?', [type, encoded, targetType, target]);
  const info = db
    .prepare(
      `INSERT INTO signal_links
         (signal_type, signal_id, target_type, target_id, tpid,
          signal_title, signal_subtitle, signal_date, source, confidence, rationale,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(signal_type, signal_id, target_type, target_id) DO UPDATE SET
         tpid            = COALESCE(excluded.tpid, signal_links.tpid),
         signal_title    = COALESCE(excluded.signal_title, signal_links.signal_title),
         signal_subtitle = COALESCE(excluded.signal_subtitle, signal_links.signal_subtitle),
         signal_date     = COALESCE(excluded.signal_date, signal_links.signal_date),
         source          = excluded.source,
         confidence      = COALESCE(excluded.confidence, signal_links.confidence),
         rationale       = COALESCE(excluded.rationale, signal_links.rationale),
         updated_at      = CURRENT_TIMESTAMP`,
    )
    .run(
      type,
      encoded,
      targetType,
      target,
      tpid,
      signalTitle,
      signalSubtitle,
      signalDate,
      source,
      confidence,
      rationale,
    );
  return { signalId: encoded, signalType: type, targetType, targetId: target, changes: info.changes };
}

// Remove one specific (signal, target) link. Returns the number of rows deleted.
function unlinkSignal(db, { signalId, signalType, nativeId, targetType, targetId } = {}) {
  const encoded = signalId ? signalId : encodeSignalId(signalType, nativeId);
  const { signalType: type } = decodeSignalId(encoded);
  assertTargetType(targetType);
  const target = targetId == null ? '' : String(targetId).trim();
  if (!target) {
    throw new Error(`signal-links: empty target_id for target_type "${targetType}"`);
  }
  assertNotArchivedLink(db, 'signal_type=? AND signal_id=? AND target_type=? AND target_id=?', [type, encoded, targetType, target]);
  const info = db
    .prepare(
      `DELETE FROM signal_links
        WHERE signal_type = ? AND signal_id = ? AND target_type = ? AND target_id = ?`,
    )
    .run(type, encoded, targetType, target);
  return info.changes;
}

// All signals linked to one target entity, newest first.
function listSignalsForTarget(db, targetType, targetId) {
  assertTargetType(targetType);
  const target = targetId == null ? '' : String(targetId).trim();
  if (!target) {
    throw new Error(`signal-links: empty target_id for target_type "${targetType}"`);
  }
  return db
    .prepare(
      `SELECT id, signal_type, signal_id, target_type, target_id, tpid,
              signal_title, signal_subtitle, signal_date, source, confidence, rationale,
              created_at, updated_at
         FROM active_signal_links
        WHERE target_type = ? AND target_id = ?
        ORDER BY COALESCE(signal_date, created_at) DESC, id DESC`,
    )
    .all(targetType, target);
}

// All targets a given signal is linked to.
function listTargetsForSignal(db, signalId) {
  const { signalType } = decodeSignalId(signalId); // validate
  return db
    .prepare(
      `SELECT id, signal_type, signal_id, target_type, target_id, tpid,
              signal_title, signal_subtitle, signal_date, source, confidence, rationale,
              created_at, updated_at
         FROM active_signal_links
        WHERE signal_type = ? AND signal_id = ?
        ORDER BY target_type ASC, id ASC`,
    )
    .all(signalType, signalId);
}

// ---------------------------------------------------------------------------
// Milestone "Related signal" — native canonical read/write (migration 024).
//
// The milestone finder used to write a per-message legacy table
// (milestone_signal_links) which a reconcile engine mirrored into signal_links.
// As of migration 024 that table is gone: the finder reads AND writes
// signal_links directly (target_type='milestone'), exactly like the workload
// panel. There is no reconcile, no SE_SIGNAL_LINKS_READ flag and no legacy
// reader any more.
//
// CHAT GRAIN (stated, not hidden): a chat signal is ONE row per THREAD
// (signal_id='chat:'<chat_id>), not one per message. The old per-message
// "N messages" roll-up is therefore gone (count is always 1) -- this was
// already the behavior in canonical read mode before the table was dropped.
// ---------------------------------------------------------------------------

// Add one milestone<->signal link (idempotent, additive). Mirrors migration
// 022's Backfill #1 identity + snapshot columns: chat is keyed by chat_id
// (falling back to refId), email/meeting by their native id, source defaults to
// 'ai'. INSERT OR IGNORE dedupes on UNIQUE(signal_type, signal_id, target_type,
// target_id), so a re-run of the finder never duplicates or clobbers a prior
// pick. Fails loud on an unknown kind or empty native id (via encodeSignalId).
// Returns { changes, signalId }.
function addMilestoneSignal(
  db,
  {
    milestoneId,
    kind,
    refId,
    chatId = null,
    title = null,
    subtitle = null,
    itemDate = null,
    reason = null,
    source = 'ai',
    tpid = null,
  } = {},
) {
  const mid = String(milestoneId == null ? '' : milestoneId).trim();
  if (!mid) throw new Error('signal-links: milestoneId is required to add a milestone signal');
  // Canonical native id: chat -> chat_id (thread grain), else the source's native id.
  const nativeId = kind === 'chat'
    ? (String(chatId == null ? '' : chatId).trim() || String(refId == null ? '' : refId).trim())
    : String(refId == null ? '' : refId).trim();
  const encoded = encodeSignalId(kind, nativeId); // validates kind + non-empty native id
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO signal_links
         (signal_type, signal_id, target_type, target_id, tpid,
          signal_title, signal_subtitle, signal_date, source, rationale,
          created_at, updated_at)
       VALUES (?, ?, 'milestone', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(kind, encoded, mid, tpid, title, subtitle, itemDate, source || 'ai', reason);
  return { changes: info.changes || 0, signalId: encoded };
}

// Canonical reader for the milestone "Related signal" card. Reads signal_links
// (target_type='milestone') and returns the row shape the renderer expects:
// { id, kind, ref_id, chat_id, title, subtitle, item_date, reason, source,
//   created_at, count, groupIds, deleteKey }. One row per chat THREAD, so count
// is always 1 and groupIds carries just this row's id (a stable React key).
// deleteKey { kind, nativeId } is the natural delete handle (the card no longer
// knows any legacy row id). Does NOT swallow a missing-table error: an absent
// signal_links means the migration never ran, and returning [] would hide links.
function readMilestoneSignals(db, milestoneId) {
  const mid = String(milestoneId == null ? '' : milestoneId).trim();
  if (!mid) throw new Error('signal-links: milestoneId is required');
  const rows = db
    .prepare(
      `SELECT id, signal_type, signal_id, signal_title, signal_subtitle,
              signal_date, source, rationale, created_at
         FROM active_signal_links
        WHERE target_type = 'milestone' AND target_id = ?
        ORDER BY signal_type, (signal_date IS NULL), signal_date DESC, id DESC`,
    )
    .all(mid);
  return rows.map((r) => {
    const { signalType, nativeId } = decodeSignalId(r.signal_id);
    const kind = signalType;
    return {
      id: r.id,
      kind,
      ref_id: nativeId,
      chat_id: kind === 'chat' ? nativeId : null,
      title: r.signal_title ?? null,
      subtitle: r.signal_subtitle ?? null,
      item_date: r.signal_date ?? null,
      reason: r.rationale ?? null,
      source: r.source ?? null,
      created_at: r.created_at ?? null,
      count: 1, // one canonical row per thread; the legacy "N messages" roll-up is gone
      groupIds: [r.id], // stable React key only — deletes go through deleteKey
      deleteKey: { kind, nativeId },
    };
  });
}

// Self-heal: drop AI-sourced milestone links whose underlying signal the customer-
// link verifier has REJECTED for this account (match_method='ai-rejected') and that
// has no accepted link. Ported to signal_links from the legacy per-source prune: for
// each kind we compare the row's native id (embedded in signal_id as '<kind>:<id>')
// against the rejected / accepted native ids in that source's *_customer_links table.
// Manual links (source <> 'ai') and legitimately-linked items are never touched.
// Best-effort per kind: a missing *_customer_links table (older/org build) is skipped,
// not fatal. Returns the number of links removed.
function pruneRejectedMilestoneSignals(db, milestoneId, tpid) {
  const mid = String(milestoneId == null ? '' : milestoneId).trim();
  if (!mid || !tpid) return 0;
  let removed = 0;
  const kinds = [
    { kind: 'email', table: 'email_customer_links', key: 'message_id' },
    { kind: 'meeting', table: 'meeting_customer_links', key: 'event_id' },
    { kind: 'chat', table: 'teams_chat_customer_links', key: 'chat_id' },
  ];
  for (const k of kinds) {
    try {
      const res = db
        .prepare(
          `DELETE FROM signal_links
            WHERE target_type = 'milestone' AND target_id = ? AND source = 'ai'
              AND id IN (SELECT id FROM active_signal_links)
              AND signal_type = ?
              AND signal_id IN (
                SELECT ? || ':' || ${k.key} FROM ${k.table}
                 WHERE tpid = ? AND match_method = 'ai-rejected')
              AND signal_id NOT IN (
                SELECT ? || ':' || ${k.key} FROM ${k.table}
                 WHERE tpid = ? AND match_method <> 'ai-rejected')`,
        )
        .run(mid, k.kind, k.kind, tpid, k.kind, tpid);
      removed += res.changes || 0;
    } catch { /* source link table absent on older/org builds */ }
  }
  return removed;
}

// Self-heal: collapse logical-duplicate email links. ref_id is the Outlook item id,
// which differs between folder-copies of one physical email, so the same email linked
// from two folders slips past the UNIQUE guard and shows twice. For each
// milestone+internet_message_id keep the earliest link, drop the rest. Only touches
// emails carrying an internet_message_id, so genuinely distinct messages are never
// merged. Best-effort: emails table absent (older/org build) -> nothing to collapse.
// Returns the number of links removed.
function dedupeMilestoneEmailSignals(db, milestoneId) {
  const mid = String(milestoneId == null ? '' : milestoneId).trim();
  if (!mid) return 0;
  try {
    const res = db
      .prepare(
        `DELETE FROM signal_links
          WHERE id IN (
            SELECT s.id
              FROM active_signal_links s
              JOIN active_emails e ON s.signal_id = 'email:' || e.message_id
             WHERE s.target_type = 'milestone' AND s.target_id = ? AND s.signal_type = 'email'
               AND e.internet_message_id IS NOT NULL AND e.internet_message_id <> ''
               AND s.id NOT IN (
                 SELECT MIN(s2.id)
                   FROM active_signal_links s2
                   JOIN active_emails e2 ON s2.signal_id = 'email:' || e2.message_id
                  WHERE s2.target_type = 'milestone' AND s2.target_id = s.target_id
                    AND s2.signal_type = 'email'
                    AND e2.internet_message_id = e.internet_message_id))`,
      )
      .run(mid);
    return res.changes || 0;
  } catch {
    return 0; // emails table absent (older/org build) — nothing to collapse
  }
}

// Delete milestone<->signal link(s) by NATURAL key (the only delete path). The card
// carries { kind, nativeId }; for a chat the nativeId is the thread's chat_id, so one
// key removes the whole thread's single canonical row. Fails loud on a bad key (via
// encodeSignalId). Returns the number of rows removed.
function removeMilestoneSignalsByKeys(db, milestoneId, keys) {
  const mid = String(milestoneId == null ? '' : milestoneId).trim();
  if (!mid) throw new Error('signal-links: milestoneId is required to delete by key');
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('signal-links: at least one delete key is required');
  }
  const del = db.prepare(
    `DELETE FROM signal_links WHERE target_type = 'milestone' AND target_id = ? AND signal_id = ?`,
  );
  let removed = 0;
  for (const k of keys) {
    const encoded = encodeSignalId(String(k?.kind == null ? '' : k.kind).trim(), k?.nativeId);
    removed += del.run(mid, encoded).changes || 0;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Workload comms-assignments — native canonical read/write (migration 023).
//
// The workload "Communication assignments" panel used to write work_item_signal_links
// and read it back. That table is gone; the panel now works directly on signal_links
// with target_type='workload'. A single assignment is ONE row: signal -> workload,
// carrying an OPTIONAL milestone/opportunity annotation in the qualifier columns
// (which milestone this comms item supports). Re-tagging the milestone updates the
// qualifier in place rather than creating a second row -- there is exactly one link
// per (signal, workload), enforced by the table's UNIQUE composite. These are
// authoritative native rows (there is no reconcile engine any more).
// ---------------------------------------------------------------------------

// List a workload's assigned comms, newest first, in the shape the renderer expects.
// Mirrors the columns the old work_item_signal_links reader returned so the UI needs
// no change: { id, signal_type, signal_id (NATIVE id), signal_title, signal_date,
// assignment_source, rationale, milestone_id, opportunity_id }. Does NOT swallow a
// missing-table error — an absent signal_links means the migration never ran.
function listWorkloadSignals(db, workloadId) {
  const wid = String(workloadId == null ? '' : workloadId).trim();
  if (!wid) throw new Error('signal-links: workloadId is required');
  const rows = db
    .prepare(
      `SELECT id, signal_type, signal_id, signal_title, signal_date, source,
              rationale, qualifier_milestone_id, qualifier_opportunity_id
         FROM active_signal_links
        WHERE target_type = 'workload' AND target_id = ?
        ORDER BY (signal_date IS NULL), signal_date DESC, id DESC`,
    )
    .all(wid);
  return rows.map((r) => {
    const { nativeId } = decodeSignalId(r.signal_id);
    return {
      id: r.id,
      signal_type: r.signal_type,
      signal_id: nativeId, // native id, matching the legacy reader's grain for display
      signal_title: r.signal_title ?? null,
      signal_date: r.signal_date ?? null,
      assignment_source: r.source ?? null,
      rationale: r.rationale ?? null,
      milestone_id: r.qualifier_milestone_id ?? null,
      opportunity_id: r.qualifier_opportunity_id ?? null,
    };
  });
}

// Assign a comms signal to a workload (idempotent). Encodes the native id, writes the
// optional milestone/opportunity annotation, and dedups on the (signal, workload)
// UNIQUE composite -- a repeat assign is a no-op (changes:0), never a duplicate row.
// Re-tagging an existing assignment's milestone is done via updateWorkloadSignalMilestone,
// NOT by re-assigning, so this deliberately does not overwrite the qualifier on conflict.
// Returns { changes, signalId }.
function addWorkloadSignal(
  db,
  {
    workloadId,
    signalType,
    nativeId,
    signalTitle = null,
    signalDate = null,
    tpid = null,
    milestoneId = null,
    opportunityId = null,
    source = 'manual',
    rationale = null,
  } = {},
) {
  const wid = String(workloadId == null ? '' : workloadId).trim();
  if (!wid) throw new Error('signal-links: workloadId is required to assign a signal');
  const encoded = encodeSignalId(signalType, nativeId); // validates type + native id
  assertActiveSource(db, signalType, decodeSignalId(encoded).nativeId);
  assertNotArchivedLink(db, "signal_type=? AND signal_id=? AND target_type='workload' AND target_id=?", [signalType, encoded, wid]);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO signal_links
         (signal_type, signal_id, target_type, target_id, tpid,
          signal_title, signal_date, source, rationale,
          qualifier_milestone_id, qualifier_opportunity_id,
          created_at, updated_at)
       VALUES (?, ?, 'workload', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(
      signalType,
      encoded,
      wid,
      tpid,
      signalTitle,
      signalDate,
      source || 'manual',
      rationale,
      milestoneId ? String(milestoneId) : null,
      opportunityId ? String(opportunityId) : null,
    );
  return { changes: info.changes || 0, signalId: encoded };
}

// Re-tag an existing workload assignment's milestone/opportunity annotation (the
// per-card dropdown). Identified by the signal_links row id and scoped to workload
// rows so a wrong id can't rewrite a milestone/account link. Returns { changes }.
function updateWorkloadSignalMilestone(db, { id, milestoneId = null, opportunityId = null } = {}) {
  const rowId = String(id == null ? '' : id).trim();
  if (!rowId) throw new Error('signal-links: assignment id is required');
  assertNotArchivedLink(db, "id=? AND target_type='workload'", [rowId]);
  const info = db
    .prepare(
      `UPDATE signal_links
          SET qualifier_milestone_id = ?, qualifier_opportunity_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND target_type = 'workload'`,
    )
    .run(
      milestoneId ? String(milestoneId) : null,
      opportunityId ? String(opportunityId) : null,
      rowId,
    );
  return { changes: info.changes || 0 };
}

// Remove one workload assignment by signal_links row id (scoped to workload rows).
// Deleting it does NOT suppress the signal from being re-assigned later. Returns { changes }.
function removeWorkloadSignal(db, { id } = {}) {
  const rowId = String(id == null ? '' : id).trim();
  if (!rowId) throw new Error('signal-links: assignment id is required to remove');
  assertNotArchivedLink(db, "id=? AND target_type='workload'", [rowId]);
  const info = db
    .prepare(`DELETE FROM signal_links WHERE id = ? AND target_type = 'workload'`)
    .run(rowId);
  return { changes: info.changes || 0 };
}

module.exports = {
  SIGNAL_TYPES,
  TARGET_TYPES,
  SIGNAL_SOURCES,
  encodeSignalId,
  decodeSignalId,
  resolveSignal,
  linkSignal,
  unlinkSignal,
  listSignalsForTarget,
  listTargetsForSignal,
  // Milestone "Related signal" (native canonical read/write, migration 024).
  addMilestoneSignal,
  readMilestoneSignals,
  pruneRejectedMilestoneSignals,
  dedupeMilestoneEmailSignals,
  removeMilestoneSignalsByKeys,
  // Workload comms-assignments (native canonical, migration 023).
  listWorkloadSignals,
  addWorkloadSignal,
  updateWorkloadSignalMilestone,
  removeWorkloadSignal,
};
