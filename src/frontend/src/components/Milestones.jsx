import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import {
  OpenRegular,
  FilterRegular,
  ArrowSortRegular,
  ArrowSortUpRegular,
  ArrowSortDownRegular,
  ChevronRightRegular,
  ChevronDownRegular,
  BuildingRegular,
  TargetRegular,
  FlagRegular,
  PeopleTeamRegular,
  WarningRegular,
  CopyRegular,
  CheckmarkRegular,
  OrganizationRegular,
  GanttChartRegular,
  ChatRegular,
  ContactCardRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { useTeamApi } from '../hooks/useTeamApi';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ensureAuth, crmRequest, dbRun, dbQuery, getMsxSettings, openExternal, copyMilestoneTeamsMessage, findMilestoneSignal, getMilestoneSignalLinks, deleteMilestoneSignalLink, suggestMilestoneComment, suggestMilestoneHokActivity, orgSearchPeople } from '../electronBridge';
import { useTerritory } from '../territoryContext';
import TerritoryToggle from './TerritoryToggle';
import { fetchTerritoryHokTasks } from '../lib/hokActivities';
import { parseTeamList, normId } from '../lib/milestoneMetrics';
import { formatDateOnly } from '../lib/datetime';
import { AccountGlanceModal } from './CustomerActivity';
import PanZoomViewport from './PanZoomViewport';
import MilestoneGrid from './MilestoneGrid';
import { MILESTONE_STATUS_MAP, CUSTOMER_COMMITMENT_MAP } from './milestoneOptions';
import {
  MILESTONE_AI_FULL_KEYS, makeStepList, setStep, firstFailedStepIndex, MilestoneAiWorkflowPopup,
} from '../lib/milestoneAiWorkflow';

const MILESTONE_TEAM_TEMPLATE_ID = '316e4735-9e83-eb11-a812-0022481e1be0';
const OPPORTUNITY_TEAM_TEMPLATE_ID = 'cc923a9d-7651-e311-9405-00155db3ba1e';

// Real msp_milestonestatus / msp_commitmentrecommendation option sets (live from MSX).
const MILESTONE_STATUS = MILESTONE_STATUS_MAP;
const CUSTOMER_COMMITMENT = CUSTOMER_COMMITMENT_MAP;

// Task (activity) categories — a curated subset of the msp_taskcategory option set from MSX.
// Trimmed to the 9 categories the team actually uses for HoK activities; every value below is a
// real msp_taskcategory option-set code, so a selection still writes back cleanly to Dynamics.
// KEEP IN SYNC with HOK_TASK_CATEGORIES in desktop/app-ipc.js (the main-process mirror used to
// ground + validate the HoK AI suggester).
export const TASK_CATEGORIES = [
  { value: 861980004, label: 'Architecture Design Session' },
  { value: 861980014, label: 'Assessment' },
  { value: 861980006, label: 'Blocker Escalation' },
  { value: 861980007, label: 'Consumption Plan' },
  { value: 861980002, label: 'Demo' },
  { value: 861980005, label: 'PoC/Pilot' },
  { value: 861980009, label: 'RFP/RFI' },
  { value: 606820005, label: 'Technical Close/Win Plan' },
  { value: 861980001, label: 'Workshop' },
];

// Local milestone-status badge helper only below; team parsing + scope come from
// ../lib/milestoneMetrics (parseTeamList) and ../territoryContext.


function parseComments(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => ({
        poster: item?.userId || 'Unknown',
        date: item?.modifiedOn || '',
        text: item?.comment || '',
      }))
      .filter(item => item.text)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch { return []; }
}

function daysAgoText(raw) {
  const comments = parseComments(raw);
  if (comments.length === 0 || !comments[0].date) return '—';
  const days = Math.floor((Date.now() - new Date(comments[0].date).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function statusTextBadgeClass(text) {
  const s = (text || '').toLowerCase();
  if (!s) return 'badge-secondary';
  if (s.includes('block')) return 'badge-danger';
  if (s.includes('off track') || s.includes('cancel') || s.includes('reject')) return 'badge-danger';
  if (s.includes('at risk')) return 'badge-warning';
  if (s.includes('on track') || s.includes('active') || s.includes('approved') || s.includes('committed')) return 'badge-success';
  if (s.includes('complete') || s.includes('closed')) return 'badge-info';
  if (s.includes('draft')) return 'badge-warning';
  return 'badge-secondary';
}

function commitmentBadgeClass(val) {
  const s = CUSTOMER_COMMITMENT[val] || '';
  if (s === 'Committed') return 'badge-success';
  if (s === 'Uncommitted') return 'badge-warning';
  return 'badge-secondary';
}

// Diagram filter helpers (mirror MilestoneTimeline). Committed = option-set 861980003.
const isCommittedMs = (m) => Number(m.commitment_recommendation) === 861980003;
// "Inactive" milestones are hidden by the Active-only toggle: completed, cancelled,
// duplicate hygiene records, or lost to a competitor.
function isInactiveMs(m) {
  const s = (m.status_label || '').toLowerCase();
  return s.includes('complete') || s.includes('cancel') || s.includes('duplicate') || s.includes('lost to competitor');
}
// Same test against a status display label (used to derive the Active-only status set).
function isInactiveStatusLabel(s) {
  const t = (s || '').toLowerCase();
  return t.includes('complete') || t.includes('cancel') || t.includes('duplicate') || t.includes('lost to competitor');
}

// Multi-select filter dropdown — changes apply on close.
// `single` mode turns it into a radio-style single-select with an "All" reset.
export function FilterDropdown({ label, options, selected, onChange, single = false, pinned = null, showSearch = true, quickPick = null, plain = false }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(selected);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  // Sync draft (and clear search) when dropdown opens
  useEffect(() => {
    if (open) { setDraft(new Set(selected)); setQuery(''); }
  }, [open]);

  // Commit draft on close
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        onChange(draft);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, draft, onChange]);

  const allSelected = draft.size === options.length;
  const noneSelected = draft.size === 0;
  const filterActive = single
    ? (selected.size >= 1 && selected.size !== options.length)
    : (selected.size !== options.length);
  const singleLabel = single && selected.size >= 1 ? [...selected][0] : null;

  const q = query.trim().toLowerCase();
  const visibleOptions = q ? options.filter(o => o.toLowerCase().includes(q)) : options;

  // Commit a value immediately and close (used by radio-style single mode).
  function commit(next) {
    setDraft(next);
    onChange(next);
    setOpen(false);
  }

  function close() {
    setOpen(false);
    onChange(draft);
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        onClick={() => open ? close() : setOpen(true)}
        className={plain
          ? `tbl-filter-th-btn${filterActive ? ' active' : ''}`
          : `diag-filter-btn${filterActive ? ' active' : ''}`}
        title={`Filter ${label}`}
      >
        {!plain && <FilterRegular style={{ fontSize: 14, flex: '0 0 auto' }} />}
        <span className={plain ? undefined : 'diag-filter-btn-label'}>{label}</span>
        {filterActive && (
          <span className="diag-filter-btn-value">
            {single ? singleLabel : `(${selected.size})`}
          </span>
        )}
        {open
          ? <ChevronDownRegular style={{ fontSize: 12, flex: '0 0 auto' }} />
          : <ChevronRightRegular style={{ fontSize: 12, flex: '0 0 auto' }} />}
      </button>
      {open && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100,
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6,
          padding: 8, minWidth: 220, maxHeight: 320, overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {pinned && pinned.options.length > 0 && (
            <div style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>{pinned.label}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {pinned.options.map(name => (
                  <button
                    key={name}
                    onClick={() => { pinned.onPick(name); close(); }}
                    title={pinned.isActive(name) ? `Clear ${name} filter` : `Show only ${name}'s opportunities`}
                    style={pillStyle(pinned.isActive(name))}
                  >{name}</button>
                ))}
              </div>
            </div>
          )}
          {quickPick && (
            <div style={{ marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <button
                onClick={() => setDraft(new Set(quickPick.values))}
                title={quickPick.title || quickPick.label}
                style={pillStyle(
                  draft.size === quickPick.values.length &&
                  quickPick.values.every(v => draft.has(v))
                )}
              >{quickPick.label}</button>
            </div>
          )}
          {showSearch && (
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 8,
                background: 'var(--canvas)', border: '1px solid var(--border)', borderRadius: 4,
                padding: '5px 8px', color: 'var(--text)', fontSize: 12, outline: 'none',
              }}
            />
          )}
          {single ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0 8px', marginBottom: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text)', borderBottom: '1px solid var(--border)' }}>
              <input
                type="radio"
                name={`single-${label}`}
                checked={draft.size !== 1}
                onChange={() => commit(new Set())}
                style={{ accentColor: 'var(--accent)' }}
              />
              All accounts
            </label>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
              <button onClick={() => setDraft(new Set(options))} style={pillStyle(allSelected)}>Select All</button>
              <button onClick={() => setDraft(new Set())} style={pillStyle(noneSelected)}>Select None</button>
            </div>
          )}
          {visibleOptions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No matches</div>
          ) : (
            visibleOptions.map(opt => (
              <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 13, color: 'var(--text)' }}>
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={single ? `single-${label}` : undefined}
                  checked={single ? (draft.size === 1 && draft.has(opt)) : draft.has(opt)}
                  onChange={() => {
                    if (single) { commit(new Set([opt])); return; }
                    const next = new Set(draft);
                    next.has(opt) ? next.delete(opt) : next.add(opt);
                    setDraft(next);
                  }}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {opt}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Depressable toggle button used for diagram filter switches.
// Tri-state sort button: none → asc → desc → none
// Clickable column header that cycles unsorted → asc → desc. The whole <th> is the
// hit target and the sort arrow sits inline, so it stays on a single row.
function SortableTh({ label, column, sortState, onSort, style }) {
  const dir = sortState?.col === column ? sortState.dir : null;
  function cycle() {
    if (dir === null) onSort({ col: column, dir: 'asc' });
    else if (dir === 'asc') onSort({ col: column, dir: 'desc' });
    else onSort(null);
  }
  const Icon = dir === 'asc' ? ArrowSortUpRegular : dir === 'desc' ? ArrowSortDownRegular : ArrowSortRegular;
  return (
    <th
      className="sortable-th"
      onClick={cycle}
      style={style}
      title={dir === 'asc' ? 'Sorted ascending — click for descending' : dir === 'desc' ? 'Sorted descending — click to clear' : 'Click to sort'}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <Icon style={{ fontSize: 13, opacity: dir ? 1 : 0.45 }} />
      </span>
    </th>
  );
}

function pillStyle(active) {
  return {
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--card)' : 'var(--accent)',
    border: '1px solid var(--accent)', borderRadius: 12,
    padding: '2px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
  };
}

// Persist the Milestone Map filter selections across tab switches. The Milestones
// component unmounts when navigating to another tab and remounts on return, which
// would otherwise reset these filters. Stored as arrays of labels (null = unset).
const diagramFilterCache = { account: null, owner: null };

export default function Milestones({ view = 'diagram' }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: milestones, initialLoading, refresh } = useDbQuery(
    `SELECT m.*, o.name as opp_name, o.opportunity_number, o.customer_name, o.opportunity_id as opp_crm_id, o.parent_account_id, o.owner_name as opp_owner_name, o.customer_need as customer_need
     FROM active_milestones m
     LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
     ORDER BY o.customer_name, o.name, m.milestone_date`
  );
  const { data: customers } = useDbQuery(
    `SELECT name, tpid, crm_account_id, parent_crm_account_id, parenting_level FROM active_customers`
  );
  // All opportunities (full breadth per account) drive the diagram top-down, so
  // opportunities with no milestones still appear.
  const { data: opps } = useDbQuery(
    `SELECT o.opportunity_id as opp_crm_id, o.name as opp_name, o.opportunity_number,
            o.customer_name, o.parent_account_id, o.owner_name as opp_owner_name, o.customer_need as customer_need
     FROM active_opportunities o
     ORDER BY o.customer_name, o.name`
  );
  const [flash, setFlash] = useState(null);
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  // Table-view filters. The "Filter" dropdown is single-select account (grouped by
  // TPID top-parent) plus a Cloud & AI Specialists section that filters by opp owner.
  const [tblAccountFilter, setTblAccountFilter] = useState(new Set()); // empty = all accounts
  const [tblOwnerFilter, setTblOwnerFilter] = useState(new Set());     // empty = all owners
  const [commitFilter, setCommitFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [sortState, setSortState] = useState(() => {
    // Honor a ?sort=&dir= deep-link (e.g. from the dashboard "% Milestones Engaged" card).
    const col = searchParams.get('sort');
    if (!col) return null;
    return { col, dir: searchParams.get('dir') === 'desc' ? 'desc' : 'asc' };
  }); // { col: 'date'|'acr'|'tasks'|'comments', dir: 'asc'|'desc' }
  const [expandedRow, setExpandedRow] = useState(null); // milestone_id
  const [collapsedAccts, setCollapsedAccts] = useState({}); // account label -> true when collapsed
  const [detail, setDetail] = useState(null); // clicked milestone row → shared DetailCard
  const [glance, setGlance] = useState(null); // { tpid, name } | null — account glance popup
  // Opportunity lookup for the table view: open the shared opp DetailCard from an
  // opportunity name click. Groups the loaded milestones by their opportunity so
  // the card shows the opp's full milestone roll-up (ACR, deal team, count).
  const oppLookup = useMemo(() => {
    const byId = new Map();
    for (const o of opps || []) byId.set(o.opp_crm_id, o);
    const msByOpp = new Map();
    for (const m of milestones || []) {
      const k = m.opp_crm_id;
      if (!k) continue;
      if (!msByOpp.has(k)) msByOpp.set(k, []);
      msByOpp.get(k).push(m);
    }
    return { byId, msByOpp };
  }, [opps, milestones]);
  const openOppDetail = useCallback((ms) => {
    const opp = oppLookup.byId.get(ms.opp_crm_id) || {
      opp_crm_id: ms.opp_crm_id, opp_name: ms.opp_name, customer_name: ms.customer_name,
      opp_owner_name: ms.opp_owner_name, customer_need: ms.customer_need,
    };
    const msRows = oppLookup.msByOpp.get(ms.opp_crm_id) || [ms];
    setDetail({ type: 'opp', data: buildOppDetail(opp, msRows, ms.customer_name) });
  }, [oppLookup]);

  // ── Search by ID: paste an opportunity / milestone GUID (e.g. copied from a detail card)
  // to jump straight to its record. Both the opportunities and milestones lists are loaded in
  // full above, so we resolve the id locally (exact, case-insensitive) and show the matched
  // record's NAME as a light-italic hint. Pressing Enter or clicking the hint opens the shared
  // DetailCard for that record.
  const [oppIdQuery, setOppIdQuery] = useState('');
  const [msIdQuery, setMsIdQuery] = useState('');
  const oppIdMatch = useMemo(() => {
    const q = oppIdQuery.trim().toLowerCase();
    if (!q) return null;
    return (opps || []).find((o) => String(o.opp_crm_id || '').toLowerCase() === q) || null;
  }, [oppIdQuery, opps]);
  const msIdMatch = useMemo(() => {
    const q = msIdQuery.trim().toLowerCase();
    if (!q) return null;
    return (milestones || []).find((m) => String(m.milestone_id || '').toLowerCase() === q) || null;
  }, [msIdQuery, milestones]);
  const openOppById = useCallback(() => { if (oppIdMatch) openOppDetail(oppIdMatch); }, [oppIdMatch, openOppDetail]);
  const openMsById = useCallback(() => { if (msIdMatch) setDetail({ type: 'ms', data: msIdMatch }); }, [msIdMatch]);
  // Diagram-specific filters (independent of the table filters above)
  const [diagAccountFilter, setDiagAccountFilter] = useState(null); // single-select (Set of 0/1 label)
  const [diagOwnerFilter, setDiagOwnerFilter] = useState(null);     // multi-select; applies when not all selected
  const [diagActiveOnly, setDiagActiveOnly] = useState(true);       // hide completed/cancelled/duplicate/lost
  const [diagUncommittedOnly, setDiagUncommittedOnly] = useState(true); // hide committed
  // Cloud and AI Specialist names + the scope predicate come from the shared territory
  // context (single source of truth for Discover). Removed the local SSP query.
  const { scope: territoryScope, currentUserName, sspNames, sspNameSet, scopeFiltersMilestones, matchesScope } = useTerritory();
  const { currentUserId, joiningKey, isOnTeam, toggleTeam, addMilestoneComment, addActivity, addMilestone, updateMilestone } =
    useTeamApi({ refresh, onFlash: setFlash });
  const scopeKeeps = matchesScope;               // My / Discover / All membership test
  const scopeFiltersMs = scopeFiltersMilestones; // true when the active scope prunes the list
  const [hokTasks, setHokTasks] = useState([]);
  const [hokPending, setHokPending] = useState(false);
  const [hokUnavailable, setHokUnavailable] = useState(false);

  function toggleRow(milestoneId) {
    setExpandedRow(expandedRow === milestoneId ? null : milestoneId);
  }

  useEffect(() => {
    getMsxSettings().then(s => setCrmBaseUrl(s.crmUrl || ''));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHokPending(true);
    setHokUnavailable(false);
    (async () => {
      try {
        const tasks = await fetchTerritoryHokTasks({ scope: territoryScope, sspNames: [...sspNameSet] });
        if (!cancelled) setHokTasks(tasks || []);
      } catch {
        if (!cancelled) {
          setHokTasks([]);
          setHokUnavailable(true);
        }
      } finally {
        if (!cancelled) setHokPending(false);
      }
    })();
    return () => { cancelled = true; };
  }, [territoryScope, sspNameSet]);

  // Derive unique filter options
  const commitOptions = useMemo(() => {
    const vals = new Set();
    for (const m of (milestones || [])) {
      vals.add(CUSTOMER_COMMITMENT[m.commitment_recommendation] || 'Unknown');
    }
    return [...vals].sort();
  }, [milestones]);
  const statusOptions = useMemo(() => {
    const vals = new Set();
    for (const m of (milestones || [])) {
      vals.add(m.status_label || MILESTONE_STATUS[m.milestone_status] || m.milestone_status || 'Unknown');
    }
    return [...vals].sort();
  }, [milestones]);
  // Active-only status set: every status label except completed/cancelled/duplicate/lost.
  const activeStatusOptions = useMemo(
    () => statusOptions.filter(s => !isInactiveStatusLabel(s)),
    [statusOptions]
  );

  // Diagram filter options
  // Group parent accounts by TPID: accounts sharing a TPID collapse into a single
  // filter option. The label is the TPID's top-parent account name (not a join of
  // every child name, which was unreadable). Accounts without a TPID stand alone.
  const accountGrouping = useMemo(() => {
    const tpidByAccId = new Map();
    const accsByTpid = new Map();
    for (const c of customers || []) {
      if (c.crm_account_id) tpidByAccId.set(c.crm_account_id, c.tpid || null);
      if (c.tpid) {
        if (!accsByTpid.has(c.tpid)) accsByTpid.set(c.tpid, []);
        accsByTpid.get(c.tpid).push(c);
      }
    }
    // Top-parent per TPID: prefer parenting_level flag, else the account with no
    // parent, else the first account in the group.
    const topNameByTpid = new Map();
    for (const [tpid, accs] of accsByTpid) {
      const top = accs.find(a => a.parenting_level === 861980000)
        || accs.find(a => !a.parent_crm_account_id)
        || accs[0];
      if (top) topNameByTpid.set(tpid, top.name);
    }
    const keyFor = (m) => {
      const tpid = m.parent_account_id ? tpidByAccId.get(m.parent_account_id) : null;
      return tpid ? `tpid:${tpid}` : `name:${m.customer_name || 'Unknown'}`;
    };
    const namesByKey = new Map();
    for (const o of (opps || [])) {
      const key = keyFor(o);
      if (!namesByKey.has(key)) namesByKey.set(key, new Set());
      namesByKey.get(key).add(o.customer_name || 'Unknown');
    }
    const labelByKey = new Map();
    for (const [key, names] of namesByKey) {
      if (key.startsWith('tpid:')) {
        const tpid = key.slice(5);
        // Top-parent name is the readable label; fall back to the joined child
        // names only when the roster has no matching customer row.
        labelByKey.set(key, topNameByTpid.get(tpid) || [...names].sort().join(' / '));
      } else {
        labelByKey.set(key, [...names].sort().join(' / '));
      }
    }
    const labelFor = (m) => labelByKey.get(keyFor(m)) || (m.customer_name || 'Unknown');
    const options = [...new Set([...labelByKey.values()])].sort();
    // Map each TPID to its grouped label so a ?tpid= deep-link can focus the diagram.
    const labelByTpid = new Map();
    for (const [key, label] of labelByKey) {
      if (key.startsWith('tpid:')) labelByTpid.set(key.slice(5), label);
    }
    return { labelFor, options, labelByTpid };
  }, [opps, customers]);
  const diagAccountOptions = accountGrouping.options;
  // Reverse of labelByTpid so the table's account-group header can open the glance popup
  // (first tpid wins if two share a label — rare).
  const tpidByLabel = useMemo(() => {
    const m = new Map();
    for (const [tpid, label] of accountGrouping.labelByTpid) if (!m.has(label)) m.set(label, tpid);
    return m;
  }, [accountGrouping]);
  const diagOwnerOptions = useMemo(() =>
    [...new Set((opps || []).map(o => o.opp_owner_name || 'Unassigned'))].sort(),
    [opps]
  );
  // `sspNames` (the Cloud & AI Specialist filter quick-picks) comes from the territory context.

  // Initialize diagram filters once data loads. Restores the saved selections (so the
  // Milestone Map remembers them across tab switches), reconciled against the current
  // options; falls back to defaults on first load. A ?tpid= deep-link (e.g. the customer
  // profile's "Milestone Map" button) overrides the saved account to focus that account.
  useEffect(() => {
    if (opps && opps.length > 0 && diagAccountFilter === null) {
      const restore = (saved, options, dflt) => {
        if (!saved) return dflt;
        const valid = saved.filter((v) => options.includes(v));
        return valid.length > 0 ? new Set(valid) : dflt;
      };
      // Account is single-select. Defaults to all accounts (empty set); a saved
      // selection or a ?tpid= deep-link focuses a specific account. Owner/Team
      // start with everything selected.
      const focusTpid = searchParams.get('tpid');
      const focusLabel = focusTpid ? accountGrouping.labelByTpid.get(String(focusTpid)) : null;
      // The tpid→label map needs `customers` loaded; if a ?tpid= focus can't be resolved
      // yet, defer rather than falling back to the wrong account. Once customers
      // load, accountGrouping changes and this effect re-runs with diagAccountFilter still null.
      if (focusTpid && !focusLabel && (!customers || customers.length === 0)) return;
      setDiagAccountFilter(
        focusLabel && diagAccountOptions.includes(focusLabel)
          ? new Set([focusLabel])
          : restore(
            diagramFilterCache.account,
            diagAccountOptions,
            new Set()
          )
      );
      setDiagOwnerFilter(restore(diagramFilterCache.owner, diagOwnerOptions, new Set(diagOwnerOptions)));
    }
  }, [opps, customers, diagAccountOptions, diagOwnerOptions, diagAccountFilter, searchParams, accountGrouping]);

  // Mirror filter changes into the module-level cache so they survive a remount.
  useEffect(() => { if (diagAccountFilter) diagramFilterCache.account = [...diagAccountFilter]; }, [diagAccountFilter]);
  useEffect(() => { if (diagOwnerFilter) diagramFilterCache.owner = [...diagOwnerFilter]; }, [diagOwnerFilter]);

  // Group all milestones by their opportunity for the diagram (built top-down from
  // opportunities so opps with no milestones still appear).
  const milestonesByOpp = useMemo(() => {
    const map = new Map();
    for (const m of milestones || []) {
      if (!m.opportunity_id) continue;
      if (!map.has(m.opportunity_id)) map.set(m.opportunity_id, []);
      map.get(m.opportunity_id).push(m);
    }
    return map;
  }, [milestones]);
  const milestoneIdsWithHok = useMemo(() => {
    const ids = new Set();
    for (const t of hokTasks || []) {
      const id = normId(t._regardingobjectid_value);
      if (id) ids.add(id);
    }
    return ids;
  }, [hokTasks]);

  // Milestone-level filters for the diagram: Active-only hides completed/cancelled/
  // duplicate/lost milestones, Uncommitted-only hides committed ones, and the territory
  // toggle restricts each opp's milestones to My (on-team) or Discover (not-on-team).
  const diagramMilestonesByOpp = useMemo(() => {
    if (!diagActiveOnly && !diagUncommittedOnly && !scopeFiltersMs) return milestonesByOpp;
    const map = new Map();
    for (const [k, rows] of milestonesByOpp) {
      const kept = rows.filter(m => {
        if (diagActiveOnly && isInactiveMs(m)) return false;
        if (diagUncommittedOnly && isCommittedMs(m)) return false;
        if (!scopeKeeps(m)) return false;
        return true;
      });
      if (kept.length) map.set(k, kept);
    }
    return map;
  }, [milestonesByOpp, diagActiveOnly, diagUncommittedOnly, scopeFiltersMs, scopeKeeps]);

  // Opportunities passing the diagram filters (drives the diagram independently of
  // the table). Parent Account is single-select; the Owner filter applies when not
  // every owner is selected. The territory toggle (My / Discover) additionally
  // requires at least one matching milestone; Active/Uncommitted only prune
  // milestone rows and never drop an opportunity node.
  const diagramOpps = useMemo(() => {
    if (!opps) return [];
    const ownerActive = diagOwnerFilter && diagOwnerOptions.length > 0 && diagOwnerFilter.size !== diagOwnerOptions.length;
    const msFilterActive = scopeFiltersMs;
    return opps.filter(o => {
      if (diagAccountFilter && diagAccountFilter.size > 0 && !diagAccountFilter.has(accountGrouping.labelFor(o))) return false;
      if (ownerActive && !diagOwnerFilter.has(o.opp_owner_name || 'Unassigned')) return false;
      if (msFilterActive && !diagramMilestonesByOpp.has(o.opp_crm_id)) return false;
      return true;
    });
  }, [opps, diagAccountFilter, diagOwnerFilter, diagOwnerOptions, scopeFiltersMs, accountGrouping, diagramMilestonesByOpp]);

  // Reset filters when URL params change (e.g. navigating from dashboard link back to plain /milestones)
  const currentTpid = searchParams.get('tpid');
  const currentOverdue = searchParams.get('overdue');
  const currentOdays = searchParams.get('odays');
  const currentStatus = searchParams.get('status');
  const currentNoHok = searchParams.get('nohok');
  const currentDue = searchParams.get('due');
  const prevParamsRef = useRef({ tpid: currentTpid, overdue: currentOverdue, odays: currentOdays, status: currentStatus, nohok: currentNoHok, due: currentDue });
  useEffect(() => {
    const prev = prevParamsRef.current;
    if (prev.tpid !== currentTpid || prev.overdue !== currentOverdue || prev.odays !== currentOdays || prev.status !== currentStatus || prev.nohok !== currentNoHok || prev.due !== currentDue) {
      prevParamsRef.current = { tpid: currentTpid, overdue: currentOverdue, odays: currentOdays, status: currentStatus, nohok: currentNoHok, due: currentDue };
      // Reset filters so they re-initialize with new params (commitFilter === null gates init)
      setCommitFilter(null);
      setStatusFilter(null);
      setTblOwnerFilter(new Set());
      setDiagAccountFilter(null); // re-focus the Milestone Map on the new ?tpid= account
    }
  }, [currentTpid, currentOverdue, currentOdays, currentStatus, currentNoHok, currentDue]);

  // Initialize filters once data loads. Defaults to the common working view:
  // Active-only statuses (via the Status filter) and Uncommitted-only (via the
  // Commit filter). A ?tpid= deep-link presets the account to that TPID's grouped
  // label; a ?status= tile deep-link narrows the status; ?nohok= shows everything.
  // Gated on commitFilter === null.
  useEffect(() => {
    if (milestones && milestones.length > 0 && commitFilter === null) {
      const tpid = searchParams.get('tpid');
      if (tpid) {
        const label = accountGrouping.labelByTpid.get(String(tpid));
        // Defer until customers/grouping resolve the label; otherwise show all.
        if (!label && (!customers || customers.length === 0)) return;
        setTblAccountFilter(label ? new Set([label]) : new Set());
      } else {
        setTblAccountFilter(new Set());
      }
      setTblOwnerFilter(new Set());
      const statusParam = searchParams.get('status');
      const noHokParam = searchParams.get('nohok') === 'true';
      if (noHokParam) {
        setStatusFilter(new Set(statusOptions));
        setCommitFilter(new Set(commitOptions));
      } else if (statusParam) {
        // Came from a dashboard status tile: show only that status (all commitments)
        // so the table matches the count that was clicked.
        const match = statusOptions.filter(s => s.toLowerCase() === statusParam.toLowerCase());
        setStatusFilter(new Set(match.length ? match : [statusParam]));
        setCommitFilter(new Set(commitOptions));
      } else {
        // Default working view — also used by the Excellence Metrics "Overdue Comments"
        // card and the per-account Overdue column (?overdue=true): Active-only statuses +
        // Uncommitted-only commitment. Those dashboard metrics count that same
        // Active+Uncommitted population, so the list length matches the clicked count.
        setStatusFilter(new Set(activeStatusOptions));
        setCommitFilter(new Set(commitOptions.filter(c => c === 'Uncommitted')));
      }
    }
  }, [milestones, statusOptions, activeStatusOptions, commitOptions, commitFilter, customers, searchParams, accountGrouping]);

  const isOverdue = searchParams.get('overdue') === 'true';
  // Optional overdue bucket: '30' (30–59d), '60' (60–89d), '90' (90+d). Only meaningful with overdue=true.
  const overdueBucket = searchParams.get('odays');
  const isNoHok = searchParams.get('nohok') === 'true';
  // "Due or overdue" prefilter (from the Action Center "Open Milestones" button): keep only
  // milestones whose target date falls in the overdue-through-due-soon window — the same
  // [today-60d, today+30d] range the Action Center's "Milestones due or overdue" list uses.
  const isDue = searchParams.get('due') === 'true';
  const dueBounds = useMemo(() => {
    const fmt = (off) => {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    return { floor: fmt(-60), ceil: fmt(30), today: fmt(0) };
  }, []);

  const filtered = useMemo(() => {
    if (!milestones || !commitFilter || !statusFilter) return [];
    if (isNoHok && hokPending) return [];
    if (isNoHok && hokUnavailable) return [];
    return milestones.filter(m => {
      const commit = CUSTOMER_COMMITMENT[m.commitment_recommendation] || 'Unknown';
      const status = m.status_label || MILESTONE_STATUS[m.milestone_status] || m.milestone_status || 'Unknown';
      // "Filter" dropdown: single-select account (grouped) + SSP owner picks.
      if (tblAccountFilter.size > 0 && !tblAccountFilter.has(accountGrouping.labelFor(m))) return false;
      if (tblOwnerFilter.size > 0 && !tblOwnerFilter.has(m.opp_owner_name || 'Unassigned')) return false;
      // Status (Active-only quick-pick) and Commit (Uncommitted default) filters.
      if (!commitFilter.has(commit) || !statusFilter.has(status)) return false;
      if (!scopeKeeps(m)) return false;
      if (isNoHok && milestoneIdsWithHok.has(normId(m.milestone_id))) return false;
      if (isDue) {
        const d = (m.milestone_date || '').slice(0, 10);
        if (!d || d < dueBounds.floor || d > dueBounds.ceil) return false;
      }
      if (isOverdue) {
        let ageDays;
        try {
          const comments = JSON.parse(m.comments_json || '[]');
          if (!Array.isArray(comments) || comments.length === 0) return false;
          const latest = comments.reduce((best, c) =>
            !best || new Date(c.modifiedOn) > new Date(best) ? c.modifiedOn : best, null);
          if (!latest) return false;
          ageDays = (Date.now() - new Date(latest).getTime()) / 86400000;
        } catch { return false; }
        if (ageDays <= 30) return false;
        if (overdueBucket === '30') return ageDays > 30 && ageDays <= 60;
        if (overdueBucket === '60') return ageDays > 60 && ageDays <= 90;
        if (overdueBucket === '90') return ageDays > 90;
        return true;
      }
      return true;
    });
  }, [milestones, tblAccountFilter, tblOwnerFilter, commitFilter, statusFilter, accountGrouping, isOverdue, overdueBucket, isDue, dueBounds, isNoHok, hokPending, hokUnavailable, milestoneIdsWithHok, scopeKeeps]);

  const sorted = useMemo(() => {
    if (!sortState) return filtered;
    const { col, dir } = sortState;
    const mult = dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let va, vb;
      if (col === 'date') {
        va = a.milestone_date || '';
        vb = b.milestone_date || '';
      } else if (col === 'acr') {
        va = a.monthly_use != null ? Number(a.monthly_use) : -Infinity;
        vb = b.monthly_use != null ? Number(b.monthly_use) : -Infinity;
      } else if (col === 'tasks') {
        va = Number(a.task_count) || 0;
        vb = Number(b.task_count) || 0;
      } else if (col === 'comments') {
        const ca = parseComments(a.comments_json);
        const cb = parseComments(b.comments_json);
        va = ca.length > 0 && ca[0].date ? new Date(ca[0].date).getTime() : -Infinity;
        vb = cb.length > 0 && cb[0].date ? new Date(cb[0].date).getTime() : -Infinity;
      }
      return va < vb ? -1 * mult : va > vb ? 1 * mult : 0;
    });
  }, [filtered, sortState]);

  // Ordered list of account-group labels for the table view (used by expand/collapse all).
  const tblAccountKeys = useMemo(() => {
    const seen = [];
    const set = new Set();
    for (const ms of sorted) {
      const acct = accountGrouping.labelFor(ms) || ms.customer_name || '—';
      if (!set.has(acct)) { set.add(acct); seen.push(acct); }
    }
    return seen;
  }, [sorted, accountGrouping]);
  const toggleAcct = useCallback((acct) => setCollapsedAccts((p) => ({ ...p, [acct]: !p[acct] })), []);
  const expandAllAccts = useCallback(() => setCollapsedAccts({}), []);
  const collapseAllAccts = useCallback(() => {
    const all = {};
    for (const a of tblAccountKeys) all[a] = true;
    setCollapsedAccts(all);
  }, [tblAccountKeys]);

  if (initialLoading || (isNoHok && hokPending)) return <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner size="large" label="Loading milestones…" /></div>;

  const hasData = (opps && opps.length > 0) || (milestones && milestones.length > 0);

  // Derived table quick-filter states, mirroring the diagram's Active/Uncommitted
  // toggles but driven off the table's status/commit filter sets.
  const tblActiveOnly = !!statusFilter && activeStatusOptions.length > 0
    && statusFilter.size === activeStatusOptions.length
    && activeStatusOptions.every(s => statusFilter.has(s));
  const tblUncommittedOnly = !!commitFilter && commitFilter.size === 1 && commitFilter.has('Uncommitted');

  return (
    <div className={`milestones-page${view === 'table' ? ' list-page' : ''}`}>
      <div className="page-header">
        <div className="page-header-left">
          <h2>{view === 'diagram' ? 'Milestone Map' : 'Milestones'}</h2>
          {hasData && view === 'diagram' && (
            <div className="diagram-filters">
              <FilterDropdown
                label="Filter"
                single
                options={diagAccountOptions}
                selected={diagAccountFilter || new Set()}
                onChange={setDiagAccountFilter}
                pinned={{
                  label: 'Cloud & AI Specialists',
                  options: sspNames,
                  isActive: (name) => !!diagOwnerFilter && diagOwnerFilter.size === 1 && diagOwnerFilter.has(name),
                  onPick: (name) => setDiagOwnerFilter(prev =>
                    (prev && prev.size === 1 && prev.has(name))
                      ? new Set(diagOwnerOptions)   // toggle off → back to all owners
                      : new Set([name])
                  ),
                }}
              />
            </div>
          )}
          {hasData && view === 'table' && (
            <div className="diagram-filters">
              <FilterDropdown
                label="Filter"
                single
                options={diagAccountOptions}
                selected={tblAccountFilter}
                onChange={setTblAccountFilter}
                pinned={{
                  label: 'Cloud & AI Specialists',
                  options: sspNames,
                  isActive: (name) => tblOwnerFilter.size === 1 && tblOwnerFilter.has(name),
                  onPick: (name) => setTblOwnerFilter(prev =>
                    (prev && prev.size === 1 && prev.has(name))
                      ? new Set()          // toggle off → all owners
                      : new Set([name])
                  ),
                }}
              />
            </div>
          )}
          {/* Cross-links to the two milestone sub-views (Map, Timeline). They live under
              Milestones and are hidden from the sidebar by default, so these buttons keep
              them discoverable from the page the user is most likely to start on. */}
          {view === 'table' && (
            <div className="ms-view-links">
              <Button
                appearance="subtle"
                size="small"
                icon={<OrganizationRegular />}
                onClick={() => navigate('/milestone-map')}
                title="Open the Milestone Map"
              >
                Milestone Map
              </Button>
              <Button
                appearance="subtle"
                size="small"
                icon={<GanttChartRegular />}
                onClick={() => navigate('/milestone-timeline')}
                title="Open the Milestone Timeline"
              >
                Milestone Timeline
              </Button>
            </div>
          )}
          {view === 'diagram' && (
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
                icon={<GanttChartRegular />}
                onClick={() => navigate('/milestone-timeline')}
                title="Open the Milestone Timeline"
              >
                Milestone Timeline
              </Button>
            </div>
          )}
        </div>
        <div className="page-header-right">
          {hasData && view === 'diagram' && (
            <div className="mt-viewtoggle">
              <button
                className={`mt-seg-btn${diagActiveOnly ? ' active' : ''}`}
                title="Hide completed, cancelled, duplicate, and lost milestones"
                onClick={() => setDiagActiveOnly((v) => !v)}
              >Active only</button>
              <button
                className={`mt-seg-btn${diagUncommittedOnly ? ' active' : ''}`}
                title="Hide committed milestones"
                onClick={() => setDiagUncommittedOnly((v) => !v)}
              >Uncommitted only</button>
            </div>
          )}
          {hasData && view === 'table' && (
            <div className="mt-viewtoggle">
              <button
                className={`mt-seg-btn${tblActiveOnly ? ' active' : ''}`}
                title="Hide completed, cancelled, duplicate, and lost milestones"
                onClick={() => setStatusFilter(new Set(tblActiveOnly ? statusOptions : activeStatusOptions))}
              >Active only</button>
              <button
                className={`mt-seg-btn${tblUncommittedOnly ? ' active' : ''}`}
                title="Hide committed milestones"
                onClick={() => setCommitFilter(new Set(tblUncommittedOnly ? commitOptions : commitOptions.filter(c => c === 'Uncommitted')))}
              >Uncommitted only</button>
            </div>
          )}
          <TerritoryToggle />
        </div>
      </div>

      {hasData && (
        <div className="ms-id-search">
          <div className="ms-id-field">
            <input
              className="ms-id-input"
              type="text"
              placeholder="Search opportunity by ID…"
              value={oppIdQuery}
              onChange={(e) => setOppIdQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') openOppById(); }}
            />
            {oppIdQuery.trim() ? (
              oppIdMatch ? (
                <button type="button" className="ms-id-hint match" onClick={openOppById} title="Open opportunity details">
                  {oppIdMatch.opp_name || '(unnamed opportunity)'}
                </button>
              ) : (
                <span className="ms-id-hint nomatch">No opportunity with that ID</span>
              )
            ) : null}
          </div>
          <div className="ms-id-field">
            <input
              className="ms-id-input"
              type="text"
              placeholder="Search milestone by ID…"
              value={msIdQuery}
              onChange={(e) => setMsIdQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') openMsById(); }}
            />
            {msIdQuery.trim() ? (
              msIdMatch ? (
                <button type="button" className="ms-id-hint match" onClick={openMsById} title="Open milestone details">
                  {msIdMatch.name || '(unnamed milestone)'}
                </button>
              ) : (
                <span className="ms-id-hint nomatch">No milestone with that ID</span>
              )
            ) : null}
          </div>
        </div>
      )}

      {flash && <div className={`flash-message flash-${flash.type}`}>{flash.msg}</div>}
      {isNoHok && hokUnavailable && (
        <div className="flash-message flash-warning">HoK activities are unavailable, so the “no HoK activity” milestone list cannot be computed right now.</div>
      )}
      {view === 'table' && isOverdue && (
        <div className="overdue-banner">
          <WarningRegular style={{ color: 'var(--pink)', flexShrink: 0 }} />
          <span>
            Showing <strong>overdue milestones only</strong> — last comment {
              overdueBucket === '30' ? 'between 30 and 60 days ago'
                : overdueBucket === '60' ? 'between 60 and 90 days ago'
                : overdueBucket === '90' ? 'more than 90 days ago'
                : 'more than 30 days ago'
            }, most overdue first.
            Adding a comment brings a milestone up to date, so it leaves this list.
          </span>
          <button
            type="button"
            className="overdue-banner-clear"
            onClick={() => setSearchParams({})}
            title="Clear the overdue filter and show all milestones"
          >
            Show all milestones
          </button>
        </div>
      )}
      {view === 'table' && isDue && (
        <div className="overdue-banner">
          <FlagRegular style={{ color: 'var(--pink)', flexShrink: 0 }} />
          <span>
            Showing <strong>milestones due or overdue only</strong> — a target date from the last 60 days
            (overdue) through the next 30 days (due soon), earliest first.
          </span>
          <button
            type="button"
            className="overdue-banner-clear"
            onClick={() => setSearchParams({})}
            title="Clear the due/overdue filter and show all milestones"
          >
            Show all milestones
          </button>
        </div>
      )}

      {!hasData ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 48 }}>
          No milestones yet. Run “Sync from CRM” in Settings to pull opportunities and milestones from Dynamics.
        </div>
      ) : (
        <>
          {view === 'diagram' && (
            <MilestoneDiagram
              opps={diagramOpps}
              milestonesByOpp={diagramMilestonesByOpp}
              customers={customers}
              crmBaseUrl={crmBaseUrl}
              onOpenExternal={openExternal}
              teamApi={{ isOnTeam, toggleTeam, joiningKey, currentUserId, currentUserName, addMilestoneComment, addActivity, addMilestone, updateMilestone }}
            />
          )}

          {view === 'table' && (
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
              <SortableTh label="ACR (M)" column="acr" sortState={sortState} onSort={setSortState} />
              <SortableTh label="Est Date" column="date" sortState={sortState} onSort={setSortState} />
              <SortableTh label="Comments" column="comments" sortState={sortState} onSort={setSortState} />
              <SortableTh label="Tasks" column="tasks" sortState={sortState} onSort={setSortState} />
              <th>
                <FilterDropdown
                  label="Status"
                  plain
                  options={statusOptions}
                  selected={statusFilter || new Set()}
                  onChange={setStatusFilter}
                  showSearch={false}
                  quickPick={{ label: 'Active Only', title: 'Show only active statuses (hide completed, cancelled, duplicate, and lost)', values: activeStatusOptions }}
                />
              </th>
              <th>
                <FilterDropdown label="Commit" plain options={commitOptions} selected={commitFilter || new Set()} onChange={setCommitFilter} showSearch={false} />
              </th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No milestones match the current filters.</td></tr>
            ) : (() => {
              const groups = [];
              const idx = new Map();
              for (const ms of sorted) {
                const acct = accountGrouping.labelFor(ms) || ms.customer_name || '—';
                let g = idx.get(acct);
                if (!g) { g = { account: acct, rows: [] }; idx.set(acct, g); groups.push(g); }
                g.rows.push(ms);
              }
              return groups.map(group => {
                const isCollapsed = !!collapsedAccts[group.account];
                return (
                <React.Fragment key={`grp-${group.account}`}>
                  <tr className="tbl-account-section tbl-row-clickable" onClick={() => toggleAcct(group.account)} style={{ cursor: 'pointer' }}>
                    <td colSpan={9}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {isCollapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
                        {group.account}
                        <span style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 12 }}>({group.rows.length})</span>
                        {tpidByLabel.get(group.account) ? (
                          <button
                            type="button"
                            className="tbl-glance-btn"
                            title="Account glance"
                            onClick={(e) => { e.stopPropagation(); setGlance({ tpid: String(tpidByLabel.get(group.account)), name: group.account }); }}
                          >
                            <ContactCardRegular />
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                  {!isCollapsed && group.rows.map(ms => {
              const msLink = ms.milestone_id && crmBaseUrl
                ? `${crmBaseUrl}/main.aspx?etn=msp_engagementmilestone&id=${ms.milestone_id}&pagetype=entityrecord`
                : null;
              const statusText = ms.status_label || MILESTONE_STATUS[ms.milestone_status] || ms.milestone_status || '—';
              const rowKey = ms.milestone_id || ms.id;
              return (
                <React.Fragment key={rowKey}>
                <tr onClick={() => setDetail({ type: 'ms', data: ms })} data-tour="ms-row" style={{ cursor: 'pointer' }} title="Click for milestone details">
                  <td>
                    {ms.opp_name ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openOppDetail(ms); }}
                        title="Click for opportunity details"
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textAlign: 'left', textDecoration: 'underline' }}
                      >
                        {ms.opp_name}
                      </button>
                    ) : '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>{ms.name || '—'}</td>
                  <td>{ms.monthly_use != null ? `$${Number(ms.monthly_use).toLocaleString()}` : '—'}</td>
                  <td>{ms.milestone_date ? formatDateOnly(ms.milestone_date) : '—'}</td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{daysAgoText(ms.comments_json)}</td>
                  <td style={{ textAlign: 'center', fontSize: 13 }}>{ms.task_count || 0}</td>
                  <td>
                    <span className={`badge ${statusTextBadgeClass(statusText)}`}>
                      {statusText}
                    </span>
                  </td>
                  <td>
                    {ms.commitment_recommendation != null
                      ? <span className={`badge ${commitmentBadgeClass(ms.commitment_recommendation)}`}>{CUSTOMER_COMMITMENT[ms.commitment_recommendation] || ms.commitment_recommendation}</span>
                      : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      {(() => {
                        const onTeam = isOnTeam('ms', ms.milestone_id, parseTeamList(ms.deal_team_json));
                        const busy = joiningKey === `ms:${ms.milestone_id}`;
                        return (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<PeopleTeamRegular style={{ color: onTeam ? 'var(--warning-text)' : 'var(--text-muted)' }} />}
                            disabled={busy || !ms.milestone_id}
                            onClick={(e) => { e.stopPropagation(); toggleTeam('ms', ms.milestone_id, onTeam); }}
                            title={onTeam ? 'You are on this milestone team — click to leave' : 'You are not on this milestone team — click to join'}
                            style={{ minWidth: 'auto', padding: 2 }}
                          />
                        );
                      })()}
                      {msLink && <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={(e) => { e.stopPropagation(); openExternal(msLink); }} title="Open Milestone in CRM" style={{ minWidth: 'auto', padding: 2 }} />}
                    </div>
                  </td>
                </tr>
                </React.Fragment>
              );
                  })}
                </React.Fragment>
                );
              });
            })()}
          </tbody>
        </table>
        </div>
          )}
        </>
      )}

      {/* Milestone details — same shared panel used by the Milestone Map / Timeline */}
      <DetailCard
        detail={detail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setDetail(null)}
        onSelect={setDetail}
        teamApi={{ isOnTeam, toggleTeam, joiningKey, currentUserId, currentUserName, addMilestoneComment, addActivity, addMilestone, updateMilestone }}
      />
      <AccountGlanceModal selected={glance} onClose={() => setGlance(null)} />
    </div>
  );
}

// Expanded milestone detail (table view): comments + add box on the left, HoK
// activities for this milestone on the right. HoK tasks come from the local cache
// (hok_tasks, populated by Settings → Sync from CRM); the right side shows nothing
// to fetch live so it stays fast and offline-consistent.
function MilestoneExpanded({ ms, comments, crmBaseUrl, currentUserName, onAddComment, onAddActivity, onOpenExternal }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [localComments, setLocalComments] = useState(comments);
  const [hok, setHok] = useState(null); // null = loading

  // Add-HoK form state
  const [showHokForm, setShowHokForm] = useState(false);
  const [hokSubject, setHokSubject] = useState('');
  const [hokCategory, setHokCategory] = useState('');
  const [hokDue, setHokDue] = useState('');
  const [hokDescription, setHokDescription] = useState('');
  const [hokSaving, setHokSaving] = useState(false);
  const [hokError, setHokError] = useState('');

  useEffect(() => { setLocalComments(comments); }, [comments]);

  const loadHok = useCallback(() => {
    const mid = (ms.milestone_id || '').replace(/[{}]/g, '').toLowerCase();
    if (!mid) { setHok([]); return Promise.resolve(); }
    return dbQuery(
      'SELECT activity_id, subject, created_on, state_code, owner_name FROM active_hok_tasks WHERE regarding_id = ? ORDER BY created_on DESC',
      [mid]
    ).then(rows => setHok(rows || [])).catch(() => setHok([]));
  }, [ms.milestone_id]);

  useEffect(() => {
    let cancelled = false;
    setHok(null);
    loadHok().then(() => { if (cancelled) setHok(h => h); });
    return () => { cancelled = true; };
  }, [loadHok]);

  const submitHok = async () => {
    if (hokSaving || !hokSubject.trim()) return;
    setHokSaving(true); setHokError('');
    try {
      await onAddActivity('ms', ms.milestone_id, { subject: hokSubject.trim(), taskCategory: hokCategory, dueDate: hokDue, description: hokDescription });
      // Show it immediately; a Settings sync will reconcile the cache from CRM.
      setHok(prev => [{ activity_id: `pending-${Date.now()}`, subject: hokSubject.trim(), created_on: new Date().toISOString(), state_code: 1, owner_name: currentUserName }, ...(prev || [])]);
      setHokSubject(''); setHokCategory(''); setHokDue(''); setHokDescription(''); setShowHokForm(false);
    } catch (e) {
      setHokError(e.message || String(e));
    } finally {
      setHokSaving(false);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true); setError('');
    try {
      const json = await onAddComment(ms.milestone_id, text);
      setDraft('');
      setLocalComments(parseComments(json));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const taskLink = (a) => (a.activity_id && crmBaseUrl)
    ? `${crmBaseUrl}/main.aspx?etn=task&id=${a.activity_id}&pagetype=entityrecord`
    : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: '12px 16px 16px 32px' }}>
      {/* Left: comments + add */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>Comments</div>
        {localComments.length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No comments.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 260, overflowY: 'auto' }}>
            {localComments.map((c, i) => (
              <div key={i}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent)' }}>
                  {c.poster} <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{c.date ? new Date(c.date).toLocaleString() : ''}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.text}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="Add a comment…"
            style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '6px 10px', fontSize: 13 }}
          />
          <Button size="small" appearance="primary" disabled={!draft.trim() || saving} onClick={submit}>
            {saving ? 'Saving…' : 'Add'}
          </Button>
        </div>
        {error && <div style={{ color: 'var(--pink)', fontSize: 12, marginTop: 6 }}>{error}</div>}
      </div>

      {/* Right: HoK activities for this milestone */}
      <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 16, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
          HoK Activities{hok ? ` (${hok.length})` : ''}
        </div>
        {hok === null ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</span>
        ) : hok.length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No HoK activities. Sync from CRM in Settings to refresh.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
            {hok.map((a) => {
              const link = taskLink(a);
              return (
                <div key={a.activity_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, justifyContent: 'space-between' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{a.subject || '(no subject)'}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {a.owner_name ? `${a.owner_name} · ` : ''}
                      {a.created_on ? new Date(a.created_on).toLocaleDateString() : ''}
                      {' · '}
                      <span className={`badge ${a.state_code === 1 ? 'badge-success' : a.state_code === 2 ? 'badge-secondary' : 'badge-warning'}`}>
                        {a.state_code === 1 ? 'Completed' : a.state_code === 2 ? 'Canceled' : 'Open'}
                      </span>
                    </div>
                  </div>
                  {link && <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={() => onOpenExternal(link)} title="Open activity in CRM" style={{ minWidth: 'auto', padding: 2 }} />}
                </div>
              );
            })}
          </div>
        )}
        {showHokForm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, padding: 10, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <input
              type="text"
              value={hokSubject}
              onChange={e => setHokSubject(e.target.value)}
              placeholder="Subject"
              autoFocus
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '6px 10px', fontSize: 13 }}
            />
            <textarea
              value={hokDescription}
              onChange={e => setHokDescription(e.target.value)}
              placeholder="Description"
              rows={3}
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '6px 10px', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }}
            />
            <select
              value={hokCategory}
              onChange={e => setHokCategory(e.target.value)}
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '6px 10px', fontSize: 13 }}
            >
              <option value="">Task category…</option>
              {TASK_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>Due date
              <input type="date" value={hokDue} onChange={e => setHokDue(e.target.value)} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '6px 10px', fontSize: 13 }} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="small" appearance="primary" disabled={!hokSubject.trim() || hokSaving} onClick={submitHok}>{hokSaving ? 'Adding…' : 'Create (completed)'}</Button>
              <Button size="small" appearance="subtle" disabled={hokSaving} onClick={() => { setShowHokForm(false); setHokError(''); setHokDescription(''); }}>Cancel</Button>
            </div>
            {hokError && <div style={{ color: 'var(--pink)', fontSize: 12 }}>{hokError}</div>}
          </div>
        ) : onAddActivity && (
          <div style={{ marginTop: 12 }}>
            <Button size="small" appearance="secondary" onClick={() => { setShowHokForm(true); setHokError(''); }}>+ Add HoK activity</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Diagram view ─────────────────────────────────────────────────────
// Builds an Account (TPID) → Opportunity → Milestone hierarchy from the
function buildHierarchy(opps, milestonesByOpp, customers) {
  const byAccountId = new Map();
  const accsByTpid = new Map();
  for (const c of customers || []) {
    if (c.crm_account_id) byAccountId.set(c.crm_account_id, c);
    if (c.tpid) {
      if (!accsByTpid.has(c.tpid)) accsByTpid.set(c.tpid, []);
      accsByTpid.get(c.tpid).push(c);
    }
  }
  // Top-parent account per TPID: prefer the parenting_level flag, else the account
  // with no parent, else the first in the group. Every opportunity rolls up to this
  // node so child (portco) accounts collapse into their parent TPID instead of
  // standing up as their own top-level account nodes.
  const topByTpid = new Map();
  for (const [tpid, accs] of accsByTpid) {
    const top = accs.find(a => a.parenting_level === 861980000)
      || accs.find(a => !a.parent_crm_account_id)
      || accs[0];
    if (top) topByTpid.set(tpid, top);
  }

  const accounts = new Map();
  for (const o of opps || []) {
    const directId = o.parent_account_id || null;
    const directCust = directId ? byAccountId.get(directId) : null;
    // Resolve to the TPID's top-parent account so all opportunities under the same
    // TPID group into one node; fall back to the opportunity's own account.
    const accCust = (directCust?.tpid && topByTpid.get(directCust.tpid)) || directCust || null;
    const accId = accCust?.crm_account_id || directId || null;
    const accName = accCust?.name || o.customer_name || 'Unknown account';
    const accKey = accId || accName;
    if (!accounts.has(accKey)) {
      const tpid = accCust?.tpid || null;
      // Children = every other account sharing this TPID (the portcos under the parent).
      const kids = tpid
        ? (accsByTpid.get(tpid) || []).filter(c => c.crm_account_id !== accId)
        : [];
      accounts.set(accKey, {
        key: accKey,
        name: accName,
        tpid,
        children: kids.map(c => ({ name: c.name, tpid: c.tpid })),
        opps: new Map(),
      });
    }
    const acc = accounts.get(accKey);
    const oppKey = o.opp_crm_id || o.opp_name || 'unassigned';
    if (!acc.opps.has(oppKey)) {
      acc.opps.set(oppKey, {
        key: oppKey,
        name: o.opp_name || 'Unassigned opportunity',
        crmId: o.opp_crm_id || null,
        owner: o.opp_owner_name || '',
        customerNeed: o.customer_need || '',
        milestones: [],
      });
    }
    const opp = acc.opps.get(oppKey);
    const msRows = (milestonesByOpp && milestonesByOpp.get(o.opp_crm_id)) || [];
    for (const m of msRows) {
      opp.milestones.push({ ...m, deal_team: parseTeamList(m.deal_team_json) });
    }
  }

  // Roll up each opportunity's deal team = owner ∪ union of its milestones' teams.
  return [...accounts.values()].map(a => ({
    ...a,
    opps: [...a.opps.values()].map(opp => {
      const members = new Set();
      if (opp.owner) members.add(opp.owner);
      for (const ms of opp.milestones) {
        for (const name of ms.deal_team) members.add(name);
      }
      return { ...opp, members: [...members].sort(), accountName: a.name };
    }),
  }));
}

function formatAcr(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n === 0) return null;
  return `$${n.toLocaleString()}`;
}

// Build the { type:'opp' } DetailCard payload from a raw opportunity row plus its
// milestone rows. Tolerates the different column shapes the various queries use
// (opp_crm_id/opp_name/opp_owner_name from the joined milestone/diagram queries,
// opportunity_id/name/owner_name from the timeline query). Rolls the deal team up
// from the opp owner ∪ each milestone's deal team, matching buildHierarchy.
export function buildOppDetail(opp, milestoneRows, accountName) {
  const milestones = (milestoneRows || []).map((m) => ({ ...m, deal_team: parseTeamList(m.deal_team_json) }));
  const owner = opp.opp_owner_name || opp.owner_name || opp.owner || '';
  const members = new Set();
  if (owner) members.add(owner);
  for (const ms of milestones) for (const name of ms.deal_team) members.add(name);
  return {
    name: opp.opp_name || opp.name || 'Unassigned opportunity',
    crmId: opp.opp_crm_id || opp.opportunity_id || opp.crmId || null,
    owner,
    accountName: accountName || opp.customer_name || '—',
    customerNeed: opp.customer_need || opp.customerNeed || '',
    members: [...members].sort(),
    milestones,
  };
}

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deal-team bubble with a hover popover listing the people on the team. When `onToggle`
// is provided the bubble becomes a button: light-yellow if the user is already a
// member (clicking removes them), otherwise clicking adds them to the team.
function DealTeam({ members, label, ownerName, isMember = false, onToggle, busy = false }) {
  const list = members || [];
  const clickable = typeof onToggle === 'function';
  const handleClick = (e) => {
    if (!clickable) return;
    e.stopPropagation();
    if (!busy) onToggle();
  };
  const cls = `eng-dealteam${isMember ? ' is-member' : ''}${clickable ? ' clickable' : ''}`;
  return (
    <span className="eng-dealteam-wrap">
      <span
        className={cls}
        onClick={handleClick}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? (isMember ? 'Remove yourself from this team' : 'Add yourself to this team') : undefined}
      >
        {busy ? <Spinner size="tiny" /> : <PeopleTeamRegular style={{ fontSize: 13 }} />}
        {list.length > 0 && <span className="eng-dealteam-count">{list.length}</span>}
      </span>
      <span className="eng-dealteam-pop" role="tooltip">
        <span className="eng-pop-title">{label}</span>
        {list.length === 0 ? (
          <span className="eng-pop-empty">No team members synced</span>
        ) : (
          list.map((name, i) => (
            <span className="eng-pop-row" key={i}>
              <span className="eng-pop-avatar">{initials(name)}</span>
              <span className="eng-pop-name">{name}</span>
              {ownerName && name === ownerName && <span className="eng-pop-owner">owner</span>}
            </span>
          ))
        )}
        {clickable && (
          <span className="eng-pop-action">
            {isMember ? '− Click to remove yourself' : '+ Click to add yourself'}
          </span>
        )}
      </span>
    </span>
  );
}

function AccountNode({ acc }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="eng-node eng-account">
      <div className="eng-node-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <BuildingRegular style={{ fontSize: 16, color: 'var(--accent)', flex: '0 0 auto' }} />
          <span className="eng-node-title" title={acc.name}>{acc.name}</span>
        </span>
      </div>
      {acc.tpid && <div className="eng-node-sub">TPID {acc.tpid}</div>}
      {acc.children.length > 0 && (
        <>
          <button
            className="eng-collapse-toggle"
            onClick={() => setExpanded(e => !e)}
            title={expanded ? 'Hide child accounts' : 'Show child accounts'}
          >
            {expanded ? <ChevronDownRegular style={{ fontSize: 12 }} /> : <ChevronRightRegular style={{ fontSize: 12 }} />}
            Child accounts ({acc.children.length})
          </button>
          {expanded && (
            <div className="eng-chips">
              {acc.children.map((c, i) => (
                <span className="eng-chip" key={i} title={c.tpid ? `TPID ${c.tpid}` : c.name}>{c.name}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OppNode({ opp, crmBaseUrl, onOpenExternal, onSelect, teamApi }) {
  const totalAcr = opp.milestones.reduce((s, m) => s + (Number(m.monthly_use) || 0), 0);
  const acr = formatAcr(totalAcr);
  const link = opp.crmId && crmBaseUrl
    ? `${crmBaseUrl}/main.aspx?etn=opportunity&id=${opp.crmId}&pagetype=entityrecord`
    : null;
  const member = teamApi?.isOnTeam ? teamApi.isOnTeam('opp', opp.crmId, opp.members) : false;
  const busy = teamApi?.joiningKey === `opp:${opp.crmId}`;
  return (
    <div className="eng-node eng-opp" title={opp.name} onClick={() => onSelect && onSelect()}>
      <div className="eng-node-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <TargetRegular style={{ fontSize: 15, color: 'var(--accent)', flex: '0 0 auto' }} />
          <span className="eng-node-title" title={opp.name}>{opp.name}</span>
        </span>
      </div>
      <div className="eng-owner" title={opp.owner ? `Opportunity owner: ${opp.owner}` : 'Owner not synced'}>
        <span className="eng-owner-avatar">{opp.owner ? initials(opp.owner) : '?'}</span>
        <span className="eng-owner-name">{opp.owner || 'Owner not synced'}</span>
      </div>
      <div className="eng-node-foot">
        <span className="eng-node-foot-left">
          {acr && <span className="eng-acr">{acr}</span>}
          {link && (
            <button className="eng-node-link" title="Open opportunity in CRM" onClick={e => { e.stopPropagation(); onOpenExternal(link); }}>
              <OpenRegular style={{ fontSize: 14 }} />
            </button>
          )}
        </span>
        <DealTeam
          members={opp.members}
          ownerName={opp.owner}
          label="Opportunity deal team"
          isMember={member}
          busy={busy}
          onToggle={teamApi?.toggleTeam && opp.crmId ? () => teamApi.toggleTeam('opp', opp.crmId, member) : undefined}
        />
      </div>
    </div>
  );
}

function MilestoneNode({ ms, crmBaseUrl, onOpenExternal, onSelect, teamApi }) {
  const acr = formatAcr(ms.monthly_use);
  const statusText = ms.status_label || MILESTONE_STATUS[ms.milestone_status] || ms.milestone_status || '—';
  const team = ms.deal_team && ms.deal_team.length ? ms.deal_team : parseTeamList(ms.deal_team_json);
  const members = [...new Set([...(team || []), ...(ms.owner_name ? [ms.owner_name] : [])])];
  const link = ms.milestone_id && crmBaseUrl
    ? `${crmBaseUrl}/main.aspx?etn=msp_engagementmilestone&id=${ms.milestone_id}&pagetype=entityrecord`
    : null;
  const member = teamApi?.isOnTeam ? teamApi.isOnTeam('ms', ms.milestone_id, members) : false;
  const busy = teamApi?.joiningKey === `ms:${ms.milestone_id}`;
  return (
    <div className="eng-node eng-ms" title={ms.name || ''} onClick={() => onSelect && onSelect()}>
      <div className="eng-node-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <FlagRegular style={{ fontSize: 14, color: 'var(--text-secondary)', flex: '0 0 auto' }} />
          <span className="eng-node-title" title={ms.name}>{ms.name || '—'}</span>
        </span>
      </div>
      <div className="eng-node-meta">
        <span className={`badge ${statusTextBadgeClass(statusText)}`}>{statusText}</span>
        {acr && <span className="eng-acr">{acr}</span>}
      </div>
      <div className="eng-node-foot">
        <span className="eng-node-foot-left">
          {ms.milestone_date && (
            <span className="eng-node-sub" style={{ margin: 0 }}>{formatDateOnly(ms.milestone_date)}</span>
          )}
          {Number(ms.task_count) > 0 && (
            <span className="eng-chip">{ms.task_count} task{Number(ms.task_count) === 1 ? '' : 's'}</span>
          )}
          {link && (
            <button className="eng-node-link" title="Open milestone in CRM" onClick={e => { e.stopPropagation(); onOpenExternal(link); }}>
              <OpenRegular style={{ fontSize: 14 }} />
            </button>
          )}
        </span>
        <DealTeam
          members={members}
          ownerName={ms.owner_name}
          label="Milestone deal team"
          isMember={member}
          busy={busy}
          onToggle={teamApi?.toggleTeam && ms.milestone_id ? () => teamApi.toggleTeam('ms', ms.milestone_id, member) : undefined}
        />
      </div>
    </div>
  );
}

// Monospace record-id value with a one-click copy button. Used in the detail card to surface
// the CRM opportunity / milestone GUID (both verified present + unique in the datastore).
// Self-contained "copied" state so it can be dropped into the details rows without threading
// state through the parent. Falls back to a plain selectable value if the id is missing.
function IdValue({ id }) {
  const [copied, setCopied] = useState(false);
  if (!id) return <span>—</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(id));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the value is still selectable */ }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, userSelect: 'all', wordBreak: 'break-all' }}>
        {id}
      </span>
      <button
        onClick={copy}
        title={copied ? 'Copied' : 'Copy ID'}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: copied ? 'var(--accent)' : 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }}
      >
        {copied ? <CheckmarkRegular style={{ fontSize: 13 }} /> : <CopyRegular style={{ fontSize: 13 }} />}
      </button>
    </span>
  );
}

// Resolve an owner's display name to a Teams-addressable email/UPN. The MSX owner is a display
// name, but the Teams chat deep-link needs an email — so we look one up: first the local
// org_people cache (fast, offline), then a live directory search (WorkIQ Graph) for anyone not
// yet cached. Prefers an exact display-name match on a real @microsoft.com mailbox. Returns null
// when no email can be resolved, so the caller can fail loudly rather than open an empty chat.
async function resolveOwnerEmail(ownerName) {
  const name = String(ownerName || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  // 1) Local cache by exact display name — prefer a corporate mailbox.
  try {
    const rows = await dbQuery(
      `SELECT mail, user_principal_name FROM org_people
        WHERE LOWER(display_name) = ? AND (TRIM(mail) <> '' OR TRIM(user_principal_name) <> '')
        ORDER BY (mail LIKE '%@microsoft.com') DESC, updated_at DESC
        LIMIT 1`,
      [lower],
    );
    const hit = Array.isArray(rows) ? rows[0] : null;
    const cached = hit && (hit.mail || hit.user_principal_name);
    if (cached && String(cached).trim()) return String(cached).trim();
  } catch { /* fall through to live search */ }
  // 2) Live directory search — take an exact display-name match, preferring @microsoft.com.
  try {
    const res = await orgSearchPeople({ query: name });
    const people = (res && res.ok && Array.isArray(res.people)) ? res.people : [];
    const exact = people.filter((p) => String(p.displayName || '').trim().toLowerCase() === lower && (p.mail || '').trim());
    const pick = exact.find((p) => /@microsoft\.com$/i.test(p.mail)) || exact[0] || null;
    if (pick && pick.mail) return String(pick.mail).trim();
  } catch { /* unresolved */ }
  return null;
}

// Modal details card shown when an opportunity or milestone node is clicked.
// Thin wrapper: returns null when nothing is selected so the inner component (which
// uses hooks for comments/activities) only mounts for a real selection.
export function DetailCard({ detail, crmBaseUrl, onOpenExternal, onClose, onSelect, teamApi }) {
  if (!detail) return null;
  const k = detail.type === 'opp' ? detail.data.crmId : detail.data.milestone_id;
  return (
    <DetailCardInner
      key={`${detail.type}:${k}`}
      detail={detail}
      crmBaseUrl={crmBaseUrl}
      onOpenExternal={onOpenExternal}
      onClose={onClose}
      onSelect={onSelect}
      teamApi={teamApi}
    />
  );
}

function DetailCardInner({ detail, crmBaseUrl, onOpenExternal, onClose, onSelect, teamApi }) {
  const isOpp = detail.type === 'opp';
  const d = detail.data;
  const recordId = isOpp ? d.crmId : d.milestone_id;
  const editorOpportunityId = isOpp ? recordId : d.opportunity_id;
  const editorOpportunityName = isOpp ? d.name : d.opp_name;
  const editorAccountName = isOpp ? d.accountName : d.customer_name;

  let title, rows, link, teamLabel, members, ownerName;
  if (isOpp) {
    const totalAcr = d.milestones.reduce((s, m) => s + (Number(m.monthly_use) || 0), 0);
    title = d.name;
    ownerName = d.owner;
    members = d.members || [];
    teamLabel = 'Opportunity deal team';
    link = d.crmId && crmBaseUrl ? `${crmBaseUrl}/main.aspx?etn=opportunity&id=${d.crmId}&pagetype=entityrecord` : null;
    rows = [
      ['Owner', d.owner || '—'],
      ['Account', d.accountName || '—'],
      ['Customer Need', d.customerNeed || '—'],
      ['Total ACR (monthly)', formatAcr(totalAcr) || '—'],
      ['Milestones', String(d.milestones.length)],
      ['Opportunity ID', <IdValue id={d.crmId} />],
    ];
  } else {
    const statusText = d.status_label || MILESTONE_STATUS[d.milestone_status] || d.milestone_status || '—';
    const team = d.deal_team && d.deal_team.length ? d.deal_team : parseTeamList(d.deal_team_json);
    members = [...new Set([...(team || []), ...(d.owner_name ? [d.owner_name] : [])])];
    ownerName = d.owner_name;
    teamLabel = 'Milestone deal team';
    title = d.name || '—';
    link = d.milestone_id && crmBaseUrl ? `${crmBaseUrl}/main.aspx?etn=msp_engagementmilestone&id=${d.milestone_id}&pagetype=entityrecord` : null;
    rows = [
      ['Status', statusText],
      ['Owner', d.owner_name || '—'],
      ['Opportunity', d.opp_name || '—'],
      ['Account', d.customer_name || '—'],
      ['ACR (monthly)', formatAcr(d.monthly_use) || '—'],
      ['Target date', d.milestone_date ? formatDateOnly(d.milestone_date) : '—'],
      ['Tasks', String(Number(d.task_count) || 0)],
      ['Milestone ID', <IdValue id={d.milestone_id} />],
    ];
  }

  // ── Message the owner in Teams ────────────────────────────────────
  // Opens a 1:1 Teams chat with this record's owner via the Teams chat deep link, opened through
  // the OS handler (same openExternal path as Join / Open in CRM). The owner's email is resolved
  // on click (cache → live directory); if it can't be resolved we say so plainly rather than
  // opening an empty chat.
  const [msgOwnerBusy, setMsgOwnerBusy] = useState(false);
  const [msgOwnerNote, setMsgOwnerNote] = useState('');
  const [msgOwnerCopied, setMsgOwnerCopied] = useState(false);
  const messageOwnerInTeams = useCallback(async () => {
    if (!ownerName) return;
    setMsgOwnerBusy(true);
    setMsgOwnerNote('');
    setMsgOwnerCopied(false);
    let copied = false;
    try {
      const milestoneName = String(d.name || '').trim();
      if (!isOpp && (!link || !milestoneName)) {
        throw new Error('Cannot prepare the Teams draft: the milestone name or MSX link is missing. Sync from CRM and check the CRM URL in User Home.');
      }
      const email = await resolveOwnerEmail(ownerName);
      if (!email) {
        setMsgOwnerNote(`Couldn't find a Teams address for ${ownerName}. They may not be in the directory cache — try My Org to look them up.`);
        return;
      }
      if (!isOpp) {
        await copyMilestoneTeamsMessage({ ownerName, milestoneName, milestoneUrl: link });
        copied = true;
      }
      const url = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`;
      await onOpenExternal(url);
      if (copied) {
        setMsgOwnerCopied(true);
        setMsgOwnerNote('Formatted message copied with the milestone name as a clickable MSX link. In Teams, press Ctrl+V to paste it, then review and send. Nothing has been sent.');
      }
    } catch (err) {
      setMsgOwnerNote(`${copied ? 'Formatted message copied, but Teams could not open. ' : ''}${err.message || String(err)}`);
    } finally {
      setMsgOwnerBusy(false);
    }
  }, [ownerName, onOpenExternal, isOpp, d.name, link]);

  // ── Comments ──────────────────────────────────────────────────────
  // Milestone: its own comments_json. Opportunity: aggregate child milestones'.
  const initialComments = useMemo(() => {
    if (isOpp) {
      const all = [];
      for (const m of d.milestones || []) all.push(...parseComments(m.comments_json));
      return all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    }
    return parseComments(d.comments_json);
  }, [d, isOpp]);
  const [comments, setComments] = useState(initialComments);
  const [commentDraft, setCommentDraft] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [suggestingComment, setSuggestingComment] = useState(false);
  const [suggestNote, setSuggestNote] = useState('');
  // After a successful add, name the milestone the comment landed on so there's no
  // ambiguity between similarly-named sibling milestones (e.g. "…Phase 1" vs "…Phase2").
  const [savedNote, setSavedNote] = useState('');

  // ── Opportunity → child milestones list + inline "Add milestone" ──
  // Only used on the opportunity card. Seed from the rolled-up milestone rows so a
  // freshly-created milestone can be appended optimistically before the next sync.
  const [oppMilestones, setOppMilestones] = useState(() => (isOpp ? (d.milestones || []) : []));
  const [showMsGrid, setShowMsGrid] = useState(false);

  // Reload this opportunity's milestone list from the local mirror after grid edits.
  const reloadOppMilestones = useCallback(async () => {
    if (!isOpp || !recordId) return;
    try {
      const rows = await dbQuery(
        `SELECT m.*, o.name as opp_name, o.customer_name
         FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
         WHERE m.opportunity_id = ? ORDER BY m.milestone_date`,
        [recordId]
      );
      if (Array.isArray(rows) && rows.length) setOppMilestones(rows);
    } catch { /* keep existing list on error */ }
  }, [isOpp, recordId]);

  const refreshMilestoneEditorContext = useCallback(async () => {
    if (isOpp) {
      await reloadOppMilestones();
      return;
    }
    if (!recordId || !onSelect) return;
    try {
      const found = await dbQuery(
        `SELECT m.*, o.name as opp_name, o.customer_name
         FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
         WHERE m.milestone_id = ?`,
        [recordId]
      );
      if (Array.isArray(found) && found.length) onSelect({ type: 'ms', data: found[0] });
    } catch { /* keep the open milestone details; the next sync will reconcile */ }
  }, [isOpp, onSelect, recordId, reloadOppMilestones]);

  const openMilestone = (row) => {
    if (!onSelect || !row) return;
    // Enrich with the opp/account context the milestone card shows in its rows.
    onSelect({
      type: 'ms',
      data: {
        ...row,
        opp_name: row.opp_name || editorOpportunityName,
        customer_name: row.customer_name || editorAccountName,
      },
    });
  };

  // The Add/Edit grid's rows are CRM-shaped drafts (recordToDraft), not the DB milestone
  // shape the DetailCard renders — so opening one directly showed a near-empty panel
  // (Status/Owner/ACR/Target date blank). Resolve the full local row by id first: from
  // the already-loaded opp milestone list, then the local milestones table. Only if the
  // milestone isn't mirrored locally do we fall back to the grid draft's known values, so
  // the panel still shows real data (status/owner/ACR/date) rather than a blank card.
  const openGridMilestone = async (gridRow) => {
    const wantId = normId(gridRow?.id);
    if (wantId) {
      const inList = (oppMilestones || []).find((m) => normId(m.milestone_id) === wantId);
      if (inList) { openMilestone(inList); return; }
      try {
        const found = await dbQuery(
          `SELECT m.*, o.name as opp_name, o.customer_name
           FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
           WHERE m.milestone_id = ?`,
          [gridRow.id]
        );
        if (Array.isArray(found) && found.length) { openMilestone(found[0]); return; }
      } catch { /* fall through to the draft mapping below */ }
    }
    // Best-effort mapping of the grid draft's fields onto the DB milestone shape.
    openMilestone({
      milestone_id: gridRow.id,
      name: gridRow.name,
      opportunity_id: editorOpportunityId,
      milestone_status: gridRow.status,
      status_reason: gridRow.statusReason,
      owner_name: gridRow.ownerName,
      owner_id: gridRow.ownerId,
      monthly_use: gridRow.estChange,
      milestone_date: gridRow.milestoneDate,
      commitment_recommendation: gridRow.commitment,
    });
  };


  const suggestComment = async () => {
    if (suggestingComment || savingComment || isOpp || !recordId) return { ok: true };
    setSuggestingComment(true);
    setCommentError('');
    setSuggestNote('');
    setSavedNote('');
    try {
      const res = await suggestMilestoneComment({ milestoneId: recordId });
      if (!res || !res.ok) {
        const msg = (res && res.error) || 'Could not generate a suggestion.';
        setCommentError(msg);
        return { ok: false, error: msg };
      } else if (res.hasActivity && res.suggestion) {
        // Populate the draft so the user can edit before adding. Never auto-submit.
        setCommentDraft(res.suggestion);
        return { ok: true };
      } else {
        // No in-window activity — say so plainly rather than inventing a comment. (Not a failure.)
        setSuggestNote(res.message || 'No recent activity found to summarize.');
        return { ok: true };
      }
    } catch (err) {
      const msg = err.message || String(err);
      setCommentError(msg);
      return { ok: false, error: msg };
    } finally {
      setSuggestingComment(false);
    }
  };

  const submitComment = async () => {
    const text = commentDraft.trim();
    if (!text || savingComment) return;
    setSavingComment(true);
    setCommentError('');
    setSavedNote('');
    try {
      const json = await teamApi.addMilestoneComment(d.milestone_id, text);
      if (json) setComments(parseComments(json));
      setCommentDraft('');
      // Confirm exactly which milestone received the comment (name, not just "saved").
      setSavedNote(title || d.name || 'this milestone');
    } catch (err) {
      setCommentError(err.message || String(err));
    } finally {
      setSavingComment(false);
    }
  };

  // ── Activities (live fetch of tasks regarding this record) ────────
  const [activities, setActivities] = useState(null); // null = loading
  const [savingActivity, setSavingActivity] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [actSubject, setActSubject] = useState('');
  const [actCategory, setActCategory] = useState('');
  const [actDueDate, setActDueDate] = useState('');
  const [actDescription, setActDescription] = useState('');
  const [suggestingHok, setSuggestingHok] = useState(false);
  const [hokNote, setHokNote] = useState('');
  // AI-suggested HoK activities from a Milestone AI / HoK run. The suggester can return several
  // (one per distinct meeting/demo); each is an editable draft the SE reviews and submits or
  // rejects individually — so ALL are shown, not just the first. Shape mirrors the workload popup's
  // batch drafts: { id, subject, description, category, dueDate, busy, error, submitted }.
  const [hokDrafts, setHokDrafts] = useState([]);
  const [milestoneAiRunning, setMilestoneAiRunning] = useState(false);
  // Live workflow popup for THIS milestone's Milestone AI run (Join deal team → Gather activity →
  // Draft comment → Suggest activities), with retry-from-failed. The drafts still render in the
  // sections below; the popup is the live monitor.
  const [aiSteps, setAiSteps] = useState([]);
  const [aiWorkflowOpen, setAiWorkflowOpen] = useState(false);

  const loadActivities = useCallback(async () => {
    if (isOpp || !recordId) { setActivities([]); return; }
    const mid = String(recordId).replace(/[{}]/g, '').toLowerCase();
    try {
      const rows = await dbQuery(
        'SELECT activity_id, subject, created_on, state_code, owner_name FROM active_hok_tasks WHERE regarding_id = ? ORDER BY created_on DESC LIMIT 10',
        [mid]
      );
      setActivities((rows || []).map(r => ({
        activityid: r.activity_id,
        subject: r.subject,
        createdon: r.created_on,
        statecode: r.state_code,
        owner_name: r.owner_name,
      })));
    } catch {
      setActivities([]);
    }
  }, [recordId, isOpp]);

  useEffect(() => { loadActivities(); }, [loadActivities]);

  // ── Related signal (AI): emails, meetings & chats tied to this milestone ──
  // Persisted links are the stable, auditable source of truth. We load them on open
  // (no model call); the Find button (re)generates + persists them via the agent.
  const [signalLoading, setSignalLoading] = useState(false);
  const [signalError, setSignalError] = useState('');
  const [signalSummary, setSignalSummary] = useState('');
  const [signalLinks, setSignalLinks] = useState([]);
  const [signalRan, setSignalRan] = useState(false); // true once a fetch/generate returned
  // Signal groups start collapsed so a completed run/open shows a compact set of
  // headers (Emails 12 · Meetings 7 · Chats 2) the user can expand on demand.
  const [signalOpenKinds, setSignalOpenKinds] = useState({ email: false, meeting: false, chat: false });

  // Load the persisted set when a milestone card opens.
  useEffect(() => {
    let alive = true;
    if (isOpp || !recordId) { setSignalLinks([]); setSignalRan(false); return; }
    (async () => {
      try {
        const res = await getMilestoneSignalLinks({ milestoneId: recordId });
        if (!alive) return;
        if (res && res.ok) { setSignalLinks(res.links || []); setSignalRan((res.links || []).length > 0); }
      } catch { /* non-fatal: user can still generate */ }
    })();
    return () => { alive = false; };
  }, [recordId, isOpp]);

  const runSignalSearch = useCallback(async () => {
    if (signalLoading || isOpp || !recordId) return { ok: true };
    setSignalLoading(true);
    setSignalError('');
    try {
      const res = await findMilestoneSignal({ milestoneId: recordId });
      if (res && res.ok) {
        setSignalSummary(res.summary || '');
        setSignalLinks(res.links || []);
        setSignalRan(true);
        // Collapse the groups so the freshly-found set presents as compact
        // headers rather than three long expanded lists.
        setSignalOpenKinds({ email: false, meeting: false, chat: false });
        return { ok: true };
      }
      const msg = (res && res.error) || 'Signal search failed.';
      setSignalError(msg);
      return { ok: false, error: msg };
    } catch (err) {
      const msg = err.message || String(err);
      setSignalError(msg);
      return { ok: false, error: msg };
    } finally {
      setSignalLoading(false);
    }
  }, [signalLoading, isOpp, recordId]);

  const removeSignalLink = useCallback(async (link) => {
    // Optimistic removal; revert on failure so we never silently drop a delete error.
    const prev = signalLinks;
    // Every card carries a natural delete key { kind, nativeId } from the canonical
    // read path. Delete by key (a chat key removes the whole thread server-side) and
    // drop just this card locally. No legacy row-id fallback — if a card somehow lacks
    // a key we fail loudly rather than silently skipping the delete.
    if (!link?.deleteKey) {
      setSignalError('Cannot remove this signal: missing delete key.');
      return;
    }
    setSignalLinks((cur) => cur.filter((l) => l.id !== link.id));
    try {
      const res = await deleteMilestoneSignalLink({ milestoneId: recordId, keys: [link.deleteKey] });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Delete failed.');
    } catch (err) {
      setSignalLinks(prev);
      setSignalError(err.message || String(err));
    }
  }, [signalLinks, recordId]);

  const submitActivity = async () => {
    if (savingActivity || !actSubject.trim()) return;
    setSavingActivity(true);
    setActivityError('');
    try {
      await teamApi.addActivity(detail.type, recordId, {
        subject: actSubject.trim(),
        taskCategory: actCategory,
        dueDate: actDueDate,
        description: actDescription,
      });
      // Show it immediately; a Settings sync reconciles the cache from CRM.
      setActivities(prev => [{ activityid: `pending-${Date.now()}`, subject: actSubject.trim(), createdon: new Date().toISOString(), statecode: 1, owner_name: teamApi?.currentUserName }, ...(prev || [])]);
      setActSubject(''); setActCategory(''); setActDueDate(''); setActDescription('');
      setShowActivityForm(false);
    } catch (err) {
      setActivityError(err.message || String(err));
    } finally {
      setSavingActivity(false);
    }
  };

  // Per-draft handlers for the AI-suggested HoK activity cards (edit / submit one / reject one).
  const updateHokDraft = (id, patch) => setHokDrafts((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const removeHokDraft = (id) => setHokDrafts((prev) => prev.filter((h) => h.id !== id));
  const submitHokDraft = async (draft) => {
    const subject = (draft.subject || '').trim();
    if (!subject || draft.busy) return;
    updateHokDraft(draft.id, { busy: true, error: '' });
    try {
      await teamApi.addActivity(detail.type, recordId, {
        subject,
        taskCategory: draft.category,
        dueDate: draft.dueDate || '',
        description: draft.description,
      });
      // Reflect it immediately in Recent activities; a Settings sync reconciles from CRM.
      setActivities((prev) => [{ activityid: `pending-${Date.now()}`, subject, createdon: new Date().toISOString(), statecode: 1, owner_name: teamApi?.currentUserName }, ...(prev || [])]);
      updateHokDraft(draft.id, { busy: false, submitted: true });
    } catch (err) {
      updateHokDraft(draft.id, { busy: false, error: err.message || String(err) });
    }
  };

  const suggestHok = async () => {
    if (suggestingHok || savingActivity || isOpp || !recordId) return { ok: true };
    setSuggestingHok(true);
    setActivityError('');
    setHokNote('');
    setHokDrafts([]); // a fresh run replaces prior drafts (submitted ones already show in Recent activities)
    try {
      const res = await suggestMilestoneHokActivity({ milestoneId: recordId });
      if (!res || !res.ok) {
        const msg = (res && res.error) || 'Could not generate a HoK activity suggestion.';
        setActivityError(msg);
        return { ok: false, error: msg };
      } else if (res.hasSignal && (Array.isArray(res.suggestions) ? res.suggestions.length : res.suggestion)) {
        // Turn EVERY suggestion into its own editable draft card (not just the first).
        const list = Array.isArray(res.suggestions) && res.suggestions.length
          ? res.suggestions
          : (res.suggestion ? [res.suggestion] : []);
        setHokDrafts(list.map((s, idx) => ({
          id: `${recordId}-hok-${Date.now()}-${idx}`,
          subject: s.subject || '',
          description: s.description || '',
          category: s.category != null ? String(s.category) : '',
          dueDate: '',
          busy: false,
          error: '',
          submitted: false,
        })));
        // The manual single add-activity form is separate; close it so the AI drafts are the focus.
        setShowActivityForm(false);
        if (list.length > 1) setHokNote(`Suggested ${list.length} HoK activities from the linked signal — review each below.`);
        return { ok: true };
      } else {
        // No related signal linked yet — say so plainly. (Informational, not a failure.)
        setHokNote(res.message || 'No related signals are linked to this milestone yet.');
        return { ok: true };
      }
    } catch (err) {
      const msg = err.message || String(err);
      setActivityError(msg);
      return { ok: false, error: msg };
    } finally {
      setSuggestingHok(false);
    }
  };

  // Unified "Milestone AI" — a short, named pipeline scoped to THIS milestone:
  //   Join deal team → Gather related activity → Draft status comment → Suggest next activities.
  // The workflow popup shows each step churning live and lets the SE retry from the first failed
  // step. Signal links persist; the comment and activities are drafts reviewed in the sections
  // below. Every step is idempotent/additive, so retrying never corrupts or duplicates.
  const runSingleStep = async (key) => {
    if (key === 'dealTeam') {
      if (!teamApi?.ensureOnMilestoneTeam) return { ok: true };
      await teamApi.ensureOnMilestoneTeam(recordId); // throws on failure → caught below
      return { ok: true };
    }
    if (key === 'find') return runSignalSearch();
    if (key === 'comment') return suggestComment();
    if (key === 'hok') return suggestHok();
    return { ok: true };
  };
  const runSinglePipeline = async (startIndex) => {
    for (let i = startIndex; i < MILESTONE_AI_FULL_KEYS.length; i += 1) {
      const key = MILESTONE_AI_FULL_KEYS[i];
      setAiSteps((prev) => setStep(prev, key, { status: 'running', error: '' }));
      try {
        const res = await runSingleStep(key);
        if (res && res.ok === false) {
          setAiSteps((prev) => setStep(prev, key, { status: 'failed', error: res.error || 'Failed.' }));
        } else {
          setAiSteps((prev) => setStep(prev, key, { status: 'ok', error: '' }));
        }
      } catch (err) {
        setAiSteps((prev) => setStep(prev, key, { status: 'failed', error: err.message || String(err) }));
      }
    }
  };
  const runMilestoneAi = async () => {
    if (milestoneAiRunning || isOpp || !recordId) return;
    setAiSteps(makeStepList(MILESTONE_AI_FULL_KEYS));
    setAiWorkflowOpen(true);
    setMilestoneAiRunning(true);
    try {
      await runSinglePipeline(0);
    } finally {
      setMilestoneAiRunning(false);
    }
  };
  // Retry this milestone from its first failed step onward.
  const retryMilestoneAi = async () => {
    if (milestoneAiRunning) return;
    const start = firstFailedStepIndex(aiSteps);
    if (start < 0) return;
    setMilestoneAiRunning(true);
    try {
      await runSinglePipeline(start);
    } finally {
      setMilestoneAiRunning(false);
    }
  };

  // ── Deal team membership / join ───────────────────────────────────
  const member = teamApi?.isOnTeam ? teamApi.isOnTeam(detail.type, recordId, members) : false;
  const joinBusy = teamApi?.joiningKey === `${detail.type}:${recordId}`;

  // Up to the 3 most-recent comments, displayed oldest→newest so the newest sits at
  // the bottom directly above the input (chat-style). A freshly added comment lands
  // right where the user is typing, so it's obvious it saved.
  const recentComments = comments.slice(0, 3).reverse();
  const recentActivities = (activities || []).slice(0, 3);
  const activityLink = (a) => (a.activityid && crmBaseUrl)
    ? `${crmBaseUrl}/main.aspx?etn=task&id=${a.activityid}&pagetype=entityrecord`
    : null;

  return (
    <>
    <div className="eng-detail-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card eng-detail-card-wide" data-tour="ms-panel" onMouseDown={e => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind">{isOpp ? 'Opportunity' : 'Milestone'}</span>
          <div className="eng-detail-head-actions">
            {!isOpp && (
              <button
                className="eng-detail-ai"
                data-tour="ms-ai"
                disabled={milestoneAiRunning}
                onClick={runMilestoneAi}
                title="Milestone AI: links related emails, meetings & chats to this milestone (additive — never overwrites), then drafts a comment and suggests HoK activities for you to review before saving."
              >
                {milestoneAiRunning ? '✨ …' : '✨ Milestone AI'}
              </button>
            )}
            {ownerName && (
              <button
                className="eng-detail-mini teams-chat-btn"
                disabled={msgOwnerBusy}
                onClick={messageOwnerInTeams}
                title={isOpp ? `Open a Teams chat with ${ownerName} (owner)` : `Copy a formatted message, open a Teams chat with ${ownerName} (owner), then paste with Ctrl+V.`}
              >
                {msgOwnerBusy ? 'Opening…' : <><ChatRegular style={{ fontSize: 13, verticalAlign: '-2px' }} /> Message owner</>}
              </button>
            )}
            {editorOpportunityId && (
              <button className="eng-detail-mini" onClick={() => setShowMsGrid(true)}>
                Add/Edit Milestones
              </button>
            )}
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="eng-detail-title">
          <span>{title}</span>
          {link && (
            <button
              className="eng-detail-title-link"
              title={isOpp ? 'Open opportunity in CRM' : 'Open milestone in CRM'}
              onClick={() => onOpenExternal(link)}
            >
              <OpenRegular style={{ fontSize: 15 }} />
            </button>
          )}
        </div>
        {(msgOwnerNote || (!isOpp && ownerName)) && (
          <div
            className={`eng-detail-owner-note${!msgOwnerNote || msgOwnerCopied ? ' eng-detail-owner-note-info' : ''}`}
            role={msgOwnerNote && !msgOwnerCopied ? 'alert' : 'status'}
          >
            {msgOwnerNote || 'Message owner copies the formatted message and opens Teams. Paste with Ctrl+V to keep the milestone name clickable. Nothing is sent automatically.'}
          </div>
        )}

        <div className="eng-detail-cols">
          {/* Left column: details + deal team */}
          <div className="eng-detail-col">
            <div className="eng-detail-rows">
              {rows.map(([key, v]) => (
                <div className="eng-detail-row" key={key}>
                  <span className="eng-detail-key">{key}</span>
                  <span className="eng-detail-val">{v}</span>
                </div>
              ))}
              {!isOpp && (
                <div className="eng-detail-row">
                  <span className="eng-detail-key">Deal Assistance</span>
                  <span className="eng-detail-val">
                    {link ? (
                      <button
                        onClick={() => onOpenExternal(link)}
                        title="Deal Assistance items are the 'UAT Action' records in MSX's Unified Action Tracker — a virtual entity served only inside the authenticated MSX web session, so the count can't be read through the API here. Open the milestone in MSX to view them."
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'underline' }}
                      >
                        View in MSX <OpenRegular style={{ fontSize: 12 }} />
                      </button>
                    ) : (
                      <span title="Deal Assistance items are the 'UAT Action' records in MSX's Unified Action Tracker — a virtual entity served only inside the authenticated MSX web session, so the count can't be read through the API here.">n/a</span>
                    )}
                  </span>
                </div>
              )}
            </div>

            <div className="eng-detail-team">
              <div className="eng-detail-section-head">
                <span className="eng-detail-key">{teamLabel}</span>
                {teamApi?.toggleTeam && recordId && (
                  <button
                    className={`eng-detail-mini${member ? ' is-member' : ''}`}
                    disabled={joinBusy}
                    onClick={() => teamApi.toggleTeam(detail.type, recordId, member)}
                    title={member ? 'Remove yourself from this deal team' : 'Add yourself to this deal team'}
                  >
                    {joinBusy ? 'Working…' : member ? '✓ On team · Remove' : '+ Add me'}
                  </button>
                )}
              </div>
              {members.length === 0 ? (
                <span className="eng-pop-empty">No team members synced</span>
              ) : (
                <div className="eng-detail-team-list">
                  {members.map((name, i) => (
                    <span className="eng-pop-row" key={i}>
                      <span className="eng-pop-avatar">{initials(name)}</span>
                      <span className="eng-pop-name">{name}</span>
                      {ownerName && name === ownerName && <span className="eng-pop-owner">owner</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {!isOpp && (
              <div className="eng-detail-signal" data-tour="ms-signal">
                <div className="eng-detail-section-head">
                  <span className="eng-detail-key">Related signal</span>
                </div>

                {signalLoading && (
                  <span className="eng-pop-empty">Scanning recent emails, meetings & chats…</span>
                )}

                {!signalLoading && signalError && (
                  <div className="eng-detail-signal-error">{signalError}</div>
                )}

                {!signalLoading && signalSummary && (
                  <div className="eng-detail-signal-summary">{signalSummary}</div>
                )}

                {!signalLoading && (() => {
                  const KINDS = [
                    { key: 'email', label: 'Emails' },
                    { key: 'meeting', label: 'Meetings' },
                    { key: 'chat', label: 'Chats' },
                  ];
                  const grouped = { email: [], meeting: [], chat: [] };
                  for (const l of signalLinks) (grouped[l.kind] || (grouped[l.kind] = [])).push(l);
                  if (!signalRan && signalLinks.length === 0) {
                    return <span className="eng-pop-empty">Run Milestone AI to link related emails, meetings &amp; chats to this milestone.</span>;
                  }
                  if (signalLinks.length === 0) {
                    return <span className="eng-pop-empty">No emails, meetings, or chats were linked to this milestone.</span>;
                  }
                  return (
                    <div className="eng-detail-signal-groups">
                      {KINDS.map(({ key, label }) => {
                        const items = grouped[key] || [];
                        if (items.length === 0) return null;
                        const open = signalOpenKinds[key];
                        return (
                          <div className="eng-signal-group" key={key}>
                            <button
                              className="eng-signal-group-head"
                              onClick={() => setSignalOpenKinds((s) => ({ ...s, [key]: !s[key] }))}
                              title={open ? 'Collapse' : 'Expand'}
                            >
                              <span className="eng-signal-caret">{open ? '▾' : '▸'}</span>
                              {label} <span className="eng-signal-count">{items.length}</span>
                            </button>
                            {open && (
                              <div className="eng-signal-list">
                                {items.map((l) => (
                                  <div className="eng-signal-item" key={l.id}>
                                    <div className="eng-signal-item-main">
                                      <div className="eng-signal-item-title" title={l.title || ''}>{l.title || '(untitled)'}</div>
                                      <div className="eng-signal-item-meta">
                                        {[
                                          l.subtitle,
                                          l.item_date ? new Date(l.item_date).toLocaleDateString() : null,
                                          l.kind === 'chat' && l.count > 1 ? `${l.count} messages` : null,
                                        ].filter(Boolean).join(' · ') || '—'}
                                      </div>
                                      {l.reason && <div className="eng-signal-item-reason">{l.reason}</div>}
                                    </div>
                                    <button
                                      className="eng-signal-del"
                                      title={l.kind === 'chat' && l.count > 1 ? 'Remove this chat thread' : 'Remove this link'}
                                      onClick={() => removeSignalLink(l)}
                                    >✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Right column: comments + activities */}
          <div className="eng-detail-col">
            <div className="eng-detail-section eng-detail-section-first" data-tour="ms-comments">
              <span className="eng-detail-key">Recent comments</span>
              {recentComments.length === 0 ? (
                <span className="eng-pop-empty">No comments</span>
              ) : (
                <div className="eng-detail-list">
                  {recentComments.map((c, i) => (
                    <div className="eng-detail-comment" key={i} title={c.text}>
                      <div className="eng-detail-comment-meta">{c.poster}{c.date ? ` · ${new Date(c.date).toLocaleDateString()}` : ''}</div>
                      <div className="eng-detail-clamp">{c.text}</div>
                    </div>
                  ))}
                </div>
              )}
              {!isOpp && (
                <>
                  <div className="eng-detail-add">
                    <textarea
                      rows={2}
                      value={commentDraft}
                      onChange={e => { setCommentDraft(e.target.value); if (suggestNote) setSuggestNote(''); if (savedNote) setSavedNote(''); }}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(); } }}
                      placeholder="Add a comment…"
                      className="eng-detail-input eng-detail-textarea"
                    />
                    <div className="eng-detail-add-btns">
                      <button className="eng-detail-mini" disabled={!commentDraft.trim() || savingComment} onClick={submitComment}>
                        {savingComment ? 'Saving…' : 'Add'}
                      </button>
                    </div>
                  </div>
                  {suggestNote && <span className="eng-detail-note">{suggestNote}</span>}
                  {savedNote && <span className="eng-detail-saved">✓ Comment saved to “{savedNote}”</span>}
                </>
              )}
              {commentError && <span className="eng-detail-err">{commentError}</span>}
            </div>

            {isOpp && (
              <div className="eng-detail-section">
                <div className="eng-detail-divider" />
                <span className="eng-detail-key">Milestones</span>
                {oppMilestones.length === 0 ? (
                  <span className="eng-pop-empty">No milestones yet</span>
                ) : (
                  <div className="eng-detail-ms-list">
                    {oppMilestones.map((m, i) => {
                      const statusText = m.status_label || MILESTONE_STATUS[m.milestone_status] || m.milestone_status || '—';
                      const acr = formatAcr(m.monthly_use);
                      const dateText = m.milestone_date ? formatDateOnly(m.milestone_date) : null;
                      return (
                        <button
                          type="button"
                          className="eng-detail-ms-item"
                          key={m.milestone_id || i}
                          onClick={() => openMilestone(m)}
                          disabled={!m.milestone_id}
                          title={m.milestone_id ? 'Open this milestone' : 'Milestone is syncing — open again shortly'}
                        >
                          <span className="eng-detail-ms-name">{m.name || '(unnamed milestone)'}</span>
                          <span className="eng-detail-ms-meta">
                            {[statusText, acr, dateText].filter(Boolean).join(' · ')}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isOpp && (
            <div className="eng-detail-section" data-tour="ms-activities">
              <span className="eng-detail-key">Recent activities</span>
              {hokDrafts.length > 0 && (
                <div className="ms-hok-drafts">
                  <div className="ms-hok-drafts-label">
                    Suggested {hokDrafts.length === 1 ? 'activity' : `activities (${hokDrafts.length})`}
                  </div>
                  {hokDrafts.map((h) => (
                    h.submitted ? (
                      <div className="ms-hok-draft-done" key={h.id}>✓ Added “{h.subject}”</div>
                    ) : (
                      <div className="ms-hok-draft" key={h.id}>
                        <input
                          type="text"
                          className="eng-detail-input"
                          value={h.subject}
                          placeholder="Subject"
                          onChange={(e) => updateHokDraft(h.id, { subject: e.target.value })}
                        />
                        <textarea
                          className="eng-detail-input"
                          rows={2}
                          value={h.description}
                          placeholder="Description"
                          style={{ resize: 'vertical', fontFamily: 'inherit' }}
                          onChange={(e) => updateHokDraft(h.id, { description: e.target.value })}
                        />
                        <div className="ms-hok-draft-row">
                          <select className="eng-detail-input" value={h.category} onChange={(e) => updateHokDraft(h.id, { category: e.target.value })}>
                            <option value="">Task category…</option>
                            {TASK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                          <input type="date" className="eng-detail-input" value={h.dueDate} onChange={(e) => updateHokDraft(h.id, { dueDate: e.target.value })} />
                        </div>
                        {h.error ? <span className="eng-detail-err">{h.error}</span> : null}
                        <div className="eng-detail-actform-buttons">
                          <button className="eng-detail-mini" disabled={!h.subject.trim() || h.busy} onClick={() => submitHokDraft(h)}>
                            {h.busy ? 'Adding…' : 'Create (completed)'}
                          </button>
                          <button className="eng-detail-mini eng-detail-mini-ghost" disabled={h.busy} onClick={() => removeHokDraft(h.id)}>
                            Reject
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}
              {activities === null ? (
                <span className="eng-pop-empty">Loading…</span>
              ) : recentActivities.length === 0 ? (
                <span className="eng-pop-empty">No activities</span>
              ) : (
                <div className="eng-detail-list">
                  {recentActivities.map((a, i) => {
                    const aLink = activityLink(a);
                    return (
                      <div className="eng-detail-activity" key={a.activityid || i} title={a.subject || ''}>
                        <div className="eng-detail-activity-row">
                          <div className="eng-detail-clamp-1">{a.subject || '(no subject)'}</div>
                          {aLink && (
                            <button className="eng-node-link" title="Open activity in CRM" onClick={() => onOpenExternal(aLink)}>
                              <OpenRegular style={{ fontSize: 13 }} />
                            </button>
                          )}
                        </div>
                        <div className="eng-detail-comment-meta">{[a.owner_name, a.createdon ? new Date(a.createdon).toLocaleDateString() : ''].filter(Boolean).join(' · ')}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {showActivityForm ? (
                <div className="eng-detail-actform">
                  <input
                    type="text"
                    value={actSubject}
                    onChange={e => setActSubject(e.target.value)}
                    placeholder="Subject"
                    className="eng-detail-input"
                    autoFocus
                  />
                  <textarea
                    value={actDescription}
                    onChange={e => setActDescription(e.target.value)}
                    placeholder="Description"
                    rows={3}
                    className="eng-detail-input"
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                  />
                  <select
                    value={actCategory}
                    onChange={e => setActCategory(e.target.value)}
                    className="eng-detail-input"
                  >
                    <option value="">Task category…</option>
                    {TASK_CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  <label className="eng-detail-field-label">Due date
                    <input
                      type="date"
                      value={actDueDate}
                      onChange={e => setActDueDate(e.target.value)}
                      className="eng-detail-input"
                    />
                  </label>
                  <div className="eng-detail-actform-buttons">
                    <button className="eng-detail-mini" disabled={!actSubject.trim() || savingActivity} onClick={submitActivity}>
                      {savingActivity ? 'Adding…' : 'Create (completed)'}
                    </button>
                    <button className="eng-detail-mini eng-detail-mini-ghost" disabled={savingActivity} onClick={() => { setShowActivityForm(false); setActivityError(''); setActDescription(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="eng-detail-add">
                  <button className="eng-detail-mini" onClick={() => setShowActivityForm(true)}>
                    + Add activity
                  </button>
                </div>
              )}
              {hokNote && <span className="eng-detail-note">{hokNote}</span>}
              {activityError && <span className="eng-detail-err">{activityError}</span>}
            </div>
            )}
          </div>
        </div>
        {showMsGrid && editorOpportunityId && (
          <MilestoneGrid
            opportunityId={editorOpportunityId}
            oppName={editorOpportunityName}
            accountName={editorAccountName}
            teamApi={teamApi}
            onClose={() => setShowMsGrid(false)}
            onChanged={refreshMilestoneEditorContext}
            onOpenMilestone={(row) => { setShowMsGrid(false); openGridMilestone(row); }}
          />
        )}
      </div>
    </div>
    {aiWorkflowOpen ? (
      <MilestoneAiWorkflowPopup
        milestones={[{
          id: recordId,
          name: title || d.name || 'Milestone',
          sub: d.customer_name || null,
          steps: aiSteps,
        }]}
        running={milestoneAiRunning}
        statusNote={`Working on ${title || d.name || 'this milestone'}…`}
        onRetryMilestone={retryMilestoneAi}
        onClose={() => setAiWorkflowOpen(false)}
      />
    ) : null}
    </>
  );
}

function MilestoneDiagram({ opps, milestonesByOpp, customers, crmBaseUrl, onOpenExternal, teamApi }) {
  const tree = useMemo(() => buildHierarchy(opps, milestonesByOpp, customers), [opps, milestonesByOpp, customers]);

  const dragRef = useRef(null); // { moved } — written by the viewport; suppresses click-after-drag
  const [detail, setDetail] = useState(null); // { type:'opp'|'ms', data }

  // Open a node's detail card — but suppress it if the gesture was a pan-drag.
  const selectNode = useCallback((type, data) => {
    if (dragRef.current?.moved) return;
    setDetail({ type, data });
  }, []);

  // Close the detail card on Escape.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  if (!opps || opps.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
        No opportunities match the current filters.
      </div>
    );
  }

  return (
    <PanZoomViewport
      dragStateRef={dragRef}
      contentKey={tree}
      overlay={(
        <DetailCard
          detail={detail}
          crmBaseUrl={crmBaseUrl}
          onOpenExternal={onOpenExternal}
          onClose={() => setDetail(null)}
          onSelect={setDetail}
          teamApi={teamApi}
        />
      )}
    >
      <ul className="eng-tree">
        {tree.map(acc => (
            <li key={acc.key}>
              <AccountNode acc={acc} />
              {acc.opps.length > 0 && (
                <ul>
                  {acc.opps.map(opp => (
                    <li key={opp.key}>
                      <OppNode opp={opp} crmBaseUrl={crmBaseUrl} onOpenExternal={onOpenExternal} onSelect={() => selectNode('opp', opp)} teamApi={teamApi} />
                      {opp.milestones.length > 0 && (
                        <ul className="eng-ms-list">
                          {opp.milestones.map(ms => (
                            <li key={ms.milestone_id || ms.id}>
                              <MilestoneNode ms={ms} crmBaseUrl={crmBaseUrl} onOpenExternal={onOpenExternal} onSelect={() => selectNode('ms', ms)} teamApi={teamApi} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
    </PanZoomViewport>
  );
}
