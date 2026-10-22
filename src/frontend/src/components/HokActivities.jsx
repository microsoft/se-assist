import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Button, Spinner } from '@fluentui/react-components';
import { OpenRegular, DismissRegular, ChevronRightRegular, ChevronDownRegular } from '@fluentui/react-icons';
import { dbQuery, getMsxSettings, openExternal } from '../electronBridge';
import { fetchTerritoryHokTasks } from '../lib/hokActivities';
import { normId, inFiscalYear, FY_LABEL } from '../lib/milestoneMetrics';
import { useTerritory } from '../territoryContext';
import { FilterDropdown, DetailCard } from './Milestones';
import { useTeamApi } from '../hooks/useTeamApi';

// statecode → badge class for MSX activities/tasks
const ACTIVITY_STATE_BADGE = {
  0: 'badge-warning',   // Open
  1: 'badge-success',   // Completed
  2: 'badge-secondary', // Canceled
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

// (normId comes from ../lib/milestoneMetrics.)

// ── HoK Activities (all MSX tasks owned by the current user) ──────────
// Proof-of-concept and other delivery work is tracked as per-milestone tasks
// (HoK activities) in MSX, so this view surfaces those activities directly.
export default function HokActivities() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tpid = searchParams.get('tpid') || '';
  // Optional fiscal-year filter (?fy=…) — set by the Excellence Metrics "HoK Activities FY27"
  // tile so the destination list matches that FY-windowed count.
  const fyOnly = !!searchParams.get('fy');
  // HoK Activities is always your own worklist — no territory toggle on this page.
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const [activities, setActivities] = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [acctFilter, setAcctFilter] = useState(new Set());   // empty = all accounts
  const [ownerFilter, setOwnerFilter] = useState(new Set());  // empty = all owners; SSP pick narrows to one
  // Cloud & AI Specialist names for the Filter's pinned quick-picks, from the shared context.
  const { sspNames } = useTerritory();
  // Customer scope (from ?tpid=): the set of regarding-record GUIDs (milestones,
  // opportunities, accounts) belonging to that customer family, plus its name.
  const [custScope, setCustScope] = useState(null); // { name, ids: Set } | null
  // Lookup indexes to resolve a task's regarding record → Account / Opportunity /
  // Milestone. Keyed by normalized GUID.
  const [regIndex, setRegIndex] = useState(null); // { ms, opp, acc } | null
  const [customerRows, setCustomerRows] = useState([]); // roster for top-parent rollup
  const [msDetail, setMsDetail] = useState(null); // clicked milestone-regarding row → shared DetailCard
  const [flash, setFlash] = useState(null); // { type, msg } surfaced from deal-team actions
  const [collapsedAccts, setCollapsedAccts] = useState({}); // account label -> true when collapsed

  useEffect(() => {
    getMsxSettings().then(s => setCrmBaseUrl(s.crmUrl || '')).catch(() => {});
  }, []);

  // Build the regarding → (account, opportunity, milestone) resolution indexes.
  // The milestone rows carry the full field set the shared DetailCard needs, plus
  // the opportunity owner name so the Cloud & AI Specialist quick-pick can filter
  // by opportunity owner (matching the Milestones / Milestone Timeline convention).
  const loadRegIndex = useCallback(async () => {
    const [msRows, oppRows, accRows, custRows] = await Promise.all([
      dbQuery(
        `SELECT m.milestone_id, m.name, m.opportunity_id, m.milestone_date, m.created_on,
                m.status_label, m.milestone_status, m.owner_name, m.comments_json,
                m.task_count, m.deal_team_json, m.commitment_recommendation, m.monthly_use,
                o.name AS opp_name, o.customer_name, o.owner_name AS opp_owner_name, o.parent_account_id
         FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id`
      ),
      dbQuery(`SELECT opportunity_id AS id, name AS opp_name, customer_name, owner_name AS opp_owner_name, parent_account_id FROM active_opportunities`),
      dbQuery(`SELECT crm_account_id AS id, name FROM active_customers WHERE crm_account_id IS NOT NULL`),
      dbQuery(`SELECT name, tpid, crm_account_id, parent_crm_account_id, parenting_level FROM active_customers`),
    ]);
    const ms = new Map(), opp = new Map(), acc = new Map();
    for (const r of msRows || []) ms.set(normId(r.milestone_id), r);
    for (const r of oppRows || []) opp.set(normId(r.id), r);
    for (const r of accRows || []) acc.set(normId(r.id), r);
    setRegIndex({ ms, opp, acc });
    setCustomerRows(custRows || []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRegIndex().catch(() => {
      if (!cancelled) setRegIndex({ ms: new Map(), opp: new Map(), acc: new Map() });
    });
    return () => { cancelled = true; };
  }, [loadRegIndex]);

  // Same deal-team / comment / activity actions the Milestone Map uses, so the
  // shared DetailCard behaves identically here.
  const teamApi = useTeamApi({ refresh: loadRegIndex, onFlash: setFlash });

  // Roll accounts up to their TPID's top-parent account name, matching the
  // Milestones page. A child account like "Fabrikam Subsidiary" shares
  // its parent's TPID and therefore groups under "Fabrikam Group" rather than
  // appearing as its own section.
  const accountLabelFor = useMemo(() => {
    const tpidByAccId = new Map();
    const accsByTpid = new Map();
    for (const c of customerRows || []) {
      if (c.crm_account_id) tpidByAccId.set(normId(c.crm_account_id), c.tpid || null);
      if (c.tpid) {
        if (!accsByTpid.has(c.tpid)) accsByTpid.set(c.tpid, []);
        accsByTpid.get(c.tpid).push(c);
      }
    }
    // Top-parent per TPID: prefer the parenting_level flag, else the account with
    // no parent, else the first account in the group.
    const topNameByTpid = new Map();
    for (const [tpid, accs] of accsByTpid) {
      const top = accs.find((a) => a.parenting_level === 861980000)
        || accs.find((a) => !a.parent_crm_account_id)
        || accs[0];
      if (top) topNameByTpid.set(tpid, top.name);
    }
    return (accId, fallbackName) => {
      const tpid = accId ? tpidByAccId.get(normId(accId)) : null;
      return (tpid && topNameByTpid.get(tpid)) || fallbackName || '—';
    };
  }, [customerRows]);

  // Resolve a task's regarding record to its Account / Opportunity / Milestone.
  // Most HoK activities regard a milestone; some regard an opportunity or account.
  // `account` is the TPID top-parent label (rollup); `oppOwner` drives the Cloud &
  // AI Specialist filter; `msRow` (when present) is the full milestone record for
  // the shared DetailCard.
  const resolveReg = (a) => {
    const id = normId(a._regardingobjectid_value);
    if (id && regIndex) {
      if (regIndex.ms.has(id)) {
        const r = regIndex.ms.get(id);
        return { account: accountLabelFor(r.parent_account_id, r.customer_name), opp: r.opp_name || '—', milestone: r.name || '—', oppOwner: r.opp_owner_name || 'Unassigned', msRow: r };
      }
      if (regIndex.opp.has(id)) {
        const r = regIndex.opp.get(id);
        return { account: accountLabelFor(r.parent_account_id, r.customer_name), opp: r.opp_name || '—', milestone: '—', oppOwner: r.opp_owner_name || 'Unassigned', msRow: null };
      }
      if (regIndex.acc.has(id)) {
        const r = regIndex.acc.get(id);
        return { account: accountLabelFor(r.id, r.name), opp: '—', milestone: '—', oppOwner: 'Unassigned', msRow: null };
      }
    }
    return { account: '—', opp: '—', milestone: '—', oppOwner: 'Unassigned', msRow: null };
  };

  // Resolve the customer scope when a ?tpid= param is present.
  useEffect(() => {
    let cancelled = false;
    if (!tpid) { setCustScope(null); return; }
    (async () => {
      try {
        const [idRows, nameRows] = await Promise.all([
          dbQuery(
            `SELECT m.milestone_id AS id FROM active_milestones m
               JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
               JOIN active_customers c ON o.parent_account_id = c.crm_account_id
               WHERE c.tpid = ?
             UNION
             SELECT o.opportunity_id AS id FROM active_opportunities o
               JOIN active_customers c ON o.parent_account_id = c.crm_account_id
               WHERE c.tpid = ?
             UNION
             SELECT crm_account_id AS id FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL`,
            [tpid, tpid, tpid]
          ),
          dbQuery(
            `SELECT name FROM active_customers WHERE tpid = ?
             ORDER BY (parenting_level = 861980000) DESC, (parent_crm_account_id IS NULL OR parent_crm_account_id = '') DESC
             LIMIT 1`,
            [tpid]
          ),
        ]);
        if (cancelled) return;
        const ids = new Set((idRows || []).map(r => normId(r.id)).filter(Boolean));
        setCustScope({ name: nameRows?.[0]?.name || `TPID ${tpid}`, ids });
      } catch {
        if (!cancelled) setCustScope({ name: `TPID ${tpid}`, ids: new Set() });
      }
    })();
    return () => { cancelled = true; };
  }, [tpid]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setActivities(await fetchTerritoryHokTasks({ scope: 'mine' }));
    } catch (e) {
      setError(e.message || String(e));
      setActivities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const taskLink = (a) => (a.activityid && crmBaseUrl)
    ? `${crmBaseUrl}/main.aspx?etn=task&id=${a.activityid}&pagetype=entityrecord`
    : null;

  // Distinct resolved account names for the Filter's option list (excludes unresolved).
  const accountNames = useMemo(() => {
    const set = new Set();
    for (const a of activities || []) {
      const acct = resolveReg(a).account;
      if (acct && acct !== '—') set.add(acct);
    }
    return [...set].sort();
  }, [activities, regIndex, accountLabelFor]);

  const ownerActive = ownerFilter.size > 0;

  const filtered = (activities || []).filter((a) => {
    // Customer scope: keep only tasks whose regarding record belongs to the customer.
    if (tpid && custScope) {
      if (!custScope.ids.has(normId(a._regardingobjectid_value))) return false;
    }
    // Fiscal-year filter (from the Excellence Metrics tile): keep only this FY's activities.
    if (fyOnly && !inFiscalYear(a.createdon)) return false;
    // Account Filter (single-select): empty set = all accounts.
    if (acctFilter.size > 0 && !acctFilter.has(resolveReg(a).account)) return false;
    // Cloud & AI Specialist quick-pick narrows to activities whose opportunity is
    // owned by that person (matches the Milestones / Milestone Timeline convention).
    if (ownerActive && !ownerFilter.has(resolveReg(a).oppOwner)) return false;
    return true;
  });

  // Ordered list of account-group labels (used by expand/collapse all).
  const acctKeys = useMemo(() => {
    const seen = [];
    const set = new Set();
    for (const a of filtered) {
      const acct = resolveReg(a).account || '—';
      if (!set.has(acct)) { set.add(acct); seen.push(acct); }
    }
    return seen;
  }, [filtered]);
  const toggleAcct = useCallback((acct) => setCollapsedAccts((p) => ({ ...p, [acct]: !p[acct] })), []);
  const expandAllAccts = useCallback(() => setCollapsedAccts({}), []);
  const collapseAllAccts = useCallback(() => {
    const all = {};
    for (const a of acctKeys) all[a] = true;
    setCollapsedAccts(all);
  }, [acctKeys]);

  function clearCustomer() {
    const next = new URLSearchParams(searchParams);
    next.delete('tpid');
    setSearchParams(next);
  }
  function clearFy() {
    const next = new URLSearchParams(searchParams);
    next.delete('fy');
    setSearchParams(next);
  }

  return (
    <div className="list-page">
      <div className="page-header">
        <div className="page-header-left">
          <h2>HoK Activities</h2>
          <div className="diagram-filters">
            <FilterDropdown
              label="Filter"
              single
              options={accountNames}
              selected={acctFilter}
              onChange={setAcctFilter}
              pinned={{
                label: 'Cloud & AI Specialists',
                options: sspNames,
                isActive: (name) => ownerFilter.size === 1 && ownerFilter.has(name),
                onPick: (name) => setOwnerFilter((prev) =>
                  (prev && prev.size === 1 && prev.has(name))
                    ? new Set()          // toggle off → all owners
                    : new Set([name])
                ),
              }}
            />
          </div>
        </div>
      </div>

      {tpid && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Customer: {custScope?.name || `TPID ${tpid}`}
            <DismissRegular style={{ fontSize: 12, cursor: 'pointer' }} onClick={clearCustomer} title="Clear customer filter" />
          </span>
          <Link to="/hok-activities" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none' }}>
            Show all
          </Link>
        </div>
      )}

      {fyOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Showing {FY_LABEL} activities only
            <DismissRegular style={{ fontSize: 12, cursor: 'pointer' }} onClick={clearFy} title={`Clear ${FY_LABEL} filter`} />
          </span>
        </div>
      )}

      {error && <div className="flash-error flash-message">{error}</div>}

      {loading && activities === null ? (
        <Spinner label="Loading activities…" />
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          {error
            ? 'Could not load activities.'
            : tpid
            ? `No activities found for ${custScope?.name || 'this customer'}.`
            : 'No activities cached yet. Run “Sync from CRM” in Settings to pull HoK activities.'}
        </p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  Opportunity
                  <span className="mt-head-toggle" style={{ fontSize: 11 }}>
                    (<button type="button" className="mt-link-btn" onClick={expandAllAccts}>expand</button>
                    /<button type="button" className="mt-link-btn" onClick={collapseAllAccts}>collapse</button>)
                  </span>
                </span>
              </th>
              <th>Milestone</th>
              <th>Subject</th>
              <th>Category</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const groups = [];
              const idx = new Map();
              for (const a of filtered) {
                const reg = resolveReg(a);
                const acct = reg.account || '—';
                let g = idx.get(acct);
                if (!g) { g = { account: acct, rows: [] }; idx.set(acct, g); groups.push(g); }
                g.rows.push({ a, reg });
              }
              return groups.map((group) => {
                const isCollapsed = !!collapsedAccts[group.account];
                return (
                <Fragment key={`grp-${group.account}`}>
                  <tr className="tbl-account-section tbl-row-clickable" onClick={() => toggleAcct(group.account)} style={{ cursor: 'pointer' }}>
                    <td colSpan={8}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {isCollapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
                        {group.account}
                        <span style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 12 }}>({group.rows.length})</span>
                      </span>
                    </td>
                  </tr>
                  {!isCollapsed && group.rows.map(({ a, reg }) => {
              const tlink = taskLink(a);
              const stateBadge = ACTIVITY_STATE_BADGE[a.statecode] || 'badge-secondary';
              const stateLabel = a['statecode@OData.Community.Display.V1.FormattedValue'] || '—';
              // Rows that regard a milestone open the shared milestone details panel.
              const openDetail = reg.msRow
                ? () => setMsDetail({ type: 'ms', data: reg.msRow })
                : null;
              return (
                <tr
                  key={a.activityid}
                  onClick={openDetail || undefined}
                  className={openDetail ? 'tbl-row-clickable' : undefined}
                  style={openDetail ? { cursor: 'pointer' } : undefined}
                  title={openDetail ? 'Click for milestone details' : undefined}
                >
                  <td>{reg.opp}</td>
                  <td style={{ fontWeight: 600 }}>{reg.milestone}</td>
                  <td>{a.subject || '(no subject)'}</td>
                  <td>{a['msp_taskcategory@OData.Community.Display.V1.FormattedValue'] || '—'}</td>
                  <td>{a['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || '—'}</td>
                  <td>
                    <span className={`badge ${stateBadge}`}>{stateLabel}</span>
                  </td>
                  <td>{fmtDate(a.createdon)}</td>
                  <td>
                    {tlink && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<OpenRegular />}
                        title="Open activity in MSX"
                        onClick={(e) => { e.stopPropagation(); openExternal(tlink); }}
                      />
                    )}
                  </td>
                </tr>
              );
                  })}
                </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
        </div>
      )}

      {/* Milestone details — same shared panel used by the Milestone Map / Timeline */}
      <DetailCard
        detail={msDetail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setMsDetail(null)}
        onSelect={setMsDetail}
        teamApi={teamApi}
      />

      {flash && (
        <div className={`flash-message ${flash.type === 'error' ? 'flash-error' : 'flash-success'}`}>
          {flash.msg}
        </div>
      )}
    </div>
  );
}
