/**
 * owned-accounts.js — derives the customer TPIDs the signed-in user actually works,
 * straight from MSX (Dynamics), so the roster no longer needs manual entry.
 *
 * An SE's book of business shows up across several MSX signals, so we union them all
 * rather than relying on any single one:
 *   1. WhoAmI                 -> systemuserid
 *   2. Milestone-team membership (FetchXML) + milestones/opportunities I own directly
 *   3. Account-team membership (msp_accountteams) -> accounts I'm assigned to, even with
 *      no current milestone (this recovers accounts the milestone-only signal misses)
 *   4. Deal-team membership (msp_dealteams) -> opportunities I'm on the deal team for
 *   5. milestone/opportunity -> account, and account.msp_mstopparentid -> TPID (top-parent)
 *
 * Every signal is best-effort: a failure in any one never blocks the others, so the
 * roster degrades gracefully to whatever signals are available. Each signal's health
 * and contribution is captured in the returned `diagnostics` (per-signal ok/count/error)
 * so a missing account can be investigated instead of a silent black box. The Settings
 * "Detect my accounts" flow merges these into the saved roster (never drops an account
 * you already have) and reconciles the two so any gap is named.
 *
 * crmRequest is injected (msx-ipc.executeCrmRequest): ({path, method, query?, getAllPages?})
 *   -> { ok, status, data:{ value:[...] } }.
 */

const MILESTONE_TEAM_TEMPLATE_ID = '316e4735-9e83-eb11-a812-0022481e1be0';
const API = '/api/data/v9.2';

const { mapWithConcurrency, chunkArray, MAX_CONCURRENT_REQUESTS } = require('./concurrency');

function stripBraces(v) {
  return String(v || '').replace(/[{}]/g, '');
}

async function deriveOwnedAccounts(crmRequest) {
  // 1) Who am I?
  const who = await crmRequest({ path: `${API}/WhoAmI`, method: 'GET' });
  if (!who?.ok) {
    throw new Error('WhoAmI failed — sign in to Microsoft first. ' + JSON.stringify(who?.data || {}));
  }
  const userId = stripBraces(who.data.UserId);

  // Per-signal diagnostics so the user can SEE what each source contributed and
  // which queries failed (instead of silently swallowing them). Surfaced in the
  // Settings "Detect my accounts" result so a missing account can be investigated.
  const diagnostics = { signals: {}, errors: [] };
  const note = (signal, resp, contributed) => {
    const ok = !!resp?.ok;
    const entry = { ok, contributed: contributed || 0 };
    if (!ok) {
      const msg = resp?.data?.message || resp?.data?.error?.message || `HTTP ${resp?.status ?? '?'}`;
      entry.error = String(msg).slice(0, 300);
      diagnostics.errors.push(`${signal}: ${entry.error}`);
    }
    diagnostics.signals[signal] = entry;
  };

  let userName = '';
  try {
    const me = await crmRequest({
      path: `${API}/systemusers(${userId})`,
      method: 'GET',
      query: { $select: 'fullname' },
    });
    if (me?.ok) userName = me.data?.fullname || '';
  } catch { /* non-fatal */ }

  // 2a) Milestones where I'm on the milestone team (the primary SE signal).
  const milestoneIds = new Set();
  const teamFetch = `<fetch no-lock="true" distinct="true">
    <entity name="systemuser">
      <filter><condition attribute="systemuserid" operator="eq" value="${userId}"/></filter>
      <link-entity name="teammembership" from="systemuserid" to="systemuserid" intersect="true">
        <link-entity name="team" from="teamid" to="teamid" alias="tm">
          <attribute name="regardingobjectid"/>
          <filter type="and">
            <condition attribute="teamtype" operator="eq" value="1"/>
            <condition attribute="teamtemplateid" operator="eq" value="{${MILESTONE_TEAM_TEMPLATE_ID}}"/>
          </filter>
        </link-entity>
      </link-entity>
    </entity>
  </fetch>`;
  try {
    const teamResp = await crmRequest({
      path: `${API}/systemusers?fetchXml=${encodeURIComponent(teamFetch)}`,
      method: 'GET',
      getAllPages: true,
    });
    let n = 0;
    if (teamResp?.ok) {
      for (const row of teamResp.data?.value || []) {
        const id = stripBraces(row['tm.regardingobjectid']);
        if (id) { milestoneIds.add(id.toLowerCase()); n += 1; }
      }
    }
    note('milestoneTeam', teamResp, n);
  } catch (e) { note('milestoneTeam', { ok: false, data: { message: e.message } }, 0); }

  // 2b) Milestones I own directly (union).
  try {
    const ownedMs = await crmRequest({
      path: `${API}/msp_engagementmilestones`,
      method: 'GET',
      getAllPages: true,
      query: { $filter: `_ownerid_value eq ${userId}`, $select: 'msp_engagementmilestoneid' },
    });
    let n = 0;
    if (ownedMs?.ok) {
      for (const m of ownedMs.data?.value || []) {
        const id = stripBraces(m.msp_engagementmilestoneid);
        if (id) { milestoneIds.add(id.toLowerCase()); n += 1; }
      }
    }
    note('ownedMilestones', ownedMs, n);
  } catch (e) { note('ownedMilestones', { ok: false, data: { message: e.message } }, 0); }

  // Shared accumulators. Declared here so the account-team / deal-team signals below
  // can seed them before the milestone/opportunity resolution fills them further.
  const opportunityIds = new Set();
  const accountIds = new Set();
  const directAccounts = []; // { accountId, name, tpid } resolved without the step-5 lookup

  // 2c) Account-team membership — the accounts I'm assigned to, independent of any
  // milestone. Recovers accounts where I'm on the account team but currently have no
  // milestone-team membership (the milestone-only signal misses these). Primary query
  // expands msp_AccountId so we get name + TPID directly; on failure (schema/plugin
  // variance) fall back to the native team-membership association.
  let accountTeamCount = 0;
  try {
    const at = await crmRequest({
      path: `${API}/msp_accountteams`,
      method: 'GET',
      getAllPages: true,
      query: {
        $filter: `_msp_systemuserid_value eq ${userId}`,
        $select: 'msp_accountteamid',
        $expand: 'msp_AccountId($select=accountid,name,msp_mstopparentid)',
      },
    });
    if (at?.ok) {
      for (const row of at.data?.value || []) {
        const acct = row.msp_AccountId;
        if (!acct) continue;
        const aid = stripBraces(acct.accountid);
        if (aid) accountIds.add(aid.toLowerCase());
        const tpid = String(acct.msp_mstopparentid || '').trim();
        if (tpid) directAccounts.push({ accountId: aid, name: acct.name || `TPID ${tpid}`, tpid });
        accountTeamCount += 1;
      }
      note('accountTeam', at, accountTeamCount);
    } else {
      // Fallback: native access-team membership (teamtype 1) whose regarding record is
      // an account. Works even when the msp_accountteams virtual table is unavailable.
      const assoc = await crmRequest({
        path: `${API}/systemusers(${userId})/teammembership_association`,
        method: 'GET',
        getAllPages: true,
        query: { $select: 'name,_regardingobjectid_value', $filter: 'teamtype eq 1' },
      });
      if (assoc?.ok) {
        for (const t of assoc.data?.value || []) {
          if (t['_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] !== 'account') continue;
          const aid = stripBraces(t._regardingobjectid_value);
          if (aid) { accountIds.add(aid.toLowerCase()); accountTeamCount += 1; }
        }
      }
      // Report the fallback's health (or the original failure if the fallback also failed).
      note('accountTeam', assoc?.ok ? assoc : at, accountTeamCount);
    }
  } catch (e) { note('accountTeam', { ok: false, data: { message: e.message } }, accountTeamCount); }

  // 2d) Deal-team membership — opportunities where I'm on the deal team (not just the
  // owner). Feeds the opportunity -> account resolution below.
  let dealTeamCount = 0;
  try {
    const dt = await crmRequest({
      path: `${API}/msp_dealteams`,
      method: 'GET',
      getAllPages: true,
      query: { $filter: `_msp_dealteamuserid_value eq ${userId} and statecode eq 0`, $select: '_msp_parentopportunityid_value' },
    });
    if (dt?.ok) {
      for (const r of dt.data?.value || []) {
        const oid = stripBraces(r._msp_parentopportunityid_value);
        if (oid) { opportunityIds.add(oid.toLowerCase()); dealTeamCount += 1; }
      }
    }
    note('dealTeam', dt, dealTeamCount);
  } catch (e) { note('dealTeam', { ok: false, data: { message: e.message } }, dealTeamCount); }

  // 3) Milestones -> opportunities (chunks fetched in parallel).
  const oppIdChunks = await mapWithConcurrency(
    chunkArray([...milestoneIds], 20), MAX_CONCURRENT_REQUESTS,
    async (ids) => {
      const filter = ids.map((id) => `msp_engagementmilestoneid eq ${id}`).join(' or ');
      const resp = await crmRequest({
        path: `${API}/msp_engagementmilestones`,
        method: 'GET',
        getAllPages: true,
        query: { $filter: filter, $select: '_msp_opportunityid_value' },
      });
      return resp?.ok ? (resp.data?.value || []) : [];
    }
  );
  for (const rows of oppIdChunks) {
    for (const m of rows) {
      const oid = stripBraces(m._msp_opportunityid_value);
      if (oid) opportunityIds.add(oid.toLowerCase());
    }
  }

  // 3b) Opportunities I own directly (union).
  try {
    const ownedOpps = await crmRequest({
      path: `${API}/opportunities`,
      method: 'GET',
      getAllPages: true,
      query: { $filter: `_ownerid_value eq ${userId}`, $select: 'opportunityid' },
    });
    let n = 0;
    if (ownedOpps?.ok) {
      for (const o of ownedOpps.data?.value || []) {
        const oid = stripBraces(o.opportunityid);
        if (oid) { opportunityIds.add(oid.toLowerCase()); n += 1; }
      }
    }
    note('ownedOpportunities', ownedOpps, n);
  } catch (e) { note('ownedOpportunities', { ok: false, data: { message: e.message } }, 0); }

  // 4) Opportunities -> parent accounts (chunks fetched in parallel).
  const acctIdChunks = await mapWithConcurrency(
    chunkArray([...opportunityIds], 20), MAX_CONCURRENT_REQUESTS,
    async (ids) => {
      const filter = ids.map((id) => `opportunityid eq ${id}`).join(' or ');
      const resp = await crmRequest({
        path: `${API}/opportunities`,
        method: 'GET',
        getAllPages: true,
        query: { $filter: filter, $select: '_parentaccountid_value' },
      });
      return resp?.ok ? (resp.data?.value || []) : [];
    }
  );
  for (const rows of acctIdChunks) {
    for (const o of rows) {
      const aid = stripBraces(o._parentaccountid_value);
      if (aid) accountIds.add(aid.toLowerCase());
    }
  }

  // 5) Accounts -> TPID (msp_mstopparentid) + name (chunks fetched in parallel).
  const byTpid = new Map(); // tpid -> { tpid, name, accountId }
  // Pre-seed with account-team accounts already resolved (name + TPID via the expand),
  // so they survive even if the accounts lookup below is throttled or partial.
  for (const a of directAccounts) {
    if (a.tpid && !byTpid.has(a.tpid)) {
      byTpid.set(a.tpid, { tpid: a.tpid, name: a.name || `TPID ${a.tpid}`, accountId: a.accountId });
    }
  }
  const acctChunks = await mapWithConcurrency(
    chunkArray([...accountIds], 25), MAX_CONCURRENT_REQUESTS,
    async (ids) => {
      const filter = ids.map((id) => `accountid eq ${id}`).join(' or ');
      const resp = await crmRequest({
        path: `${API}/accounts`,
        method: 'GET',
        getAllPages: true,
        query: { $filter: filter, $select: 'accountid,name,msp_mstopparentid' },
      });
      return resp?.ok ? (resp.data?.value || []) : [];
    }
  );
  for (const rows of acctChunks) {
    for (const a of rows) {
      const tpid = String(a.msp_mstopparentid || '').trim();
      if (!tpid) continue;
      if (!byTpid.has(tpid)) {
        byTpid.set(tpid, { tpid, name: a.name || `TPID ${tpid}`, accountId: a.accountid });
      }
    }
  }

  const accounts = [...byTpid.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    userId,
    userName,
    tpids: accounts.map((a) => a.tpid),
    accounts,
    counts: {
      milestones: milestoneIds.size,
      opportunities: opportunityIds.size,
      accountTeams: accountTeamCount,
      accounts: accountIds.size,
      tpids: accounts.length,
    },
    diagnostics,
  };
}

module.exports = { deriveOwnedAccounts, MILESTONE_TEAM_TEMPLATE_ID };
