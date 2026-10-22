/**
 * sync.js — the single source of truth for pulling data from Dynamics (MSX) into the
 * local SQLite cache. Previously this logic lived inside the Customers and Milestones
 * tabs as per-tab "Sync from CRM" buttons; it's centralized here so one button in
 * Settings can run the whole pipeline (customers → milestones → HoK activities).
 *
 * Each step is an independent async function that returns a small result summary and
 * throws on a fatal error. syncAll() runs them in dependency order and reports progress.
 */
import { ensureAuth, crmRequest, dbRun, dbQuery, getMsxTpids, withCrmSync } from '../electronBridge';
import { syncHokTasks } from './hokActivities';
import { mapWithConcurrency, chunkArray, MAX_CONCURRENT_REQUESTS } from './concurrency';

// ── Constants used by the sync queries (mirror the display maps in the components) ──
const MILESTONE_SELECT = [
  'msp_engagementmilestoneid', 'msp_milestonenumber', 'msp_name',
  '_msp_workloadlkid_value', 'msp_commitmentrecommendation', 'msp_milestonecategory',
  'msp_monthlyuse', 'msp_milestonedate', 'msp_milestonestatus', 'msp_milestonestatusreason',
  'msp_nonrecurring', 'msp_nonrecurringmonths', '_ownerid_value', '_msp_opportunityid_value',
  'msp_forecastcomments', 'msp_forecastcommentsjsonfield', 'createdon',
].join(',');

const MILESTONE_TEAM_TEMPLATE_ID = '316e4735-9e83-eb11-a812-0022481e1be0';

const MILESTONE_STATUS = { 0: 'Draft', 1: 'Approved', 2: 'Rejected', 3: 'Cancelled', 4: 'Completed', 100000000: 'Active', 100000001: 'Closed', 100000002: 'Cancelled' };
const CUSTOMER_COMMITMENT = { 861980000: 'Uncommitted', 861980003: 'Committed' };

// Dynamics segment code → label.
const SEGMENTS = { 1: 'S500 Strategic', 2: 'Major', 3: 'Corporate Managed', 4: 'Corporate Unmanaged', 5: 'Small/Medium/Corporate' };

// ── Shared sync lock ─────────────────────────────────────────────────────────────
// Both the manual "Sync from CRM" button (syncAll) and the background MSX auto-sync
// (msxAutoSync.js) write to the same SQLite tables. A single in-flight guard makes sure
// they never overlap: whoever gets here first holds the lock; the other yields.
let syncInFlight = false;
export function syncInProgress() { return syncInFlight; }
export function beginSync() {
  if (syncInFlight) return false;
  syncInFlight = true;
  return true;
}
export function endSync() { syncInFlight = false; }

// ── Step 1: Customers (accounts under each tracked TPID) ─────────────────────────────
export const syncCustomers = () => withCrmSync(syncCustomersInternal);
async function syncCustomersInternal() {
  const tpids = await getMsxTpids();
  if (!tpids.length) {
    const err = new Error('No default accounts configured. Add TPIDs in Settings → Default Accounts.');
    err.code = 'NO_ROSTER';
    throw err;
  }

  await ensureAuth();
  let totalSynced = 0;
  // Count requests that failed (e.g. Dataverse service-protection throttling). A
  // swallowed failure would silently under-report the pull, so we surface the count
  // to the caller instead of pretending the sync was complete.
  let failedRequests = 0;

  // Fetch each tracked TPID's accounts in parallel (bounded), then persist
  // sequentially so the SQLite writes stay serialized.
  const perTpidAccounts = await mapWithConcurrency(tpids, MAX_CONCURRENT_REQUESTS, async (tpid) => {
    const resp = await crmRequest({
      path: '/api/data/v9.2/accounts',
      method: 'GET',
      query: {
        $filter: `msp_mstopparentid eq '${tpid}'`,
        $select: 'accountid,name,msp_mstopparentid,_parentaccountid_value,msp_segmentgroup,msp_endcustomersegmentcode,msp_parentinglevelcode,address1_city,address1_country,revenue,telephone1,websiteurl,numberofemployees,description',
        $orderby: 'name',
      },
    });

    if (!resp?.ok) {
      console.warn(`CRM request failed for TPID ${tpid}:`, resp);
      failedRequests += 1;
      return [];
    }
    return resp?.data?.value || [];
  });

  for (const accounts of perTpidAccounts) {
    for (const acct of accounts) {
      const segmentCode = acct.msp_endcustomersegmentcode || acct.msp_segmentgroup;
      const segment = SEGMENTS[segmentCode] || (segmentCode ? String(segmentCode) : null);

      const existing = await dbQuery(
        'SELECT id FROM customers WHERE crm_account_id = ?',
        [acct.accountid]
      );

      if (existing.length > 0) {
        await dbRun(
          `UPDATE customers SET name=?, tpid=?, parent_crm_account_id=?, segment=?, parenting_level=?, city=?, country=?, revenue=?, phone=?, website=?, employees=?, description=?, last_synced_at=datetime('now'), updated_at=datetime('now') WHERE crm_account_id=?`,
          [
            acct.name, acct.msp_mstopparentid, acct._parentaccountid_value, segment,
            acct.msp_parentinglevelcode, acct.address1_city, acct.address1_country,
            acct.revenue, acct.telephone1, acct.websiteurl, acct.numberofemployees,
            acct.description, acct.accountid,
          ]
        );
      } else {
        await dbRun(
          `INSERT INTO customers (name, tpid, crm_account_id, parent_crm_account_id, segment, parenting_level, city, country, revenue, phone, website, employees, description, last_synced_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))`,
          [
            acct.name, acct.msp_mstopparentid, acct.accountid, acct._parentaccountid_value,
            segment, acct.msp_parentinglevelcode, acct.address1_city, acct.address1_country,
            acct.revenue, acct.telephone1, acct.websiteurl, acct.numberofemployees, acct.description,
          ]
        );
      }
      totalSynced++;
    }
  }

  return { accounts: totalSynced, failedRequests };
}

// ── Step 2: Milestones (identity + opportunities + milestones + tasks + deal teams) ──
export const syncMilestones = () => withCrmSync(syncMilestonesInternal);
async function syncMilestonesInternal() {
  const acctRows = await dbQuery(
    `SELECT DISTINCT crm_account_id FROM active_customers WHERE crm_account_id IS NOT NULL AND crm_account_id <> ''`
  );
  const accountIds = (acctRows || []).map((r) => r.crm_account_id).filter(Boolean);
  if (!accountIds.length) {
    const err = new Error('No active customer accounts found. Save your roster in User Home and sync customers first.');
    err.code = 'NO_ACCOUNTS';
    throw err;
  }
  await ensureAuth();
  // Track requests that failed (throttling / transient errors). Chunk workers below
  // return [] on failure so one bad chunk can't abort the whole pull, but that means a
  // silent failure would under-report the totals — so we count them and surface the
  // count to the caller (the summary flags the pull as incomplete when > 0).
  let failedRequests = 0;

  const whoResp = await crmRequest({ path: '/api/data/v9.2/WhoAmI', method: 'GET' });
  if (!whoResp?.ok) throw new Error('WhoAmI failed: ' + JSON.stringify(whoResp?.data));
  const userId = whoResp.data.UserId;

  // Persist the signed-in user's identity so "My Milestones" can match deal teams
  // and deal-team join actions know who to add.
  try {
    const sanitizedUserId = String(userId).replace(/[{}]/g, '');
    await dbRun(
      `INSERT INTO app_settings (key, value) VALUES ('current_user_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      [sanitizedUserId, sanitizedUserId]
    );
    const meResp = await crmRequest({
      path: `/api/data/v9.2/systemusers(${userId})`,
      method: 'GET',
      query: { $select: 'fullname' },
    });
    const meName = meResp?.ok ? (meResp.data?.fullname || '') : '';
    if (meName) {
      await dbRun(
        `INSERT INTO app_settings (key, value) VALUES ('current_user_name', ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
        [meName, meName]
      );
    }
  } catch (e) {
    console.warn('Could not resolve current user identity:', e);
  }

  // Pull opportunities top-down per tracked account (full breadth).
  // 1) All OPEN opportunities for those accounts (chunks fetched in parallel).
  const oppChunks = await mapWithConcurrency(
    chunkArray(accountIds, 20), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const acctFilter = chunk.map((id) => `_parentaccountid_value eq '${id}'`).join(' or ');
      const oppResp = await crmRequest({
        path: '/api/data/v9.2/opportunities',
        method: 'GET',
        getAllPages: true,
        query: {
          $filter: `(${acctFilter}) and statecode eq 0`,
          $select: 'opportunityid,name,msp_opportunitynumber,estimatedclosedate,createdon,_ownerid_value,_parentaccountid_value,msp_salesplay,customerneed',
          $expand: 'parentaccountid($select=name)',
        },
      });
      if (!oppResp?.ok) {
        console.warn('Opportunity query error:', oppResp?.status, oppResp?.data);
        failedRequests += 1;
        return [];
      }
      return oppResp.data?.value || [];
    }
  );
  const oppMap = new Map();
  for (const opps of oppChunks) {
    for (const opp of opps) oppMap.set(opp.opportunityid, opp);
  }

  if (oppMap.size === 0) {
    return {
      opportunities: 0,
      milestones: 0,
      failedRequests,
      note: failedRequests > 0
        ? 'No opportunities returned, but some requests failed — retry.'
        : 'No open opportunities found for your accounts.',
    };
  }

  for (const opp of oppMap.values()) {
    const custName = opp.parentaccountid?.name || '';
    const ownerName = opp['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || '';
    await dbRun(
      `INSERT INTO opportunities (opportunity_id, name, opportunity_number, estimated_close_date, created_on, owner_id, parent_account_id, customer_name, sales_play, customer_commitment, customer_need, owner_name, last_synced_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))
       ON CONFLICT(opportunity_id) DO UPDATE SET name=?, opportunity_number=?, estimated_close_date=?, created_on=?, owner_id=?, parent_account_id=?, customer_name=?, sales_play=?, customer_commitment=?, customer_need=?, owner_name=?, last_synced_at=datetime('now'), updated_at=datetime('now')`,
      [
        opp.opportunityid, opp.name, opp.msp_opportunitynumber, opp.estimatedclosedate, opp.createdon,
        opp._ownerid_value, opp._parentaccountid_value, custName, opp.msp_salesplay, '', opp.customerneed || '', ownerName,
        opp.name, opp.msp_opportunitynumber, opp.estimatedclosedate, opp.createdon,
        opp._ownerid_value, opp._parentaccountid_value, custName, opp.msp_salesplay, '', opp.customerneed || '', ownerName,
      ]
    );
  }

  // 2) All milestones under those opportunities (chunks fetched in parallel).
  const msChunks = await mapWithConcurrency(
    chunkArray([...oppMap.keys()], 15), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const msFilter = chunk.map((id) => `_msp_opportunityid_value eq '${id}'`).join(' or ');
      const msResp = await crmRequest({
        path: '/api/data/v9.2/msp_engagementmilestones',
        method: 'GET',
        getAllPages: true,
        query: { $filter: msFilter, $select: MILESTONE_SELECT },
      });
      if (!msResp?.ok) {
        console.warn('Milestone query error:', msResp?.status, msResp?.data);
        failedRequests += 1;
        return [];
      }
      return msResp.data?.value || [];
    }
  );
  const milestoneMap = new Map();
  for (const rows of msChunks) {
    for (const ms of rows) {
      if (ms.msp_engagementmilestoneid) milestoneMap.set(ms.msp_engagementmilestoneid, ms);
    }
  }

  // Task (activity) counts per milestone (chunks fetched in parallel).
  const msIds = [...milestoneMap.keys()];
  const taskChunks = await mapWithConcurrency(
    chunkArray(msIds, 15), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const regardingFilter = chunk.map((id) => `_regardingobjectid_value eq '${id}'`).join(' or ');
      const taskResp = await crmRequest({
        path: '/api/data/v9.2/tasks',
        method: 'GET',
        getAllPages: true,
        query: { $filter: `(${regardingFilter})`, $select: 'activityid,_regardingobjectid_value,activitytypecode' },
      });
      if (!taskResp?.ok) {
        console.warn('Activity query error:', taskResp?.status, taskResp?.data);
        failedRequests += 1;
        return [];
      }
      return taskResp.data?.value || [];
    }
  );
  const taskCountMap = new Map();
  for (const tasks of taskChunks) {
    for (const task of tasks) {
      const rid = (task._regardingobjectid_value || '').replace(/[{}]/g, '').toLowerCase();
      if (rid) taskCountMap.set(rid, (taskCountMap.get(rid) || 0) + 1);
    }
  }
  for (const [rid, count] of taskCountMap) {
    for (const ms of milestoneMap.values()) {
      const msNorm = (ms.msp_engagementmilestoneid || '').replace(/[{}]/g, '').toLowerCase();
      if (msNorm === rid) { ms._taskCount = count; break; }
    }
  }

  // Deal-team members per milestone (best-effort; failures must not block sync).
  const teamChunks = await mapWithConcurrency(
    chunkArray(msIds, 50), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const values = chunk.map((id) => `<value>${id.replace(/[{}]/g, '')}</value>`).join('');
      const teamFetch = `<fetch no-lock="true" distinct="true">
        <entity name="systemuser">
          <attribute name="fullname"/>
          <link-entity name="teammembership" from="systemuserid" to="systemuserid" intersect="true">
            <link-entity name="team" from="teamid" to="teamid" alias="tm">
              <attribute name="regardingobjectid"/>
              <filter type="and">
                <condition attribute="teamtype" operator="eq" value="1"/>
                <condition attribute="teamtemplateid" operator="eq" value="{${MILESTONE_TEAM_TEMPLATE_ID}}"/>
                <condition attribute="regardingobjectid" operator="in">${values}</condition>
              </filter>
            </link-entity>
          </link-entity>
        </entity>
      </fetch>`;
      try {
        const teamMembersResp = await crmRequest({
          path: `/api/data/v9.2/systemusers?fetchXml=${encodeURIComponent(teamFetch)}`,
          method: 'GET',
          getAllPages: true,
        });
        if (teamMembersResp?.ok) return teamMembersResp.data?.value || [];
        console.warn('Deal-team query error:', teamMembersResp?.status, teamMembersResp?.data);
        return [];
      } catch (teamErr) {
        console.warn('Deal-team enrichment failed for chunk:', teamErr);
        return [];
      }
    }
  );
  const dealTeamMap = new Map();
  for (const rows of teamChunks) {
    for (const row of rows) {
      const rid = (row['tm.regardingobjectid'] || '').replace(/[{}]/g, '').toLowerCase();
      const name = row.fullname;
      if (!rid || !name) continue;
      if (!dealTeamMap.has(rid)) dealTeamMap.set(rid, new Set());
      dealTeamMap.get(rid).add(name);
    }
  }

  for (const ms of milestoneMap.values()) {
    const statusLabel = ms['msp_milestonestatus@OData.Community.Display.V1.FormattedValue'] || MILESTONE_STATUS[ms.msp_milestonestatus] || '';
    const custCommitment = ms['msp_customercommitment@OData.Community.Display.V1.FormattedValue'] || CUSTOMER_COMMITMENT[ms.msp_customercommitment] || '';
    const ownerName = ms['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || '';
    const msNorm = (ms.msp_engagementmilestoneid || '').replace(/[{}]/g, '').toLowerCase();
    const teamSet = dealTeamMap.get(msNorm);
    const dealTeamJson = teamSet && teamSet.size > 0 ? JSON.stringify([...teamSet].sort()) : null;
    await dbRun(
      `INSERT INTO milestones (milestone_id, milestone_number, name, opportunity_id, workload, milestone_category, milestone_date, milestone_status, status_reason, commitment_recommendation, customer_commitment, status_label, monthly_use, non_recurring, non_recurring_months, owner_id, forecast_comments, comments_json, task_count, owner_name, deal_team_json, created_on, last_synced_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))
       ON CONFLICT(milestone_id) DO UPDATE SET milestone_number=?, name=?, opportunity_id=?, workload=?, milestone_category=?, milestone_date=?, milestone_status=?, status_reason=?, commitment_recommendation=?, customer_commitment=?, status_label=?, monthly_use=?, non_recurring=?, non_recurring_months=?, owner_id=?, forecast_comments=?, comments_json=?, task_count=?, owner_name=?, deal_team_json=?, created_on=?, last_synced_at=datetime('now'), updated_at=datetime('now')`,
      [
        ms.msp_engagementmilestoneid, ms.msp_milestonenumber, ms.msp_name,
        ms._msp_opportunityid_value, ms['_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue'] || ms._msp_workloadlkid_value,
        ms.msp_milestonecategory, ms.msp_milestonedate, ms.msp_milestonestatus,
        ms.msp_milestonestatusreason, ms.msp_commitmentrecommendation,
        custCommitment, statusLabel,
        ms.msp_monthlyuse, ms.msp_nonrecurring, ms.msp_nonrecurringmonths,
        ms._ownerid_value, ms.msp_forecastcomments, ms.msp_forecastcommentsjsonfield || null,
        ms._taskCount || 0, ownerName, dealTeamJson, ms.createdon,
        ms.msp_milestonenumber, ms.msp_name,
        ms._msp_opportunityid_value, ms['_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue'] || ms._msp_workloadlkid_value,
        ms.msp_milestonecategory, ms.msp_milestonedate, ms.msp_milestonestatus,
        ms.msp_milestonestatusreason, ms.msp_commitmentrecommendation,
        custCommitment, statusLabel,
        ms.msp_monthlyuse, ms.msp_nonrecurring, ms.msp_nonrecurringmonths,
        ms._ownerid_value, ms.msp_forecastcomments, ms.msp_forecastcommentsjsonfield || null,
        ms._taskCount || 0, ownerName, dealTeamJson, ms.createdon,
      ]
    );
  }

  return { opportunities: oppMap.size, milestones: milestoneMap.size, failedRequests };
}

// ── Step 3: HoK activities (fetch + store; implemented in hokActivities.js) ──────────
export async function syncHok() {
  return syncHokTasks();
}

// ── Step 4: Customer contacts (CRM contacts + LinkedIn deep links) ───────────────────
// Pulls the contacts under each tracked account, capturing the LinkedIn profile URL that
// MSX stores on the contact (msp_linkedinprofileurl) plus name/title/email. This is the
// legitimate, ToS-safe slice of the "LinkedIn in Dynamics" story: Sales Navigator never
// mirrors profiles/org charts into Dataverse, but these per-contact deep links DO exist.
const CONTACT_SELECT =
  'contactid,fullname,jobtitle,emailaddress1,msp_linkedinprofileurl,li_companyid,_parentcustomerid_value';

export const syncContacts = () => withCrmSync(syncContactsInternal);
async function syncContactsInternal() {
  // Map each synced account id → its top-parent TPID + name (from the customers table).
  const acctRows = await dbQuery(
    `SELECT crm_account_id, tpid, name FROM active_customers WHERE crm_account_id IS NOT NULL AND crm_account_id <> ''`
  );
  if (!acctRows.length) {
    const err = new Error('No active customer accounts found. Save your roster in User Home and sync customers first.');
    err.code = 'NO_ACCOUNTS';
    throw err;
  }
  await ensureAuth();
  const acctMap = new Map();
  for (const r of acctRows) {
    acctMap.set(String(r.crm_account_id).toLowerCase(), { tpid: r.tpid, name: r.name });
  }
  const accountIds = [...acctMap.keys()];

  let total = 0;
  let withLinkedIn = 0;
  let failedRequests = 0;
  const contactChunks = await mapWithConcurrency(
    chunkArray(accountIds, 15), MAX_CONCURRENT_REQUESTS,
    async (chunk) => {
      const acctFilter = chunk.map((id) => `_parentcustomerid_value eq ${id}`).join(' or ');
      const resp = await crmRequest({
        path: '/api/data/v9.2/contacts',
        method: 'GET',
        getAllPages: true,
        query: { $filter: `(${acctFilter}) and statecode eq 0`, $select: CONTACT_SELECT },
      });
      if (!resp?.ok) {
        console.warn('Contacts query error:', resp?.status, resp?.data);
        failedRequests += 1;
        return [];
      }
      return resp.data?.value || [];
    }
  );
  for (const contacts of contactChunks) {
    for (const c of contacts) {
      const acct = acctMap.get(String(c._parentcustomerid_value || '').toLowerCase()) || {};
      const linkedin = c.msp_linkedinprofileurl || null;
      if (linkedin) withLinkedIn += 1;
      await dbRun(
        `INSERT INTO customer_contacts (contact_id, tpid, account_id, account_name, full_name, job_title, email, linkedin_url, li_company_id, last_synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(contact_id) DO UPDATE SET tpid=?, account_id=?, account_name=?, full_name=?, job_title=?, email=?, linkedin_url=?, li_company_id=?, last_synced_at=datetime('now')`,
        [
          c.contactid, acct.tpid || null, c._parentcustomerid_value || null, acct.name || null,
          c.fullname || null, c.jobtitle || null, c.emailaddress1 || null, linkedin, c.li_companyid || null,
          acct.tpid || null, c._parentcustomerid_value || null, acct.name || null,
          c.fullname || null, c.jobtitle || null, c.emailaddress1 || null, linkedin, c.li_companyid || null,
        ]
      );
      total += 1;
    }
  }

  return { contacts: total, withLinkedIn, failedRequests };
}

// ── Orchestrator: run all steps in dependency order, reporting progress ──────────────
// onStep({ step, status, result?, error? }) is called as each step starts and finishes.
//   step:   'customers' | 'milestones' | 'hok'
//   status: 'running' | 'done' | 'error'
export async function syncAll(onStep) {
  if (!beginSync()) throw new Error('A sync is already running — wait for it to finish and try again.');
  try {
    const steps = [
      { key: 'customers', run: syncCustomers },
      { key: 'milestones', run: syncMilestones },
      { key: 'hok', run: syncHok },
      { key: 'contacts', run: syncContacts },
    ];
    const results = {};
    for (const { key, run } of steps) {
      onStep?.({ step: key, status: 'running' });
      try {
        const result = await run();
        results[key] = result;
        onStep?.({ step: key, status: 'done', result });
      } catch (err) {
        onStep?.({ step: key, status: 'error', error: err });
        throw err;
      }
    }
    return results;
  } finally {
    endSync();
  }
}
