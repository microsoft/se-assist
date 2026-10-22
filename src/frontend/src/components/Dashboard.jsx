import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '@fluentui/react-components';
import {
  PeopleRegular,
  TargetRegular,
  FlagRegular,
  OpenRegular,
  WarningRegular,
  TaskListSquareLtrRegular,
  DataTrendingRegular,
  ArrowRightRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { getMsxSettings, openExternal } from '../electronBridge';
import { useTerritory } from '../territoryContext';
import { fetchTerritoryHokTasks } from '../lib/hokActivities';
import {
  isActiveMilestone, inFiscalYear, parseTeamList, isCommentsOverdue, latestCommentAgeDays,
  UNCOMMITTED, COMMITTED, normId,
} from '../lib/milestoneMetrics';

const MILESTONE_STATUS_LABELS = { 0: 'Draft', 1: 'Approved', 2: 'Rejected', 3: 'Cancelled', 4: 'Completed', 100000000: 'Active', 100000001: 'Closed', 100000002: 'Cancelled' };

// msp_commitmentrecommendation option-set. NOTE the values are easy to invert:
// "Engaged" per the MSX metric dictionary is limited to *active* milestones (not
// Completed/Cancelled/Lost/Hygiene) in the POC/Pilot or Production categories.
// (Status/commitment/fiscal-year helpers now come from ../lib/milestoneMetrics.)
const ENGAGED_CATEGORIES = new Set([861980000, 861980002]); // POC/Pilot, Production

function isEngagedMilestone(m) {
  return isActiveMilestone(m) && ENGAGED_CATEGORIES.has(Number(m.milestone_category));
}

// Whole-dollar currency for the KPI scorecard (matches the pasted report's
// $13,065,490 style). Non-finite inputs render as $0.
function fmtUsd(n) {
  const v = Number(n);
  return '$' + (Number.isFinite(v) ? Math.round(v) : 0).toLocaleString();
}

export default function Dashboard() {
  const { data: custCount, loading: l1 } = useDbQuery(
    'SELECT COUNT(*) as count FROM active_customers'
  );
  const { data: oppCount, loading: l2 } = useDbQuery(
    'SELECT COUNT(*) as count FROM active_opportunities'
  );
  // Per-milestone rows drive the (optionally My-Milestones-filtered) metrics below.
  const { data: milestoneRows, loading: l3 } = useDbQuery(
    `SELECT milestone_id, opportunity_id, status_label, milestone_status, milestone_category, commitment_recommendation, comments_json, owner_name, deal_team_json, monthly_use, created_on
     FROM active_milestones`
  );
  const { data: topParents, loading: l4 } = useDbQuery(
    `SELECT c.id, c.name, c.tpid, c.crm_account_id,
       (SELECT COUNT(*) FROM active_customers c2 WHERE c2.tpid = c.tpid) - 1 as portco,
       (SELECT COUNT(*) FROM active_opportunities o4
        JOIN active_customers c4 ON o4.parent_account_id = c4.crm_account_id
        WHERE c4.tpid = c.tpid
       ) as opportunity_count,
       (SELECT COUNT(*) FROM active_milestones m
        JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
        JOIN active_customers c3 ON o.parent_account_id = c3.crm_account_id
        WHERE c3.tpid = c.tpid AND m.commitment_recommendation = 861980003
       ) as milestone_count
     FROM active_customers c
     WHERE parenting_level = 861980000
     ORDER BY name`
  );
  // Maps every milestone / opportunity / account GUID to its owning TPID so HoK
  // tasks (keyed by their "regarding" record) can be attributed to a customer.
  const { data: hokIdMapRows } = useDbQuery(
    `SELECT m.milestone_id AS id, c.tpid AS tpid FROM active_milestones m
       JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
       JOIN active_customers c ON o.parent_account_id = c.crm_account_id
       WHERE c.tpid IS NOT NULL AND m.milestone_id IS NOT NULL
     UNION
     SELECT o.opportunity_id AS id, c.tpid AS tpid FROM active_opportunities o
       JOIN active_customers c ON o.parent_account_id = c.crm_account_id
       WHERE c.tpid IS NOT NULL AND o.opportunity_id IS NOT NULL
     UNION
     SELECT crm_account_id AS id, tpid AS tpid FROM active_customers
       WHERE tpid IS NOT NULL AND crm_account_id IS NOT NULL`
  );
  // Maps each opportunity to its owning TPID so the per-customer Opportunities,
  // Milestones, and Overdue columns can be scoped to "my" milestones in JS when the
  // territory toggle is on (full-territory values come from the SQL subqueries above).
  const { data: oppToTpidRows } = useDbQuery(
    `SELECT o.opportunity_id, c.tpid FROM active_opportunities o
       JOIN active_customers c ON o.parent_account_id = c.crm_account_id
     WHERE c.tpid IS NOT NULL AND o.opportunity_id IS NOT NULL`
  );
  const { data: overdueByTpidRaw } = useDbQuery(
    `SELECT c.tpid, m.comments_json, m.status_label, m.milestone_status
     FROM active_milestones m
     JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
     JOIN active_customers c ON o.parent_account_id = c.crm_account_id
     WHERE m.comments_json IS NOT NULL AND m.comments_json != '[]' AND m.comments_json != ''
       AND m.commitment_recommendation = 861980000
       AND c.tpid IN (SELECT tpid FROM active_customers WHERE parenting_level = 861980000)`
  );
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const [hokTasks, setHokTasks] = useState(null); // null = not loaded / unavailable
  const [hokPending, setHokPending] = useState(true);
  const { currentUserName } = useTerritory();
  // Excellence Metrics is a fixed personal scorecard — the territory toggle was removed from
  // this page, so it always scopes to the signed-in user's own (on-team) milestones.
  const scope = 'mine';

  useEffect(() => {
    getMsxSettings().then(s => setCrmBaseUrl(s.crmUrl || ''));
  }, []);

  // HoK Activities, scoped to the current territory toggle and shared with the HoK
  // Activities tab. My = tasks I own; Discover = book tasks I don't own; All = every task
  // regarding a milestone in the book of business. Fetched independently so it never blocks
  // the DB-backed dashboard; the tile shows '—' if CRM is unavailable.
  useEffect(() => {
    let cancelled = false;
    setHokPending(true);
    (async () => {
      try {
        const tasks = await fetchTerritoryHokTasks({
          scope,
          select: 'activityid,_regardingobjectid_value',
        });
        if (!cancelled) setHokTasks(tasks);
      } catch {
        if (!cancelled) setHokTasks(null);
      } finally {
        if (!cancelled) setHokPending(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

  const loading = l1 || l2 || l3 || l4;

  // Apply the territory scope: 'mine' keeps milestones where I'm the owner or on the deal
  // team; 'discover' keeps the complement (candidates to join); 'all' keeps everything.
  const scopedMilestones = useMemo(() => {
    const rows = milestoneRows || [];
    if ((scope !== 'mine' && scope !== 'discover') || !currentUserName) return rows;
    return rows.filter(m => {
      const onTeam = m.owner_name === currentUserName
        || parseTeamList(m.deal_team_json).includes(currentUserName);
      return scope === 'mine' ? onTeam : !onTeam;
    });
  }, [milestoneRows, scope, currentUserName]);

  const msCountVal = scopedMilestones.length;
  // When a personal scope (mine/discover) is on, count only the opportunities that parent
  // the scoped milestones; otherwise show the full opportunity count.
  const oppCountVal = useMemo(() => {
    if (scope === 'all' || !currentUserName) return oppCount?.[0]?.count ?? 0;
    const ids = new Set();
    for (const m of scopedMilestones) {
      if (m.opportunity_id) ids.add(m.opportunity_id);
    }
    return ids.size;
  }, [scope, currentUserName, oppCount, scopedMilestones]);
  const statusBreakdown = useMemo(() => {
    const counts = new Map();
    for (const m of scopedMilestones) {
      const label = m.status_label || MILESTONE_STATUS_LABELS[m.milestone_status] || 'Unknown';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const arr = [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
    // Surface Blocked immediately to the right of On Track regardless of its count.
    const onTrackIdx = arr.findIndex(s => s.status === 'On Track');
    const blockedIdx = arr.findIndex(s => s.status === 'Blocked');
    if (onTrackIdx > -1 && blockedIdx > -1 && blockedIdx !== onTrackIdx + 1) {
      const [blocked] = arr.splice(blockedIdx, 1);
      arr.splice(arr.findIndex(s => s.status === 'On Track') + 1, 0, blocked);
    }
    return arr;
  }, [scopedMilestones]);

  // Overdue comments (last comment > 30 days ago), bucketed by how overdue:
  // 30–59 days, 60–89 days, and 90+ days. overdueCount is the total across buckets.
  // Scope: Active-only statuses + Uncommitted-only commitment — the same population
  // the /milestones drill-down shows by default, so clicking the card lands on a list
  // of exactly this many.
  const overdueBuckets = useMemo(() => {
    const b = { d30: 0, d60: 0, d90: 0 };
    for (const row of scopedMilestones) {
      if (!isActiveMilestone(row) || Number(row.commitment_recommendation) !== UNCOMMITTED) continue;
      const days = latestCommentAgeDays(row.comments_json);
      if (days == null || days <= 30) continue;
      if (days <= 60) b.d30 += 1;
      else if (days <= 90) b.d60 += 1;
      else b.d90 += 1;
    }
    return b;
  }, [scopedMilestones]);
  const overdueCount = overdueBuckets.d30 + overdueBuckets.d60 + overdueBuckets.d90;

  // Overdue count per TPID for the Customers table. Scope matches the headline card:
  // Active-only statuses + Uncommitted-only commitment (Uncommitted enforced in the
  // SQL above; Active applied here so it mirrors the /milestones drill-down default).
  const overdueByTpid = useMemo(() => {
    const map = {};
    for (const row of (overdueByTpidRaw || [])) {
      if (!isActiveMilestone(row)) continue;
      try {
        const comments = JSON.parse(row.comments_json);
        if (!Array.isArray(comments) || comments.length === 0) continue;
        const latest = comments.reduce((best, c) =>
          !best || new Date(c.modifiedOn) > new Date(best) ? c.modifiedOn : best, null);
        if (!latest) continue;
        if ((Date.now() - new Date(latest).getTime()) > 30 * 86400000) {
          map[row.tpid] = (map[row.tpid] || 0) + 1;
        }
      } catch { /* skip */ }
    }
    return map;
  }, [overdueByTpidRaw]);

  // HoK headline count + per-customer breakdown, derived from the territory-scoped
  // task list. Each task is attributed to a customer via its "regarding" record.
  // hokTasks === null after a finished load means CRM was unavailable (show '—').
  // Both the top stat strip and the scorecard window HoK to the current fiscal year,
  // mirroring the corporate report.
  const hokFyVal = hokTasks == null ? null : hokTasks.filter(t => inFiscalYear(t.createdon)).length;
  const hokUnavailable = !hokPending && hokTasks == null;
  const idToTpid = useMemo(() => {
    const m = new Map();
    for (const r of (hokIdMapRows || [])) m.set(normId(r.id), r.tpid);
    return m;
  }, [hokIdMapRows]);
  const hokByTpid = useMemo(() => {
    const map = {};
    for (const t of (hokTasks || [])) {
      const tp = idToTpid.get(normId(t._regardingobjectid_value));
      if (tp) map[tp] = (map[tp] || 0) + 1;
    }
    return map;
  }, [hokTasks, idToTpid]);

  // FY2027 KPI scorecard (mirrors the pasted MSX report). "Engaged" = active
  // POC/Pilot & Production milestones in the (optionally My-Milestones-scoped) book
  // of business — the local stand-in for the warehouse Stage 2-3 gate (see
  // isEngagedMilestone). Dollars come from msp_monthlyuse (ACR), a local proxy that
  // won't equal the corporate warehouse revenue field. "New" spans the whole scoped
  // book (all stages/categories), windowed to the fiscal year via created_on.
  const kpi = useMemo(() => {
    const engaged = scopedMilestones.filter(isEngagedMilestone);
    let dollarEngaged = 0, dollarCommitted = 0, countCommitted = 0;
    for (const m of engaged) {
      const val = Number(m.monthly_use) || 0;
      dollarEngaged += val;
      if (Number(m.commitment_recommendation) === COMMITTED) {
        dollarCommitted += val;
        countCommitted += 1;
      }
    }
    let dollarNew = 0, countNew = 0;
    for (const m of scopedMilestones) {
      if (inFiscalYear(m.created_on)) {
        dollarNew += Number(m.monthly_use) || 0;
        countNew += 1;
      }
    }
    const pctCommittedPipe = dollarEngaged > 0 ? (dollarCommitted / dollarEngaged) * 100 : 0;
    return {
      dollarEngaged,
      countEngaged: engaged.length,
      dollarCommitted,
      countCommitted,
      pctCommittedPipe,
      dollarNew,
      countNew,
    };
  }, [scopedMilestones]);

  // Per-customer Opportunities / Milestones / Overdue scoped to "my" milestones,
  // grouped by TPID. Used only when the territory toggle is on; full territory keeps
  // the SQL subquery values so those numbers are unchanged. The Milestones column
  // counts committed milestones; the Overdue column counts Active + Uncommitted
  // milestones with a stale comment (matching the headline card and the drill-down);
  // the Opportunities column is the set of opportunities parenting any of my milestones.
  const oppToTpid = useMemo(() => {
    const m = new Map();
    for (const r of (oppToTpidRows || [])) m.set(r.opportunity_id, r.tpid);
    return m;
  }, [oppToTpidRows]);
  const myByTpid = useMemo(() => {
    const ms = {}, overdue = {}, oppSets = {};
    for (const m of scopedMilestones) {
      const tp = oppToTpid.get(m.opportunity_id);
      if (!tp) continue;
      if (Number(m.commitment_recommendation) === COMMITTED) {
        ms[tp] = (ms[tp] || 0) + 1;
      }
      if (isActiveMilestone(m) && Number(m.commitment_recommendation) === UNCOMMITTED
          && isCommentsOverdue(m.comments_json)) {
        overdue[tp] = (overdue[tp] || 0) + 1;
      }
      if (m.opportunity_id) (oppSets[tp] || (oppSets[tp] = new Set())).add(m.opportunity_id);
    }
    const opp = {};
    for (const tp in oppSets) opp[tp] = oppSets[tp].size;
    return { ms, overdue, opp };
  }, [scopedMilestones, oppToTpid]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spinner size="large" label="Loading dashboard…" />
      </div>
    );
  }

  const stats = [
    {
      icon: <PeopleRegular style={{ fontSize: 24, color: 'var(--accent)' }} />,
      label: 'Customers',
      value: custCount[0]?.count ?? 0,
      link: '/email',
    },
    {
      icon: <TargetRegular style={{ fontSize: 24, color: 'var(--pink)' }} />,
      label: scope === 'mine' ? 'My Opportunities' : scope === 'discover' ? 'Discover Opportunities' : 'Opportunities',
      value: oppCountVal,
      link: '/milestones',
    },
    {
      icon: <FlagRegular style={{ fontSize: 24, color: 'var(--violet)' }} />,
      label: scope === 'mine' ? 'My Milestones' : scope === 'discover' ? 'Discover Milestones' : 'Milestones',
      value: msCountVal,
      link: '/milestones',
    },
    {
      icon: <TaskListSquareLtrRegular style={{ fontSize: 24, color: 'var(--success-text)' }} />,
      label: 'HoK Activities',
      value: hokFyVal,
      sub: 'FY2027',
      link: '/hok-activities?fy=2027',
      pending: hokPending,
    },
  ];

  // FY2027 KPI scorecard tiles, in the same order as the pasted MSX report. The two
  // that overlap the top stat strip (# Milestones Engaged, # HoK Activity) are kept so
  // this band reads as a cohesive scorecard. Milestone tiles deep-link to /milestones.
  const kpiTiles = [
    { label: '$ Milestones Engaged', value: fmtUsd(kpi.dollarEngaged), link: '/milestones' },
    { label: '# Milestones Engaged', value: kpi.countEngaged.toLocaleString(), link: '/milestones' },
    { label: '$ Committed Milestones Engaged', value: fmtUsd(kpi.dollarCommitted), link: '/milestones' },
    { label: '# Committed Milestones Engaged', value: kpi.countCommitted.toLocaleString(), link: '/milestones' },
    { label: '% Committed Pipe Engaged vs Total Engaged ($)', value: `${kpi.pctCommittedPipe.toFixed(2)}%`, link: '/milestones' },
    { label: '$ New Milestones Created', value: fmtUsd(kpi.dollarNew), link: '/milestones' },
    { label: '# New Milestones Created', value: kpi.countNew.toLocaleString(), link: '/milestones' },
    { label: '# Hands-on-Keyboard Activity', value: hokPending ? null : (hokFyVal == null ? '—' : hokFyVal.toLocaleString()), link: '/hok-activities?fy=2027', pending: hokPending },
  ];


  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2>Excellence Metrics</h2>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {stats.map((s) => {
          const card = (
            <div className="stat-card" style={s.disabled ? { opacity: 0.72, cursor: 'default' } : undefined}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                {s.icon}
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{s.label}</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {s.pending ? <Spinner size="tiny" /> : (s.value == null ? '—' : s.value)}
              </div>
              {s.sub ? <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{s.sub}</div> : null}
            </div>
          );
          if (!s.link || s.disabled) return <div key={s.label} style={{ flex: 1 }}>{card}</div>;
          return (
            <Link
              key={s.label}
              to={s.link}
              style={{ textDecoration: 'none', color: 'inherit', flex: 1 }}
            >
              {card}
            </Link>
          );
        })}
      </div>

      {/* FY2027 KPI scorecard — mirrors the pasted MSX engagement report */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontWeight: 700 }}>FY2027 KPI Scorecard</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'help' }}
            title={'Engaged = active milestones (not Completed/Cancelled/Lost/Hygiene) in the POC/Pilot or Production categories — a local stand-in for the warehouse Stage 2-3 gate. The corporate report also counts opportunity owner/team membership that is not cached locally, so # Engaged approximates the official figure (# Committed lines up exactly). $ values use the local milestone ACR (msp_monthlyuse) and will not equal the corporate warehouse revenue field. HoK and New Created are windowed to FY2027.'}>
            {scope === 'mine' ? 'My milestones' : scope === 'discover' ? 'Discover mode' : 'Full territory'} · Engaged = active POC/Pilot &amp; Production · HoK &amp; New = FY2027 · $ = local ACR proxy&nbsp;ⓘ
          </span>
        </div>
        <div className="card-body-custom" style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            {kpiTiles.map((t) => {
              const tile = (
                <div style={{ border: '1px solid var(--canvas)', borderRadius: 8, padding: '12px 14px', background: 'var(--surface-3)', height: '100%', boxSizing: 'border-box' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.3, lineHeight: 1.3, minHeight: 30 }}>
                    {t.label}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>
                    {t.pending ? <Spinner size="tiny" /> : (t.value == null ? '—' : t.value)}
                  </div>
                </div>
              );
              if (!t.link) return <div key={t.label}>{tile}</div>;
              return (
                <Link key={t.label} to={t.link} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {tile}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Azure Consumption entry */}
      <Link to="/consumption" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="card" style={{ marginBottom: 24, cursor: 'pointer' }}>
          <div className="card-body-custom" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
            <DataTrendingRegular style={{ fontSize: 28, color: 'var(--accent)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Azure Consumption</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Monthly ACR trends, growers vs decliners, service mix, and per-customer AI opportunity &amp; risk analysis.
              </div>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
              Explore <ArrowRightRegular style={{ fontSize: 16 }} />
            </span>
          </div>
        </div>
      </Link>

      {/* Overdue Comments (bucketed) + Milestones by Status */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ height: '100%', flex: 1 }}>
          <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <WarningRegular style={{ color: overdueCount > 0 ? 'var(--pink)' : 'var(--success-text)' }} />
            Overdue Comments
          </div>
          <div className="card-body-custom" style={{ padding: 24 }}>
            <Link
              to="/milestones?overdue=true&sort=comments&dir=asc"
              style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
            >
              <div style={{ fontSize: 36, fontWeight: 700, color: overdueCount > 0 ? 'var(--pink)' : 'var(--success-text)' }}>{overdueCount}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>milestones with last comment &gt; 30 days ago</div>
            </Link>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {[
                { key: 'd30', label: '30–59 days', days: '30', count: overdueBuckets.d30 },
                { key: 'd60', label: '60–89 days', days: '60', count: overdueBuckets.d60 },
                { key: 'd90', label: '90+ days', days: '90', count: overdueBuckets.d90 },
              ].map(b => (
                <Link
                  key={b.key}
                  to={`/milestones?overdue=true&odays=${b.days}&sort=comments&dir=asc`}
                  style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}
                >
                  <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 6px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: b.count > 0 ? 'var(--pink)' : 'var(--text-secondary)' }}>{b.count}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{b.label}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
        <div className="card" style={{ flex: 2 }}>
          <div className="card-header-custom">Milestones by Status</div>
          <div className="card-body-custom">
            {statusBreakdown && statusBreakdown.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {statusBreakdown.map(s => {
                  const isBlocked = s.status === 'Blocked';
                  return (
                    <Link
                      key={s.status}
                      to={`/milestones?status=${encodeURIComponent(s.status)}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: isBlocked ? 'var(--danger-tint)' : 'var(--surface-2)', borderRadius: 8, cursor: 'pointer' }}>
                        <span style={{ fontSize: 22, fontWeight: 700, color: isBlocked ? 'var(--danger)' : undefined }}>{s.count}</span>
                        <span style={{ fontSize: 13, color: isBlocked ? 'var(--danger)' : 'var(--text-secondary)' }}>{s.status}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No milestones synced yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Customers */}
      <div style={{ display: 'flex', gap: 16 }}>
        <div className="card" style={{ flex: 1 }}>
        <div className="card-header-custom">Customers</div>
        <div className="card-body-custom">
          {topParents && topParents.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>PortCo</th>
                  <th>Opportunities</th>
                  <th>Milestones</th>
                  <th>Overdue</th>
                  <th>HoK</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {topParents.map((tp) => {
                  const crmLink = tp.crm_account_id && crmBaseUrl
                    ? `${crmBaseUrl}/main.aspx?etn=account&id=${tp.crm_account_id}&pagetype=entityrecord` : null;
                  const hokCount = hokByTpid[tp.tpid] || 0;
                  // Opportunities / Milestones / Overdue follow the territory scope:
                  // scoped (mine/discover) values when a personal scope is on, full-territory
                  // SQL values otherwise.
                  const personalScope = scope === 'mine' || scope === 'discover';
                  const oppVal = personalScope ? (myByTpid.opp[tp.tpid] || 0) : tp.opportunity_count;
                  const msVal = personalScope ? (myByTpid.ms[tp.tpid] || 0) : tp.milestone_count;
                  const overdueVal = personalScope ? (myByTpid.overdue[tp.tpid] || 0) : (overdueByTpid[tp.tpid] || 0);
                  return (
                    <tr key={tp.crm_account_id || tp.name}>
                      <td>
                        <Link to={`/customers/${tp.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                          {tp.name}
                        </Link>
                      </td>
                      <td>{tp.portco > 0 ? (
                        <Link to={`/customers/${tp.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                          {tp.portco}
                        </Link>
                      ) : 0}</td>
                      <td>{oppVal > 0 ? (
                        <Link to={`/milestones?tpid=${encodeURIComponent(tp.tpid)}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                          {oppVal}
                        </Link>
                      ) : 0}</td>
                      <td>{msVal > 0 ? (
                        <Link to={`/milestones?tpid=${encodeURIComponent(tp.tpid)}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                          {msVal}
                        </Link>
                      ) : 0}</td>
                      <td style={{ color: overdueVal > 0 ? 'var(--pink)' : undefined, fontWeight: overdueVal > 0 ? 600 : undefined }}>
                        {overdueVal > 0 ? (
                          <Link to={`/milestones?tpid=${encodeURIComponent(tp.tpid)}&overdue=true&sort=comments&dir=asc`} style={{ color: 'var(--pink)', textDecoration: 'none', fontWeight: 600 }}>
                            {overdueVal}
                          </Link>
                        ) : 0}
                      </td>
                      <td style={{ color: hokCount > 0 ? 'var(--success-text)' : undefined, fontWeight: hokCount > 0 ? 600 : undefined }}>
                        {hokPending ? <Spinner size="tiny" /> : hokUnavailable ? '—' : hokCount > 0 ? (
                          <Link to={`/hok-activities?tpid=${encodeURIComponent(tp.tpid)}`} style={{ color: 'var(--success-text)', textDecoration: 'none', fontWeight: 600 }}>
                            {hokCount}
                          </Link>
                        ) : 0}
                      </td>
                      <td>
                        {crmLink && <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={() => openExternal(crmLink)} title="Open in CRM" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p style={{ color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>
              No top parent accounts yet. <Link to="/settings" style={{ color: 'var(--accent)' }}>Sync customers from CRM</Link> to populate this list.
            </p>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
