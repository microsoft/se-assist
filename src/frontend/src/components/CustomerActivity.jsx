import { useState, useMemo, useCallback } from 'react';
import { Spinner } from '@fluentui/react-components';
import {
  MailRegular, CalendarLtrRegular, ChatRegular, OpenRegular, DismissRegular,
  FlagRegular, BoardRegular, PeopleTeamRegular, DataTrendingRegular, ArrowRightRegular,
  PersonRegular, PeopleRegular, ChevronDownRegular, ChevronRightRegular,
} from '@fluentui/react-icons';
import { useNavigate } from 'react-router-dom';
import { useDbQuery } from '../hooks/useDb';
import { openExternal } from '../electronBridge';
import { useTerritory } from '../territoryContext';
import { computeAccountMilestoneMetrics, ACCOUNT_HOK_FY_SQL, FY_START_ISO, FY_END_ISO, FY_LABEL } from '../lib/milestoneMetrics';
import AccountMetricStat from './AccountMetricStat';

// ── Customer Activity ─────────────────────────────────────────────────────────
// One compact card per top-level customer account (TPID) with recent email / meeting /
// Teams-chat counts, grouped by the configured SSP (the "Cloud and AI Specialist" role in
// customer_account_team_roles; accounts with none fall under "SSP Not Set"). Selecting a card
// opens a fast "account glance + triage" popup: identity + SSP/ATS/AE, MSX pipeline counts,
// associated workloads, all-time email/meeting/chat totals, internal/external contact counts,
// links to the full profile / Milestones / Azure Consumption, and the combined color-coded
// recent-activity list (emails blue, meetings green, chats purple). Purely local data; nothing
// here calls an AI model.

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACKS = [7, 14, 30, 90];
const NO_SSP = 'SSP Not Set';

// Per-TPID recent activity counts + resolved top-parent name + configured SSP + all-time last
// contact. The card set is every account with in-window activity OR a configured SSP, so an
// assigned-but-quiet account still appears (its stale last-contact is the point). Bound params in
// order: emails-since, meetings-since, meetings-now, chats-since, last-contact meetings-now.
const CARDS_SQL = `
WITH em AS (
  SELECT l.tpid AS tpid, COUNT(DISTINCT e.message_id) AS n
  FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
  WHERE COALESCE(e.received_at, e.sent_at) >= ?
  GROUP BY l.tpid
),
mt AS (
  SELECT l.tpid AS tpid, COUNT(DISTINCT m.event_id) AS n
  FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
  WHERE m.start_at >= ? AND m.start_at <= ?
  GROUP BY l.tpid
),
ch AS (
  SELECT l.tpid AS tpid, COUNT(DISTINCT msg.chat_id) AS n
  FROM active_teams_chat_messages msg JOIN active_teams_chat_customer_links l ON l.chat_id = msg.chat_id
  WHERE msg.sent_at >= ?
  GROUP BY l.tpid
),
tp AS (
  SELECT tpid,
         MAX(CASE WHEN parenting_level = 861980000 THEN name END) AS top_name,
         MAX(name) AS any_name
  FROM active_customers WHERE tpid IS NOT NULL AND TRIM(tpid) <> '' GROUP BY tpid
),
ssp AS (
  SELECT tpid, person_name FROM active_customer_account_team_roles
  WHERE role = 'Cloud and AI Specialist' AND person_name IS NOT NULL AND TRIM(person_name) <> ''
),
lc AS (
  SELECT tpid, MAX(ts) AS last_ts FROM (
    SELECT l.tpid AS tpid, COALESCE(e.received_at, e.sent_at) AS ts
    FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
    UNION ALL
    SELECT l.tpid, m.start_at
    FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
    WHERE m.start_at <= ?
    UNION ALL
    SELECT l.tpid, msg.sent_at
    FROM active_teams_chat_messages msg JOIN active_teams_chat_customer_links l ON l.chat_id = msg.chat_id
  ) GROUP BY tpid
),
ids AS (
  SELECT tpid FROM em
  UNION SELECT tpid FROM mt
  UNION SELECT tpid FROM ch
  UNION SELECT tpid FROM ssp
)
SELECT i.tpid,
       COALESCE(tp.top_name, tp.any_name, 'Unknown account') AS name,
       COALESCE(em.n, 0) AS emails, COALESCE(mt.n, 0) AS meetings, COALESCE(ch.n, 0) AS chats,
       ssp.person_name AS ssp_name, lc.last_ts AS last_contact
FROM ids i
LEFT JOIN tp ON tp.tpid = i.tpid
LEFT JOIN em ON em.tpid = i.tpid
LEFT JOIN mt ON mt.tpid = i.tpid
LEFT JOIN ch ON ch.tpid = i.tpid
LEFT JOIN ssp ON ssp.tpid = i.tpid
LEFT JOIN lc ON lc.tpid = i.tpid
WHERE i.tpid IS NOT NULL AND TRIM(i.tpid) <> ''
ORDER BY name`;

// Combined recent activity for one account: emails (per message), meetings (per event), Teams
// chats (per thread). `tpid` + `since` are bound once per source (6 params, in source order).
const ACTIVITY_SQL = `
SELECT 'email' AS kind, e.message_id AS native_id,
       COALESCE(NULLIF(TRIM(e.subject), ''), '(no subject)') AS title,
       e.from_name AS who, COALESCE(e.received_at, e.sent_at) AS ts, e.web_link AS web_link
FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
WHERE l.tpid = ? AND COALESCE(e.received_at, e.sent_at) >= ?
UNION ALL
SELECT 'meeting' AS kind, m.event_id AS native_id,
       COALESCE(NULLIF(TRIM(m.subject), ''), '(no subject)') AS title,
       m.organizer_name AS who, m.start_at AS ts, m.web_link AS web_link
FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
WHERE l.tpid = ? AND m.start_at >= ? AND m.start_at <= ?
UNION ALL
SELECT 'chat' AS kind, tc.chat_id AS native_id,
       COALESCE(NULLIF(TRIM(tc.topic), ''), 'Teams chat') AS title,
       (SELECT m2.sender_name FROM active_teams_chat_messages m2 WHERE m2.chat_id = tc.chat_id
         ORDER BY m2.sent_at DESC LIMIT 1) AS who,
       MAX(msg.sent_at) AS ts, NULL AS web_link
FROM active_teams_chats tc
JOIN active_teams_chat_customer_links l ON l.chat_id = tc.chat_id
JOIN active_teams_chat_messages msg ON msg.chat_id = tc.chat_id
WHERE l.tpid = ? AND msg.sent_at >= ?
GROUP BY tc.chat_id
ORDER BY ts DESC`;

// Workloads that belong to this customer (primary account OR via a milestone link).
const WORKLOADS_SQL = `
SELECT id, COALESCE(NULLIF(TRIM(title), ''), name) AS name, status
FROM active_workloads
WHERE customer_tpid = ? OR tpid = ?
   OR id IN (SELECT workload_id FROM active_workload_milestone_links WHERE customer_tpid = ?)
ORDER BY sort_order, id`;

// Top-parent customer row for a TPID — its id drives the "Open full profile" link and its
// segment is shown in the glance header. Prefers the Dynamics top parent, then a CRM-backed row.
const PROFILE_SQL = `
SELECT id, industry_segment
FROM active_customers
WHERE tpid = ?
ORDER BY (parenting_level = 861980000) DESC, (crm_account_id IS NOT NULL) DESC, id
LIMIT 1`;

// The account's key role assignments (SSP / ATS / AE) from the curated account-team roster.
const ROLES_SQL = `
SELECT role, person_name, person_email FROM active_customer_account_team_roles
WHERE tpid = ? AND role IN ('Cloud and AI Specialist','Account Technology Strategist','Account Executive')`;

// Account opportunity + milestone rows for the refined "your active + uncommitted" pipeline
// metrics (computed in JS since deal-team membership lives in JSON). Matched by the account's
// CRM ids or name, mirroring the profile page.
const OPP_ROWS_SQL = `
WITH acct AS (SELECT crm_account_id, name FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL)
SELECT o.opportunity_id, o.state_code
FROM active_opportunities o
WHERE o.parent_account_id IN (SELECT crm_account_id FROM acct) OR o.customer_name IN (SELECT name FROM acct)`;

const MS_ROWS_SQL = `
WITH acct AS (SELECT crm_account_id, name FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL)
SELECT m.milestone_id, m.opportunity_id, m.deal_team_json, m.owner_name, m.status_label,
       m.milestone_status, m.commitment_recommendation, m.comments_json
FROM active_milestones m LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
WHERE o.parent_account_id IN (SELECT crm_account_id FROM acct) OR o.customer_name IN (SELECT name FROM acct)`;

// All-time association totals for the glance: distinct emails / meetings / Teams chats linked to
// the account (excluding AI-rejected links), plus internal (Microsoft) and external (customer)
// contact counts from the derived account-team graph. One tpid bound five times, in order.
const TOTALS_SQL = `
SELECT
  (SELECT COUNT(DISTINCT e.message_id) FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected') AS emails,
  (SELECT COUNT(DISTINCT m.event_id) FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected') AS meetings,
  (SELECT COUNT(DISTINCT tc.chat_id) FROM active_teams_chats tc JOIN active_teams_chat_customer_links l ON l.chat_id = tc.chat_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected') AS chats,
  (SELECT COUNT(*) FROM active_customer_account_team WHERE tpid = ? AND org = 'microsoft') AS internal_contacts,
  (SELECT COUNT(*) FROM active_customer_account_team WHERE tpid = ? AND org = 'customer') AS external_contacts`;

const KIND_META = {
  email: { label: 'Emails', icon: MailRegular },
  meeting: { label: 'Meetings', icon: CalendarLtrRegular },
  chat: { label: 'Chats', icon: ChatRegular },
};

function parseTs(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function relTime(iso) {
  const t = parseTs(iso);
  if (!t) return '—';
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

// Supported OWA deep link rebuilt from the Graph message id (the ingested web_link uses the
// retired classic OWA form). The id itself is the OWA ItemID.
function outlookDeeplink(messageId) {
  const raw = String(messageId || '').trim();
  if (!raw) return null;
  const id = encodeURIComponent(raw);
  return `https://outlook.office.com/mail/deeplink/read/${id}?ItemID=${id}&exvsurl=1`;
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Whole days since a timestamp (null when there is none). Drives the card's "last contact"
// health line — an account contacted more than 14 days ago (or never) is flagged stale.
const STALE_DAYS = 14;
function daysSince(iso) {
  const t = parseTs(iso);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

export default function CustomerActivity() {
  const [lookbackDays, setLookbackDays] = useState(30);
  const sinceIso = useMemo(
    () => new Date(Date.now() - lookbackDays * DAY_MS).toISOString(),
    [lookbackDays],
  );
  // Upper bound for meetings: exclude far-future recurring placeholders so counts reflect real
  // recent activity (emails/chats are inherently past). Recomputed per render is fine — it only
  // affects the meeting window edge and keeps queries stable within a session tick.
  const nowIso = useMemo(() => new Date().toISOString(), [lookbackDays]);

  const { data: cards, initialLoading, error } = useDbQuery(
    CARDS_SQL, [sinceIso, sinceIso, nowIso, sinceIso, nowIso], [sinceIso],
  );

  const [selected, setSelected] = useState(null); // { tpid, name } | null

  // Group cards by configured SSP; a dedicated "SSP Not Set" group sorts last.
  const groups = useMemo(() => {
    const bySsp = new Map();
    for (const c of cards || []) {
      const key = c.ssp_name && c.ssp_name.trim() ? c.ssp_name.trim() : NO_SSP;
      if (!bySsp.has(key)) bySsp.set(key, []);
      bySsp.get(key).push(c);
    }
    const named = [...bySsp.keys()].filter((k) => k !== NO_SSP).sort((a, b) => a.localeCompare(b));
    const ordered = bySsp.has(NO_SSP) ? [...named, NO_SSP] : named;
    return ordered.map((ssp) => ({
      ssp,
      cards: bySsp.get(ssp).slice().sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [cards]);

  const selectCard = useCallback((card) => {
    setSelected({ tpid: String(card.tpid), name: card.name, ssp: card.ssp_name || '' });
  }, []);

  return (
    <div className="ca-page">
      <div className="page-header">
        <div className="page-header-left">
          <h2>Customer Activity</h2>
          <p className="ca-intro">
            Recent emails, meetings, and Teams chats per account, grouped by SSP. Open an account for
            a fast glance — its pipeline, team, workloads, contacts, and recent activity.
          </p>
        </div>
        <div className="ca-lookback">
          <label>
            Last
            <select value={lookbackDays} onChange={(e) => setLookbackDays(Number(e.target.value))}>
              {LOOKBACKS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
      </div>

      {error ? <div className="alert-error">{String(error)}</div> : null}

      {selected ? (
        <AccountGlanceModal
          selected={selected}
          lookbackDays={lookbackDays}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {initialLoading ? (
        <div className="ca-empty"><Spinner size="small" /> Loading customer activity…</div>
      ) : groups.length ? (
        <div className="ca-groups">
          {groups.map((group) => (
            <section key={group.ssp} className="ca-ssp-group">
              <div className="ca-ssp-head">
                <h3>{group.ssp}</h3>
                <span className="ca-ssp-count">{group.cards.length} account{group.cards.length === 1 ? '' : 's'}</span>
              </div>
              <div className="ca-grid">
                {group.cards.map((card) => (
                  <button
                    key={card.tpid}
                    type="button"
                    className={`ca-card${selected?.tpid === String(card.tpid) ? ' selected' : ''}`}
                    onClick={() => selectCard(card)}
                  >
                    <span className="ca-avatar">{initials(card.name)}</span>
                    <span className="ca-card-body">
                      <span className="ca-card-name" title={card.name}>{card.name}</span>
                      <span className="ca-card-counts">
                        <span className="ca-count email">{card.emails} emails</span>
                        <span className="ca-count meeting">{card.meetings} meetings</span>
                        <span className="ca-count chat">{card.chats} chats</span>
                      </span>
                      {(() => {
                        const d = daysSince(card.last_contact);
                        const stale = d == null || d > STALE_DAYS;
                        const text = d == null
                          ? 'No recent contact'
                          : d === 0 ? 'Last contact today' : `Last contact ${d} day${d === 1 ? '' : 's'} ago`;
                        return <span className={`ca-card-contact${stale ? ' stale' : ''}`}>{text}</span>;
                      })()}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="ca-empty card">
          No customer activity in the last {lookbackDays} days. Run an M365 ingest (Settings) to populate emails, meetings, and Teams chats.
        </div>
      )}
    </div>
  );
}

// ── Account glance + triage popup ────────────────────────────────────────────
// Self-contained launcher: given `selected` ({ tpid, name, ssp? }) it computes a default
// activity window and its own navigate, then renders the glance overlay. This is the reusable
// entry point for every surface (Customer Activity cards, Action Center, SSP Configuration,
// milestone account rows) — pass a `selected` and an `onClose`; render nothing when null.
export function AccountGlanceModal({ selected, onClose, lookbackDays = 30 }) {
  const navigate = useNavigate();
  const sinceIso = useMemo(() => new Date(Date.now() - lookbackDays * DAY_MS).toISOString(), [lookbackDays]);
  const nowIso = useMemo(() => new Date().toISOString(), []);
  if (!selected) return null;
  return (
    <CustomerGlanceModal
      selected={selected}
      sinceIso={sinceIso}
      nowIso={nowIso}
      lookbackDays={lookbackDays}
      navigate={navigate}
      onClose={onClose}
    />
  );
}

// Fast, read-only overlay for one account: identity + SSP/ATS/AE, MSX pipeline counts,
// associated workloads, all-time email/meeting/chat + internal/external contact totals, links to
// the full profile / Milestones / Azure Consumption, and the combined recent-activity list. All
// data is local; queries live here (not the parent) so they only run while the popup is open.
export function CustomerGlanceModal({ selected, sinceIso, nowIso, lookbackDays, navigate, onClose }) {
  const tpid = String(selected.tpid || '');
  const [visibleKinds, setVisibleKinds] = useState(new Set(['email', 'meeting', 'chat']));
  const [activityOpen, setActivityOpen] = useState(false); // recent-activity list collapsed by default
  const [teamsChatError, setTeamsChatError] = useState('');
  const { currentUserName, setScope } = useTerritory();

  const { data: activity, initialLoading: activityLoading } = useDbQuery(
    ACTIVITY_SQL, [tpid, sinceIso, tpid, sinceIso, nowIso, tpid, sinceIso], [tpid, sinceIso],
  );
  const { data: workloadRows } = useDbQuery(WORKLOADS_SQL, [tpid, tpid, tpid], [tpid]);
  const { data: profileRows } = useDbQuery(PROFILE_SQL, [tpid], [tpid]);
  const { data: roleRows } = useDbQuery(ROLES_SQL, [tpid], [tpid]);
  const { data: oppRows } = useDbQuery(OPP_ROWS_SQL, [tpid], [tpid]);
  const { data: msRows } = useDbQuery(MS_ROWS_SQL, [tpid], [tpid]);
  const { data: hokRows } = useDbQuery(ACCOUNT_HOK_FY_SQL, [tpid, FY_START_ISO, FY_END_ISO], [tpid]);
  const { data: totalsRows } = useDbQuery(TOTALS_SQL, [tpid, tpid, tpid, tpid, tpid], [tpid]);

  const profile = profileRows?.[0] || null;
  const totals = totalsRows?.[0] || {};
  const workloads = workloadRows || [];
  // Refined pipeline metrics: your active + uncommitted opportunities/milestones vs. totals.
  const acctMetrics = useMemo(
    () => computeAccountMilestoneMetrics({ opportunities: oppRows || [], milestones: msRows || [], currentUserName }),
    [oppRows, msRows, currentUserName],
  );
  const hok = hokRows?.[0] || {};

  // Role name per slot (SSP / ATS / AE), from the curated roster.
  const roleName = useCallback((role) => {
    const hit = (roleRows || []).find((r) => r.role === role);
    return (hit && hit.person_name && hit.person_name.trim()) || '—';
  }, [roleRows]);

  // Role name + a "Message in Teams" launcher for that person (shown only when we have their
  // email, via the same Teams deep link the rest of the app uses).
  const roleCell = useCallback((role) => {
    const hit = (roleRows || []).find((r) => r.role === role);
    const name = (hit && hit.person_name && hit.person_name.trim()) || '—';
    const email = hit && hit.person_email && String(hit.person_email).trim();
    return (
      <span className="ca-role-cell">
        <span>{name}</span>
        {email ? (
          <button
            type="button"
            className="mtg-inline-btn teams-chat-btn ca-role-teams"
            title={`Message ${name} in Teams`}
            onClick={async () => {
              setTeamsChatError('');
              try {
                const accountName = String(selected.name || '').trim();
                if (!accountName) throw new Error('Cannot prepare the Teams draft: this account has no name. Sync from CRM and try again.');
                const first = String(hit.person_name || '').trim().split(/\s+/)[0];
                if (!first) throw new Error('Cannot prepare the Teams draft: this contact has no saved name. Update the account team and try again.');
                const message = `Hi ${first}, can we talk about ${accountName}?`;
                await openExternal(`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}&message=${encodeURIComponent(message)}`);
              } catch (err) {
                setTeamsChatError(err?.message || String(err));
              }
            }}
          >
            <ChatRegular /> Message in Teams
          </button>
        ) : null}
      </span>
    );
  }, [roleRows, selected.name]);

  const visibleActivity = useMemo(
    () => (activity || []).filter((a) => visibleKinds.has(a.kind)),
    [activity, visibleKinds],
  );
  function toggleKind(kind) {
    setVisibleKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }
  const linkFor = (item) => (item.kind === 'email'
    ? outlookDeeplink(item.native_id)
    : (item.web_link || null));

  const go = (path) => { onClose(); navigate(path); };
  // Navigate to a page scoped to "My Milestones" — used by the pipeline stat panels so the
  // destination's my/discover/all territory filter matches the metric you clicked.
  const goMine = (path) => { setScope('mine'); go(path); };
  const profileLink = profile?.id != null ? `/customers/${profile.id}` : null;
  const milestonesLink = `/milestones?tpid=${encodeURIComponent(tpid)}`;
  const consumptionLink = `/consumption/${encodeURIComponent(tpid)}`;

  return (
    <div className="ca-modal-backdrop" onMouseDown={onClose}>
      <div className="ca-modal" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header: identity + SSP + primary actions */}
        <div className="ca-modal-head">
          <span className="ca-avatar ca-avatar-lg">{initials(selected.name)}</span>
          <div className="ca-modal-head-main">
            <div className="ca-modal-title" title={selected.name}>{selected.name}</div>
            <div className="ca-modal-sub">
              <span className="badge badge-secondary">TPID {tpid}</span>
              {profile?.industry_segment ? <span>{profile.industry_segment}</span> : null}
              <span>SSP · {roleName('Cloud and AI Specialist')}</span>
            </div>
          </div>
          <div className="ca-modal-head-actions">
            {profileLink ? (
              <button type="button" className="btn btn-primary ca-sm" onClick={() => go(profileLink)}>
                Open full profile <ArrowRightRegular />
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary ca-sm" onClick={() => go(milestonesLink)} title="Open this account in Milestones">
              <FlagRegular /> Milestones
            </button>
            <button type="button" className="ca-panel-close" title="Close" onClick={onClose}><DismissRegular /></button>
          </div>
        </div>

        <div className="ca-modal-body">
          {/* MSX pipeline stat row: your active + uncommitted pipeline (with account totals).
              Panels open the matching page scoped to My Milestones. */}
          <div className="ca-stat-row">
            <AccountMetricStat
              label="Active Opportunities"
              primary={acctMetrics.oppsActive}
              total={acctMetrics.oppsTotal}
              onClick={() => goMine(milestonesLink)}
              hint="Your active, uncommitted opportunities · open in Milestones (My Milestones)"
            />
            <AccountMetricStat
              label="Active Milestones"
              primary={acctMetrics.msActive}
              total={acctMetrics.msTotal}
              onClick={() => goMine(milestonesLink)}
              hint="Your active, uncommitted milestones · open in Milestones (My Milestones)"
            />
            <AccountMetricStat
              label={`HoK Activities ${FY_LABEL}`}
              primary={Number(hok.hok_fy) || 0}
              total={Number(hok.hok_total) || 0}
              onClick={() => goMine(`/hok-activities?tpid=${encodeURIComponent(tpid)}`)}
              hint={`HoK activities created in ${FY_LABEL} · open in HoK Activities (My Milestones)`}
            />
          </div>

          {/* Team strip + at-a-glance totals */}
          <div className="ca-modal-cols">
            <div className="ca-modal-block">
              <div className="ca-modal-block-head"><PeopleTeamRegular /> Account team</div>
              <dl className="ca-team-facts">
                <div><dt>SSP</dt><dd>{roleCell('Cloud and AI Specialist')}</dd></div>
                <div><dt>ATS</dt><dd>{roleCell('Account Technology Strategist')}</dd></div>
                <div><dt>AE</dt><dd>{roleCell('Account Executive')}</dd></div>
              </dl>
              {teamsChatError && (
                <div className="flash-message flash-error" role="alert">{teamsChatError}</div>
              )}
            </div>
            <div className="ca-modal-block">
              <div className="ca-modal-block-head">Associated signal (all time)</div>
              <div className="ca-totals">
                <span className="ca-total email"><MailRegular /> {Number(totals.emails) || 0} emails</span>
                <span className="ca-total meeting"><CalendarLtrRegular /> {Number(totals.meetings) || 0} meetings</span>
                <span className="ca-total chat"><ChatRegular /> {Number(totals.chats) || 0} chats</span>
                <span className="ca-total"><PersonRegular /> {Number(totals.internal_contacts) || 0} internal</span>
                <span className="ca-total"><PeopleRegular /> {Number(totals.external_contacts) || 0} external</span>
              </div>
              <button type="button" className="ca-inline-link" onClick={() => go(consumptionLink)}>
                <DataTrendingRegular /> View Azure Consumption (ACR) <ArrowRightRegular />
              </button>
            </div>
          </div>

          {/* Associated workloads */}
          <div className="ca-modal-block">
            <div className="ca-modal-block-head"><BoardRegular /> Workloads <span className="ca-count-n">{workloads.length}</span></div>
            {workloads.length ? (
              <div className="ca-wl-chips">
                {workloads.map((w) => (
                  <span key={w.id} className={`ca-wl-pill${w.status && w.status !== 'active' ? ' inactive' : ''}`} title={`Workload #${w.id}${w.status ? ` · ${w.status}` : ''}`}>
                    {w.name} <span className="ca-wl-id">#{w.id}</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="ca-modal-empty">No workloads for this account yet.</p>
            )}
          </div>

          {/* Recent activity (the anchor) — collapsed by default; the per-type counts stay
              visible so you can see volume at a glance, expand to see the items. */}
          <div className="ca-modal-block">
            <div
              className="ca-modal-block-head ca-collapse-head"
              role="button"
              tabIndex={0}
              aria-expanded={activityOpen}
              onClick={() => setActivityOpen((o) => !o)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActivityOpen((o) => !o); } }}
            >
              <span className="ca-collapse-caret" aria-hidden="true">{activityOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
              Recent activity <span className="ca-count-n">{(activity || []).length}</span>
              <span className="ca-modal-block-sub">last {lookbackDays} days</span>
            </div>
            <div className="ca-legend">
              {['email', 'meeting', 'chat'].map((kind) => {
                const Meta = KIND_META[kind];
                const Icon = Meta.icon;
                const count = (activity || []).filter((a) => a.kind === kind).length;
                const on = visibleKinds.has(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`ca-legend-chip ${kind}${on ? ' on' : ''}`}
                    onClick={() => { setActivityOpen(true); toggleKind(kind); }}
                    aria-pressed={on}
                    title={activityOpen ? `Toggle ${Meta.label.toLowerCase()}` : `Show ${Meta.label.toLowerCase()}`}
                  >
                    <Icon /> {Meta.label} <span className="ca-count-n">{count}</span>
                  </button>
                );
              })}
            </div>
            {activityOpen ? (
              activityLoading ? (
                <div className="ca-empty"><Spinner size="tiny" /> Loading activity…</div>
              ) : visibleActivity.length ? (
                <ul className="ca-list">
                  {visibleActivity.map((item) => {
                    const key = `${item.kind}:${item.native_id}`;
                    const Icon = KIND_META[item.kind].icon;
                    const link = linkFor(item);
                    return (
                      <li key={key} className={`ca-item ${item.kind}`}>
                        <Icon className="ca-item-icon" />
                        <span className="ca-item-main">
                          <span className="ca-item-title">{item.title}</span>
                          <span className="ca-item-sub">
                            {[item.who, relTime(item.ts)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {link ? (
                          <button type="button" className="ca-item-open" title="Open" onClick={() => openExternal(link)}>
                            <OpenRegular />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="ca-empty ca-muted">
                  {(activity || []).length ? 'No items match the selected types.' : 'No activity for this account in the selected window.'}
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
