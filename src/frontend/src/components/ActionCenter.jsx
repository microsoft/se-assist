import { useState, useMemo, useCallback, useEffect } from 'react';
import { Spinner } from '@fluentui/react-components';
import {
  CalendarLtrRegular, ClockRegular, FlagRegular,
  VideoRegular, ArrowRightRegular, CheckmarkCircleRegular,
  BoardRegular, ChevronDownRegular, ChevronRightRegular, ChevronLeftRegular,
  WarningRegular, DismissCircleRegular,
} from '@fluentui/react-icons';
import { useNavigate } from 'react-router-dom';
import { useDbQuery } from '../hooks/useDb';
import { useTeamApi } from '../hooks/useTeamApi';
import { openExternal, getMsxSettings, dbQuery } from '../electronBridge';
import { useTerritory } from '../territoryContext';
import { isActiveMilestone, latestCommentAgeDays, parseTeamList, UNCOMMITTED } from '../lib/milestoneMetrics';
import { WorkloadsWorkspace, MilestoneLinkList, buildSignalCountMap } from './WorkloadManagement';
import { DetailCard } from './Milestones';
import { AccountGlanceModal } from './CustomerActivity';
import { AgendaView } from './Agenda';
import MeetingDetailPanel from './MeetingDetailPanel';
import SecretarySection from './SecretarySection';

// Secretary is hidden from Action Center for now; set to true to show it again.
const SHOW_SECRETARY = false;

// ── Action Center ─────────────────────────────────────────────────────────────
// A single "what needs doing" surface. The top row shows today's meetings as a gap-collapsed
// one-day calendar (with day navigation) on the left, and on the right two at-a-glance count
// cards (overdue comments, blocked milestones) above your due/overdue milestones (active +
// uncommitted, where you're on the deal team). Below sits an Active workloads master/detail
// (pick one on the left, see its critical details on the right) and an "accounts to re-engage"
// list. Clicking a meeting opens its detail panel (Join + Prepare live there). Everything here is
// local data; only "Prepare" (in the panel) calls a model.

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 14;

// All of a given local day's meetings, customer-linked or not — a LEFT JOIN so internal /
// non-customer meetings still appear. start_at is stored as UTC ISO ("…Z"), so the local-day
// bounds are converted to UTC ISO by the caller and compared as strings. The day is selectable
// (prev/next), so the caller passes the chosen day's [start, end) bounds.
const DAY_MEETINGS_SQL = `
SELECT m.event_id, m.subject, m.organizer_name, m.start_at, m.end_at,
       m.is_online_meeting, m.online_meeting_url,
       GROUP_CONCAT(COALESCE(c.name, 'TPID ' || l.tpid), '||') AS accounts
FROM active_meetings m
LEFT JOIN active_meeting_customer_links l ON l.event_id = m.event_id AND l.match_method <> 'ai-rejected'
LEFT JOIN active_customers c ON c.tpid = l.tpid AND (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '')
WHERE m.is_cancelled = 0 AND m.start_at >= ? AND m.start_at < ?
GROUP BY m.event_id
ORDER BY m.start_at ASC`;

// Minimal milestone rows for the two at-a-glance count cards (overdue comments / blocked).
// Comment recency is computed from comments_json in JS (same as the Excellence Metrics page),
// which SQL can't easily do; owner_name/deal_team_json drive the optional My-scope filter.
const MS_HEALTH_SQL = `
SELECT status_label, milestone_status, commitment_recommendation, comments_json,
       owner_name, deal_team_json
FROM active_milestones`;

// ── Milestone health helpers ────────────────────────────────────────────────────────────────
// Status/commitment/team/comment-age helpers come from ../lib/milestoneMetrics so the Action
// Center's counts match the Excellence Metrics page exactly.

// Accounts (top-parent) whose most-recent contact across email/meeting(past)/chat is older than
// the stale cutoff — the "reach out" list, oldest first. SSP shown where configured.
const STALE_SQL = `
WITH lc AS (
  SELECT tpid, MAX(ts) AS last_ts FROM (
    SELECT l.tpid AS tpid, COALESCE(e.received_at, e.sent_at) AS ts
    FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
    UNION ALL
    SELECT l.tpid, m.start_at FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id WHERE m.start_at <= ?
    UNION ALL
    SELECT l.tpid, msg.sent_at FROM active_teams_chat_messages msg JOIN active_teams_chat_customer_links l ON l.chat_id = msg.chat_id
  ) GROUP BY tpid
),
tp AS (
  SELECT tpid, MAX(CASE WHEN parenting_level = 861980000 THEN name END) AS top_name, MAX(name) AS any_name
  FROM active_customers WHERE tpid IS NOT NULL AND TRIM(tpid) <> '' GROUP BY tpid
),
ssp AS (
  SELECT tpid, person_name FROM active_customer_account_team_roles
  WHERE role = 'Cloud and AI Specialist' AND person_name IS NOT NULL AND TRIM(person_name) <> ''
)
SELECT lc.tpid, COALESCE(tp.top_name, tp.any_name, 'Unknown account') AS name, lc.last_ts, ssp.person_name AS ssp_name
FROM lc
LEFT JOIN tp ON tp.tpid = lc.tpid
LEFT JOIN ssp ON ssp.tpid = lc.tpid
WHERE lc.last_ts IS NOT NULL AND lc.last_ts < ?
ORDER BY lc.last_ts ASC
LIMIT 25`;

// Active workloads (saved + approved) with their linked context, mirroring the columns the
// Workload Management grid derives so the detail pane can show the same "critical details".
// json_group_array yields JSON-string arrays the renderer parses. Ordered by the user's manual
// sort so the first row (the default selection) matches the top of the Workloads list.
const ACTIVE_WORKLOADS_SQL = `
  SELECT w.*,
    (SELECT json_group_array(value) FROM (
       SELECT DISTINCT l.milestone_name AS value
       FROM active_workload_milestone_links l
       WHERE l.workload_id = w.id AND COALESCE(TRIM(l.milestone_name), '') <> ''
       ORDER BY value
     )) AS milestone_names,
    (SELECT json_group_array(value) FROM (
       SELECT DISTINCT l.customer_name AS value
       FROM active_workload_milestone_links l
       WHERE l.workload_id = w.id AND COALESCE(TRIM(l.customer_name), '') <> ''
       ORDER BY value
     )) AS linked_customer_names,
    (SELECT json_group_array(value) FROM (
       SELECT DISTINCT l.customer_tpid AS value
       FROM active_workload_milestone_links l
       WHERE l.workload_id = w.id AND COALESCE(TRIM(l.customer_tpid), '') <> ''
       ORDER BY value
     )) AS linked_customer_tpids,
    (SELECT json_group_array(value) FROM (
       SELECT DISTINCT COALESCE(l.opportunity_name, o.name) AS value
       FROM active_workload_milestone_links l
       LEFT JOIN active_opportunities o ON o.opportunity_id = l.opportunity_id
       WHERE l.workload_id = w.id
         AND COALESCE(TRIM(COALESCE(l.opportunity_name, o.name)), '') <> ''
       ORDER BY value
     )) AS linked_opportunity_names,
    (SELECT r.person_name FROM active_customer_account_team_roles r
       WHERE r.role = 'Cloud and AI Specialist'
         AND r.tpid = COALESCE(NULLIF(TRIM(w.customer_tpid), ''), NULLIF(TRIM(w.tpid), ''))
         AND COALESCE(TRIM(r.person_name), '') <> ''
       LIMIT 1) AS profile_ssp_name
  FROM active_workloads w
  WHERE w.status = 'active'
  ORDER BY w.sort_order, w.id`;

// Milestone links for the active workloads — one row per linked milestone, carrying the
// opportunity so the detail pane can group by it, and enough to open the milestone popup + show
// signal counts. Grouped by workload_id in JS.
const ACTIVE_WL_MS_SQL = `
  SELECT l.workload_id, l.milestone_id, l.milestone_name, l.opportunity_id, l.opportunity_name,
         l.customer_name, l.id
  FROM active_workload_milestone_links l
  JOIN active_workloads w ON w.id = l.workload_id AND w.status = 'active'
  ORDER BY l.opportunity_name, l.created_at, l.id`;

// Per-milestone signal counts (emails/meetings/chats) from the canonical links store — the SAME
// rows the milestone detail popup's "Related signals" lists, so the counts match.
const MS_SIGNAL_COUNTS_SQL = `
  SELECT target_id AS milestone_id, signal_type, COUNT(*) AS n
  FROM active_signal_links
  WHERE target_type = 'milestone'
  GROUP BY target_id, signal_type`;

// Candidate due/overdue milestones straight from the synced MSX milestones (NOT via workloads),
// within the date window. Active + Uncommitted + deal-team membership are applied in JS (the
// deal-team check needs deal_team_json parsing). milestone_date is YYYY-MM-DD, so the date-only
// string bounds compare correctly. The opportunity/customer join gives display context.
const MY_DUE_MS_SQL = `
SELECT m.milestone_id, m.name, m.milestone_date, m.status_label, m.milestone_status,
       m.commitment_recommendation, m.owner_name, m.deal_team_json,
       o.name AS opportunity_name, cu.name AS customer_name
FROM active_milestones m
LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
LEFT JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
WHERE m.milestone_date IS NOT NULL AND TRIM(m.milestone_date) <> ''
  AND m.milestone_date >= ? AND m.milestone_date <= ?
ORDER BY m.milestone_date ASC`;

function parseTs(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}
function isoDaysFromNow(days) { return new Date(Date.now() + days * DAY_MS).toISOString(); }
function dateOnly(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function relPastDays(iso) {
  const t = parseTs(iso);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}
function uniqueList(str) {
  return [...new Set(String(str || '').split('||').map((s) => s.trim()).filter(Boolean))];
}

// Parse a json_group_array() result (a JSON-encoded string array) into a clean string array.
function jsonArr(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return []; }
}
// Display name for a workload: explicit title, else the orchestration `name`, else a placeholder.
function wlName(w) {
  return (w.title && w.title.trim()) || (w.name && w.name.trim()) || 'Untitled workload';
}
// Best account label for a workload: the saved customer/account snapshot, else the first linked
// customer name derived from its milestone links.
function wlAccount(w) {
  return (w.customer_name && w.customer_name.trim())
    || (w.account_name && w.account_name.trim())
    || jsonArr(w.linked_customer_names)[0] || '';
}
// Short label for a day offset (0 = Today) used in the meetings section title / nav.
function dayLabel(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Today's meetings → gap-collapsed one-day calendar ───────────────────────────────────────
const MEETING_DEFAULT_MIN = 30; // assumed length when a meeting has no end time
const CAL_PX_PER_MIN = 0.9;      // vertical scale within a cluster
const CAL_MIN_EVENT_PX = 40;     // shortest still-readable/clickable block (fits time + title)

// Group meetings into overlap-clusters (maximal runs of transitively-overlapping meetings),
// assign each a column within its cluster so overlaps render side by side, and precompute
// proportional geometry. Empty time BETWEEN clusters is dropped — the renderer shows a compact
// "gap" label instead — so the result is a one-day calendar with dead time collapsed.
function buildDayClusters(meetings) {
  const evs = (meetings || []).map((m) => {
    const s = parseTs(m.start_at);
    let e = parseTs(m.end_at);
    if (!e || e <= s) e = s + MEETING_DEFAULT_MIN * 60000;
    return { m, s, e };
  }).filter((x) => x.s).sort((a, b) => a.s - b.s || a.e - b.e);

  const clusters = [];
  let cur = null;
  for (const ev of evs) {
    if (cur && ev.s < cur.end) { cur.events.push(ev); cur.end = Math.max(cur.end, ev.e); }
    else { cur = { start: ev.s, end: ev.e, events: [ev] }; clusters.push(cur); }
  }
  for (const cl of clusters) {
    const colEnds = []; // last end time per column (interval-partitioning)
    for (const ev of cl.events) {
      let col = colEnds.findIndex((end) => end <= ev.s);
      if (col === -1) { col = colEnds.length; colEnds.push(ev.e); }
      else colEnds[col] = ev.e;
      ev.col = col;
    }
    cl.cols = Math.max(1, colEnds.length);
    let h = ((cl.end - cl.start) / 60000) * CAL_PX_PER_MIN;
    for (const ev of cl.events) {
      ev.top = ((ev.s - cl.start) / 60000) * CAL_PX_PER_MIN;
      ev.h = Math.max(((ev.e - ev.s) / 60000) * CAL_PX_PER_MIN, CAL_MIN_EVENT_PX);
      h = Math.max(h, ev.top + ev.h); // grow the block so min-height events never overflow it
    }
    cl.height = h;
  }
  return clusters;
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtGapLabel(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min gap`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h${m ? ` ${m}m` : ''} gap`;
}

export default function ActionCenter() {
  const navigate = useNavigate();
  // The embedded Workloads section (bottom of the page) is collapsed by default; actions that
  // "go to Workloads" expand it and scroll to it.
  const [workloadsOpen, setWorkloadsOpen] = useState(false);
  const scrollToWorkloads = useCallback(() => {
    setWorkloadsOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('ac-workloads')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const nowIso = useMemo(() => new Date().toISOString(), []);
  // Selectable day for the meetings calendar (0 = today). Prev/next arrows shift it; the bounds
  // are local-day converted to UTC ISO to match stored start_at.
  const [dayOffset, setDayOffset] = useState(0);
  const dayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset); return d.toISOString(); }, [dayOffset]);
  const dayEnd = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset + 1); return d.toISOString(); }, [dayOffset]);
  const staleCut = useMemo(() => isoDaysFromNow(-STALE_DAYS), []);
  const msMin = useMemo(() => dateOnly(-60), []);
  const msMax = useMemo(() => dateOnly(30), []);

  const { data: meetings, initialLoading: l1, refresh: refreshMeetings } = useDbQuery(DAY_MEETINGS_SQL, [dayStart, dayEnd], [dayStart, dayEnd]);
  const { data: stale, initialLoading: l2 } = useDbQuery(STALE_SQL, [nowIso, staleCut], [nowIso]);
  const { data: activeWorkloads, initialLoading: l3 } = useDbQuery(ACTIVE_WORKLOADS_SQL);
  const { data: activeWlMs } = useDbQuery(ACTIVE_WL_MS_SQL, [], [activeWorkloads]);
  const { data: signalCountRows } = useDbQuery(MS_SIGNAL_COUNTS_SQL, [], [activeWorkloads]);
  const { data: dueMsRaw, initialLoading: l4 } = useDbQuery(MY_DUE_MS_SQL, [msMin, msMax], [msMin, msMax]);
  const { data: msHealth, initialLoading: l5 } = useDbQuery(MS_HEALTH_SQL);

  const initialLoading = l1 || l2 || l3 || l4 || l5;

  // Milestone links grouped by workload, and per-milestone signal counts (emails/meetings/chats)
  // — the detail pane renders these grouped by opportunity with the same tallies the milestone
  // popup shows under "Related signals".
  const msByWorkload = useMemo(() => {
    const map = new Map();
    for (const l of activeWlMs || []) {
      const arr = map.get(l.workload_id) || [];
      arr.push(l);
      map.set(l.workload_id, arr);
    }
    return map;
  }, [activeWlMs]);
  const countsByMs = useMemo(() => buildSignalCountMap(signalCountRows), [signalCountRows]);

  // At-a-glance counts. The Action Center is your personal "what needs doing" surface, so these
  // are ALWAYS scoped to the signed-in user's own milestones (owner or a deal_team_json member),
  // independent of the global My/All/Discover toggle — otherwise, with the toggle on "All", the
  // overdue/blocked cards would count every SSP's milestones across the whole book. Same overdue
  // (Active + Uncommitted + last comment > 30 days) and Blocked definitions as Excellence Metrics.
  // Empty when identity is unresolved: we can't attribute deal-team membership without it, so we
  // fail honestly rather than count the entire book.
  const { currentUserName } = useTerritory();
  const scopedMs = useMemo(() => {
    if (!currentUserName) return [];
    return (msHealth || []).filter((m) => m.owner_name === currentUserName || parseTeamList(m.deal_team_json).includes(currentUserName));
  }, [msHealth, currentUserName]);
  const overdueCommentsCount = useMemo(() => {
    let n = 0;
    for (const m of scopedMs) {
      if (!isActiveMilestone(m) || Number(m.commitment_recommendation) !== UNCOMMITTED) continue;
      const days = latestCommentAgeDays(m.comments_json);
      if (days != null && days > 30) n += 1;
    }
    return n;
  }, [scopedMs]);
  const blockedCount = useMemo(
    () => scopedMs.filter((m) => (m.status_label || '') === 'Blocked').length,
    [scopedMs],
  );

  // Due/overdue milestones for the top-right list: Active + Uncommitted + the signed-in user is
  // on the deal team (owner or a deal_team_json member). Always deal-team scoped regardless of the
  // global My toggle, per the Action Center spec. Empty when the user's identity isn't resolved
  // (we can't attribute deal-team membership without it — fail honestly rather than show unrelated
  // milestones).
  const myDueMs = useMemo(() => {
    const rows = dueMsRaw || [];
    if (!currentUserName) return [];
    return rows.filter((m) => {
      if (!isActiveMilestone(m)) return false;
      if (Number(m.commitment_recommendation) !== UNCOMMITTED) return false;
      const team = parseTeamList(m.deal_team_json);
      return m.owner_name === currentUserName || team.includes(currentUserName);
    });
  }, [dueMsRaw, currentUserName]);

  // "Milestones due or overdue" list paging: show a first page, then reveal 10 more per click
  // in place (the section keeps a fixed height and scrolls) rather than navigating away.
  const DUE_PAGE = 10;
  const DUE_INITIAL = 6;
  const [dueShown, setDueShown] = useState(DUE_INITIAL);
  // Collapse back to the first page whenever the underlying set shrinks below what's shown, so a
  // refresh that removes milestones can't leave the list padded with a stale "showing N" count.
  useEffect(() => {
    if (dueShown > DUE_INITIAL && myDueMs.length <= DUE_INITIAL) setDueShown(DUE_INITIAL);
  }, [myDueMs.length, dueShown]);

  // Active workloads master/detail: default the detail pane to the first workload; keep the
  // selection valid as the list changes (e.g. after an approve/delete elsewhere).
  const [selectedWlId, setSelectedWlId] = useState(null);
  useEffect(() => {
    const list = activeWorkloads || [];
    if (!list.length) { if (selectedWlId !== null) setSelectedWlId(null); return; }
    if (selectedWlId == null || !list.some((w) => w.id === selectedWlId)) setSelectedWlId(list[0].id);
  }, [activeWorkloads, selectedWlId]);
  const selectedWl = useMemo(
    () => (activeWorkloads || []).find((w) => w.id === selectedWlId) || null,
    [activeWorkloads, selectedWlId],
  );
  const selectedWlLinks = useMemo(
    () => (selectedWlId != null ? (msByWorkload.get(selectedWlId) || []) : []),
    [msByWorkload, selectedWlId],
  );

  // Milestone detail popup (shared DetailCard) — opened by clicking a milestone in the detail
  // pane. Resolves the full local milestone row by id, exactly like the Workload workspace does.
  const [msDetail, setMsDetail] = useState(null);
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const teamApi = useTeamApi({});
  useEffect(() => { getMsxSettings().then((s) => setCrmBaseUrl(s.crmUrl || '')).catch(() => {}); }, []);
  const openMilestoneDetail = useCallback(async (milestoneId) => {
    if (!milestoneId) return;
    try {
      const rows = await dbQuery(
        `SELECT m.*, o.name AS opp_name, o.customer_name
           FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
          WHERE m.milestone_id = ?`,
        [milestoneId],
      );
      if (Array.isArray(rows) && rows.length) setMsDetail({ type: 'ms', data: rows[0] });
    } catch { /* non-fatal: leave the pane as-is */ }
  }, []);

  // Customer glance popup (shared AccountGlanceModal from Customer Activity) — opened by clicking
  // an account name in "Accounts to re-engage". The wrapper owns its activity window + navigation.
  const [glanceAccount, setGlanceAccount] = useState(null); // { tpid, name, ssp } | null

  // Opening the workload popup from the detail pane: expand the embedded Workloads section and
  // ask it to open that workload's popup (it owns the modal + its data).
  const [pendingOpenWorkloadId, setPendingOpenWorkloadId] = useState(null);
  const openWorkloadPopup = useCallback((id) => {
    setWorkloadsOpen(true);
    setPendingOpenWorkloadId(id);
  }, []);

  // Today's meetings laid out as gap-collapsed calendar clusters (overlaps → columns).
  const dayClusters = useMemo(() => buildDayClusters(meetings), [meetings]);

  const [agendaOpen, setAgendaOpen] = useState(false); // full-calendar section, collapsed by default
  const [detailEventId, setDetailEventId] = useState(null); // meeting popup panel

  // The Agenda tab was retired — its full calendar now lives in the collapsible section on this
  // page, so "See all" expands and scrolls to it instead of navigating away.
  const openAgenda = useCallback(() => {
    setAgendaOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('ac-agenda')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const totalActions =
    (meetings?.length || 0) + (stale?.length || 0) + (myDueMs.length || 0)
    + (activeWorkloads?.length || 0);

  return (
    <div className="ac-page">
      <div className="page-header">
        <div className="page-header-left">
          <h2>Action Center</h2>
          <p className="ac-intro">
            Everything that needs your attention — meetings to prep, milestones due, your active
            workloads, and accounts to re-engage — in one place.
          </p>
        </div>
        <span className="ac-total">{totalActions} open action{totalActions === 1 ? '' : 's'}</span>
      </div>

      {initialLoading ? (
        <div className="ac-empty"><Spinner size="small" /> Gathering your actions…</div>
      ) : (
        <>
        {SHOW_SECRETARY && <SecretarySection userName={currentUserName} />}
        <div className="ac-top-row">
          <div className="ac-top-left">
            {/* A day's meetings — a gap-collapsed one-day calendar (overlaps side by side), with
                prev/next day navigation. */}
            <ActionSection
              icon={CalendarLtrRegular}
              title={dayOffset === 0 ? "Today's meetings" : `Meetings · ${dayLabel(dayOffset)}`}
              count={meetings?.length || 0}
              tone="meeting"
              emptyText={dayOffset === 0 ? 'No meetings scheduled today.' : `No meetings on ${dayLabel(dayOffset)}.`}
              onSeeAll={openAgenda}
              seeAllLabel="Open Agenda"
              hideMore
              control={
                <span className="ac-daynav">
                  <button type="button" className="ac-daynav-btn" title="Previous day" onClick={() => setDayOffset((o) => o - 1)}><ChevronLeftRegular /></button>
                  {dayOffset !== 0 ? (
                    <button type="button" className="ac-daynav-today" title="Back to today" onClick={() => setDayOffset(0)}>Today</button>
                  ) : null}
                  <button type="button" className="ac-daynav-btn" title="Next day" onClick={() => setDayOffset((o) => o + 1)}><ChevronRightRegular /></button>
                </span>
              }
            >
              <DayCalendar clusters={dayClusters} onOpen={setDetailEventId} />
            </ActionSection>
          </div>

          <div className="ac-top-right ac-top-right-col">
            <div className="ac-stat-row">
              <StatCard
                icon={WarningRegular}
                label="Overdue comments"
                value={overdueCommentsCount}
                danger={overdueCommentsCount > 0}
                dataTour="ac-overdue"
                onClick={() => navigate('/milestones?overdue=true&sort=comments&dir=asc')}
              />
              <StatCard
                icon={DismissCircleRegular}
                label="Blocked milestones"
                value={blockedCount}
                danger={blockedCount > 0}
                dataTour="ac-blocked"
                onClick={() => navigate('/milestones?status=Blocked')}
              />
            </div>

            {/* Your due/overdue milestones — Active + Uncommitted + you're on the deal team.
                Overdue dates render in red. Fixed height (matches the meetings calendar); the
                pinned footer reveals 10 more at a time in place, scrolling within the section. */}
            <ActionSection
              icon={FlagRegular}
              title="Milestones due or overdue"
              count={myDueMs.length}
              tone="milestone"
              dataTour="ac-due"
              emptyText="No active, uncommitted milestones on your deal teams are due or overdue."
              onSeeAll={() => navigate('/milestones?due=true&sort=date&dir=asc')}
              seeAllLabel="Open Milestones"
              hideMore
              footer={myDueMs.length > dueShown ? (
                <button
                  type="button"
                  className="ac-more-foot"
                  onClick={() => setDueShown((v) => v + DUE_PAGE)}
                >
                  +{myDueMs.length - dueShown} · See {Math.min(DUE_PAGE, myDueMs.length - dueShown)} more
                </button>
              ) : null}
            >
              {myDueMs.slice(0, dueShown).map((m) => {
                const overdue = m.milestone_date < dateOnly(0);
                return (
                  <div
                    key={m.milestone_id}
                    className="ac-row ac-row-clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => openMilestoneDetail(m.milestone_id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMilestoneDetail(m.milestone_id); } }}
                  >
                    <FlagRow icon={FlagRegular} tone="milestone" />
                    <span className="ac-row-body">
                      <span className="ac-row-title">{m.name}</span>
                      <span className="ac-row-sub">
                        <span className={overdue ? 'ac-stale-text' : ''}>
                          {overdue ? 'Overdue' : 'Due'} {m.milestone_date}
                        </span>
                        {m.customer_name ? ` · ${m.customer_name}` : ''}
                        {m.opportunity_name ? ` · ${m.opportunity_name}` : ''}
                      </span>
                    </span>
                  </div>
                );
              })}
            </ActionSection>
          </div>
        </div>

        {/* Active workloads — one Outlook-style reader section: pick a workload on the left, see
            its details on the right. */}
        <section className="ac-section ac-wl-reader">
          <div className="ac-section-head">
            <span className="ac-section-icon suggested"><BoardRegular /></span>
            <h3>Active workloads</h3>
            <span className={`ac-section-count${activeWorkloads?.length ? ' active' : ''}`}>{activeWorkloads?.length || 0}</span>
            {activeWorkloads?.length ? (
              <button className="ac-seeall" onClick={scrollToWorkloads}>Manage <ArrowRightRegular /></button>
            ) : null}
          </div>
          {activeWorkloads?.length ? (
            <div className="ac-wl-reader-body">
              <div className="ac-wl-list">
                {activeWorkloads.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className={`ac-wl-item${w.id === selectedWlId ? ' is-active' : ''}`}
                    onClick={() => setSelectedWlId(w.id)}
                  >
                    <span className="ac-wl-item-title">{wlName(w)}</span>
                    <span className="ac-wl-item-sub">{wlAccount(w) || 'No account'}</span>
                  </button>
                ))}
              </div>
              <div className="ac-wl-pane">
                {selectedWl ? (
                  <WorkloadDetail
                    w={selectedWl}
                    links={selectedWlLinks}
                    countsByMs={countsByMs}
                    onOpen={() => openWorkloadPopup(selectedWl.id)}
                    onOpenMilestone={openMilestoneDetail}
                    onOpenAccount={(acct) => setGlanceAccount(acct)}
                  />
                ) : (
                  <p className="ac-section-empty">Select a workload to see its details.</p>
                )}
              </div>
            </div>
          ) : (
            <p className="ac-section-empty"><CheckmarkCircleRegular /> No active workloads yet — create or approve one below.</p>
          )}
        </section>

        {/* Accounts to re-engage — collapsed by default */}
        <div className="ac-sections">
          <ActionSection
            icon={ClockRegular}
            title="Accounts to re-engage"
            count={stale?.length || 0}
            tone="stale"
            emptyText={`No accounts have gone quiet past ${STALE_DAYS} days.`}
            onSeeAll={() => navigate('/email')}
            seeAllLabel="Open Customer Activity"
            collapsible
            defaultCollapsed
          >
            {(stale || []).slice(0, 6).map((a) => {
              const d = relPastDays(a.last_ts);
              return (
                <div key={a.tpid} className="ac-row">
                  <FlagRow icon={ClockRegular} tone="stale" />
                  <span className="ac-row-body">
                    <button
                      type="button"
                      className="ac-row-title ac-title-link"
                      onClick={() => setGlanceAccount({ tpid: String(a.tpid), name: a.name, ssp: a.ssp_name || '' })}
                      title="Open account glance"
                    >
                      {a.name}
                    </button>
                    <span className="ac-row-sub ac-stale-text">
                      Last contact {d} day{d === 1 ? '' : 's'} ago{a.ssp_name ? ` · SSP · ${a.ssp_name}` : ''}
                    </span>
                  </span>
                  <span className="ac-row-actions">
                    <button className="btn btn-secondary ac-sm" onClick={() => navigate('/email')}>
                      Review <ArrowRightRegular />
                    </button>
                  </span>
                </div>
              );
            })}
          </ActionSection>
        </div>
        </>
      )}

      <section className={`ac-section${workloadsOpen ? '' : ' collapsed'}`} id="ac-workloads" style={{ marginTop: 16 }}>
        <div
          className="ac-section-head ac-section-head-clickable"
          role="button"
          tabIndex={0}
          aria-expanded={workloadsOpen}
          onClick={() => setWorkloadsOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWorkloadsOpen((v) => !v); } }}
        >
          <span className="ac-collapse-btn" aria-hidden="true">{workloadsOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
          <span className="ac-section-icon suggested"><BoardRegular /></span>
          <h3>Workloads</h3>
          <span className="ac-muted ac-workloads-hint">View, create, and approve — each opens in a popup</span>
        </div>
        {workloadsOpen && (
          <div className="ac-embed-body">
            <WorkloadsWorkspace
              embedded
              initialOpenWorkloadId={pendingOpenWorkloadId}
              onOpenWorkloadHandled={() => setPendingOpenWorkloadId(null)}
            />
          </div>
        )}
      </section>

      <section className={`ac-section${agendaOpen ? '' : ' collapsed'}`} id="ac-agenda" style={{ marginTop: 16 }}>
        <div
          className="ac-section-head ac-section-head-clickable"
          role="button"
          tabIndex={0}
          aria-expanded={agendaOpen}
          onClick={() => setAgendaOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAgendaOpen((v) => !v); } }}
        >
          <span className="ac-collapse-btn" aria-hidden="true">{agendaOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
          <span className="ac-section-icon meeting"><CalendarLtrRegular /></span>
          <h3>Agenda</h3>
          <span className="ac-muted ac-workloads-hint">Full day-by-day calendar, including internal meetings</span>
        </div>
        {agendaOpen && (
          <div className="ac-embed-body">
            <AgendaView embedded />
          </div>
        )}
      </section>

      {detailEventId && (
        <MeetingDetailPanel
          eventId={detailEventId}
          onClose={() => setDetailEventId(null)}
          onTagsChanged={() => { if (refreshMeetings) refreshMeetings(); }}
        />
      )}

      {/* Shared milestone detail popup — opened by clicking a milestone in the workload reader
          or the "due or overdue" list. */}
      <DetailCard
        detail={msDetail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setMsDetail(null)}
        onSelect={setMsDetail}
        teamApi={teamApi}
      />

      {/* Shared customer glance popup — opened by clicking an account in "Accounts to re-engage". */}
      <AccountGlanceModal selected={glanceAccount} onClose={() => setGlanceAccount(null)} />
    </div>
  );
}

function FlagRow({ icon: Icon, tone }) {
  return <span className={`ac-flag ${tone}`}><Icon /></span>;
}

// At-a-glance count card (overdue comments / blocked milestones). Clickable — jumps to the
// matching /milestones drill-down. Value turns danger-colored when the count is non-zero.
function StatCard({ icon: Icon, label, value, sub, danger, onClick, dataTour }) {
  return (
    <button type="button" data-tour={dataTour} className={`ac-statcard${danger ? ' danger' : ''}`} onClick={onClick} title={`Open ${label.toLowerCase()} in Milestones`}>
      <span className="ac-statcard-head"><Icon /> {label}</span>
      <span className="ac-statcard-value">{value}</span>
      {sub ? <span className="ac-statcard-sub">{sub}</span> : null}
    </button>
  );
}

function ActionSection({ icon: Icon, title, count, tone, emptyText, children, onSeeAll, seeAllLabel, hideMore, control, footer, collapsible, defaultCollapsed, dataTour }) {
  const hasItems = count > 0;
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const showBody = !collapsible || !collapsed;
  return (
    <section data-tour={dataTour} className={`ac-section${hasItems ? '' : ' empty'}${collapsible && collapsed ? ' collapsed' : ''}`}>
      <div className="ac-section-head">
        {collapsible ? (
          <button
            type="button"
            className="ac-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
          </button>
        ) : null}
        <span className={`ac-section-icon ${tone}`}><Icon /></span>
        <h3>{title}</h3>
        {control || null}
        <span className={`ac-section-count${hasItems ? ' active' : ''}`}>{count}</span>
        {hasItems && onSeeAll ? (
          <button className="ac-seeall" onClick={onSeeAll}>{seeAllLabel} <ArrowRightRegular /></button>
        ) : null}
      </div>
      {showBody ? (hasItems ? (
        <div className="ac-rows">
          {children}
          {!hideMore && count > 6 ? (
            <button className="ac-more" onClick={onSeeAll}>+{count - 6} more · {seeAllLabel}</button>
          ) : null}
        </div>
      ) : (
        <p className="ac-section-empty"><CheckmarkCircleRegular /> {emptyText}</p>
      )) : null}
      {showBody && hasItems && footer ? footer : null}
    </section>
  );
}

// Right-hand reader pane for the selected active workload: account + SSP, description, and the
// linked milestones grouped by opportunity (with email/meeting/chat signal counts) — each
// milestone clickable to open the shared milestone detail popup. "Open" opens the full workload
// popup (where the workload is edited and Milestone AI runs). Opportunity/category are intentionally
// NOT called out here — a workload can span more than one opportunity, so they live in the grouped
// milestone list instead.
function WorkloadDetail({ w, links, countsByMs, onOpen, onOpenMilestone, onOpenAccount }) {
  const name = wlName(w);
  const account = wlAccount(w);
  const tpid = (w.customer_tpid && String(w.customer_tpid).trim())
    || (w.tpid && String(w.tpid).trim())
    || jsonArr(w.linked_customer_tpids)[0] || '';
  // The workload's SSP is the account's curated Cloud & AI Specialist from the customer profile
  // (customer_account_team_roles → w.profile_ssp_name), NOT the opportunity/milestone owner —
  // matching the Milestone Timeline. Shows '—' when no SSP is configured on the account's profile.
  const ssp = (w.profile_ssp_name && w.profile_ssp_name.trim()) || '';
  const ms = links || [];
  return (
    <>
      <div className="ac-section-head">
        <span className="ac-section-icon suggested"><BoardRegular /></span>
        <button type="button" className="ac-wl-detail-title ac-title-link" title={`Open ${name}`} onClick={onOpen}>{name}</button>
        {w.status ? <span className="ac-wl-badge">{w.status}</span> : null}
        <button className="ac-seeall" data-tour="wl-open" onClick={onOpen}>Open <ArrowRightRegular /></button>
      </div>
      <div className="ac-wl-detail-body">
        <dl className="ac-wl-facts">
          <div>
            <dt>Account</dt>
            <dd>
              {account && tpid ? (
                <button type="button" className="ac-title-link" title="Open account details" onClick={() => onOpenAccount?.({ tpid: String(tpid), name: account, ssp })}>{account}</button>
              ) : (account || '—')}
              {tpid ? ` · ${tpid}` : ''}
            </dd>
          </div>
          <div>
            <dt>SSP</dt>
            <dd>{ssp || '—'}</dd>
          </div>
        </dl>
        {w.description && w.description.trim() ? (
          <p className="ac-wl-desc">{w.description}</p>
        ) : null}
        <div className="ac-wl-ms">
          <div className="ac-wl-ms-head">
            <FlagRegular /> Milestones
            <span className="ac-section-count">{ms.length}</span>
          </div>
          {ms.length ? (
            <MilestoneLinkList links={ms} countsByMs={countsByMs} onOpenMilestone={onOpenMilestone} />
          ) : (
            <p className="ac-wl-ms-empty">No milestones linked to this workload yet.</p>
          )}
        </div>
      </div>
    </>
  );
}

// One-day calendar for today's meetings: overlapping meetings render as side-by-side columns
// with proportional heights; empty time between overlap-clusters is collapsed to a compact
// "gap" label. Clicking an event opens the meeting detail panel (which hosts Join + Prepare);
// online meetings also expose a one-click Join badge.
function DayCalendar({ clusters, onOpen }) {
  if (!clusters || clusters.length === 0) return null;
  return (
    <div className="ac-daycal">
      {clusters.map((cl, ci) => {
        const gapMs = ci > 0 ? cl.start - clusters[ci - 1].end : 0;
        return (
        <div key={cl.start} className="ac-cal-block">
          {gapMs >= 15 * 60000 ? (
            <div className="ac-cal-gap"><span>{fmtGapLabel(gapMs)}</span></div>
          ) : null}
          <div className="ac-cal-cluster" style={{ height: cl.height }}>
            {cl.events.map((ev) => {
              const m = ev.m;
              const accts = uniqueList(m.accounts);
              const online = m.is_online_meeting && m.online_meeting_url;
              return (
                <div
                  key={m.event_id}
                  className="ac-cal-event"
                  role="button"
                  tabIndex={0}
                  style={{
                    top: ev.top,
                    height: ev.h,
                    left: `calc(${(ev.col / cl.cols) * 100}% + 2px)`,
                    width: `calc(${100 / cl.cols}% - 4px)`,
                  }}
                  title={`${m.subject || '(no subject)'} · ${fmtClock(ev.s)}–${fmtClock(ev.e)}${accts.length ? ` · ${accts.join(', ')}` : ''}`}
                  onClick={() => onOpen(m.event_id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(m.event_id); } }}
                >
                  <span className="ac-cal-event-time">{fmtClock(ev.s)}</span>
                  <span className="ac-cal-event-title">{m.subject || '(no subject)'}</span>
                  {ev.h > 54 && cl.cols === 1 && accts.length ? (
                    <span className="ac-cal-event-acct">{accts.join(', ')}</span>
                  ) : null}
                  {online ? (
                    <button
                      type="button"
                      className="ac-cal-join"
                      title="Join online meeting"
                      onClick={(e) => { e.stopPropagation(); openExternal(m.online_meeting_url); }}
                    >
                      <VideoRegular />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
}
