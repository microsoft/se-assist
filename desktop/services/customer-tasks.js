'use strict';

const crypto = require('node:crypto');
const { rowToTodo } = require('./row-mappers');

const TASK_SELECT = `
  SELECT t.*, p.tpid AS customer_tpid, p.display_name AS customer_name,
         COALESCE(NULLIF(TRIM(w.title), ''), w.name) AS workload_name
  FROM active_cached_customer_todos t
  LEFT JOIN active_cached_customer_profiles p ON p.id = t.profile_id
  LEFT JOIN active_workloads w ON w.id = t.workload_id`;

function getTask(database, id) {
  const row = database.prepare(`${TASK_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
  if (!row) throw new Error('Task not found. It may have been deleted.');
  return rowToTodo(row);
}

function listTasks(database, scope) {
  const column = Object.hasOwn(scope, 'meetingEventId') ? 'meeting_event_id'
    : Object.hasOwn(scope, 'workloadId') ? 'workload_id'
      : Object.hasOwn(scope, 'profileId') ? 'profile_id' : null;
  if (!column) throw new Error('A customer, meeting, or workload is required to list Tasks.');
  const value = column === 'meeting_event_id' ? scope.meetingEventId
    : column === 'workload_id' ? scope.workloadId : scope.profileId;
  return database.prepare(
    `${TASK_SELECT} WHERE t.${column} IS ? AND t.deleted_at IS NULL
     ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.due_at, t.updated_at DESC, t.id`,
  ).all(value).map(rowToTodo);
}

function getAssignmentOptions(database) {
  const customers = database.prepare(`
    SELECT p.id, p.tpid,
           COALESCE(NULLIF(p.display_name, 'TPID ' || p.tpid),
             (SELECT c.name FROM active_customers c WHERE c.tpid = p.tpid
              ORDER BY CASE WHEN c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '' THEN 0 ELSE 1 END, c.name LIMIT 1),
             p.display_name) AS display_name
    FROM active_cached_customer_profiles p WHERE p.deleted_at IS NULL
    ORDER BY display_name, p.tpid, p.id`).all().map(row => ({
    id: row.id, tpid: row.tpid, displayName: row.display_name,
  }));
  const workloads = database.prepare(`
    SELECT id, COALESCE(NULLIF(TRIM(title), ''), name) AS title,
           COALESCE(NULLIF(account_name, ''), customer_name) AS account_name, status
    FROM active_workloads
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'delivered' THEN 1 ELSE 2 END, title, id
  `).all().map(row => ({
    id: row.id, title: row.title, accountName: row.account_name, status: row.status,
  }));
  return { ok: true, customers, workloads };
}

function saveTask(database, payload = {}, origin = {}) {
  const existing = payload.id ? database.prepare('SELECT * FROM active_cached_customer_todos WHERE id = ?').get(payload.id) : null;
  if (payload.id && (!existing || existing.deleted_at)) throw new Error('Task not found. It may have been deleted.');
  const value = (key, column, defaultValue) => Object.hasOwn(payload, key)
    ? payload[key] : existing ? existing[column] : defaultValue;
  const title = String(value('title', 'title', '') || '').trim();
  if (!title) throw new Error('Task title is required.');
  const profileId = String(value('profileId', 'profile_id', null) || '').trim() || null;
  if (profileId && !database.prepare('SELECT 1 FROM active_cached_customer_profiles WHERE id = ? AND deleted_at IS NULL').get(profileId)) {
    throw new Error('The selected customer no longer exists. Choose a customer or Unselected.');
  }
  const workloadValue = value('workloadId', 'workload_id', null);
  const workloadId = workloadValue == null || workloadValue === '' ? null : Number(workloadValue);
  if (workloadId !== null && (!Number.isSafeInteger(workloadId) || workloadId <= 0
    || !database.prepare('SELECT 1 FROM active_workloads WHERE id = ?').get(workloadId))) {
    throw new Error('The selected workload no longer exists. Choose a workload or None.');
  }
  const id = existing?.id || crypto.randomUUID();
  const status = String(value('status', 'status', 'open') || '');
  if (!['open', 'in_progress', 'blocked', 'done', 'cancelled'].includes(status)) throw new Error('Invalid Task status.');
  const description = String(value('description', 'description', '') || '');
  const dueAt = value('dueAt', 'due_at', null) || null;
  const sourceRef = value('sourceRef', 'source_ref', null) || null;
  const updatedAt = new Date().toISOString();
  if (existing) {
    database.prepare(`
      UPDATE cached_customer_todos
      SET profile_id = ?, workload_id = ?, title = ?, description = ?, status = ?, due_at = ?,
          source_ref = ?, version = version + 1, updated_at = ?, synced_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL
    `).run(profileId, workloadId, title, description, status, dueAt, sourceRef, updatedAt, id);
  } else {
    database.prepare(`
      INSERT INTO cached_customer_todos
        (id, profile_id, workload_id, title, description, status, due_at, source_ref,
         meeting_event_id, meeting_action_key, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, profileId, workloadId, title, description, status, dueAt, sourceRef,
      origin.meetingEventId || null, origin.meetingActionKey || null, updatedAt);
  }
  return getTask(database, id);
}

function deleteTask(database, payload = {}) {
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('Task id is required.');
  const task = getTask(database, id);
  if (Object.hasOwn(payload, 'profileId') && (payload.profileId || null) !== task.profileId) {
    throw new Error('The Task customer has changed. Refresh before deleting it.');
  }
  const updatedAt = new Date().toISOString();
  database.prepare(`
    UPDATE cached_customer_todos
    SET deleted_at = ?, updated_at = ?, version = version + 1, synced_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).run(updatedAt, updatedAt, id);
  return task;
}

module.exports = { getTask, listTasks, getAssignmentOptions, saveTask, deleteTask };
