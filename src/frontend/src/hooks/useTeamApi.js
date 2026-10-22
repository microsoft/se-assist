import { useState, useEffect, useCallback, useRef } from 'react';
import { crmRequest, dbRun, dbQuery } from '../electronBridge';
import { MILESTONE_STATUS_MAP } from '../components/milestoneOptions';
import { upsertHokTask } from '../lib/hokActivities';
import { parseTeamList } from '../lib/milestoneMetrics';

// Access-team template IDs (mirror of the Dynamics deal-team templates).
const MILESTONE_TEAM_TEMPLATE_ID = '316e4735-9e83-eb11-a812-0022481e1be0';
const OPPORTUNITY_TEAM_TEMPLATE_ID = 'cc923a9d-7651-e311-9405-00155db3ba1e';

// The milestone→opportunity lookup ATTRIBUTE is `msp_opportunityid`, but the
// single-valued NAVIGATION PROPERTY used for `@odata.bind` on create has a
// different (schema-cased) name that MSX assigns to the relationship. Binding to
// the attribute name fails with "undeclared property 'msp_opportunityid'". We
// resolve the real navigation-property name from entity metadata once per session
// and cache it here.
// Milestone lookup ATTRIBUTES (e.g. `msp_opportunityid`, `msp_workloadlkid`) differ
// from the single-valued NAVIGATION PROPERTY names required for `@odata.bind` on
// create/update. Binding to the attribute name fails ("undeclared property …"). We
// resolve the real navigation-property name per referencing attribute from entity
// metadata once per session and cache it.
const navPropCache = {};
async function resolveMsNavProp(referencingAttribute, expectedEntity) {
  if (navPropCache[referencingAttribute]) return navPropCache[referencingAttribute];
  const res = await crmRequest({
    path: "/api/data/v9.2/EntityDefinitions(LogicalName='msp_engagementmilestone')/ManyToOneRelationships",
    method: 'GET',
    query: {
      $select: 'ReferencingEntityNavigationPropertyName,ReferencingAttribute,ReferencedEntity',
      $filter: `ReferencingAttribute eq '${referencingAttribute}'`,
    },
  });
  if (!res?.ok) {
    throw new Error(
      `Could not read the milestone relationship metadata for ${referencingAttribute} (${res?.data?.error?.message || res?.data?.message || `HTTP ${res?.status}`}).`
    );
  }
  const rows = res.data?.value || [];
  const rel = (expectedEntity && rows.find(r => r.ReferencedEntity === expectedEntity)) || rows[0];
  const nav = rel?.ReferencingEntityNavigationPropertyName;
  if (!nav) throw new Error(`Navigation property for ${referencingAttribute} not found in metadata.`);
  navPropCache[referencingAttribute] = nav;
  return nav;
}
const resolveOppNavProp = () => resolveMsNavProp('msp_opportunityid', 'opportunity');
const resolveWorkloadNavProp = () => resolveMsNavProp('msp_workloadlkid', 'msp_workload');

// ── UI field → CRM attribute normalization ───────────────────────────
// Scalar/option/text fields. Lookups (workload, owner) and the parent opportunity
// bind are handled separately because they need `@odata.bind` navigation props.
// A value of null means "omit on create / explicitly clear on update".
const numOrNull = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
const strOrNull = (v) => { const s = (v ?? '').toString().trim(); return s === '' ? null : s; };
const dateOnlyOrNull = (v) => {
  const s = (v ?? '').toString().trim();
  if (!s) return null;
  // msp_milestonedate is Edm.Date — must be bare YYYY-MM-DD, never a full ISO datetime.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};
const multiOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const cleaned = arr.map(x => Number(x)).filter(n => isFinite(n));
  return cleaned.length ? cleaned.join(',') : null;
};

// Map one UI field key to its { attr, value } for a scalar CRM attribute.
function crmScalarFor(key, v) {
  switch (key) {
    case 'name': return { attr: 'msp_name', value: (v ?? '').toString().trim() };
    case 'commitment': return { attr: 'msp_commitmentrecommendation', value: numOrNull(v) };
    case 'deliveredBy': return { attr: 'msp_deliveryspecifiedfield', value: numOrNull(v) };
    case 'partner': return { attr: 'msp_partneroption', value: strOrNull(v) };
    case 'category': return { attr: 'msp_milestonecategory', value: numOrNull(v) };
    case 'milestoneDate': return { attr: 'msp_milestonedate', value: dateOnlyOrNull(v) };
    case 'estChange': return { attr: 'msp_monthlyuse', value: numOrNull(v) };
    case 'nonRecurring': return { attr: 'msp_nonrecurring', value: v ? 861980000 : null };
    case 'status': return { attr: 'msp_milestonestatus', value: numOrNull(v) };
    case 'statusReason': return { attr: 'msp_milestonestatusreason', value: numOrNull(v) };
    case 'helpNeeded': return { attr: 'msp_helpneeded', value: numOrNull(v) };
    case 'riskDetails': return { attr: 'msp_milestonecomments', value: strOrNull(v) };
    case 'capacityType': return { attr: 'msp_milestoneazurecapacitytype', value: multiOrNull(v) };
    case 'region': return { attr: 'msp_milestonepreferredazureregion', value: numOrNull(v) };
    default: return null;
  }
}
const SCALAR_KEYS = ['name','commitment','deliveredBy','partner','category','milestoneDate','estChange','nonRecurring','status','statusReason','helpNeeded','riskDetails','capacityType','region'];

// (Deal-team parsing comes from ../lib/milestoneMetrics: parseTeamList.)

// Shared deal-team / comment / activity actions used by both the Milestones page
// and the Milestone Timeline. Loads the signed-in user's identity (persisted on
// sync) and exposes the same teamApi surface the DetailCard expects.
//
// Params:
//   refresh — called after a mutation to re-fetch the host's data.
//   onFlash — optional ({ type, msg }) callback to surface status messages.
export function useTeamApi({ refresh, onFlash } = {}) {
  const [currentUserName, setCurrentUserName] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [joinedKeys, setJoinedKeys] = useState(() => new Set()); // 'opp:{id}' / 'ms:{id}' joined this session
  const [leftKeys, setLeftKeys] = useState(() => new Set());     // keys the user left this session
  const [joiningKey, setJoiningKey] = useState(null);            // key currently being added/removed

  // The signed-in user's CRM identity (systemuser GUID + name) lives in app_settings, written by
  // every "Sync from CRM" (manual or the hourly background sync). We keep an in-memory copy for
  // synchronous checks AND a ref mirror so on-demand reads / listeners see the latest without
  // stale-closure issues.
  const identityRef = useRef({ userId: '', userName: '' });

  // Read identity fresh from the DB and update state + ref. Returns the latest {userId,userName}.
  // Because it re-reads the DB (which the hourly sync keeps current), this SELF-HEALS a stale
  // in-memory copy — e.g. when this hook mounted before the session's first sync populated the
  // identity. Previously the identity was read only ONCE on mount, so it never recovered without a
  // remount (which is why visiting User Home, remounting the page, appeared to "fix" it).
  const loadIdentity = useCallback(async () => {
    try {
      const rows = await dbQuery("SELECT key, value FROM app_settings WHERE key IN ('current_user_name','current_user_id')");
      let userId = identityRef.current.userId;
      let userName = identityRef.current.userName;
      for (const r of rows || []) {
        if (r.key === 'current_user_id' && r.value) userId = r.value;
        if (r.key === 'current_user_name' && r.value) userName = r.value;
      }
      identityRef.current = { userId, userName };
      setCurrentUserId((prev) => (prev === userId ? prev : userId));
      setCurrentUserName((prev) => (prev === userName ? prev : userName));
      return identityRef.current;
    } catch {
      return identityRef.current;
    }
  }, []);

  // Ensure we have identity right before an action that needs it: return the in-memory copy if
  // present, otherwise re-read the DB once. So a deal-team add works the moment the DB has the
  // identity (hourly sync keeps it current) — no manual sync or User Home visit required.
  const resolveIdentity = useCallback(async () => {
    if (identityRef.current.userId && identityRef.current.userName) return identityRef.current;
    return loadIdentity();
  }, [loadIdentity]);

  useEffect(() => {
    loadIdentity();
    // Self-heal on focus/visibility: whenever the app regains focus (e.g. after WorkIQ reconnects
    // in the background), re-read identity so a stale empty copy recovers on its own.
    const onFocus = () => { loadIdentity(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadIdentity]);

  // True if the signed-in user is on the given record's deal team. Session join/leave
  // overrides take precedence over the synced members list for instant feedback.
  const isOnTeam = useCallback((type, id, members) => {
    const key = `${type}:${id}`;
    if (joinedKeys.has(key)) return true;
    if (leftKeys.has(key)) return false;
    if (!currentUserName) return false;
    return Array.isArray(members) && members.includes(currentUserName);
  }, [joinedKeys, leftKeys, currentUserName]);

  // Toggle the signed-in user's membership on a record's access team.
  const toggleTeam = useCallback(async (type, id, currentlyMember) => {
    const { userId, userName } = await resolveIdentity();
    if (!userId) {
      onFlash?.({ type: 'warning', msg: 'Your Microsoft/CRM identity isn’t available yet. Run "Sync from CRM" once.' });
      return;
    }
    const key = `${type}:${id}`;
    if (joiningKey) return;
    setJoiningKey(key);
    const leaving = currentlyMember;
    try {
      const odataType = type === 'opp' ? 'opportunity' : 'msp_engagementmilestone';
      const idField = type === 'opp' ? 'opportunityid' : 'msp_engagementmilestoneid';
      const templateId = type === 'opp' ? OPPORTUNITY_TEAM_TEMPLATE_ID : MILESTONE_TEAM_TEMPLATE_ID;
      const action = leaving ? 'RemoveUserFromRecordTeam' : 'AddUserToRecordTeam';
      const resp = await crmRequest({
        path: `/api/data/v9.2/systemusers(${userId})/Microsoft.Dynamics.CRM.${action}`,
        method: 'POST',
        body: {
          Record: { '@odata.type': `Microsoft.Dynamics.CRM.${odataType}`, [idField]: id },
          TeamTemplate: { '@odata.type': 'Microsoft.Dynamics.CRM.teamtemplate', teamtemplateid: templateId },
        },
      });
      if (!resp?.ok && resp?.status !== 204) {
        throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
      }
      setJoinedKeys(prev => { const n = new Set(prev); leaving ? n.delete(key) : n.add(key); return n; });
      setLeftKeys(prev => { const n = new Set(prev); leaving ? n.add(key) : n.delete(key); return n; });
      if (type === 'ms' && userName) {
        const rows = await dbQuery('SELECT deal_team_json FROM active_milestones WHERE milestone_id = ?', [id]);
        const existing = parseTeamList(rows?.[0]?.deal_team_json);
        let updatedArr;
        if (leaving) updatedArr = existing.filter(n => n !== userName);
        else updatedArr = existing.includes(userName) ? existing : [...existing, userName];
        await dbRun('UPDATE milestones SET deal_team_json = ? WHERE milestone_id = ?', [JSON.stringify(updatedArr.sort()), id]);
      }
      const noun = type === 'opp' ? 'opportunity' : 'milestone';
      onFlash?.({ type: 'success', msg: leaving ? `Removed you from the ${noun} deal team.` : `Added you to the ${noun} deal team.` });
      refresh?.();
    } catch (err) {
      console.error('Toggle team failed:', err);
      onFlash?.({ type: 'error', msg: `Could not ${leaving ? 'leave' : 'join'} deal team: ${err.message || err}` });
    } finally {
      setJoiningKey(null);
    }
  }, [resolveIdentity, joiningKey, refresh, onFlash]);

  // Ensure the signed-in user is on a milestone's deal team (MSX AddUserToRecordTeam + local
  // mirror), mirroring toggleTeam's ADD path. Add-only and idempotent: a no-op when the user is
  // already the owner or a member, and it NEVER removes. Unlike toggleTeam it isn't guarded by the
  // interactive joiningKey, so it can be called in a batch (once per milestone). Throws on failure
  // so callers can surface it. Used by Milestone AI to put the user on every milestone it works.
  const ensureOnMilestoneTeam = useCallback(async (milestoneId) => {
    const id = String(milestoneId || '').trim();
    if (!id) return { skipped: true };
    // Resolve identity on-demand (re-reads the DB if the in-memory copy is empty) so this works the
    // moment the identity exists in app_settings — no manual sync or User Home visit required. It
    // only needs the STABLE systemuser GUID, which the hourly sync keeps current.
    const { userId, userName } = await resolveIdentity();
    if (!userId || !userName) {
      throw new Error('Your Microsoft/CRM identity isn’t available yet. Run "Sync from CRM" once so we know who to add to the deal team.');
    }
    const rows = await dbQuery('SELECT owner_name, deal_team_json FROM active_milestones WHERE milestone_id = ?', [id]);
    const row = rows?.[0] || {};
    const existing = parseTeamList(row.deal_team_json);
    if (row.owner_name === userName || existing.includes(userName)) {
      return { alreadyMember: true };
    }
    const resp = await crmRequest({
      path: `/api/data/v9.2/systemusers(${userId})/Microsoft.Dynamics.CRM.AddUserToRecordTeam`,
      method: 'POST',
      body: {
        Record: { '@odata.type': 'Microsoft.Dynamics.CRM.msp_engagementmilestone', msp_engagementmilestoneid: id },
        TeamTemplate: { '@odata.type': 'Microsoft.Dynamics.CRM.teamtemplate', teamtemplateid: MILESTONE_TEAM_TEMPLATE_ID },
      },
    });
    if (!resp?.ok && resp?.status !== 204) {
      throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
    }
    // Mirror locally so the UI reflects membership immediately (sync will later confirm it).
    const updatedArr = [...existing, userName].sort();
    await dbRun('UPDATE milestones SET deal_team_json = ? WHERE milestone_id = ?', [JSON.stringify(updatedArr), id]);
    return { added: true };
  }, [resolveIdentity]);

  // Append a comment to a milestone (CRM PATCH + local mirror). Returns the updated
  // comments_json string so the open detail card can refresh in place.
  const addMilestoneComment = useCallback(async (milestoneId, text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || !milestoneId) return null;
    const rows = await dbQuery('SELECT comments_json FROM active_milestones WHERE milestone_id = ?', [milestoneId]);
    let existing = [];
    try { existing = JSON.parse(rows?.[0]?.comments_json || '[]'); } catch { existing = []; }
    if (!Array.isArray(existing)) existing = [];
    const entry = { userId: currentUserName || 'Me', modifiedOn: new Date().toISOString(), comment: trimmed };
    const next = [entry, ...existing];
    const json = JSON.stringify(next);
    // Only write the structured JSON field. MSX renders each JSON entry as a comment
    // and derives the plaintext rollup (msp_forecastcomments) itself. Writing the rollup
    // here caused MSX to surface it as a second, duplicate "summary" comment.
    const resp = await crmRequest({
      path: `/api/data/v9.2/msp_engagementmilestones(${milestoneId})`,
      method: 'PATCH',
      body: { msp_forecastcommentsjsonfield: json },
    });
    if (!resp?.ok && resp?.status !== 204) {
      throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
    }
    await dbRun('UPDATE milestones SET comments_json = ? WHERE milestone_id = ?', [json, milestoneId]);
    refresh?.();
    return json;
  }, [currentUserName, refresh]);

  // Create a Task activity regarding a record (milestone or opportunity), then mark it
  // Completed. MSX rejects creating a task already-completed, so we create it active,
  // look it back up, then PATCH it to Completed.
  const addActivity = useCallback(async (type, id, { subject, taskCategory, dueDate, description } = {}) => {
    const { userId: uid } = await resolveIdentity();
    if (!uid) throw new Error('Your Microsoft/CRM identity isn’t available yet. Run "Sync from CRM" once.');
    // Bind the task's polymorphic `regardingobjectid` lookup via the task-side
    // single-valued navigation property. In Dataverse that property is named
    // `regardingobjectid_<referencedentity>_task` (e.g. regardingobjectid_opportunity_task) —
    // the plain `regardingobjectid_<entity>` form does NOT exist on the task entity, so the
    // create silently fails to associate (or is rejected) and nothing shows up in MSX.
    const bindField = type === 'opp'
      ? 'regardingobjectid_opportunity_task@odata.bind'
      : 'regardingobjectid_msp_engagementmilestone_task@odata.bind';
    const bindPath = type === 'opp' ? `/opportunities(${id})` : `/msp_engagementmilestones(${id})`;
    const finalSubject = (subject || '').trim() || 'SE follow-up';
    const body = {
      subject: finalSubject,
      scheduleddurationminutes: 60,
      prioritycode: 1,
      [bindField]: bindPath,
      'ownerid@odata.bind': `/systemusers(${uid})`,
    };
    if (taskCategory != null && taskCategory !== '') body.msp_taskcategory = Number(taskCategory);
    if (dueDate) body.scheduledend = new Date(`${dueDate}T00:00:00Z`).toISOString();
    if (description != null && description.trim() !== '') body.description = description.trim();

    const resp = await crmRequest({ path: '/api/data/v9.2/tasks', method: 'POST', body });
    if (!resp?.ok && resp?.status !== 204) {
      throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
    }

    try {
      const lookup = await crmRequest({
        path: '/api/data/v9.2/tasks',
        method: 'GET',
        query: {
          $filter: `_regardingobjectid_value eq '${id}' and _ownerid_value eq '${uid}' and subject eq '${finalSubject.replace(/'/g, "''")}'`,
          $select: 'activityid,subject,createdon,scheduledend,actualend,statecode,statuscode,msp_taskcategory,_regardingobjectid_value,_ownerid_value',
          $orderby: 'createdon desc',
          $top: 1,
        },
      });
      const row = lookup?.ok ? lookup.data?.value?.[0] : null;
      const taskId = row?.activityid || null;
      if (taskId) {
        await crmRequest({
          path: `/api/data/v9.2/tasks(${taskId})`,
          method: 'PATCH',
          body: { statecode: 1, statuscode: 5 },
        });
        // Persist the created activity into the local HoK cache so it survives a
        // popup reopen (the detail card reads from active_hok_tasks). The next Settings
        // sync reconciles the same row by its activity_id primary key.
        try {
          await upsertHokTask({
            ...row,
            statecode: 1,
            statuscode: 5,
            actualend: row.actualend || new Date().toISOString(),
          });
        } catch (cacheErr) {
          console.warn('Task created but could not be cached locally:', cacheErr);
        }
      }
    } catch (e) {
      console.warn('Task created but could not be marked complete:', e);
    }
    return true;
  }, [resolveIdentity]);

  // Create a new engagement milestone under an opportunity (CRM POST + local mirror).
  // Accepts the full field object from the Milestone editor grid. Dataverse create
  // returns 204 with no body exposed through the IPC bridge, so we look the record
  // back up to learn its id, then insert a row into the local cache so it shows
  // app-wide until the next full sync. Returns an { type:'ms' }-shaped row so the
  // caller can open its DetailCard / append it to the opportunity list.
  const addMilestone = useCallback(async (opportunityId, fields = {}) => {
    const { userId: uid, userName: uname } = await resolveIdentity();
    if (!uid) throw new Error('Your Microsoft/CRM identity isn’t available yet. Run "Sync from CRM" once.');
    if (!opportunityId) throw new Error('Missing opportunity — cannot create a milestone.');
    const finalName = (fields.name || '').trim();
    if (!finalName) throw new Error('Milestone name is required.');
    const workloadId = fields.workloadId ? String(fields.workloadId).replace(/[{}]/g, '') : null;
    if (!workloadId) throw new Error('Workload is required.');
    if (numOrNull(fields.category) == null) throw new Error('Milestone category is required.');
    if (dateOnlyOrNull(fields.milestoneDate) == null) throw new Error('Estimated date is required.');
    const oppId = String(opportunityId).replace(/[{}]/g, '');
    const ownerId = (fields.ownerId ? String(fields.ownerId).replace(/[{}]/g, '') : '') || uid;

    const [oppNavProp, workloadNavProp] = await Promise.all([resolveOppNavProp(), resolveWorkloadNavProp()]);

    // Scalars — omit nulls on create. Apply valid defaults for status/commitment.
    const body = {};
    for (const key of SCALAR_KEYS) {
      if (!(key in fields)) continue;
      const mapped = crmScalarFor(key, fields[key]);
      if (mapped && mapped.value !== null && mapped.value !== undefined) body[mapped.attr] = mapped.value;
    }
    if (body.msp_milestonestatus == null) body.msp_milestonestatus = 861980000;         // On Track
    if (body.msp_commitmentrecommendation == null) body.msp_commitmentrecommendation = 861980000; // Uncommitted
    body.msp_name = finalName;
    body[`${oppNavProp}@odata.bind`] = `/opportunities(${oppId})`;
    body[`${workloadNavProp}@odata.bind`] = `/msp_workloads(${workloadId})`;
    body['ownerid@odata.bind'] = `/systemusers(${ownerId})`;

    const resp = await crmRequest({ path: '/api/data/v9.2/msp_engagementmilestones', method: 'POST', body });
    if (!resp?.ok && resp?.status !== 204) {
      throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
    }

    // Look the new record back up to learn its id (and server-normalized values).
    let created = null;
    try {
      const lookup = await crmRequest({
        path: '/api/data/v9.2/msp_engagementmilestones',
        method: 'GET',
        query: {
          $filter: `_msp_opportunityid_value eq '${oppId}' and msp_name eq '${finalName.replace(/'/g, "''")}'`,
          $select: 'msp_engagementmilestoneid,msp_name,msp_milestonedate,msp_monthlyuse,msp_milestonestatus,msp_milestonestatusreason,msp_commitmentrecommendation,msp_milestonecategory,createdon',
          $orderby: 'createdon desc',
          $top: 1,
        },
      });
      created = lookup?.ok ? lookup.data?.value?.[0] : null;
    } catch { /* non-fatal: optimistic UI + next sync reconciles */ }

    const newId = created?.msp_engagementmilestoneid || null;
    const statusVal = created?.msp_milestonestatus ?? body.msp_milestonestatus;
    const commitVal = created?.msp_commitmentrecommendation ?? body.msp_commitmentrecommendation;
    const statusLabel = MILESTONE_STATUS_MAP[statusVal] || null;
    const dateVal = created?.msp_milestonedate || dateOnlyOrNull(fields.milestoneDate);
    const acrVal = created?.msp_monthlyuse ?? numOrNull(fields.estChange);
    const teamJson = JSON.stringify(uname ? [uname] : []);
    if (newId) {
      try {
        await dbRun(
          `INSERT OR IGNORE INTO milestones
             (milestone_id, name, opportunity_id, workload, milestone_category, milestone_date,
              milestone_status, status_reason, commitment_recommendation, status_label, monthly_use,
              owner_id, owner_name, comments_json, task_count, deal_team_json,
              created_on, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
          [
            newId, finalName, oppId, fields.workloadName || null,
            numOrNull(fields.category), dateVal,
            statusVal, numOrNull(fields.statusReason), commitVal, statusLabel, acrVal,
            ownerId, fields.ownerName || uname || null,
            '[]', 0, teamJson, created?.createdon || new Date().toISOString(),
          ]
        );
      } catch { /* non-fatal: sync will reconcile the full row */ }
    }
    refresh?.();

    // Shape mirrors the joined milestone-row columns the DetailCard ('ms') reads.
    return {
      milestone_id: newId,
      name: finalName,
      opp_crm_id: oppId,
      workload: fields.workloadName || null,
      milestone_category: numOrNull(fields.category),
      milestone_date: dateVal,
      milestone_status: statusVal,
      status_reason: numOrNull(fields.statusReason),
      status_label: statusLabel,
      monthly_use: acrVal,
      commitment_recommendation: commitVal,
      owner_id: ownerId,
      owner_name: fields.ownerName || uname || '',
      comments_json: '[]',
      task_count: 0,
      deal_team_json: teamJson,
    };
  }, [resolveIdentity, refresh]);

  // Update an existing milestone (CRM PATCH + local mirror). `changed` contains only
  // the UI field keys the user edited (may include workloadId/workloadName and
  // ownerId/ownerName for the two lookups). Sends a partial PATCH; surfaces Dataverse
  // errors verbatim. Returns the changed-field patch applied to the local row so the
  // caller can update its in-memory copy.
  const updateMilestone = useCallback(async (milestoneId, changed = {}) => {
    const id = milestoneId ? String(milestoneId).replace(/[{}]/g, '') : '';
    if (!id) throw new Error('Missing milestone id — cannot update.');
    if (!changed || Object.keys(changed).length === 0) return {};

    const body = {};
    for (const key of SCALAR_KEYS) {
      if (!(key in changed)) continue;
      const mapped = crmScalarFor(key, changed[key]);
      if (mapped) body[mapped.attr] = mapped.value; // null explicitly clears the field
    }
    if ('workloadId' in changed) {
      const wl = changed.workloadId ? String(changed.workloadId).replace(/[{}]/g, '') : null;
      if (!wl) throw new Error('Workload is required.');
      const workloadNavProp = await resolveWorkloadNavProp();
      body[`${workloadNavProp}@odata.bind`] = `/msp_workloads(${wl})`;
    }
    if ('ownerId' in changed) {
      const ow = changed.ownerId ? String(changed.ownerId).replace(/[{}]/g, '') : null;
      if (!ow) throw new Error('Owner is required.');
      body['ownerid@odata.bind'] = `/systemusers(${ow})`;
    }
    if (Object.keys(body).length === 0) return {};

    const resp = await crmRequest({ path: `/api/data/v9.2/msp_engagementmilestones(${id})`, method: 'PATCH', body });
    if (!resp?.ok && resp?.status !== 204) {
      throw new Error(resp?.data?.error?.message || resp?.data?.message || `HTTP ${resp?.status}`);
    }

    // Mirror the subset of edited fields we track locally (others reconcile on sync).
    const cols = [];
    const vals = [];
    const set = (col, val) => { cols.push(`${col} = ?`); vals.push(val); };
    const patch = {}; // returned to caller to update its in-memory row
    if ('name' in changed) { const v = (changed.name || '').trim(); set('name', v); patch.name = v; }
    if ('milestoneDate' in changed) { const v = dateOnlyOrNull(changed.milestoneDate); set('milestone_date', v); patch.milestone_date = v; }
    if ('estChange' in changed) { const v = numOrNull(changed.estChange); set('monthly_use', v); patch.monthly_use = v; }
    if ('status' in changed) {
      const v = numOrNull(changed.status); const lbl = MILESTONE_STATUS_MAP[v] || null;
      set('milestone_status', v); set('status_label', lbl); patch.milestone_status = v; patch.status_label = lbl;
    }
    if ('statusReason' in changed) { const v = numOrNull(changed.statusReason); set('status_reason', v); patch.status_reason = v; }
    if ('commitment' in changed) { const v = numOrNull(changed.commitment); set('commitment_recommendation', v); patch.commitment_recommendation = v; }
    if ('category' in changed) { const v = numOrNull(changed.category); set('milestone_category', v); patch.milestone_category = v; }
    if ('nonRecurring' in changed) { const v = changed.nonRecurring ? 861980000 : null; set('non_recurring', v); patch.non_recurring = v; }
    if ('workloadId' in changed) { const v = changed.workloadName || null; set('workload', v); patch.workload = v; }
    if ('ownerId' in changed) {
      const oid = changed.ownerId ? String(changed.ownerId).replace(/[{}]/g, '') : null;
      set('owner_id', oid); set('owner_name', changed.ownerName || null);
      patch.owner_id = oid; patch.owner_name = changed.ownerName || null;
    }
    if (cols.length) {
      try {
        await dbRun(`UPDATE milestones SET ${cols.join(', ')}, updated_at = datetime('now') WHERE milestone_id = ?`, [...vals, id]);
      } catch { /* non-fatal: sync reconciles */ }
    }
    refresh?.();
    return patch;
  }, [refresh]);

  return { currentUserName, currentUserId, joiningKey, isOnTeam, toggleTeam, ensureOnMilestoneTeam, addMilestoneComment, addActivity, addMilestone, updateMilestone };
}
