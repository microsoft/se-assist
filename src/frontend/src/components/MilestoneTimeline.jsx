import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from '@fluentui/react-components';
import {
  ChevronRightRegular, ChevronDownRegular, ChevronLeftRegular,
  CalendarTodayRegular, CommentRegular, TaskListSquareLtrRegular,
  TargetRegular, FlagRegular, DismissRegular, InfoRegular,
  OrganizationRegular, ContactCardRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { useTeamApi } from '../hooks/useTeamApi';
import { useTerritory } from '../territoryContext';
import TerritoryToggle from './TerritoryToggle';
import { getMsxSettings, openExternal } from '../electronBridge';
import { DetailCard, FilterDropdown, buildOppDetail } from './Milestones';
import { parseTeamList, normId, SSP_ROLES_SQL } from '../lib/milestoneMetrics';
import { formatDateOnly } from '../lib/datetime';
import { AccountGlanceModal } from './CustomerActivity';

// ── Date helpers (all local timezone) ────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const quarterOf = (d) => Math.floor(d.getMonth() / 3);
const startOfQuarter = (d) => new Date(d.getFullYear(), quarterOf(d) * 3, 1);
// Microsoft fiscal year starts July 1 the previous calendar year. FY26 Q1 = Jul–Sep 2025.
// Fiscal quarters align to calendar-quarter month boundaries (Jul, Oct, Jan, Apr).
const fiscalYearOf = (d) => (d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear());
const fiscalQuarterOf = (d) => (((d.getMonth() + 6) % 12) / 3 | 0) + 1; // Jul→Q1 … Jun→Q4
const fiscalQuarterLabel = (d) => `FY${String(fiscalYearOf(d)).slice(-2)} Q${fiscalQuarterOf(d)}`;
const fmtMonth = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const fmtDate = (d) => (d ? d.toLocaleDateString() : '—');
const fmtDateTime = (d) => (d ? d.toLocaleString() : '—');

const STATE_LABELS = { 0: 'Open', 1: 'Completed', 2: 'Canceled' };

// Commitment recommendation option-set: 861980000 = Uncommitted, 861980003 = Committed.
const COMMIT_COMMITTED = 861980003;
const isCommitted = (m) => Number(m.commitment_recommendation) === COMMIT_COMMITTED;
// A milestone is "inactive" (hidden by the Active-only filter) if its status is
// completed, cancelled, a hygiene/duplicate record, or lost to a competitor.
function isInactiveMilestone(m) {
  const s = (m.status_label || '').toLowerCase();
  return s.includes('complete') || s.includes('cancel') || s.includes('duplicate') || s.includes('lost to competitor');
}

// Row accent for at-a-glance risk: Blocked → light red, At Risk → light yellow.
function riskClass(m) {
  const s = (m.status_label || '').toLowerCase();
  if (s.includes('blocked')) return ' mt-ms-blocked';
  if (s.includes('at risk')) return ' mt-ms-atrisk';
  return '';
}

// Mirror of Milestones.jsx parseComments: [{userId, modifiedOn, comment}] → sorted newest-first.
function parseComments(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((i) => ({ poster: i?.userId || 'Unknown', date: i?.modifiedOn || '', text: i?.comment || '' }))
      .filter((i) => i.text)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch { return []; }
}

export default function MilestoneTimeline() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusTpid = (searchParams.get('tpid') || '').trim();
  const { data: customers } = useDbQuery(
    'SELECT name, tpid, crm_account_id, parent_crm_account_id, parenting_level FROM active_customers'
  );
  const { data: opps } = useDbQuery(
    `SELECT opportunity_id, name, customer_name, parent_account_id, owner_name,
            estimated_close_date, created_on, created_at, state_code, customer_need
     FROM active_opportunities`
  );
  const { data: milestones, refresh: refreshMilestones } = useDbQuery(
    `SELECT milestone_id, name, opportunity_id, milestone_date, created_on, created_at,
            status_label, milestone_status, owner_name, comments_json, task_count, deal_team_json,
            commitment_recommendation, monthly_use
     FROM active_milestones`
  );
  const { data: sspRoles } = useDbQuery(SSP_ROLES_SQL);
  const { data: hok } = useDbQuery(
    `SELECT activity_id, subject, created_on, scheduled_end, state_code, owner_name,
            regarding_id, regarding_type FROM active_hok_tasks`
  );

  const [anchor, setAnchor] = useState(() => startOfQuarter(new Date()));
  const [collapsed, setCollapsed] = useState({}); // tpid -> true when collapsed
  const [hokDetail, setHokDetail] = useState(null);
  const [msDetail, setMsDetail] = useState(null); // clicked milestone → shared DetailCard
  const [glance, setGlance] = useState(null); // { tpid, name } | null — account glance popup
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const [flash, setFlash] = useState(null); // { type, msg } surfaced from deal-team actions
  const [activeOnly, setActiveOnly] = useState(true); // hide completed/cancelled/duplicate
  const [uncommittedOnly, setUncommittedOnly] = useState(true); // hide committed
  const [acctFilter, setAcctFilter] = useState(new Set());  // empty = all accounts
  const [ownerFilter, setOwnerFilter] = useState(new Set()); // empty = all owners; SSP pick narrows to one
  const isYear = true; // timeline is fixed to the year (quarter-segmented) view

  const { myOnly, scope, currentUserName, sspNames, scopeFiltersMilestones, matchesScope } = useTerritory();
  // Same deal-team / comment / activity actions the Milestone Map uses, so the
  // shared DetailCard behaves identically here.
  const teamApi = useTeamApi({ refresh: refreshMilestones, onFlash: setFlash });

  useEffect(() => {
    getMsxSettings().then(s => setCrmBaseUrl(s.crmUrl || '')).catch(() => {});
  }, []);

  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  // Cloud and AI Specialist (SSP) name per top account, from the manually-maintained
  // Account Team roster (customer_account_team_roles). Keyed by TPID.
  const sspByTpid = useMemo(() => {
    const map = new Map();
    for (const r of sspRoles || []) {
      if (r.tpid && r.person_name) map.set(String(r.tpid), r.person_name);
    }
    return map;
  }, [sspRoles]);

  // `sspNames` (filter quick-picks) and the Discover scope predicate come from the shared
  // territory context. `sspByTpid` above still uses the tpid-keyed roster for display.

  // Top-parent account names that have at least one opportunity — the account
  // Filter's option list. Built independently of the Active/Uncommitted/My filters
  // so the options stay stable as those toggle. Mirrors the tree's group naming.
  const accountNames = useMemo(() => {
    if (!customers || !opps) return [];
    const accById = new Map();
    for (const c of customers) if (c.crm_account_id) accById.set(c.crm_account_id, c);
    const byTpid = new Map();
    for (const c of customers) {
      if (!c.tpid) continue;
      if (!byTpid.has(c.tpid)) byTpid.set(c.tpid, []);
      byTpid.get(c.tpid).push(c);
    }
    const tpidsWithOpps = new Set();
    for (const o of opps) {
      const acc = o.parent_account_id ? accById.get(o.parent_account_id) : null;
      if (acc?.tpid) tpidsWithOpps.add(acc.tpid);
    }
    const names = [];
    for (const [tpid, accounts] of byTpid.entries()) {
      if (!tpidsWithOpps.has(tpid)) continue;
      const topParent =
        accounts.find((a) => a.parenting_level === 861980000) ||
        accounts.find((a) => !a.parent_crm_account_id) ||
        accounts[0];
      names.push(topParent?.name || 'Account');
    }
    return [...new Set(names)].sort();
  }, [customers, opps]);

  // TPID → top-parent account name, mirroring the account Filter's naming, so a
  // ?tpid= deep link (from the customer profile) can pre-select the account filter.
  const tpidToName = useMemo(() => {
    const map = new Map();
    if (!customers) return map;
    const byTpid = new Map();
    for (const c of customers) {
      if (!c.tpid) continue;
      if (!byTpid.has(c.tpid)) byTpid.set(c.tpid, []);
      byTpid.get(c.tpid).push(c);
    }
    for (const [tpid, accounts] of byTpid.entries()) {
      const topParent =
        accounts.find((a) => a.parenting_level === 861980000) ||
        accounts.find((a) => !a.parent_crm_account_id) ||
        accounts[0];
      map.set(String(tpid), topParent?.name || 'Account');
    }
    return map;
  }, [customers]);

  // Apply a ?tpid= deep link once (per distinct tpid) by pre-selecting its account
  // in the Filter. Guarded by a ref so it never clobbers later manual filter changes.
  const appliedTpidRef = useRef(null);
  useEffect(() => {
    if (!focusTpid || appliedTpidRef.current === focusTpid) return;
    const name = tpidToName.get(String(focusTpid));
    if (!name) return; // wait until customers load / name resolves
    setAcctFilter(new Set([name]));
    appliedTpidRef.current = focusTpid;
  }, [focusTpid, tpidToName]);

  // Owner filter is "active" only when a subset (not all / not none) is chosen.
  const ownerActive = ownerFilter.size > 0;

  // Visible window + header segments depend on the view mode:
  //  • 3-month: prev / current / next month; nav shifts by 1 month.
  //  • year: 12 months starting at the anchor's quarter, split into Q1–Q4
  //    header segments; nav shifts by 1 quarter (3 months).
  let windowStart, windowEnd;
  if (isYear) {
    windowStart = startOfQuarter(anchor);
    windowEnd = endOfMonth(addMonths(windowStart, 11));
  } else {
    windowStart = startOfMonth(addMonths(anchor, -1));
    windowEnd = endOfMonth(addMonths(anchor, 1));
  }
  const windowMs = windowEnd.getTime() - windowStart.getTime();
  const pct = (d) => ((d.getTime() - windowStart.getTime()) / windowMs) * 100;

  // Header segments (quarters in year view, months otherwise).
  const segments = isYear
    ? [0, 3, 6, 9].map((n) => {
        const qs = addMonths(windowStart, n);
        const qe = endOfMonth(addMonths(qs, 2));
        return { key: qs.toISOString(), label: fiscalQuarterLabel(qs), left: pct(qs), width: pct(qe) - pct(qs) };
      })
    : [-1, 0, 1].map((n) => {
        const ms = addMonths(anchor, n);
        const me = endOfMonth(ms);
        return { key: ms.toISOString(), label: fmtMonth(ms), left: pct(ms), width: pct(me) - pct(ms) };
      });
  const boundaries = segments.slice(1).map((s) => s.left);
  const rangeLabel = isYear
    ? `${fiscalQuarterLabel(windowStart)} – ${fiscalQuarterLabel(addMonths(windowStart, 9))}`
    : `${fmtMonth(addMonths(anchor, -1))} – ${fmtMonth(addMonths(anchor, 1))}`;
  const now = new Date();
  const todayPct = now >= windowStart && now <= windowEnd ? pct(now) : null;

  // Navigation: step size is a quarter in year view, a month otherwise.
  const shift = (dir) => setAnchor((a) => addMonths(a, dir * (isYear ? 3 : 1)));
  const goToday = () => setAnchor(isYear ? startOfQuarter(new Date()) : startOfMonth(new Date()));

  // ── Build Account (top TPID) → Opportunity → Milestone hierarchy ────
  const tree = useMemo(() => {
    if (!customers || !opps) return [];
    const accById = new Map();
    for (const c of customers) if (c.crm_account_id) accById.set(c.crm_account_id, c);

    const byTpid = new Map();
    for (const c of customers) {
      if (!c.tpid) continue;
      if (!byTpid.has(c.tpid)) byTpid.set(c.tpid, []);
      byTpid.get(c.tpid).push(c);
    }

    const msByOpp = new Map();
    for (const m of milestones || []) {
      if (!msByOpp.has(m.opportunity_id)) msByOpp.set(m.opportunity_id, []);
      msByOpp.get(m.opportunity_id).push(m);
    }

    const hokByReg = new Map();
    for (const t of hok || []) {
      const k = normId(t.regarding_id);
      if (!k) continue;
      if (!hokByReg.has(k)) hokByReg.set(k, []);
      hokByReg.get(k).push(t);
    }

    // Territory scope: 'mine' keeps milestones I'm on the deal team of; 'discover' keeps
    // the complement (candidates to join). 'all' applies no membership filter.
    // Territory scope (mine/discover/all) — the shared predicate is the single source of truth.
    const scopeActive = scopeFiltersMilestones;
    const oppsByTpid = new Map();
    for (const o of opps) {
      const acc = o.parent_account_id ? accById.get(o.parent_account_id) : null;
      const tpid = acc?.tpid || null;
      if (!tpid) continue;
      // Cloud & AI Specialist quick-pick narrows to opportunities owned by that person.
      if (ownerActive && !ownerFilter.has(o.owner_name || 'Unassigned')) continue;
      let oppMilestones = (msByOpp.get(o.opportunity_id) || []).map((m) => ({
        ...m,
        _comments: parseComments(m.comments_json),
        _hok: hokByReg.get(normId(m.milestone_id)) || [],
      }));
      if (activeOnly) oppMilestones = oppMilestones.filter((m) => !isInactiveMilestone(m));
      if (uncommittedOnly) oppMilestones = oppMilestones.filter((m) => !isCommitted(m));
      if (scopeActive) oppMilestones = oppMilestones.filter(matchesScope);
      // Hide opportunities that have no milestones left after the Active / Uncommitted /
      // territory filters — an opportunity row with no milestone bars is just noise.
      if (oppMilestones.length === 0) continue;
      if (!oppsByTpid.has(tpid)) oppsByTpid.set(tpid, []);
      oppsByTpid.get(tpid).push({ ...o, _milestones: oppMilestones });
    }

    const groups = [];
    for (const [tpid, accounts] of byTpid.entries()) {
      const oppList = oppsByTpid.get(tpid) || [];
      if (oppList.length === 0) continue; // only accounts that have opportunities
      const topParent =
        accounts.find((a) => a.parenting_level === 861980000) ||
        accounts.find((a) => !a.parent_crm_account_id) ||
        accounts[0];
      const name = topParent?.name || oppList[0].customer_name || 'Account';
      // Account Filter (single-select): empty set = all accounts.
      if (acctFilter.size > 0 && !acctFilter.has(name)) continue;
      groups.push({
        tpid,
        name,
        opps: oppList.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
      });
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, opps, milestones, hok, scopeFiltersMilestones, matchesScope, activeOnly, uncommittedOnly, acctFilter, ownerFilter, ownerActive]);

  // Whether any real CRM creation date is present (drives the "re-sync" hint).
  const hasCreatedOn = useMemo(() => {
    if ((opps || []).some((o) => o.created_on)) return true;
    if ((milestones || []).some((m) => m.created_on)) return true;
    return false;
  }, [opps, milestones]);

  // Compute a shaded bar (start → end) clamped to the visible window.
  // Missing start clamps to window left (open-start); missing end clamps to window
  // right (open-end). Returns null if the bar has no overlap with the window.
  function computeBar(startStr, endStr) {
    const s = parseDate(startStr);
    const e = parseDate(endStr);
    if (!s && !e) return null;
    if (s && s.getTime() > windowEnd.getTime()) return null;
    if (e && e.getTime() < windowStart.getTime()) return null;
    const bs = s ? Math.max(s.getTime(), windowStart.getTime()) : windowStart.getTime();
    const be = e ? Math.min(e.getTime(), windowEnd.getTime()) : windowEnd.getTime();
    const left = ((bs - windowStart.getTime()) / windowMs) * 100;
    const width = Math.max(0.6, ((be - bs) / windowMs) * 100);
    return {
      left,
      width,
      openStart: !s || s.getTime() < windowStart.getTime(),
      openEnd: !e || e.getTime() > windowEnd.getTime(),
    };
  }

  const toggle = (tpid) => setCollapsed((p) => ({ ...p, [tpid]: !p[tpid] }));
  const expandAll = () => setCollapsed({});
  const collapseAll = () => {
    const all = {};
    for (const g of tree) all[g.tpid] = true;
    setCollapsed(all);
  };

  const TrackGrid = ({ showToday = true }) => (
    <>
      {boundaries.map((b, i) => (
        <div key={i} className="mt-grid-line" style={{ left: `${b}%` }} />
      ))}
      {showToday && todayPct != null && <div className="mt-today-line" style={{ left: `${todayPct}%` }} />}
    </>
  );

  const loading = !customers || !opps || !milestones;

  return (
    <div className="mt-page">
      <div className="page-header">
        <div className="page-header-left">
          <h2>Milestone Timeline</h2>
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
          {/* Cross-links to the sibling milestone views (Milestones table, Milestone Map),
              mirroring the links on the Milestones page. */}
          <div className="ms-view-links">
            <Button
              appearance="subtle"
              size="small"
              icon={<FlagRegular />}
              onClick={() => navigate('/milestones')}
              title="Open the Milestones table"
            >
              Milestones
            </Button>
            <Button
              appearance="subtle"
              size="small"
              icon={<OrganizationRegular />}
              onClick={() => navigate('/milestone-map')}
              title="Open the Milestone Map"
            >
              Milestone Map
            </Button>
          </div>
        </div>
        <div className="mt-controls">
          <div className="mt-viewtoggle">
            <button
              className={`mt-seg-btn${activeOnly ? ' active' : ''}`}
              title="Hide completed, cancelled, and duplicate milestones"
              onClick={() => setActiveOnly((v) => !v)}
            >Active only</button>
            <button
              className={`mt-seg-btn${uncommittedOnly ? ' active' : ''}`}
              title="Hide committed milestones"
              onClick={() => setUncommittedOnly((v) => !v)}
            >Uncommitted only</button>
          </div>
          <TerritoryToggle />
        </div>
      </div>

      {!hasCreatedOn && tree.length > 0 && (
        <div className="flash-info mt-hint">
          <InfoRegular /> Opportunity and milestone start dates populate after the next
          <b> Sync from CRM</b>. Until then, bars extend from the left edge to each item's completion date.
        </div>
      )}

      <div className="mt-legend">
        <button className="mt-nav-btn" title={isYear ? 'Previous quarter' : 'Previous month'} onClick={() => shift(-1)}>
          <ChevronLeftRegular />
        </button>
        <button className="mt-nav-btn mt-today-btn" title={isYear ? 'Jump to current quarter' : 'Jump to current month'} onClick={goToday}>
          <CalendarTodayRegular /> Today
        </button>
        <button className="mt-nav-btn" title={isYear ? 'Next quarter' : 'Next month'} onClick={() => shift(1)}>
          <ChevronRightRegular />
        </button>
        <span className="mt-range">{rangeLabel}</span>
        <span className="mt-controls-spacer" />
        <span className="mt-lg-icon"><CommentRegular /> Comment</span>
        <span className="mt-lg-icon"><TaskListSquareLtrRegular /> HoK activity</span>
        {todayPct != null && <span className="mt-lg-icon"><span className="mt-lg-today" /> Today</span>}
      </div>

      <div className="mt-gantt card">
        {/* Month header */}
        <div className="mt-row mt-header">
          <div className="mt-label mt-label-head">
            Accounts - Opportunities - Milestones{' '}
            <span className="mt-head-toggle">
              (<button type="button" className="mt-link-btn" onClick={expandAll}>expand</button>
              /<button type="button" className="mt-link-btn" onClick={collapseAll}>collapse</button>)
            </span>
          </div>
          <div className="mt-track mt-track-head">
            {segments.map((seg) => (
              <div key={seg.key} className="mt-month" style={{ left: `${seg.left}%`, width: `${seg.width}%` }}>
                {seg.label}
              </div>
            ))}
            <TrackGrid showToday={false} />
          </div>
        </div>

        <div className="mt-body">
          {loading && <div className="mt-empty">Loading…</div>}
          {!loading && tree.length === 0 && (
            <div className="mt-empty">
              {scope === 'discover' && currentUserName
                ? <>No milestones to discover — none owned by your configured SSPs (that you're not already on) are in view. Set SSPs in <b>User Home → SSP Configuration</b>, or switch scope with the top-right toggle.</>
                : myOnly && currentUserName
                  ? <>No opportunities or milestones in <b>your territory</b>. Switch to <b>Full Territory</b> in the left nav to see everything.</>
                  : <>No accounts with opportunities found. Run <b>Sync from CRM</b> in Settings.</>}
            </div>
          )}

          {tree.map((group) => {
            const isCollapsed = !!collapsed[group.tpid];
            const ssp = sspByTpid.get(String(group.tpid));
            return (
              <div key={group.tpid} className="mt-account-group">
                <div className="mt-row mt-account-row" onClick={() => toggle(group.tpid)}>
                  <div className="mt-label mt-account-label">
                    {isCollapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
                    <span className="mt-account-name" title={group.name}>{group.name}</span>
                    <button
                      type="button"
                      className="tbl-glance-btn"
                      title="Account glance"
                      onClick={(e) => { e.stopPropagation(); setGlance({ tpid: String(group.tpid), name: group.name }); }}
                    >
                      <ContactCardRegular />
                    </button>
                    <span
                      className={`mt-account-ssp${ssp ? '' : ' mt-account-ssp-empty'}`}
                      title="Cloud and AI Specialist"
                    >{ssp || 'No SSP assigned'}</span>
                  </div>
                  <div className="mt-track"><TrackGrid /></div>
                </div>

                {!isCollapsed && group.opps.map((o) => {
                  return (
                    <React.Fragment key={o.opportunity_id}>
                      <div className="mt-row mt-opp-row">
                        <div
                          className="mt-label mt-opp-label mt-opp-clickable"
                          onClick={() => setMsDetail({ type: 'opp', data: buildOppDetail(o, o._milestones, group.name) })}
                          title="Click for opportunity details"
                        >
                          <TargetRegular className="mt-lvl-icon mt-lvl-opp" />
                          <span className="mt-opp-name" title={o.name}>{o.name}</span>
                          {o.owner_name && (
                            <span className="mt-opp-owner" title={`Owner: ${o.owner_name}`}>{o.owner_name}</span>
                          )}
                        </div>
                        <div className="mt-track">
                          <TrackGrid />
                        </div>
                      </div>

                      {o._milestones.map((m) => {
                        const msBar = computeBar(m.created_on, m.milestone_date);
                        const latestComment = m._comments[0];
                        const commentDate = latestComment ? parseDate(latestComment.date) : null;
                        const showComment = commentDate && commentDate >= windowStart && commentDate <= windowEnd;
                        return (
                          <div className={`mt-row mt-ms-row${riskClass(m)}`} key={m.milestone_id}>
                            <div
                              className="mt-label mt-ms-label mt-ms-clickable"
                              onClick={() => setMsDetail({ type: 'ms', data: { ...m, opp_name: o.name, customer_name: group.name } })}
                              title="Click for milestone details"
                            >
                              <FlagRegular className="mt-lvl-icon mt-lvl-ms" />
                              <span className="mt-ms-name" title={m.name}>{m.name}</span>
                              <span className="mt-ms-status">
                                {isCommitted(m) ? 'C' : 'UC'}/{m.status_label || '—'}
                              </span>
                            </div>
                            <div className="mt-track">
                              <TrackGrid />
                              {msBar && (
                                <div
                                  className={`mt-bar mt-bar-ms${msBar.openStart ? ' open-start' : ''}${msBar.openEnd ? ' open-end' : ''}`}
                                  style={{ left: `${msBar.left}%`, width: `${msBar.width}%` }}
                                  title={`${m.name}\nDue: ${formatDateOnly(m.milestone_date) || '—'}`}
                                />
                              )}

                              {/* Comment marker at the latest comment's date */}
                              {showComment && (
                                <span className="mt-marker mt-marker-comment" style={{ left: `${pct(commentDate)}%` }}>
                                  <CommentRegular />
                                  <span className="mt-tip">
                                    <b>{latestComment.poster}</b>
                                    <span className="mt-tip-date">{fmtDate(commentDate)}</span>
                                    <span className="mt-tip-text">{latestComment.text}</span>
                                    {m._comments.length > 1 && (
                                      <span className="mt-tip-more">+{m._comments.length - 1} more comment(s)</span>
                                    )}
                                  </span>
                                </span>
                              )}

                              {/* HoK activity markers at each activity's created date */}
                              {m._hok.map((t) => {
                                const td = parseDate(t.created_on);
                                if (!td || td < windowStart || td > windowEnd) return null;
                                return (
                                  <span
                                    key={t.activity_id}
                                    className="mt-marker mt-marker-hok"
                                    style={{ left: `${pct(td)}%` }}
                                    onClick={(e) => { e.stopPropagation(); setHokDetail({ ...t, milestoneName: m.name }); }}
                                  >
                                    <TaskListSquareLtrRegular />
                                    <span className="mt-tip">
                                      <b>{t.subject || 'HoK activity'}</b>
                                      <span className="mt-tip-date">{fmtDate(td)}</span>
                                      <span className="mt-tip-more">Click for details</span>
                                    </span>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* HoK activity details panel */}
      {hokDetail && (
        <div className="mt-drawer-overlay" onClick={() => setHokDetail(null)}>
          <div className="mt-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mt-drawer-head">
              <div className="mt-drawer-title"><TaskListSquareLtrRegular /> HoK Activity</div>
              <button className="mt-nav-btn" onClick={() => setHokDetail(null)} title="Close"><DismissRegular /></button>
            </div>
            <div className="mt-drawer-body">
              <div className="mt-dl-subject">{hokDetail.subject || '(no subject)'}</div>
              <dl className="mt-dl">
                <dt>Status</dt><dd>{STATE_LABELS[hokDetail.state_code] ?? '—'}</dd>
                <dt>Owner</dt><dd>{hokDetail.owner_name || '—'}</dd>
                <dt>Created</dt><dd>{fmtDateTime(parseDate(hokDetail.created_on))}</dd>
                <dt>Scheduled end</dt><dd>{fmtDateTime(parseDate(hokDetail.scheduled_end))}</dd>
                <dt>Regarding</dt><dd>{hokDetail.milestoneName || '—'}</dd>
                <dt>Type</dt><dd>{hokDetail.regarding_type || '—'}</dd>
              </dl>
            </div>
          </div>
        </div>
      )}

      {/* Milestone details — same shared panel used by the Milestone Map */}
      <DetailCard
        detail={msDetail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setMsDetail(null)}
        onSelect={setMsDetail}
        teamApi={teamApi}
      />
      <AccountGlanceModal selected={glance} onClose={() => setGlance(null)} />

      {/* Deal-team / comment / activity status surfaced from teamApi */}
      {flash && (
        <div className={`mt-flash mt-flash-${flash.type || 'info'}`} onClick={() => setFlash(null)}>
          {flash.msg}
        </div>
      )}
    </div>
  );
}
