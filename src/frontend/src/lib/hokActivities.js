import { dbQuery, dbRun, crmRequest, ensureAuth, getMsxTpids, withCrmSync } from '../electronBridge';
import { mapWithConcurrency, chunkArray, MAX_CONCURRENT_REQUESTS } from './concurrency';
import { parseTeamList, normId } from './milestoneMetrics';

// Re-exported for existing importers; the single definition lives in ./milestoneMetrics.
export { normId };

// Fields the HoK Activities tab needs to render each task row. Includes the owner so the
// stored cache can reproduce the "mine vs full territory" views without a live call.
export const OWNED_TASK_SELECT =
  'activityid,subject,createdon,scheduledend,actualend,statecode,statuscode,msp_taskcategory,_regardingobjectid_value';

// Same fields plus the owner — used when syncing tasks into the local cache.
const HOK_SYNC_SELECT = `${OWNED_TASK_SELECT},_ownerid_value`;

const REGARDING_TYPE_KEY = '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname';
const OWNER_NAME_KEY = '_ownerid_value@OData.Community.Display.V1.FormattedValue';
const CATEGORY_LABEL_KEY = 'msp_taskcategory@OData.Community.Display.V1.FormattedValue';
const STATE_LABEL_KEY = 'statecode@OData.Community.Display.V1.FormattedValue';
const REGARDING_NAME_KEY = '_regardingobjectid_value@OData.Community.Display.V1.FormattedValue';

// statecode → label (MSX task state). Used to rebuild the status label from the cache.
const STATE_LABELS = { 0: 'Open', 1: 'Completed', 2: 'Canceled' };

// Resolve the signed-in MSX user's GUID: prefer the cached value in app_settings,
// otherwise fall back to a live WhoAmI (and cache the result).
export async function resolveCurrentUserId() {
  const rows = await dbQuery(
    "SELECT value FROM app_settings WHERE key = 'current_user_id'"
  );
  const stored = rows?.[0]?.value;
  if (stored) return stored;
  await ensureAuth();
  const who = await crmRequest({ path: '/api/data/v9.2/WhoAmI', method: 'GET' });
  if (!who?.ok) {
    throw new Error('Could not determine current user. Sign in via the Milestone Map tab first.');
  }
  const uid = String(who.data.UserId).replace(/[{}]/g, '');
  await dbRun(
    `INSERT INTO app_settings (key, value) VALUES ('current_user_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`,
    [uid, uid]
  );
  return uid;
}

// Owned tasks regarding active accounts, opportunities, or milestones only.
export async function fetchOwnedTasks(uid, { top = null, select = OWNED_TASK_SELECT } = {}) {
  const ids = await activeRegardingIds();
  if (!ids.length) return [];
  const tasks = await fetchTasksRegarding(ids, { select: select.includes('_ownerid_value') ? select : `${select},_ownerid_value` });
  const owned = tasks.filter((task) => normId(task._ownerid_value) === normId(uid));
  return top == null ? owned : owned.slice(0, top);
}

async function activeRegardingIds() {
  const tpids = await getMsxTpids();
  if (!tpids.length) throw new Error('No active accounts. Save your roster in User Home before syncing activities.');
  const rows = await dbQuery(
    `SELECT milestone_id AS id FROM active_milestones WHERE milestone_id IS NOT NULL
     UNION SELECT opportunity_id AS id FROM active_opportunities WHERE opportunity_id IS NOT NULL
     UNION SELECT crm_account_id AS id FROM active_customers WHERE crm_account_id IS NOT NULL`
  );
  return [...new Set(rows.map((row) => normId(row.id)).filter(Boolean))];
}

// All MSX tasks whose "regarding" record is in the given GUID set, regardless of owner.
// Fetched in chunks (OData $filter length limits) and de-duplicated by activityid.
// Throws if a chunk request fails (e.g. CRM auth loss) so callers can surface an
// "unavailable" state instead of a misleading empty/zero result.
export const fetchTasksRegarding = (ids, options) => withCrmSync(() => fetchTasksRegardingInternal(ids, options));
async function fetchTasksRegardingInternal(ids, { select = OWNED_TASK_SELECT, chunkSize = 12 } = {}) {
  const list = [...new Set((ids || []).map((x) => String(x || '').replace(/[{}]/g, '')).filter(Boolean))];
  if (!list.length) return [];
  const active = new Set(await activeRegardingIds());
  if (list.some(id => !active.has(normId(id)))) throw new Error('An activity target is archived or unavailable. Refresh the active roster before pulling activities.');
  // Fetch the OData `$filter` chunks in parallel (bounded). A failed chunk throws,
  // which rejects the batch so callers can surface an "unavailable" state.
  const chunkResults = await mapWithConcurrency(
    chunkArray(list, chunkSize), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const filter = chunk.map((id) => `_regardingobjectid_value eq '${id}'`).join(' or ');
      const resp = await crmRequest({
        path: '/api/data/v9.2/tasks',
        method: 'GET',
        getAllPages: true,
        query: { $filter: `(${filter})`, $select: select },
      });
      if (!resp?.ok) throw new Error('Failed to load activities: ' + JSON.stringify(resp?.data));
      return resp.data?.value || [];
    }
  );
  const out = [];
  const seen = new Set();
  for (const tasks of chunkResults) {
    for (const t of tasks) {
      if (t.activityid && !seen.has(t.activityid)) {
        seen.add(t.activityid);
        out.push(t);
      }
    }
  }
  return out;
}

// ── Fetch + store (the sync action persists HoK tasks into the local cache) ──────────

// Map a stored hok_tasks row back to the CRM-shaped object the UI already expects, so
// the HoK tab and Dashboard render identically whether data is live or cached.
function rowToTask(r) {
  return {
    activityid: r.activity_id,
    subject: r.subject,
    createdon: r.created_on,
    scheduledend: r.scheduled_end,
    actualend: r.actual_end,
    statecode: r.state_code,
    statuscode: r.status_code,
    msp_taskcategory: r.task_category,
    [CATEGORY_LABEL_KEY]: r.task_category_label,
    [STATE_LABEL_KEY]: STATE_LABELS[r.state_code] ?? null,
    _ownerid_value: r.owner_id,
    [OWNER_NAME_KEY]: r.owner_name,
    _regardingobjectid_value: r.regarding_id,
    [REGARDING_NAME_KEY]: r.regarding_name,
    [REGARDING_TYPE_KEY]: r.regarding_type,
  };
}

// Insert (or replace) a single CRM-shaped task into the local hok_tasks cache. Used both
// by the full sync and by the "add activity" flow, so a freshly created activity survives
// a popup reopen without waiting for the next Settings sync (which reconciles by activity_id).
export async function upsertHokTask(task) {
  if (!task || !task.activityid) return;
  await dbRun(
    `INSERT OR REPLACE INTO hok_tasks
       (activity_id, subject, created_on, scheduled_end, actual_end, state_code,
        status_code, task_category, task_category_label, owner_id, owner_name,
        regarding_id, regarding_name, regarding_type, last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
    [
      task.activityid,
      task.subject ?? null,
      task.createdon ?? null,
      task.scheduledend ?? null,
      task.actualend ?? null,
      task.statecode ?? null,
      task.statuscode ?? null,
      task.msp_taskcategory ?? null,
      task[CATEGORY_LABEL_KEY] ?? null,
      normId(task._ownerid_value) || null,
      task[OWNER_NAME_KEY] ?? null,
      normId(task._regardingobjectid_value) || null,
      task[REGARDING_NAME_KEY] ?? null,
      task[REGARDING_TYPE_KEY] ?? null,
    ]
  );
}

// Refresh only active-account HoK cache rows; retain archived rows unchanged.
export const syncHokTasks = () => withCrmSync(syncHokTasksInternal);
async function syncHokTasksInternal() {
  const ids = await activeRegardingIds();
  const tasks = ids.length
    ? await fetchTasksRegarding(ids, { select: HOK_SYNC_SELECT })
    : [];
  await dbRun('DELETE FROM hok_tasks WHERE activity_id IN (SELECT activity_id FROM active_hok_tasks)');
  for (const t of tasks) {
    await upsertHokTask(t);
  }
  return { tasks: tasks.length };
}

// ── Read (HoK tab + Dashboard) — now served from the local cache ─────────────────────

// Resolve the HoK task list for the current territory scope from the local cache. This
// is the single source of truth shared by the Dashboard headline/per-customer counts and
// the HoK Activities tab, so all surfaces stay consistent. Reads only local data — run
// "Sync from CRM" (Settings) to refresh the cache from Dynamics.
//   scope 'mine'     -> tasks owned by the signed-in user (your personal worklist).
//   scope 'all'      -> every cached task regarding a milestone in your book of business
//                       (all owners; milestones with task_count > 0).
//   scope 'discover' -> tasks regarding milestones OWNED by one of your configured SSPs
//                       (pass `sspNames`). Empty/absent SSP list → no tasks.
// A legacy `myOnly` boolean is still accepted (true → 'mine', false → 'all').
export async function fetchTerritoryHokTasks({ scope, myOnly, sspNames } = {}) {
  const effScope = (scope === 'all' || scope === 'mine' || scope === 'discover')
    ? scope
    : (myOnly === false ? 'all' : 'mine');

  const rows = (await dbQuery('SELECT * FROM active_hok_tasks')) || [];
  const tasks = rows.map(rowToTask);
  const sortByNewest = (a, b) => new Date(b.createdon || 0) - new Date(a.createdon || 0);

  if (effScope === 'mine') {
    const idRows = await dbQuery(
      "SELECT value FROM app_settings WHERE key = 'current_user_id'"
    );
    const uid = normId(idRows?.[0]?.value);
    if (!uid) return []; // identity unknown → can't resolve a personal scope
    return tasks
      .filter((t) => normId(t._ownerid_value) === uid)
      .sort(sortByNewest);
  }

  if (effScope === 'discover') {
    // Tasks regarding milestones owned by a configured SSP that the signed-in user is NOT
    // already on the deal team of (candidates to join).
    const names = Array.isArray(sspNames) ? sspNames.map((n) => String(n || '').trim()).filter(Boolean) : [];
    if (!names.length) return [];
    const ph = names.map(() => '?').join(',');
    const msRows = await dbQuery(
      `SELECT milestone_id, owner_name, deal_team_json FROM active_milestones WHERE task_count > 0 AND milestone_id IS NOT NULL AND owner_name IN (${ph})`,
      names,
    );
    const nameRows = await dbQuery("SELECT value FROM app_settings WHERE key = 'current_user_name'");
    const me = String(nameRows?.[0]?.value || '').trim();
    const msSet = new Set();
    for (const r of (msRows || [])) {
      if (me) {
        const team = new Set(parseTeamList(r.deal_team_json));
        if (r.owner_name) team.add(r.owner_name);
        if (team.has(me)) continue; // already on this milestone's team → skip
      }
      msSet.add(normId(r.milestone_id));
    }
    return tasks
      .filter((t) => msSet.has(normId(t._regardingobjectid_value)))
      .sort(sortByNewest);
  }

  const msRows = await dbQuery(
    'SELECT milestone_id FROM active_milestones WHERE task_count > 0 AND milestone_id IS NOT NULL'
  );
  const msSet = new Set((msRows || []).map((r) => normId(r.milestone_id)));
  return tasks
    .filter((t) => msSet.has(normId(t._regardingobjectid_value)))
    .sort(sortByNewest);
}
