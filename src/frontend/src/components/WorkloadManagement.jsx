import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AddRegular, CalendarLtrRegular, ChatRegular, CheckmarkCircleRegular,
  ChevronDownRegular, ChevronRightRegular, DeleteRegular, FlagRegular,
  LinkRegular, MailRegular, SparkleRegular, DismissCircleRegular, ArrowClockwiseRegular,
} from '@fluentui/react-icons';
import { Spinner } from '@fluentui/react-components';
import {
  dbQuery,
  findMilestoneSignal,
  getMsxSettings,
  listSignals,
  modelProviderStatus,
  openExternal,
  suggestMilestoneComment,
  suggestMilestoneHokActivity,
  suggestWorkloads,
  workloadApproveSuggestion,
  workloadCreate,
  workloadDiscover,
  workloadSignalList,
  workloadSignalAssign,
  workloadSignalUpdate,
  workloadSignalUnlink,
} from '../electronBridge';
import { runDb, useDbQuery } from '../hooks/useDb';
import { useTeamApi } from '../hooks/useTeamApi';
import { workloadSignalIdentity } from '../lib/workloadSignals';
import { SSP_ROLES_SQL } from '../lib/milestoneMetrics';
import {
  MILESTONE_AI_STEPS, MILESTONE_AI_FULL_KEYS, makeStepList, setStep,
  firstFailedStepIndex, stepsHaveFailure, MilestoneAiWorkflowPopup,
} from '../lib/milestoneAiWorkflow';
import { DetailCard, FilterDropdown, TASK_CATEGORIES } from './Milestones';

const WORKLOADS_SQL = `
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
  ORDER BY w.sort_order, w.id`;

const MILESTONES_SQL = `
  SELECT m.milestone_id, m.name, m.milestone_date, m.status_label, m.opportunity_id,
         m.owner_name AS milestone_owner,
         o.name AS opportunity_name, o.owner_name AS ssp_name,
         cu.tpid AS customer_tpid, cu.name AS customer_name
  FROM active_milestones m
  LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
  LEFT JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
  ORDER BY COALESCE(m.milestone_date, '9999-12-31'), m.name`;

const OPPORTUNITIES_SQL = `
  SELECT o.opportunity_id, o.name, o.owner_name AS ssp_name,
         cu.tpid AS customer_tpid, cu.name AS customer_name
  FROM active_opportunities o
  LEFT JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
  WHERE o.state_code = 0 OR o.state_code IS NULL
  ORDER BY cu.name, o.name`;

const SUGGESTIONS_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM active_workload_suggestion_opportunities o
       WHERE o.suggestion_id = s.id AND o.included = 1) AS opportunity_count,
    (SELECT COUNT(*) FROM active_workload_suggestion_milestones m
       WHERE m.suggestion_id = s.id AND m.included = 1) AS milestone_count
  FROM active_workload_suggestions s
  WHERE s.status = 'suggested'
  ORDER BY s.created_at DESC, s.id DESC`;

const SUGGESTION_OPPORTUNITIES_SQL = `
  SELECT o.opportunity_id, o.name, o.owner_name AS ssp_name
  FROM active_opportunities o
  JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
  WHERE cu.tpid = ? AND (o.state_code = 0 OR o.state_code IS NULL)
  ORDER BY o.name`;

const SUGGESTION_MILESTONES_SQL = `
  SELECT m.milestone_id, m.name, m.status_label, m.opportunity_id, m.milestone_date
  FROM active_milestones m
  JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
  JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
  WHERE cu.tpid = ?
  ORDER BY COALESCE(m.milestone_date, '9999-12-31'), m.name`;

// Top-parent account name per TPID (parenting_level 861980000 is the Dynamics "top parent"),
// falling back to any name for the TPID. Used so the New-workload account dropdown labels each
// account with its PARENT account, never a child account under the same TPID.
const PARENT_ACCOUNTS_SQL = `
  SELECT tpid,
         MAX(CASE WHEN parenting_level = 861980000 THEN name END) AS top_name,
         MAX(name) AS any_name
  FROM active_customers
  WHERE tpid IS NOT NULL AND TRIM(tpid) <> ''
  GROUP BY tpid`;

// Per-milestone signal counts (emails / meetings / chats) from the canonical links store. These
// are the SAME rows the milestone detail popup's "Related signals" lists, so the counts match.
// One row per (milestone, signal_type); the caller pivots into { email, meeting, chat }.
const MS_SIGNAL_COUNTS_SQL = `
  SELECT target_id AS milestone_id, signal_type, COUNT(*) AS n
  FROM active_signal_links
  WHERE target_type = 'milestone'
  GROUP BY target_id, signal_type`;

// Workload "Category" options — reuse the MSX task-category LABELS (TASK_CATEGORIES) so the
// workload bucket stays consistent with the HoK activity categories. Stored as free text in
// workloads.category (a local, non-CRM column), so we keep just the label string. Derived from
// the single TASK_CATEGORIES source, so trimming that list trims this dropdown too.
const CATEGORIES = TASK_CATEGORIES.map((c) => c.label);

function jsonList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function jsonObj(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Read a comms count from a suggestion's source_json defensively. New drafts store arrays under
// `emails`/`meetings`/`chats` plus true totals under `counts`; legacy drafts stored bare numbers.
function sourceCount(source, key) {
  const counts = source && typeof source.counts === 'object' ? source.counts : null;
  if (counts && Number.isFinite(Number(counts[key]))) return Number(counts[key]);
  const value = source ? source[key] : null;
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(Number(value))) return Number(value);
  return 0;
}

// A missing model provider is a hard, batch-wide stop (nothing is configured), not a per-milestone
// hiccup — detect it so the batch aborts loudly instead of repeating the same error N times.
function isProviderError(message) {
  return /No AI model provider|model provider is configured/i.test(String(message || ''));
}
class ProviderAbort extends Error {}

// ── Milestone AI pipeline (batch-specific glue over the shared workflow model) ──
// Ordered step keys for a run mode: 'full' = the whole pipeline; 'find' = signal-gathering only.
function milestoneAiStepKeys(mode) {
  return mode === 'find' ? ['find'] : MILESTONE_AI_FULL_KEYS;
}
// Recompute the panel-facing error fields (errors[]/commentError/hokError) from step statuses, so
// the inline drafts panel (BatchDraftsPanel) and the workflow popup never drift. Informational
// empties ("no signal linked") are NOT failures — they live in comment.note / item.hokNote with the
// step marked ok, and only surface muted in the panel.
function syncStepErrors(item) {
  const by = Object.fromEntries((item.steps || []).map((s) => [s.key, s]));
  const errors = [];
  for (const key of ['dealTeam', 'find']) {
    const s = by[key];
    if (s && s.status === 'failed') errors.push(`${MILESTONE_AI_STEPS[key].label}: ${s.error}`);
  }
  const commentError = by.comment && by.comment.status === 'failed' ? by.comment.error : '';
  const hokFailed = by.hok && by.hok.status === 'failed' ? by.hok.error : '';
  return { ...item, errors, commentError, hokError: hokFailed || item.hokNote || '' };
}
function itemHasFailure(item) {
  return stepsHaveFailure(item.steps);
}


// Items to render for a comms type: only present when a draft carries the enriched (array) shape.
function sourceItems(source, key) {
  const value = source ? source[key] : null;
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function formatSourceDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

// Resolve a workload's customer account name(s) to the TPID's top-parent account (never a child).
// Workloads carry customer_tpid + linked_customer_tpids; we relabel those through the parent-name
// map so cards, the filter dropdown, and its matching all agree on the parent account. Falls back
// to the stored snapshot names only when a tpid has no resolved parent (older/org data).
function workloadCustomerNames(workload, parentNameByTpid) {
  const tpids = unique(
    [workload.customer_tpid, ...jsonList(workload.linked_customer_tpids)]
      .map((t) => (t == null ? '' : String(t).trim()))
      .filter(Boolean),
  );
  const names = tpids.map((t) => parentNameByTpid.get(t)).filter(Boolean);
  return names.length ? unique(names) : unique([workload.customer_name, ...jsonList(workload.linked_customer_names)]);
}

function Pill({ children, tone = '' }) {
  return <span className={`wl-tag${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

// Pivot MS_SIGNAL_COUNTS_SQL rows into a Map<milestone_id, { email, meeting, chat }>.
export function buildSignalCountMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const id = String(r.milestone_id || '');
    if (!id) continue;
    const cur = map.get(id) || { email: 0, meeting: 0, chat: 0 };
    if (r.signal_type === 'email') cur.email = Number(r.n) || 0;
    else if (r.signal_type === 'meeting') cur.meeting = Number(r.n) || 0;
    else if (r.signal_type === 'chat') cur.chat = Number(r.n) || 0;
    map.set(id, cur);
  }
  return map;
}

// Compact email / meeting / chat signal counts for a milestone — the same three linked-item
// tallies shown in the milestone detail popup's "Related signals". Zero-count kinds are dimmed
// (shown, not hidden, so the row layout stays stable and "0 emails" reads honestly).
export function SignalCounts({ counts }) {
  const c = counts || { email: 0, meeting: 0, chat: 0 };
  const groups = [
    { key: 'email', n: c.email, Icon: MailRegular, label: 'linked emails' },
    { key: 'meeting', n: c.meeting, Icon: CalendarLtrRegular, label: 'linked meetings' },
    { key: 'chat', n: c.chat, Icon: ChatRegular, label: 'linked Teams chats' },
  ];
  return (
    <span className="wl-sigcounts" onClick={(e) => e.stopPropagation()}>
      {groups.map(({ key, n, Icon, label }) => (
        <span key={key} className={`wl-sigcount${n ? '' : ' is-zero'}`} title={`${n} ${label}`}>
          <Icon /> {n}
        </span>
      ))}
    </span>
  );
}

// Group workload milestone-link rows by their opportunity. Returns an array of
// { opportunityId, opportunityName, items }. Order follows first appearance so the list is stable.
export function groupLinksByOpportunity(links) {
  const groups = [];
  const byKey = new Map();
  for (const l of links || []) {
    const key = l.opportunity_id || l.opportunity_name || '__none__';
    let g = byKey.get(key);
    if (!g) {
      g = { opportunityId: l.opportunity_id || null, opportunityName: l.opportunity_name || '', items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(l);
  }
  return groups;
}

// Shared milestone list for a workload: milestone rows (name + customer, signal counts, clickable
// to open the milestone detail popup), grouped under an opportunity header ONLY when the workload
// spans more than one opportunity. `onOpenMilestone(id)` opens the shared milestone DetailCard;
// `renderTrailing(link)` optionally adds a per-row control (e.g. unlink) on the right.
export function MilestoneLinkList({ links, countsByMs, onOpenMilestone, renderTrailing }) {
  const groups = groupLinksByOpportunity(links);
  const multiOpp = groups.length > 1;
  const row = (link) => (
    <li key={link.id ?? link.milestone_id}>
      <FlagRegular className="wl-li-icon" />
      <button
        type="button"
        className="wl-li-main wl-li-open"
        onClick={() => onOpenMilestone?.(link.milestone_id)}
        title={`View ${link.milestone_name} details, related signals, comments, and activities`}
      >
        <span className="wl-li-title">{link.milestone_name}</span>
        <span className="wl-li-sub">
          {link.customer_name || 'Unknown customer'}
          {!multiOpp && link.opportunity_name ? ` · ${link.opportunity_name}` : ''}
        </span>
      </button>
      <SignalCounts counts={countsByMs?.get?.(String(link.milestone_id))} />
      {renderTrailing ? renderTrailing(link) : null}
    </li>
  );
  if (!multiOpp) {
    return <ul className="wl-linklist">{(links || []).map(row)}</ul>;
  }
  return (
    <div className="wl-ms-oppgroups">
      {groups.map((g) => (
        <div className="wl-ms-oppgroup" key={g.opportunityId || g.opportunityName || 'none'}>
          <div className="wl-ms-oppgroup-head" title={g.opportunityName || 'No opportunity'}>
            <FlagRegular /> {g.opportunityName || 'No opportunity'}
            <span className="wl-count">({g.items.length})</span>
          </div>
          <ul className="wl-linklist">{g.items.map(row)}</ul>
        </div>
      ))}
    </div>
  );
}

// Milestone-AI drafts review (per workload) — Find signal → Comment AI → HoK AI results, each
// editable/submittable. Driven entirely by `batchApi` so it can render inside the workload popup.
// Deleting a draft only discards it locally (no persistence), matching the app's pattern.
export function BatchDraftsPanel({ batchApi }) {
  const { results, running, progress, error, mode } = batchApi;
  const findMode = mode === 'find';
  const failureCount = results.reduce((n, it) => n + ((it.steps || []).some((s) => s.status === 'failed') ? 1 : 0), 0);
  return (
    <div className="wl-batch-inline">
      {running && progress ? (
        <div className="wl-batch-progress">
          <Spinner size="tiny" /> Processing {Math.min(progress.done + 1, progress.total)} of {progress.total}
          {progress.label ? ` — ${progress.label}` : ''}…
        </div>
      ) : null}
      {!running && failureCount > 0 && batchApi.openWorkflow ? (
        <button type="button" className="wl-batch-reopen" onClick={batchApi.openWorkflow}>
          <DismissCircleRegular /> {failureCount} milestone{failureCount === 1 ? '' : 's'} had a failed step — view workflow to retry
        </button>
      ) : null}
      {error ? <div className="alert-error">{error}</div> : null}
      {!running && !results.length && !error ? (
        <p className="wl-muted">No drafts yet — run Milestone AI to link related communications and generate comment and HoK activity suggestions.</p>
      ) : null}
      <div className="wl-batch-list">
        {results.map((item) => (
          <div key={item.milestoneId} className="wl-batch-item">
            <div className="wl-batch-item-head">
              <strong>{item.milestoneName}</strong>
              <span className="wl-muted"> · {item.workloadName}{item.customerName ? ` · ${item.customerName}` : ''}</span>
              <span className="wl-batch-sig">{item.signalCount} signal{item.signalCount === 1 ? '' : 's'}</span>
            </div>
            {item.errors.map((err, idx) => <div key={idx} className="wl-batch-err">{err}</div>)}
            {findMode ? (
              <div className="wl-muted wl-batch-find-note">
                {item.signalCount ? `Linked ${item.signalCount} related communication${item.signalCount === 1 ? '' : 's'}.` : 'No related communications found.'}
              </div>
            ) : (<>

            <div className="wl-batch-block">
              <div className="wl-batch-block-label">Suggested comment</div>
              {item.comment ? (
                item.comment.submitted ? (
                  <div className="wl-batch-done">✓ Comment added to {item.milestoneName}</div>
                ) : (item.comment.text || !item.comment.note) ? (
                  <>
                    <textarea
                      rows="2"
                      value={item.comment.text}
                      onChange={(e) => batchApi.setBatchCommentText(item.milestoneId, e.target.value)}
                    />
                    {item.commentError ? <div className="wl-batch-err">{item.commentError}</div> : null}
                    <div className="wl-batch-actions">
                      <button
                        className="btn btn-primary"
                        disabled={!item.comment.text.trim() || item.comment.busy}
                        onClick={() => batchApi.submitBatchComment(item)}
                      >
                        {item.comment.busy ? <Spinner size="tiny" /> : null} Submit
                      </button>
                      <button className="btn btn-secondary" onClick={() => batchApi.deleteBatchComment(item.milestoneId)}>Reject</button>
                    </div>
                  </>
                ) : (
                  <div className="wl-muted">{item.comment.note}</div>
                )
              ) : (
                <div className="wl-muted">{item.commentError || 'No comment suggested.'}</div>
              )}
            </div>

            <div className="wl-batch-block">
              <div className="wl-batch-block-label">Suggested HoK activities</div>
              {item.hoks.length ? item.hoks.map((hok) => (
                hok.submitted ? (
                  <div key={hok.id} className="wl-batch-done">✓ Activity “{hok.subject}” logged</div>
                ) : (
                  <div key={hok.id} className="wl-batch-hok">
                    <input
                      className="wl-batch-hok-subject"
                      value={hok.subject}
                      placeholder="Activity subject"
                      onChange={(e) => batchApi.updateBatchHok(item.milestoneId, hok.id, { subject: e.target.value })}
                    />
                    <textarea
                      rows="2"
                      value={hok.description}
                      placeholder="Description"
                      onChange={(e) => batchApi.updateBatchHok(item.milestoneId, hok.id, { description: e.target.value })}
                    />
                    <div className="wl-batch-hok-row">
                      <select value={hok.category} onChange={(e) => batchApi.updateBatchHok(item.milestoneId, hok.id, { category: e.target.value })}>
                        <option value="">Category…</option>
                        {TASK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                      <input type="date" value={hok.dueDate || ''} onChange={(e) => batchApi.updateBatchHok(item.milestoneId, hok.id, { dueDate: e.target.value })} />
                    </div>
                    {hok.error ? <div className="wl-batch-err">{hok.error}</div> : null}
                    <div className="wl-batch-actions">
                      <button
                        className="btn btn-primary"
                        disabled={!hok.subject.trim() || hok.busy}
                        onClick={() => batchApi.submitBatchHok(item, hok)}
                      >
                        {hok.busy ? <Spinner size="tiny" /> : null} Submit
                      </button>
                      <button className="btn btn-secondary" onClick={() => batchApi.deleteBatchHok(item.milestoneId, hok.id)}>Reject</button>
                    </div>
                  </div>
                )
              )) : (
                <div className="wl-muted">{item.hokError || 'No HoK activity suggested.'}</div>
              )}
            </div>
            </>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// Adapt the batch state to the shared workflow popup (multiple milestones, per-milestone + global
// retry). The editable drafts still live in BatchDraftsPanel; this popup is the live monitor.
function BatchWorkflowPopup({ batchApi, onClose }) {
  const { results, running, progress, error } = batchApi;
  const statusNote = progress
    ? `${progress.label || 'Working'}${progress.total ? ` (${Math.min(progress.done + 1, progress.total)} of ${progress.total})` : ''}…`
    : 'Working…';
  const milestones = results.map((it) => ({
    id: it.milestoneId,
    name: it.milestoneName,
    sub: it.customerName || it.workloadName,
    steps: it.steps,
  }));
  return (
    <MilestoneAiWorkflowPopup
      milestones={milestones}
      running={running}
      statusNote={statusNote}
      error={error}
      onRetryMilestone={batchApi.retryMilestone}
      onRetryAll={batchApi.retryAllFailures}
      onClose={onClose}
    />
  );
}

function Section({ title, count, action, children, collapsible = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) {
    return (
      <section className="wl-section">
        <div className="wl-section-head">
          <h4>{title}{count != null ? <span className="wl-count">({count})</span> : null}</h4>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className={`wl-section wl-section-collapsible${open ? ' open' : ''}`}>
      <div className="wl-section-head">
        <button type="button" className="wl-section-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="wl-expand-icon">{open ? <ChevronDownRegular /> : <ChevronRightRegular />}</span>
          <h4>{title}{count != null ? <span className="wl-count">({count})</span> : null}</h4>
        </button>
        {open ? action : null}
      </div>
      {open ? children : null}
    </section>
  );
}

function MilestonesSection({ workload, links, milestoneOptions, countsByMs, refresh, refreshCards, setError, onOpenMilestone, batchApi }) {
  const [showPicker, setShowPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmUnlinkId, setConfirmUnlinkId] = useState(null); // milestone-link id pending unlink confirmation
  const linkedIds = new Set(links.map((link) => link.milestone_id));
  // Milestone AI runs Find signal → Comment AI → HoK AI across THIS workload's milestones and
  // surfaces each draft below for review/submit. Scoped to workload.id via batchApi.
  const aiActive = batchApi && batchApi.workloadId === workload.id;
  const aiResults = aiActive ? batchApi.results : [];

  // Link More is scoped to THIS workload's account: only milestones under the same parent TPID AND
  // owned by that account's configured SSP (Cloud & AI Specialist) — mirroring Discover mode's
  // owner-vs-SSP match. Load the account→SSP roster and build the set of SSP names for this TPID.
  const { data: sspRoleRows } = useDbQuery(SSP_ROLES_SQL, []);
  const workloadTpid = String(workload.customer_tpid || workload.tpid || '').trim();
  const accountSspSet = useMemo(() => {
    const set = new Set();
    for (const r of (sspRoleRows || [])) {
      if (String(r.tpid || '').trim() === workloadTpid) {
        const name = String(r.person_name || '').trim();
        if (name) set.add(name);
      }
    }
    return set;
  }, [sspRoleRows, workloadTpid]);
  const hasAccount = !!workloadTpid;
  const hasConfiguredSsp = accountSspSet.size > 0;

  const options = milestoneOptions
    .filter((milestone) => !linkedIds.has(milestone.milestone_id))
    // Same parent TPID as the workload's account (only when the workload has an account).
    .filter((milestone) => !hasAccount || String(milestone.customer_tpid || '').trim() === workloadTpid)
    // Owned by the account's configured SSP (only when one is configured).
    .filter((milestone) => !hasConfiguredSsp || accountSspSet.has(String(milestone.milestone_owner || '').trim()))
    .filter((milestone) => !query.trim()
      || `${milestone.name} ${milestone.customer_name} ${milestone.opportunity_name}`.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 50);

  // Honest empty-state: explain WHY the (scoped) list is empty rather than a bare "no matches".
  const emptyReason = (() => {
    if (options.length) return null;
    if (query.trim()) return 'No milestones match your search.';
    if (hasAccount && !hasConfiguredSsp) {
      return 'No Cloud & AI Specialist (SSP) is configured for this account. Set one in User Home → SSP Configuration to see its milestones here.';
    }
    if (hasAccount) {
      return 'No unlinked milestones for this account are owned by its configured SSP.';
    }
    return 'No matching unlinked milestones.';
  })();

  async function attach(milestone) {
    try {
      await runDb(
        `INSERT OR IGNORE INTO workload_milestone_links
           (workload_id, milestone_id, milestone_name, account_name, customer_tpid, customer_name, opportunity_id, opportunity_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workload.id,
          milestone.milestone_id,
          milestone.name,
          milestone.customer_name || null,
          milestone.customer_tpid || null,
          milestone.customer_name || null,
          milestone.opportunity_id || null,
          milestone.opportunity_name || null,
        ],
      );
      await runDb(
        `UPDATE workloads
         SET customer_tpid = COALESCE(customer_tpid, ?),
             customer_name = COALESCE(customer_name, ?),
             tpid = COALESCE(tpid, ?),
             account_name = COALESCE(account_name, ?),
             opportunity_id = COALESCE(opportunity_id, ?),
             opportunity_name = COALESCE(opportunity_name, ?),
             ssp_name = COALESCE(ssp_name, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          milestone.customer_tpid || null,
          milestone.customer_name || null,
          milestone.customer_tpid || null,
          milestone.customer_name || null,
          milestone.opportunity_id || null,
          milestone.opportunity_name || null,
          milestone.ssp_name || null,
          workload.id,
        ],
      );
      setShowPicker(false);
      refresh();
      refreshCards();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  return (
    <Section
      title={(
        <>
          Milestones<span className="wl-count">({links.length})</span>
          <button
            className="wl-link-btn wl-link-more"
            onClick={() => setShowPicker((value) => !value)}
            title="Link more milestones to this workload"
          >
            <LinkRegular /> Link More
          </button>
        </>
      )}
      action={(
        <div className="wl-section-actions" data-tour="wl-ai-buttons">
          {batchApi ? (
            <button
              className="eng-detail-ai"
              onClick={() => batchApi.run(workload.id)}
              disabled={batchApi.running || !links.length}
              title="Milestone AI: first links related emails, meetings & chats across this workload's milestones, then drafts a comment and suggests HoK activities for each"
            >
              {batchApi.running && aiActive ? '✨ …' : '✨ Milestone AI'}
            </button>
          ) : null}
        </div>
      )}
    >
      {showPicker ? (
        <div className="wl-picker">
          <input
            className="wl-picker-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search milestones, customers, or opportunities"
            autoFocus
          />
          <div className="wl-picker-list">
            {options.map((milestone) => (
              <button key={milestone.milestone_id} className="wl-picker-row" onClick={() => attach(milestone)}>
                <FlagRegular className="wl-li-icon" />
                <span className="wl-li-main">
                  <span className="wl-li-title">{milestone.name}</span>
                  <span className="wl-li-sub">
                    {milestone.customer_name || 'Unknown customer'} · {milestone.opportunity_name || 'No opportunity'}
                  </span>
                </span>
              </button>
            ))}
            {!options.length ? <div className="wl-picker-empty wl-muted">{emptyReason}</div> : null}
          </div>
        </div>
      ) : null}
      {links.length ? (
        <MilestoneLinkList
          links={links}
          countsByMs={countsByMs}
          onOpenMilestone={onOpenMilestone}
          renderTrailing={(link) => (
            confirmUnlinkId === link.id ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className="wl-link-btn"
                  style={{ color: 'var(--danger)' }}
                  title={`Unlink ${link.milestone_name} from this workload`}
                  onClick={() => runDb('DELETE FROM workload_milestone_links WHERE id = ?', [link.id])
                    .then(() => { setConfirmUnlinkId(null); refresh(); refreshCards(); })
                    .catch((err) => { setConfirmUnlinkId(null); setError(err.message); })}
                >
                  Confirm
                </button>
                <button type="button" className="wl-link-btn" onClick={() => setConfirmUnlinkId(null)}>Cancel</button>
              </span>
            ) : (
              <button
                className="wl-icon-btn"
                title={`Unlink ${link.milestone_name}`}
                onClick={() => setConfirmUnlinkId(link.id)}
              >
                <DeleteRegular />
              </button>
            )
          )}
        />
      ) : <p className="wl-section-empty wl-muted">Link the milestone and opportunity this effort supports.</p>}
      {aiActive ? (
        <BatchDraftsPanel batchApi={batchApi} />
      ) : null}
    </Section>
  );
}

function SignalAssignmentsSection({
  workload, links, milestoneOptions, setError,
}) {
  const [assignments, setAssignments] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const res = await workloadSignalList({ workloadId: workload.id });
      if (!res?.ok) throw new Error(res?.error || 'Assigned communication could not be loaded.');
      setAssignments(res.items || []);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [workload.id, setError]);
  useEffect(() => { refresh(); }, [refresh]);
  const [signals, setSignals] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [targetMilestoneId, setTargetMilestoneId] = useState(null);
  const effectiveMilestoneId = targetMilestoneId === null
    ? (links[0]?.milestone_id || '')
    : targetMilestoneId;
  const milestoneById = useMemo(
    () => new Map(milestoneOptions.map((milestone) => [milestone.milestone_id, milestone])),
    [milestoneOptions],
  );

  async function persistAssignment(signal, source, rationale = '') {
    const milestone = milestoneById.get(effectiveMilestoneId);
    const identity = workloadSignalIdentity(signal);
    return workloadSignalAssign({
      workloadId: workload.id,
      signalType: identity.type,
      nativeId: identity.id,
      signalTitle: signal.title || null,
      signalDate: signal.item_date || null,
      tpid: workload.customer_tpid || links[0]?.customer_tpid || null,
      milestoneId: effectiveMilestoneId || null,
      opportunityId: milestone?.opportunity_id || workload.opportunity_id || null,
      source,
      rationale: rationale || null,
    });
  }

  async function browseSignals() {
    const tpid = workload.customer_tpid || links[0]?.customer_tpid;
    if (!tpid) {
      setError('Assign a customer or link a customer milestone before browsing communication.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await listSignals({ tpid, medium: 'all', limit: 60 });
      if (!result?.ok) throw new Error(result?.error || 'Communication signals could not be loaded.');
      setSignals(result.items || []);
      if (!(result.items || []).length) {
        setMessage('No account-linked email, meetings, or Teams chats are available yet.');
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function assignSignal(signal) {
    try {
      const result = await persistAssignment(signal, 'manual');
      if (!result?.ok) throw new Error(result?.error || 'Communication could not be assigned.');
      setMessage(result.changes
        ? 'Communication assigned to this work hierarchy.'
        : 'That communication is already assigned to this workload. Use the milestone dropdown on its card to re-tag it.');
      refresh();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function findWithAi() {
    if (!effectiveMilestoneId) {
      setError('Link and select a milestone before asking AI to relate communication.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await findMilestoneSignal({ milestoneId: effectiveMilestoneId });
      if (!result?.ok) throw new Error(result?.error || 'AI communication assignment failed.');
      let added = 0;
      for (const signal of result.links || []) {
        const write = await persistAssignment(signal, 'ai', signal.reason || '');
        if (!write?.ok) throw new Error(write?.error || 'AI communication assignment failed to persist.');
        added += write.changes || 0;
      }
      setMessage(added
        ? `AI assigned ${added} grounded communication item${added === 1 ? '' : 's'}.`
        : (result.summary || 'AI found no new communication to assign.'));
      refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateAssignment(assignment, milestoneId) {
    const milestone = milestoneById.get(milestoneId);
    try {
      const res = await workloadSignalUpdate({
        id: assignment.id,
        milestoneId: milestoneId || null,
        opportunityId: milestone?.opportunity_id || workload.opportunity_id || null,
      });
      if (!res?.ok) throw new Error(res?.error || 'Milestone re-tag failed.');
      refresh();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  return (
    <Section
      title="Communication assignments"
      count={assignments.length}
      collapsible
      action={(
        <div className="wl-section-actions">
          <button className="wl-link-btn" disabled={busy} onClick={browseSignals}>Browse signals</button>
          <button className="wl-link-btn" disabled={busy || !effectiveMilestoneId} onClick={findWithAi}>
            {busy ? 'Working...' : 'Find with AI'}
          </button>
        </div>
      )}
    >
      <div className="wl-signal-targets">
        <label>
          Assign to milestone / opportunity
          <select value={effectiveMilestoneId} onChange={(event) => setTargetMilestoneId(event.target.value)}>
            <option value="">No milestone</option>
            {links.map((link) => (
              <option key={link.milestone_id} value={link.milestone_id}>
                {link.milestone_name}{link.opportunity_name ? ` · ${link.opportunity_name}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {message ? <div className="wl-signal-message">{message}</div> : null}
      {signals ? (
        <div className="wl-signal-picker">
          {signals.map((signal) => (
            <div key={`${signal.medium}-${signal.id}`} className="wl-signal-row">
              <Pill>{signal.medium === 'chat' ? 'Teams' : signal.medium}</Pill>
              <span className="wl-signal-main">
                <strong>{signal.title || '(untitled communication)'}</strong>
                <small>{signal.from_name || ''}{signal.item_date ? ` · ${String(signal.item_date).slice(0, 10)}` : ''}</small>
              </span>
              <button className="btn btn-secondary wl-sm" onClick={() => assignSignal(signal)}>Assign</button>
            </div>
          ))}
        </div>
      ) : null}
      {assignments.length ? (
        <div className="wl-signal-list">
          {assignments.map((assignment) => (
            <div key={assignment.id} className="wl-signal-row assigned">
              <Pill tone={assignment.assignment_source === 'ai' ? 'ssp' : ''}>
                {assignment.signal_type === 'chat' ? 'Teams' : assignment.signal_type} · {assignment.assignment_source}
              </Pill>
              <span className="wl-signal-main">
                <strong>{assignment.signal_title || assignment.signal_id}</strong>
                <small>{assignment.rationale || (assignment.signal_date ? String(assignment.signal_date).slice(0, 10) : 'Assigned communication')}</small>
              </span>
              <select
                value={assignment.milestone_id || ''}
                onChange={(event) => updateAssignment(assignment, event.target.value)}
                aria-label={`Milestone assignment for ${assignment.signal_title || assignment.signal_id}`}
              >
                <option value="">No milestone</option>
                {links.map((link) => <option key={link.milestone_id} value={link.milestone_id}>{link.milestone_name}</option>)}
              </select>
              <button
                className="wl-icon-btn"
                title="Remove communication assignment"
                onClick={() => workloadSignalUnlink({ id: assignment.id })
                  .then((res) => { if (!res?.ok) throw new Error(res?.error || 'Remove failed.'); return refresh(); })
                  .catch((err) => setError(err.message))}
              >
                <DeleteRegular />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="wl-section-empty wl-muted">Assign account communication manually, or let AI ground suggestions through a linked milestone.</p>}
    </Section>
  );
}

function WorkloadDetails({
  workload, milestoneOptions, refreshCards, onDelete, onOpenMilestone, batchApi,
}) {
  const [error, setError] = useState('');
  const { data: links, refresh: refreshLinks } = useDbQuery(
    'SELECT * FROM active_workload_milestone_links WHERE workload_id = ? ORDER BY created_at, id',
    [workload.id],
  );
  // Per-milestone signal counts (emails/meetings/chats) — same source as the milestone popup's
  // Related signals, so the tallies match. Refetched with the links so a newly linked milestone
  // gets its counts. Cheap aggregate over the whole links table.
  const { data: signalCountRows } = useDbQuery(MS_SIGNAL_COUNTS_SQL, [], [links]);
  const countsByMs = useMemo(() => buildSignalCountMap(signalCountRows), [signalCountRows]);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  return (
    <div className="wl-card-body">
      {error ? <div className="alert-error">{error}</div> : null}
      <Section title="Overview">
        <div className="wl-detail-top">
          <div className="wl-detail-desc">
            <p>{workload.description || 'No workload description yet.'}</p>
          </div>
        </div>
      </Section>
      <MilestonesSection
        workload={workload}
        links={links}
        milestoneOptions={milestoneOptions}
        countsByMs={countsByMs}
        refresh={refreshLinks}
        refreshCards={refreshCards}
        setError={setError}
        onOpenMilestone={onOpenMilestone}
        batchApi={batchApi}
      />
      <SignalAssignmentsSection
        workload={workload}
        links={links}
        milestoneOptions={milestoneOptions}
        setError={setError}
      />
      <div className="wl-card-footer">
        {deleteConfirm ? (
          <div className="wl-confirm">
            Delete this workload and its milestone links and communication assignments?
            <button className="btn btn-secondary wl-sm wl-danger-btn" onClick={() => onDelete(workload.id)}>Delete permanently</button>
            <button className="btn btn-secondary wl-sm" onClick={() => setDeleteConfirm(false)}>Cancel</button>
          </div>
        ) : (
          <button className="wl-link-btn wl-danger" onClick={() => setDeleteConfirm(true)}>
            <DeleteRegular /> Delete workload
          </button>
        )}
      </div>
    </div>
  );
}

function WorkloadCard({
  workload, onOpen, onMove, canMoveUp, canMoveDown, parentNameByTpid,
}) {
  const customerTags = workloadCustomerNames(workload, parentNameByTpid);
  const milestoneTags = unique(jsonList(workload.milestone_names));
  const sspTags = workload.profile_ssp_name ? [workload.profile_ssp_name] : [];

  return (
    <article className="wl-card wl-card-compact">
      <div className="wl-order-controls">
        <button disabled={!canMoveUp} title="Move workload earlier" onClick={() => onMove(-1)}>↑</button>
        <button disabled={!canMoveDown} title="Move workload later" onClick={() => onMove(1)}>↓</button>
      </div>
      <button className="wl-card-summary" onClick={onOpen} title="Open workload">
        <div className="wl-card-title-row">
          <span className="wl-title-text">{workload.name}</span>
        </div>
        <p className="wl-card-description">{workload.description || 'No description yet.'}</p>
        <div className="wl-tag-row">
          {customerTags.map((tag) => <Pill key={`customer-${tag}`} tone="customer">{tag}</Pill>)}
          {sspTags.map((tag) => <Pill key={`ssp-${tag}`} tone="ssp">SSP · {tag}</Pill>)}
          {milestoneTags.length ? <Pill tone="milestone">{milestoneTags.length} ms</Pill> : null}
          {!customerTags.length && !milestoneTags.length ? <Pill tone="unassigned">Unassigned</Pill> : null}
        </div>
      </button>
      <div className="wl-card-actions">
        <button className="btn btn-secondary wl-sm" onClick={onOpen} title="Open workload">
          Open ›
        </button>
      </div>
    </article>
  );
}

// Full workload popup — clean modal with every section collapsed by default (Overview,
// Milestones and opportunities, Communication assignments). Reuses the app's detail-modal
// chrome (eng-detail-*) so it matches the milestone/opportunity popups.
function WorkloadModal({
  workload, milestoneOptions, refreshCards, onDelete, onOpenMilestone, onClose, parentNameByTpid, batchApi,
}) {
  // Only the customer/account is shown as a tag in the header. SSP, opportunities, and milestones
  // are NOT shown as oval tags — they live in the Overview/Milestones sections below.
  const customerTags = workloadCustomerNames(workload, parentNameByTpid);
  return (
    <div className="eng-detail-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card eng-detail-card-wide wl-modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind">Workload</span>
          <div className="eng-detail-head-actions">
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="eng-detail-title"><span>{workload.name}</span></div>
        {customerTags.length ? (
          <div className="wl-tag-row wl-modal-tags">
            {customerTags.map((tag) => <Pill key={`customer-${tag}`} tone="customer">{tag}</Pill>)}
          </div>
        ) : null}
        <WorkloadDetails
          workload={workload}
          milestoneOptions={milestoneOptions}
          refreshCards={refreshCards}
          onDelete={onDelete}
          onOpenMilestone={onOpenMilestone}
          batchApi={batchApi}
        />
      </div>
    </div>
  );
}

const SOURCE_GROUPS = [
  { key: 'emails', label: 'Emails', icon: MailRegular },
  { key: 'meetings', label: 'Meetings', icon: CalendarLtrRegular },
  { key: 'chats', label: 'Teams chats', icon: ChatRegular },
];

// Provenance for a suggestion: the emails, meetings and Teams chats from the account's recent
// window that grounded the model's proposal. The basis is the whole account window (the model is
// not asked to cite individual items), so this is shown as "grounded in", not "derived only from".
function SuggestionSources({ source }) {
  const groups = SOURCE_GROUPS
    .map((group) => ({
      ...group,
      total: sourceCount(source, group.key),
      items: sourceItems(source, group.key),
    }))
    .filter((group) => group.total > 0 || group.items.length > 0);

  if (!groups.length) {
    return <p className="wl-section-empty wl-muted">No source activity was recorded for this suggestion.</p>;
  }

  const label = source?.windowLabel || 'recent activity';
  return (
    <div className="wl-sug-sources">
      <p className="wl-muted wl-sug-sources-lead">Grounded in this account&apos;s {label} of signal.</p>
      {groups.map((group) => {
        const Icon = group.icon;
        const more = group.total - group.items.length;
        return (
          <div key={group.key} className="wl-sug-source-group">
            <div className="wl-sug-source-head">
              <Icon className="wl-li-icon" />
              <span className="wl-li-title">{group.label}</span>
              <span className="wl-count">({group.total})</span>
            </div>
            {group.items.length ? (
              <ul className="wl-sug-source-list">
                {group.items.map((item, index) => (
                  <li key={item.id || `${group.key}-${index}`} className="wl-sug-source-item">
                    <span className="wl-li-title">{item.subject || '(no subject)'}</span>
                    <span className="wl-li-sub">
                      {[item.from, formatSourceDate(item.date)].filter(Boolean).join(' · ')}
                    </span>
                    {item.excerpt ? <span className="wl-sug-source-excerpt">{item.excerpt}</span> : null}
                  </li>
                ))}
                {more > 0 ? (
                  <li className="wl-sug-source-more wl-muted">+{more} more {group.label.toLowerCase()}</li>
                ) : null}
              </ul>
            ) : (
              <p className="wl-section-empty wl-muted">
                {group.total} {group.label.toLowerCase()} — item details were not captured for this draft.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SuggestionDetails({ suggestion, refreshSuggestions, setError }) {
  const { data: availableOpps } = useDbQuery(SUGGESTION_OPPORTUNITIES_SQL, [suggestion.tpid]);
  const { data: accountMilestones } = useDbQuery(SUGGESTION_MILESTONES_SQL, [suggestion.tpid]);
  const { data: addedOpps, refresh: refreshOpps } = useDbQuery(
    'SELECT * FROM active_workload_suggestion_opportunities WHERE suggestion_id = ? ORDER BY id',
    [suggestion.id],
  );
  const { data: addedMilestones, refresh: refreshMilestones } = useDbQuery(
    'SELECT * FROM active_workload_suggestion_milestones WHERE suggestion_id = ? ORDER BY id',
    [suggestion.id],
  );
  const [selectedSsp, setSelectedSsp] = useState(null);

  const addedOppIds = new Set(addedOpps.map((opp) => opp.opportunity_id));
  const addedMsIds = new Set(addedMilestones.map((milestone) => milestone.milestone_id));
  const sspNames = unique(availableOpps.map((opp) => opp.ssp_name));
  // Auto-select the account's SSP so the opportunity/milestone picker is scoped to their work by
  // default (instead of "All SSPs"). Prefer the suggestion's own SSP when it's one of the account's
  // opportunity owners; otherwise, when the account has a single SSP, pick that. Runs once, only
  // after the opportunities load, and never overrides a manual choice.
  const sspInitRef = useRef(false);
  useEffect(() => {
    if (sspInitRef.current || !sspNames.length) return;
    sspInitRef.current = true;
    const own = suggestion.ssp_name && sspNames.includes(suggestion.ssp_name) ? suggestion.ssp_name : null;
    if (own) setSelectedSsp(own);
    else if (sspNames.length === 1 && sspNames[0]) setSelectedSsp(sspNames[0]);
  }, [sspNames, suggestion.ssp_name]);
  // Filter the opportunity/milestone picker down to the selected SSP (owner_name). Milestones
  // ride along because they are grouped under their parent opportunity below.
  const filteredOpps = useMemo(
    () => (selectedSsp ? availableOpps.filter((opp) => opp.ssp_name === selectedSsp) : availableOpps),
    [availableOpps, selectedSsp],
  );
  const milestonesByOpp = useMemo(() => {
    const map = new Map();
    for (const milestone of accountMilestones) {
      if (!map.has(milestone.opportunity_id)) map.set(milestone.opportunity_id, []);
      map.get(milestone.opportunity_id).push(milestone);
    }
    return map;
  }, [accountMilestones]);

  async function addOpportunity(opp) {
    try {
      await runDb(
        `INSERT OR IGNORE INTO workload_suggestion_opportunities
           (suggestion_id, opportunity_id, opportunity_name, included)
         VALUES (?, ?, ?, 1)`,
        [suggestion.id, opp.opportunity_id, opp.name],
      );
      if (opp.ssp_name) {
        await runDb(
          `UPDATE workload_suggestions
           SET ssp_name = COALESCE(ssp_name, ?), updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [opp.ssp_name, suggestion.id],
        );
      }
      refreshOpps();
      refreshSuggestions();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function removeOpportunity(opp) {
    try {
      // Removing an opportunity also removes any milestones picked under it, preserving the
      // rule that a milestone can only exist while its parent opportunity is added.
      await runDb(
        'DELETE FROM workload_suggestion_opportunities WHERE suggestion_id = ? AND opportunity_id = ?',
        [suggestion.id, opp.opportunity_id],
      );
      await runDb(
        'DELETE FROM workload_suggestion_milestones WHERE suggestion_id = ? AND opportunity_id = ?',
        [suggestion.id, opp.opportunity_id],
      );
      refreshOpps();
      refreshMilestones();
      refreshSuggestions();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function addMilestone(opp, milestone) {
    if (!addedOppIds.has(opp.opportunity_id)) return; // gated: parent opportunity must be added
    try {
      await runDb(
        `INSERT OR IGNORE INTO workload_suggestion_milestones
           (suggestion_id, opportunity_id, milestone_id, milestone_name, status_label, included)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [suggestion.id, opp.opportunity_id, milestone.milestone_id, milestone.name, milestone.status_label || null],
      );
      refreshMilestones();
      refreshSuggestions();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function removeMilestone(milestone) {
    try {
      await runDb(
        'DELETE FROM workload_suggestion_milestones WHERE suggestion_id = ? AND milestone_id = ?',
        [suggestion.id, milestone.milestone_id],
      );
      refreshMilestones();
      refreshSuggestions();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  return (
    <div className="wl-card-body wl-suggestion-details">
      <Section title="Based on recent activity">
        <SuggestionSources source={jsonObj(suggestion.source_json)} />
      </Section>

      <Section title="SSP">
        {sspNames.length ? (
          <div className="wl-tag-row">
            <button
              type="button"
              className={`wl-tag ssp wl-tag-btn${selectedSsp === null ? ' is-active' : ''}`}
              aria-pressed={selectedSsp === null}
              onClick={() => setSelectedSsp(null)}
            >
              All SSPs
            </button>
            {sspNames.map((ssp) => (
              <button
                type="button"
                key={ssp}
                className={`wl-tag ssp wl-tag-btn${selectedSsp === ssp ? ' is-active' : ''}`}
                aria-pressed={selectedSsp === ssp}
                onClick={() => setSelectedSsp((prev) => (prev === ssp ? null : ssp))}
              >
                SSP · {ssp}
              </button>
            ))}
          </div>
        ) : <p className="wl-section-empty wl-muted">No SSP found for this account&apos;s open opportunities.</p>}
      </Section>

      <Section title="Opportunities and milestones" count={addedOpps.length}>
        {filteredOpps.length ? (
          <ul className="wl-sug-opp-list">
            {filteredOpps.map((opp) => {
              const added = addedOppIds.has(opp.opportunity_id);
              const oppMilestones = milestonesByOpp.get(opp.opportunity_id) || [];
              return (
                <li key={opp.opportunity_id} className={`wl-sug-opp${added ? ' added' : ''}`}>
                  <div className="wl-sug-opp-head">
                    <FlagRegular className="wl-li-icon" />
                    <span className="wl-li-main">
                      <span className="wl-li-title">{opp.name}</span>
                      <span className="wl-li-sub">{opp.ssp_name ? `SSP · ${opp.ssp_name}` : 'No SSP'}</span>
                    </span>
                    {added ? (
                      <button className="wl-link-btn wl-danger" onClick={() => removeOpportunity(opp)}>
                        <DeleteRegular /> Remove
                      </button>
                    ) : (
                      <button className="wl-link-btn" onClick={() => addOpportunity(opp)}>
                        <AddRegular /> Add opportunity
                      </button>
                    )}
                  </div>
                  {added ? (
                    <div className="wl-sug-ms">
                      {oppMilestones.length ? oppMilestones.map((milestone) => {
                        const msAdded = addedMsIds.has(milestone.milestone_id);
                        return (
                          <div key={milestone.milestone_id} className={`wl-sug-ms-row${msAdded ? ' added' : ''}`}>
                            <FlagRegular className="wl-li-icon" />
                            <span className="wl-li-main">
                              <span className="wl-li-title">{milestone.name}</span>
                              {milestone.status_label ? <span className="wl-li-sub">{milestone.status_label}</span> : null}
                            </span>
                            {msAdded ? (
                              <button className="wl-icon-btn" title={`Remove ${milestone.name}`} onClick={() => removeMilestone(milestone)}>
                                <DeleteRegular />
                              </button>
                            ) : (
                              <button className="wl-link-btn wl-sm" onClick={() => addMilestone(opp, milestone)}>
                                <AddRegular /> Add
                              </button>
                            )}
                          </div>
                        );
                      }) : <p className="wl-section-empty wl-muted">No milestones on this opportunity.</p>}
                    </div>
                  ) : (
                    <p className="wl-sug-gate wl-muted">Add this opportunity to choose its milestones.</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="wl-section-empty wl-muted">
            {selectedSsp
              ? `No open opportunities for SSP · ${selectedSsp}.`
              : 'No open opportunities found for this account.'}
          </p>
        )}
      </Section>
    </div>
  );
}

function SuggestionCard({ suggestion, onOpen, onApprove, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const source = jsonObj(suggestion.source_json);
  const emails = sourceCount(source, 'emails');
  const meetings = sourceCount(source, 'meetings');
  const chats = sourceCount(source, 'chats');
  const total = emails + meetings + chats;
  return (
    <article className="wl-card wl-card-compact wl-suggested-card">
      <button className="wl-card-summary" onClick={onOpen} title="Open suggestion">
        <div className="wl-card-title-row">
          <span className="wl-title-text">{suggestion.title}</span>
          <Pill tone="suggested">Suggested</Pill>
        </div>
        <p className="wl-card-description">{suggestion.description || 'No description.'}</p>
        <div className="wl-tag-row">
          {suggestion.account_name ? <Pill tone="customer">{suggestion.account_name}</Pill> : null}
          {(suggestion.opportunity_count || 0) > 0 ? <Pill tone="opportunity">{suggestion.opportunity_count} opp</Pill> : null}
          {(suggestion.milestone_count || 0) > 0 ? <Pill tone="milestone">{suggestion.milestone_count} ms</Pill> : null}
          {total ? <span className="wl-card-source wl-muted">{total} signal item{total === 1 ? '' : 's'}</span> : null}
        </div>
      </button>
      <div className="wl-card-actions">
        {confirm ? (
          <div className="wl-confirm">
            Dismiss permanently?
            <button className="btn btn-secondary wl-sm wl-danger-btn" onClick={() => { setConfirm(false); onDelete(suggestion); }}>Dismiss</button>
            <button className="btn btn-secondary wl-sm" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        ) : (
          <>
            <button className="btn btn-primary wl-sm" onClick={() => onApprove(suggestion)} title="Convert to a real workload">
              <CheckmarkCircleRegular /> Approve
            </button>
            <button className="btn btn-secondary wl-sm" onClick={onOpen} title="Add opportunities and milestones">
              <AddRegular /> Build
            </button>
            <button className="wl-icon-btn wl-danger" onClick={() => setConfirm(true)} title="Dismiss permanently — will not be suggested again">
              <DeleteRegular />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

// Suggested-workload popup — the "Build details" curation surface (SSP, opportunities and their
// milestones) in the shared detail-modal chrome, with Approve / Delete in the footer.
function SuggestionModal({ suggestion, refreshSuggestions, onApprove, onDelete, setError, onClose }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="eng-detail-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card eng-detail-card-wide wl-modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind">Suggested workload</span>
          <div className="eng-detail-head-actions">
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="eng-detail-title"><span>{suggestion.title}</span></div>
        <div className="wl-tag-row wl-modal-tags">
          <Pill tone="suggested">Suggested</Pill>
          {suggestion.account_name ? <Pill tone="customer">{suggestion.account_name}</Pill> : null}
          {suggestion.ssp_name ? <Pill tone="ssp">SSP · {suggestion.ssp_name}</Pill> : null}
        </div>
        <SuggestionDetails
          suggestion={suggestion}
          refreshSuggestions={refreshSuggestions}
          setError={setError}
        />
        <div className="wl-card-footer wl-modal-footer">
          {confirm ? (
            <div className="wl-confirm">
              Dismiss this suggestion permanently? It will not be suggested again.
              <button className="btn btn-secondary wl-danger-btn" onClick={() => { setConfirm(false); onDelete(suggestion); }}>Dismiss permanently</button>
              <button className="btn btn-secondary" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => onApprove(suggestion)}>
                <CheckmarkCircleRegular /> Approve workload
              </button>
              <button className="btn btn-secondary wl-danger-btn" onClick={() => setConfirm(true)}>
                <DeleteRegular /> Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const DISCOVER_ICONS = { email: MailRegular, meeting: CalendarLtrRegular, chat: ChatRegular };

// Create-workload popup. Top "Discover" section uses the selected AI model to parse the account's
// recent emails/meetings/chats for items matching the typed description, then auto-fills the fields
// below (name, category, SSP) and surfaces the matched communications + the account's opportunities
// and milestones (same gated add-opportunity-then-milestone model as Suggest workloads). Everything
// stays editable; Create writes the workload and atomically links the chosen milestones + signals.
function CreateWorkloadModal({ opportunityOptions, onCreated, onClose }) {
  const [draft, setDraft] = useState({ name: '', description: '', category: CATEGORIES[0] });
  const [selectedTpid, setSelectedTpid] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [discoverInfo, setDiscoverInfo] = useState('');
  const [signals, setSignals] = useState([]); // discovered comms: { signalType, nativeId, signalTitle, signalDate, rationale, included }
  const [addedOpps, setAddedOpps] = useState([]); // { opportunity_id, name, ssp_name }
  const [addedMs, setAddedMs] = useState([]); // { milestone_id, name, status_label, opportunity_id, opportunity_name }
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const { data: parentAccounts } = useDbQuery(PARENT_ACCOUNTS_SQL);
  // One dropdown entry per TPID that has open opportunities, labeled with the TPID's PARENT
  // account name (not whatever child account an opportunity happened to hang off). Keeps the
  // Discover + opportunity/milestone flow scoped to accounts that actually have opportunities.
  const accountOptions = useMemo(() => {
    const nameByTpid = new Map();
    for (const p of parentAccounts || []) {
      nameByTpid.set(String(p.tpid), p.top_name || p.any_name || 'Unknown account');
    }
    const tpids = new Set();
    for (const o of opportunityOptions || []) {
      const tpid = o.customer_tpid != null && String(o.customer_tpid).trim() !== '' ? String(o.customer_tpid) : null;
      if (tpid) tpids.add(tpid);
    }
    return [...tpids]
      .map((tpid) => ({ tpid, name: nameByTpid.get(tpid) || 'Unknown account' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [opportunityOptions, parentAccounts]);
  const accountName = useMemo(
    () => accountOptions.find((a) => a.tpid === selectedTpid)?.name || null,
    [accountOptions, selectedTpid],
  );

  // The account's open opportunities + its milestones (deterministic — available as soon as an
  // account is chosen, whether or not Discover has run). Same queries as the Suggest picker.
  const { data: availableOpps } = useDbQuery(SUGGESTION_OPPORTUNITIES_SQL, selectedTpid ? [selectedTpid] : ['']);
  const { data: accountMilestones } = useDbQuery(SUGGESTION_MILESTONES_SQL, selectedTpid ? [selectedTpid] : ['']);
  const addedOppIds = new Set(addedOpps.map((o) => o.opportunity_id));
  const addedMsIds = new Set(addedMs.map((m) => m.milestone_id));
  const milestonesByOpp = useMemo(() => {
    const map = new Map();
    for (const m of accountMilestones) {
      if (!map.has(m.opportunity_id)) map.set(m.opportunity_id, []);
      map.get(m.opportunity_id).push(m);
    }
    return map;
  }, [accountMilestones]);

  // Reset the in-memory opp/milestone selection when the account changes (they're account-scoped).
  function pickAccount(tpid) {
    setSelectedTpid(tpid);
    setAddedOpps([]);
    setAddedMs([]);
    setSignals([]);
    setDiscoverInfo('');
    setDiscoverError('');
  }

  function addOpportunity(opp) {
    setAddedOpps((prev) => (prev.some((o) => o.opportunity_id === opp.opportunity_id) ? prev : [...prev, opp]));
  }
  function removeOpportunity(opp) {
    // Removing an opportunity also drops any milestones picked under it (gated model).
    setAddedOpps((prev) => prev.filter((o) => o.opportunity_id !== opp.opportunity_id));
    setAddedMs((prev) => prev.filter((m) => m.opportunity_id !== opp.opportunity_id));
  }
  function addMilestone(opp, ms) {
    if (!addedOppIds.has(opp.opportunity_id)) return; // gated: parent opportunity must be added first
    setAddedMs((prev) => (prev.some((m) => m.milestone_id === ms.milestone_id)
      ? prev
      : [...prev, { ...ms, opportunity_id: opp.opportunity_id, opportunity_name: opp.name }]));
  }
  function removeMilestone(ms) {
    setAddedMs((prev) => prev.filter((m) => m.milestone_id !== ms.milestone_id));
  }

  async function runDiscover() {
    if (!selectedTpid) { setDiscoverError('Select an account to discover activity for.'); return; }
    if (!draft.description.trim()) { setDiscoverError('Describe the workload so Discover knows what to look for.'); return; }
    setDiscovering(true);
    setDiscoverError('');
    setDiscoverInfo('');
    try {
      const res = await workloadDiscover({ tpid: selectedTpid, description: draft.description, categories: CATEGORIES });
      if (!res || res.ok === false) throw new Error((res && res.error) || 'Discovery failed.');
      const f = res.fields || {};
      setDraft((prev) => ({
        ...prev,
        name: prev.name.trim() || f.title || '',
        description: f.description || prev.description,
        category: CATEGORIES.includes(f.category) ? f.category : prev.category,
      }));
      setSignals((res.signals || []).map((s) => ({ ...s, included: true })));
      const c = res.counts || {};
      setDiscoverInfo(
        `Matched ${c.matched || 0} item${(c.matched || 0) === 1 ? '' : 's'} from ${c.emails || 0} email${(c.emails || 0) === 1 ? '' : 's'}, ${c.meetings || 0} meeting${(c.meetings || 0) === 1 ? '' : 's'}, ${c.chats || 0} chat${(c.chats || 0) === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      setDiscoverError(err.message || String(err));
    } finally {
      setDiscovering(false);
    }
  }

  async function submit() {
    if (!draft.name.trim()) { setCreateError('A workload name is required.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      // A workload can span several opportunities (the gated picker above). Seed the primary
      // opportunity + SSP from the first added opportunity — SSP is that opportunity's owner (the
      // account's specialist), never typed. Display still derives the full set from milestone links.
      const primaryOpportunity = addedOpps[0] || null;
      const result = await workloadCreate({
        name: draft.name,
        description: draft.description,
        category: draft.category,
        opportunityId: primaryOpportunity?.opportunity_id || null,
        sspName: primaryOpportunity?.ssp_name || null,
        tpid: selectedTpid || null,
        accountName,
        milestones: addedMs.map((m) => ({
          milestoneId: m.milestone_id,
          milestoneName: m.name,
          statusLabel: m.status_label,
          opportunityId: m.opportunity_id,
          opportunityName: m.opportunity_name,
        })),
        signals: signals.filter((s) => s.included).map((s) => ({
          signalType: s.signalType,
          nativeId: s.nativeId,
          signalTitle: s.signalTitle,
          signalDate: s.signalDate,
          rationale: s.rationale,
        })),
      });
      onCreated(result.workloadId);
    } catch (err) {
      setCreateError(err.message || String(err));
      setCreating(false);
    }
  }

  return (
    <div className="eng-detail-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card eng-detail-card-wide wl-modal-card wl-create-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind">New workload</span>
          <div className="eng-detail-head-actions">
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="wl-create-body">
          {/* Discover section */}
          <section className="wl-discover">
            <div className="wl-discover-head">
              <SparkleRegular /> Discover all data matching this workload description
            </div>
            <div className="wl-discover-controls">
              <label className="wl-field wl-grow">
                Workload description
                <textarea
                  rows="3"
                  value={draft.description}
                  placeholder="e.g. Fabric proof-of-concept for the risk data platform"
                  onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                />
              </label>
              <label className="wl-field">
                Account
                <select value={selectedTpid} onChange={(e) => pickAccount(e.target.value)}>
                  <option value="">Select an account…</option>
                  {accountOptions.map((a) => <option key={a.tpid} value={a.tpid}>{a.name}</option>)}
                </select>
              </label>
            </div>
            <div className="wl-discover-actions">
              <button className="btn btn-primary" onClick={runDiscover} disabled={discovering || !selectedTpid || !draft.description.trim()}>
                {discovering ? <Spinner size="tiny" /> : <SparkleRegular />} Discover
              </button>
              {discoverInfo ? <span className="wl-muted">{discoverInfo}</span> : null}
            </div>
            {discoverError ? <div className="alert-error">{discoverError}</div> : null}
            {signals.length ? (
              <div className="wl-discover-signals">
                <div className="wl-discover-signals-head">Matched communications ({signals.filter((s) => s.included).length}/{signals.length})</div>
                <ul>
                  {signals.map((s) => {
                    const Icon = DISCOVER_ICONS[s.signalType] || MailRegular;
                    return (
                      <li key={`${s.signalType}:${s.nativeId}`} className={s.included ? '' : 'wl-excluded'}>
                        <Icon className="wl-li-icon" />
                        <span className="wl-li-main">
                          <span className="wl-li-title">{s.signalTitle || '(no subject)'}</span>
                          {s.rationale ? <span className="wl-li-sub">{s.rationale}</span> : null}
                        </span>
                        <button
                          type="button"
                          className="wl-icon-btn"
                          title={s.included ? 'Exclude from this workload' : 'Include in this workload'}
                          onClick={() => setSignals((prev) => prev.map((x) => (x.nativeId === s.nativeId && x.signalType === s.signalType ? { ...x, included: !x.included } : x)))}
                        >
                          {s.included ? <DeleteRegular /> : <AddRegular />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </section>

          {/* Editable fields */}
          <div className="wl-form-row">
            <label className="wl-field wl-grow">
              Name <span className="wl-req">*</span>
              <input value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} />
            </label>
            <label className="wl-field">
              Category
              <select value={draft.category} onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>

          {/* Gated opportunities + milestones (available once an account is chosen). A workload can
              carry several opportunities; its SSP is derived from those opportunities (the account's
              specialist), so there is no single-opportunity or manual-SSP field here. */}
          {selectedTpid ? (
            <Section title="Opportunities and milestones" count={addedOpps.length}>
              {availableOpps.length ? (
                <ul className="wl-sug-opp-list">
                  {availableOpps.map((opp) => {
                    const added = addedOppIds.has(opp.opportunity_id);
                    const oppMs = milestonesByOpp.get(opp.opportunity_id) || [];
                    return (
                      <li key={opp.opportunity_id} className={`wl-sug-opp${added ? ' added' : ''}`}>
                        <div className="wl-sug-opp-head">
                          <FlagRegular className="wl-li-icon" />
                          <span className="wl-li-main">
                            <span className="wl-li-title">{opp.name}</span>
                            <span className="wl-li-sub">{opp.ssp_name ? `SSP · ${opp.ssp_name}` : 'No SSP'}</span>
                          </span>
                          {added ? (
                            <button className="wl-link-btn wl-danger" onClick={() => removeOpportunity(opp)}><DeleteRegular /> Remove</button>
                          ) : (
                            <button className="wl-link-btn" onClick={() => addOpportunity(opp)}><AddRegular /> Add opportunity</button>
                          )}
                        </div>
                        {added ? (
                          <div className="wl-sug-ms">
                            {oppMs.length ? oppMs.map((ms) => {
                              const msAdded = addedMsIds.has(ms.milestone_id);
                              return (
                                <div key={ms.milestone_id} className={`wl-sug-ms-row${msAdded ? ' added' : ''}`}>
                                  <FlagRegular className="wl-li-icon" />
                                  <span className="wl-li-main">
                                    <span className="wl-li-title">{ms.name}</span>
                                    {ms.status_label ? <span className="wl-li-sub">{ms.status_label}</span> : null}
                                  </span>
                                  {msAdded ? (
                                    <button className="wl-icon-btn" title={`Remove ${ms.name}`} onClick={() => removeMilestone(ms)}><DeleteRegular /></button>
                                  ) : (
                                    <button className="wl-link-btn wl-sm" onClick={() => addMilestone(opp, ms)}><AddRegular /> Add</button>
                                  )}
                                </div>
                              );
                            }) : <p className="wl-section-empty wl-muted">No milestones on this opportunity.</p>}
                          </div>
                        ) : (
                          <p className="wl-sug-gate wl-muted">Add this opportunity to choose its milestones.</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="wl-section-empty wl-muted">No open opportunities found for this account.</p>}
            </Section>
          ) : null}

          {createError ? <div className="alert-error">{createError}</div> : null}
        </div>

        <div className="wl-form-actions wl-create-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={creating || !draft.name.trim()}>
            {creating ? <Spinner size="tiny" /> : null} Create workload
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkloadsWorkspace({ embedded = false, initialOpenWorkloadId = null, onOpenWorkloadHandled }) {
  const { data: workloads, loading, initialLoading, error, refresh } = useDbQuery(WORKLOADS_SQL);
  const { data: milestoneOptions } = useDbQuery(MILESTONES_SQL);
  const { data: opportunityOptions } = useDbQuery(OPPORTUNITIES_SQL);
  const { data: suggestions, refresh: refreshSuggestions } = useDbQuery(SUGGESTIONS_SQL);
  // Cloud & AI Specialists for the account picker's pinned section. Sourced from the curated
  // Account Team roster (same as the Milestone Map/Timeline filters), NOT from raw opportunity
  // owner names — that roster is the user's own account-to-specialist association, so it lists
  // only specialists tied to the user's accounts rather than every opp owner in the system.
  const { data: specialistRoleRows } = useDbQuery(SSP_ROLES_SQL);
  // TPID -> top-parent account name, so every account label on this surface (workload cards, the
  // Customer filter, and the Suggest picker) shows the PARENT account, never a child under the TPID.
  const { data: parentAccounts } = useDbQuery(PARENT_ACCOUNTS_SQL);
  const parentNameByTpid = useMemo(() => {
    const map = new Map();
    for (const p of parentAccounts || []) {
      map.set(String(p.tpid), p.top_name || p.any_name || null);
    }
    return map;
  }, [parentAccounts]);
  const [openWorkloadId, setOpenWorkloadId] = useState(null);
  // Allow a parent (e.g. the Action Center) to request opening a specific workload's popup.
  useEffect(() => {
    if (initialOpenWorkloadId != null) {
      setOpenWorkloadId(initialOpenWorkloadId);
      onOpenWorkloadHandled?.();
    }
  }, [initialOpenWorkloadId, onOpenWorkloadHandled]);
  const [openSuggestionId, setOpenSuggestionId] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestFlash, setSuggestFlash] = useState('');
  // Account scoping for "Suggest workloads": a Set of selected account LABELS. Defaults to
  // "all" (every option selected) and is healed toward all until the user narrows it. An
  // explicit narrowing is passed to the backend as tpids; leaving it at all scans the roster.
  const [suggestAccounts, setSuggestAccounts] = useState(null);
  const suggestAccountsTouched = useRef(false);
  // Orthogonal SSP quick-filter (mirrors the milestone pages' pinned "Cloud & AI Specialists"
  // section): a 0- or 1-element Set of SSP names that AND-narrows the account selection.
  const [suggestSsp, setSuggestSsp] = useState(new Set());
  // Batch "Milestone AI" — run Find-signal → Comment AI → HoK AI across every linked milestone,
  // then let the user review/edit/submit each draft. Delete only discards the draft (no blocklist).
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [batchResults, setBatchResults] = useState([]);
  const [batchError, setBatchError] = useState('');
  // Live workflow popup: shows each milestone's pipeline (Join deal team → Gather activity → Draft
  // comment → Suggest activities) churning step-by-step, with per-milestone and global "retry from
  // the failed step" controls. Auto-opens when a run starts.
  const [workflowOpen, setWorkflowOpen] = useState(false);
  // Ref mirror of batchResults so the async pipeline can read the freshest per-milestone state
  // (e.g. "is this step already submitted?") between awaits without stale closures.
  const batchResultsRef = useRef([]);
  useEffect(() => { batchResultsRef.current = batchResults; }, [batchResults]);
  // Which workload the current Milestone AI run/drafts belong to (the button now lives in the
  // workload popup, so a run is always scoped to one workload).
  const [batchWorkloadId, setBatchWorkloadId] = useState(null);
  // Which flavor of run produced the current drafts: 'full' (Find signal → Comment AI → HoK AI)
  // or 'find' (Find Related — signal search only). Drives the per-button "…" spinner label.
  const [batchMode, setBatchMode] = useState('full');
  const [listAccounts, setListAccounts] = useState(() => new Set()); // workloads-list filter: account labels
  const [listSsp, setListSsp] = useState(() => new Set());           // workloads-list filter: SSP names
  const [showCreate, setShowCreate] = useState(false);
  const [mutationError, setMutationError] = useState('');

  // Shared milestone detail popup (Related signals / recent comments / recent activities),
  // reusing the exact panel from the Milestone Map so saved workloads surface the same data.
  const [flash, setFlash] = useState(null);
  const [msDetail, setMsDetail] = useState(null);
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const teamApi = useTeamApi({ refresh, onFlash: setFlash });

  useEffect(() => {
    getMsxSettings().then((s) => setCrmBaseUrl(s.crmUrl || '')).catch(() => {});
  }, []);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(timer);
  }, [flash]);

  // Resolve the full local milestone row by id, then open the shared DetailCard. If the
  // milestone isn't mirrored locally we say so plainly rather than opening an empty panel.
  const openMilestoneDetail = useCallback(async (milestoneId) => {
    if (!milestoneId) return;
    try {
      const rows = await dbQuery(
        `SELECT m.*, o.name AS opp_name, o.customer_name
           FROM active_milestones m LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
          WHERE m.milestone_id = ?`,
        [milestoneId],
      );
      if (Array.isArray(rows) && rows.length) {
        setMsDetail({ type: 'ms', data: rows[0] });
      } else {
        setFlash({ type: 'warning', msg: 'This milestone is not in the local dataset yet — sync from CRM to view its details.' });
      }
    } catch (err) {
      setFlash({ type: 'error', msg: err.message || String(err) });
    }
  }, []);

  const customerOptions = useMemo(
    () => unique(workloads.flatMap((workload) => workloadCustomerNames(workload, parentNameByTpid))),
    [workloads, parentNameByTpid],
  );
  // SSP options for the workloads filter come ONLY from the curated customer-profile roster
  // (customer_account_team_roles → w.profile_ssp_name), matching the Milestone Timeline — NOT from
  // opportunity/milestone owners. Scoped to SSPs on accounts that actually have a workload here.
  const sspOptions = useMemo(
    () => unique(workloads.map((workload) => workload.profile_ssp_name).filter(Boolean)),
    [workloads],
  );

  // Account picker for "Suggest workloads" — reuses Milestones' FilterDropdown. Options are
  // the open-opportunity accounts (one label per tpid, matching the milestone filter list),
  // with a "Cloud & AI Specialists" section (sourced from the curated Account Team roster,
  // same as the milestone filters) that bulk-selects the accounts each specialist is tied to.
  const suggestAccountIndex = useMemo(() => {
    const tpidsWithOpps = new Set();
    for (const o of opportunityOptions || []) {
      const tpid = o.customer_tpid != null && String(o.customer_tpid).trim() !== '' ? String(o.customer_tpid) : null;
      if (tpid) tpidsWithOpps.add(tpid);
    }
    // Label each TPID by its top-parent account (never a child under the same TPID), falling back
    // to the raw opportunity customer name only when no parent row resolves.
    const fallbackNameByTpid = new Map();
    for (const o of opportunityOptions || []) {
      const tpid = o.customer_tpid != null && String(o.customer_tpid).trim() !== '' ? String(o.customer_tpid) : null;
      if (tpid && !fallbackNameByTpid.has(tpid)) fallbackNameByTpid.set(tpid, o.customer_name || 'Unknown');
    }
    const labelForTpid = new Map();
    for (const tpid of tpidsWithOpps) {
      labelForTpid.set(tpid, parentNameByTpid.get(tpid) || fallbackNameByTpid.get(tpid) || 'Unknown account');
    }
    const labelToTpids = new Map();
    for (const [tpid, label] of labelForTpid) {
      if (!labelToTpids.has(label)) labelToTpids.set(label, new Set());
      labelToTpids.get(label).add(tpid);
    }
    const sspToLabels = new Map();
    for (const r of specialistRoleRows || []) {
      const tpid = r.tpid != null && String(r.tpid).trim() !== '' ? String(r.tpid) : null;
      const ssp = (r.person_name || '').trim();
      if (!tpid || !ssp) continue;
      const label = labelForTpid.get(tpid);
      // Only map to accounts that are actually in the picker (i.e. have open opportunities).
      if (!label) continue;
      if (!sspToLabels.has(ssp)) sspToLabels.set(ssp, new Set());
      sspToLabels.get(ssp).add(label);
    }
    const options = [...labelToTpids.keys()].sort();
    // Only surface specialists that map to at least one account shown in the picker — these are
    // the ones the user associated to their accounts. Avoids listing specialists whose accounts
    // aren't in scope (which would be dead-end pills that select nothing).
    const sspNames = [...sspToLabels.keys()].sort();
    return { options, labelToTpids, sspToLabels, sspNames };
  }, [opportunityOptions, specialistRoleRows, parentNameByTpid]);

  // Heal the selection toward "all accounts" while the user has not narrowed it, so the
  // dropdown reads cleanly (no "(0)") and new option loads default to everything selected.
  useEffect(() => {
    if (!suggestAccountsTouched.current) {
      setSuggestAccounts(new Set(suggestAccountIndex.options));
    }
  }, [suggestAccountIndex.options]);
  const suggestSelected = suggestAccounts || new Set(suggestAccountIndex.options);
  // Effective account labels = the checkbox selection AND-narrowed by the active SSP pill (if
  // any). This mirrors how the milestone pages combine the account list with the SSP section.
  const suggestEffectiveLabels = useMemo(() => {
    let labels = [...suggestSelected];
    if (suggestSsp.size > 0) {
      const allowed = new Set();
      for (const ssp of suggestSsp) {
        for (const label of (suggestAccountIndex.sspToLabels.get(ssp) || [])) allowed.add(label);
      }
      labels = labels.filter((label) => allowed.has(label));
    }
    return labels;
  }, [suggestSelected, suggestSsp, suggestAccountIndex]);
  const suggestScansAll = suggestSsp.size === 0
    && suggestSelected.size >= suggestAccountIndex.options.length;

  const filtered = useMemo(() => workloads.filter((workload) => {
    const accts = workloadCustomerNames(workload, parentNameByTpid);
    const acctOk = listAccounts.size === 0 || accts.some((a) => listAccounts.has(a));
    // SSP match uses the curated customer-profile SSP (w.profile_ssp_name), not opportunity owners.
    const sspOk = listSsp.size === 0 || (!!workload.profile_ssp_name && listSsp.has(workload.profile_ssp_name));
    return acctOk && sspOk;
  }), [workloads, listAccounts, listSsp, parentNameByTpid]);

  function onWorkloadCreated(workloadId) {
    setShowCreate(false);
    setMutationError('');
    refresh();
    if (workloadId) setOpenWorkloadId(workloadId);
  }

  async function moveWorkload(workload, direction) {
    const index = workloads.findIndex((item) => item.id === workload.id);
    const other = workloads[index + direction];
    if (!other) return;
    try {
      setMutationError('');
      await runDb(
        `UPDATE workloads
         SET sort_order = CASE id
           WHEN ? THEN ?
           WHEN ? THEN ?
           ELSE sort_order
         END,
         updated_at = CURRENT_TIMESTAMP
         WHERE id IN (?, ?)`,
        [
          workload.id,
          other.sort_order,
          other.id,
          workload.sort_order,
          workload.id,
          other.id,
        ],
      );
      refresh();
    } catch (err) {
      setMutationError(err.message || String(err));
    }
  }

  async function deleteWorkload(id) {
    try {
      await runDb('DELETE FROM workloads WHERE id = ?', [id]);
      if (openWorkloadId === id) setOpenWorkloadId(null);
      refresh();
    } catch (err) {
      setMutationError(err.message || String(err));
    }
  }

  async function runSuggest() {
    // Account scoping: an explicit narrowing is sent as tpids; a full selection (all accounts,
    // no SSP pill) keeps the default whole-roster scan. An empty effective selection means the
    // user cleared everything — fail loudly instead of silently scanning everything.
    const allOptions = suggestAccountIndex.options;
    if (allOptions.length > 0 && suggestEffectiveLabels.length === 0) {
      setMutationError('Select at least one account to suggest for, or choose Select All to scan every account.');
      return;
    }
    let scopedTpids = [];
    if (!suggestScansAll) {
      const set = new Set();
      for (const label of suggestEffectiveLabels) {
        for (const tpid of (suggestAccountIndex.labelToTpids.get(label) || [])) set.add(tpid);
      }
      scopedTpids = [...set];
    }

    // A completed run REPLACES the entire draft set (see se-suggest-workloads). Guard
    // against an accidental re-click silently wiping any in-progress, un-approved
    // curation (opportunities/milestones added via "Build details").
    const existing = suggestions.length;
    if (existing > 0) {
      const ok = window.confirm(
        `This will replace ${existing} current suggestion${existing === 1 ? '' : 's'}, `
        + 'including any unsaved opportunity or milestone edits. Approved workloads are not affected. Continue?',
      );
      if (!ok) return;
    }
    setSuggesting(true);
    setMutationError('');
    setSuggestFlash('');
    try {
      const res = await suggestWorkloads(scopedTpids.length ? { tpids: scopedTpids } : {});
      if (res?.ok === false) {
        setMutationError(res.error || 'Workload suggestion failed.');
      } else {
        refreshSuggestions();
        const scanned = res.accountsScanned || 0;
        setSuggestFlash(res.count
          ? `Suggested ${res.count} workload${res.count === 1 ? '' : 's'} from ${scanned} account${scanned === 1 ? '' : 's'} with recent activity.`
          : `No workloads worth suggesting from the last 4 weeks of activity across ${scanned} account${scanned === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      setMutationError(err.message || String(err));
    } finally {
      setSuggesting(false);
    }
  }

  async function approveSuggestion(suggestion) {
    try {
      setMutationError('');
      setSuggestFlash('');
      const result = await workloadApproveSuggestion({ suggestionId: suggestion.id });
      if (openSuggestionId === suggestion.id) setOpenSuggestionId(null);
      refreshSuggestions();
      refresh();
      if (result?.workloadId) setOpenWorkloadId(result.workloadId);
    } catch (err) {
      setMutationError(err.message || String(err));
    }
  }

  async function deleteSuggestion(suggestion) {
    try {
      setMutationError('');
      // Delete PERMANENTLY dismisses: record the account + stable concept key so future "Suggest
      // workloads" runs never re-propose the same effort (exact (tpid, concept_key) match, stable
      // across runs and volume-independent), then remove the draft. Record the dismissal FIRST — if
      // it fails, the draft is left intact and the error is surfaced (fail loud). INSERT OR IGNORE
      // keeps re-dismissing the same concept idempotent (unique index on tpid + concept_key).
      await runDb(
        `INSERT OR IGNORE INTO workload_suggestion_dismissals
           (tpid, account_name, title, description, source_json, concept_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          suggestion.tpid,
          suggestion.account_name || null,
          suggestion.title || '',
          suggestion.description || null,
          suggestion.source_json || null,
          suggestion.concept_key || null,
        ],
      );
      await runDb('DELETE FROM workload_suggestions WHERE id = ?', [suggestion.id]);
      if (openSuggestionId === suggestion.id) setOpenSuggestionId(null);
      refreshSuggestions();
    } catch (err) {
      setMutationError(err.message || String(err));
    }
  }

  // ── Batch "Milestone AI" ────────────────────────────────────────────────
  // Run the three milestone-popup AI actions (Find signal → Comment AI → HoK AI) across every
  // milestone linked to any workload, then surface each draft for review/edit/submit. Deleting a
  // draft only discards it locally (no persistence, no blocklist) — matching the app's pattern.
  function updateBatchItem(milestoneId, updater) {
    setBatchResults((prev) => prev.map((it) => (it.milestoneId === milestoneId ? updater(it) : it)));
  }
  function setBatchCommentText(milestoneId, text) {
    updateBatchItem(milestoneId, (it) => ({ ...it, comment: { ...(it.comment || { submitted: false }), text } }));
  }
  // After a reject, drop the whole milestone block when nothing actionable remains — i.e. no
  // comment draft/confirmation and no HoK drafts/confirmations left. This removes the now-empty
  // suggestion section the run created. Submitted (✓) items are kept as confirmation, not pruned.
  function itemHasContent(it) {
    const hasComment = !!it.comment; // draft, note, or submitted ✓
    const hasHoks = Array.isArray(it.hoks) && it.hoks.length > 0;
    return hasComment || hasHoks;
  }
  function updateOrPruneBatchItem(milestoneId, updater) {
    setBatchResults((prev) => prev.flatMap((it) => {
      if (it.milestoneId !== milestoneId) return [it];
      const next = updater(it);
      return itemHasContent(next) ? [next] : [];
    }));
  }
  function deleteBatchComment(milestoneId) {
    updateOrPruneBatchItem(milestoneId, (it) => ({ ...it, comment: null, commentError: '' }));
  }
  function updateBatchHok(milestoneId, hokId, patch) {
    updateBatchItem(milestoneId, (it) => ({
      ...it,
      hoks: it.hoks.map((h) => (h.id === hokId ? { ...h, ...patch } : h)),
    }));
  }
  function deleteBatchHok(milestoneId, hokId) {
    updateOrPruneBatchItem(milestoneId, (it) => ({ ...it, hoks: it.hoks.filter((h) => h.id !== hokId), hokError: '' }));
  }

  async function submitBatchComment(item) {
    const text = (item.comment?.text || '').trim();
    if (!text) return;
    updateBatchItem(item.milestoneId, (it) => ({ ...it, comment: { ...it.comment, busy: true }, commentError: '' }));
    try {
      await teamApi.addMilestoneComment(item.milestoneId, text);
      updateBatchItem(item.milestoneId, (it) => ({ ...it, comment: { ...it.comment, busy: false, submitted: true } }));
    } catch (err) {
      updateBatchItem(item.milestoneId, (it) => ({ ...it, comment: { ...it.comment, busy: false }, commentError: err.message || String(err) }));
    }
  }

  async function submitBatchHok(item, hok) {
    const subject = (hok.subject || '').trim();
    if (!subject) return;
    updateBatchHok(item.milestoneId, hok.id, { busy: true, error: '' });
    try {
      await teamApi.addActivity('ms', item.milestoneId, {
        subject,
        taskCategory: hok.category,
        dueDate: hok.dueDate || '',
        description: hok.description,
      });
      updateBatchHok(item.milestoneId, hok.id, { busy: false, submitted: true });
    } catch (err) {
      updateBatchHok(item.milestoneId, hok.id, { busy: false, error: err.message || String(err) });
    }
  }

  // Execute ONE named pipeline step for a milestone. Returns a patch of the item's draft fields on
  // success (merged by the caller); throws on genuine failure. Informational empties ("no recent
  // activity", "no signal linked") are SUCCESS — they return a note field, not a throw — so the
  // workflow popup marks the step done rather than failed. Provider-not-configured bubbles as a
  // ProviderAbort so the whole run stops loudly instead of repeating the same error N times.
  async function execMilestoneStep(milestoneId, key) {
    if (key === 'dealTeam') {
      await teamApi.ensureOnMilestoneTeam(milestoneId);
      return {};
    }
    if (key === 'find') {
      const sig = await findMilestoneSignal({ milestoneId });
      if (sig && sig.ok) return { signalCount: Array.isArray(sig.links) ? sig.links.length : 0 };
      const msg = (sig && sig.error) || 'Signal search failed.';
      if (isProviderError(msg)) throw new ProviderAbort(msg);
      throw new Error(msg);
    }
    if (key === 'comment') {
      const cm = await suggestMilestoneComment({ milestoneId });
      if (cm && cm.ok) {
        if (cm.hasActivity && cm.suggestion) return { comment: { text: cm.suggestion, submitted: false } };
        return { comment: { text: '', submitted: false, note: cm.message || 'No recent activity to summarize.' } };
      }
      const msg = (cm && cm.error) || 'Comment suggestion failed.';
      if (isProviderError(msg)) throw new ProviderAbort(msg);
      throw new Error(msg);
    }
    if (key === 'hok') {
      const hk = await suggestMilestoneHokActivity({ milestoneId });
      if (hk && hk.ok) {
        const list = Array.isArray(hk.suggestions) ? hk.suggestions : (hk.suggestion ? [hk.suggestion] : []);
        if (!list.length) {
          return { hoks: [], hokNote: hk.message || (hk.hasSignal ? 'No HoK activity warranted by the linked signal.' : 'No related signal linked to summarize.') };
        }
        return {
          hoks: list.map((s, idx) => ({
            id: `${milestoneId}-hok-${idx}`,
            subject: s.subject || '',
            description: s.description || '',
            category: s.category != null ? String(s.category) : '',
            dueDate: '',
            submitted: false,
          })),
          hokNote: '',
        };
      }
      const msg = (hk && hk.error) || 'HoK suggestion failed.';
      if (isProviderError(msg)) throw new ProviderAbort(msg);
      throw new Error(msg);
    }
    return {};
  }

  // Run a milestone's pipeline from `startIndex` to the end, updating the popup live as each step
  // flips pending → running → ok/failed. Already-SUBMITTED comment/HoK steps are skipped so a retry
  // never clobbers work the SE already logged. A failed step does not stop the milestone — later
  // steps still attempt (matching the original behavior) — so one "retry from the failed step" pass
  // recovers everything from that point. ProviderAbort propagates to stop the whole run.
  async function runMilestonePipeline(milestoneId, keys, startIndex) {
    for (let i = startIndex; i < keys.length; i += 1) {
      const key = keys[i];
      const snap = batchResultsRef.current.find((x) => x.milestoneId === milestoneId);
      if (key === 'comment' && snap?.comment?.submitted) continue;
      if (key === 'hok' && Array.isArray(snap?.hoks) && snap.hoks.length && snap.hoks.every((h) => h.submitted)) continue;

      updateBatchItem(milestoneId, (it) => syncStepErrors({ ...it, steps: setStep(it.steps, key, { status: 'running', error: '' }) }));
      try {
        const patch = await execMilestoneStep(milestoneId, key);
        updateBatchItem(milestoneId, (it) => syncStepErrors({ ...it, ...patch, steps: setStep(it.steps, key, { status: 'ok', error: '' }) }));
      } catch (err) {
        if (err instanceof ProviderAbort) throw err;
        const msg = err.message || String(err);
        updateBatchItem(milestoneId, (it) => syncStepErrors({ ...it, steps: setStep(it.steps, key, { status: 'failed', error: msg }) }));
      }
    }
  }

  async function runBatchMilestoneAi(workloadId = null, mode = 'full') {
    if (batchRunning) return;
    // Guard against an accidental re-click wiping in-progress, unsaved edits.
    if (batchResults.length) {
      const ok = window.confirm(
        `This will discard the current ${batchResults.length} milestone AI result${batchResults.length === 1 ? '' : 's'} `
        + '(including any unsaved comment or activity edits) and re-run. Continue?',
      );
      if (!ok) return;
    }
    setBatchError('');
    setBatchResults([]);
    setBatchProgress(null);
    setBatchWorkloadId(workloadId);
    setBatchMode(mode);
    setWorkflowOpen(true); // the popup shows the run churn through each step

    // Provider preflight — fail loudly before doing any work if no model is configured.
    let status;
    try {
      status = await modelProviderStatus();
    } catch (err) {
      setBatchError(err.message || String(err));
      return;
    }
    if (!status || !status.active) {
      setBatchError('No AI model provider is configured. Connect GitHub Copilot (Settings → AI Model) or configure Azure AI Foundry, then try again.');
      return;
    }

    // Enumerate the distinct milestones linked to the target workload (a milestone may link to
    // several workloads; scoped by workloadId when the run is launched from a workload popup).
    let rows;
    try {
      rows = await dbQuery(
        `SELECT l.milestone_id AS milestone_id,
                l.milestone_name AS milestone_name,
                l.customer_name AS customer_name,
                COALESCE(NULLIF(TRIM(w.title), ''), w.name) AS workload_name
           FROM active_workload_milestone_links l
           JOIN active_workloads w ON w.id = l.workload_id
          WHERE COALESCE(TRIM(l.milestone_id), '') <> ''
            ${workloadId != null ? 'AND l.workload_id = ?' : ''}
          ORDER BY w.sort_order, w.id, l.created_at, l.id`,
        workloadId != null ? [workloadId] : [],
      );
    } catch (err) {
      setBatchError(err.message || String(err));
      return;
    }

    const seen = new Set();
    const targets = [];
    for (const row of (rows || [])) {
      const id = String(row.milestone_id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      targets.push({
        milestoneId: id,
        milestoneName: (row.milestone_name || '').trim() || id,
        workloadName: (row.workload_name || '').trim() || 'Workload',
        customerName: (row.customer_name || '').trim(),
      });
    }

    if (!targets.length) {
      setBatchError('No milestones are linked to this workload yet. Link a milestone first, then run Milestone AI.');
      return;
    }

    // Seed every milestone up front with its full step list (all 'pending') so the popup shows the
    // entire plan immediately, then fills in as the run advances.
    const keys = milestoneAiStepKeys(mode);
    const initial = targets.map((t) => ({
      milestoneId: t.milestoneId,
      milestoneName: t.milestoneName,
      workloadName: t.workloadName,
      customerName: t.customerName,
      signalCount: 0,
      comment: null,
      commentError: '',
      hoks: [],
      hokError: '',
      hokNote: '',
      errors: [],
      steps: makeStepList(milestoneAiStepKeys(mode)),
    }));
    setBatchResults(initial);
    batchResultsRef.current = initial;

    setBatchRunning(true);
    const total = targets.length;
    try {
      for (let i = 0; i < targets.length; i += 1) {
        setBatchProgress({ done: i, total, label: targets[i].milestoneName });
        await runMilestonePipeline(targets[i].milestoneId, keys, 0);
      }
      setBatchProgress({ done: total, total, label: '' });
    } catch (err) {
      setBatchError(err instanceof ProviderAbort ? err.message : (err.message || String(err)));
    } finally {
      setBatchRunning(false);
    }
  }

  // Retry ONE milestone from its first failed step onward (idempotent: additive signal search,
  // regenerated drafts; submitted steps are skipped). Used by the per-milestone button in the popup.
  async function retryMilestone(milestoneId) {
    if (batchRunning) return;
    const snap = batchResultsRef.current.find((x) => x.milestoneId === milestoneId);
    if (!snap) return;
    const start = firstFailedStepIndex(snap.steps);
    if (start < 0) return;
    const keys = snap.steps.map((s) => s.key);
    setBatchError('');
    setBatchRunning(true);
    setBatchProgress({ done: 0, total: 1, label: `Retrying ${snap.milestoneName}` });
    try {
      await runMilestonePipeline(milestoneId, keys, start);
      setBatchProgress({ done: 1, total: 1, label: '' });
    } catch (err) {
      setBatchError(err instanceof ProviderAbort ? err.message : (err.message || String(err)));
    } finally {
      setBatchRunning(false);
    }
  }

  // Retry every milestone that has a failed step, each from its own first failure. Used by the
  // global "Retry all failures" button in the popup footer.
  async function retryAllFailures() {
    if (batchRunning) return;
    const failing = batchResultsRef.current.filter(itemHasFailure);
    if (!failing.length) return;
    setBatchError('');
    setBatchRunning(true);
    const total = failing.length;
    try {
      for (let i = 0; i < failing.length; i += 1) {
        const it = failing[i];
        setBatchProgress({ done: i, total, label: `Retrying ${it.milestoneName}` });
        await runMilestonePipeline(it.milestoneId, it.steps.map((s) => s.key), Math.max(0, firstFailedStepIndex(it.steps)));
      }
      setBatchProgress({ done: total, total, label: '' });
    } catch (err) {
      setBatchError(err instanceof ProviderAbort ? err.message : (err.message || String(err)));
    } finally {
      setBatchRunning(false);
    }
  }

  // Bundle the batch state + handlers so the workload popup (WorkloadModal → MilestonesSection)
  // can trigger a scoped run and render its drafts. `workloadId` scopes results to one workload.
  const batchApi = useMemo(() => ({
    workloadId: batchWorkloadId,
    mode: batchMode,
    results: batchResults,
    running: batchRunning,
    progress: batchProgress,
    error: batchError,
    run: (workloadId) => runBatchMilestoneAi(workloadId, 'full'),
    retryMilestone,
    retryAllFailures,
    openWorkflow: () => setWorkflowOpen(true),
    setBatchCommentText,
    deleteBatchComment,
    submitBatchComment,
    updateBatchHok,
    deleteBatchHok,
    submitBatchHok,
  }), [batchWorkloadId, batchMode, batchResults, batchRunning, batchProgress, batchError]);

  return (
    <div className={embedded ? 'wl-workspace-embedded' : ''}>
      {embedded ? (
        <div className="wl-embedded-head">
          <span className="wl-muted wl-batch-hint">Open a card to view, build, or approve — each opens in a popup.</span>
        </div>
      ) : (
        <div className="page-header wl-page-header">
          <div>
            <h1>Workload Management</h1>
            <p className="wl-intro">
              Organize reusable customer efforts as cards. Each workload connects opportunities,
              milestones, and the communications that ground them.
            </p>
          </div>
          <div className="wl-header-actions">
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <AddRegular /> New workload
            </button>
          </div>
        </div>
      )}

      {mutationError ? <div className="alert-error">{mutationError}</div> : null}
      {error ? <div className="alert-error">{error}</div> : null}

      <div className="wl-filterbar">
        <div className="diagram-filters">
          <FilterDropdown
            label="Filter"
            options={customerOptions}
            selected={listAccounts}
            onChange={(next) => setListAccounts(next)}
            pinned={{
              label: 'SSP',
              options: sspOptions,
              isActive: (ssp) => listSsp.has(ssp),
              onPick: (ssp) => setListSsp((prev) => {
                const n = new Set(prev);
                if (n.has(ssp)) n.delete(ssp); else n.add(ssp);
                return n;
              }),
            }}
          />
        </div>
        <span className="wl-filter-count">{filtered.length} of {workloads.length} workloads</span>
      </div>

      {initialLoading ? (
        <div className="wl-empty"><Spinner size="small" /> Loading workloads...</div>
      ) : filtered.length ? (
        <div className={`wl-grid${loading ? ' is-refreshing' : ''}`}>
          {filtered.map((workload) => {
            const fullIndex = workloads.findIndex((item) => item.id === workload.id);
            return (
              <WorkloadCard
                key={workload.id}
                workload={workload}
                onOpen={() => setOpenWorkloadId(workload.id)}
                onMove={(direction) => moveWorkload(workload, direction)}
                canMoveUp={fullIndex > 0}
                canMoveDown={fullIndex >= 0 && fullIndex < workloads.length - 1}
                parentNameByTpid={parentNameByTpid}
              />
            );
          })}
        </div>
      ) : (
        <div className="wl-empty card">
          {workloads.length
            ? 'No workload cards match this filter.'
            : 'No workloads yet. Create the first card and connect it to an opportunity or milestone.'}
        </div>
      )}

      <section className="wl-suggest-section">
        <div className="wl-suggest-bar">
          {embedded ? (
            <button className="btn btn-primary wl-sm" data-tour="wl-new" onClick={() => setShowCreate(true)}>
              <AddRegular /> New workload
            </button>
          ) : null}
          <button className="eng-detail-ai" data-tour="suggest-workloads" onClick={runSuggest} disabled={suggesting}>
            {suggesting ? <Spinner size="tiny" /> : <SparkleRegular />} Suggest workloads
          </button>
          {suggestAccountIndex.options.length > 0 ? (
            <div className="diagram-filters">
              <FilterDropdown
                label="Accounts"
                options={suggestAccountIndex.options}
                selected={suggestSelected}
                onChange={(next) => { suggestAccountsTouched.current = true; setSuggestAccounts(next); }}
                pinned={{
                  label: 'Cloud & AI Specialists',
                  options: suggestAccountIndex.sspNames,
                  isActive: (ssp) => suggestSsp.size === 1 && suggestSsp.has(ssp),
                  onPick: (ssp) => setSuggestSsp((prev) => (
                    prev.size === 1 && prev.has(ssp) ? new Set() : new Set([ssp])
                  )),
                }}
              />
            </div>
          ) : null}
          <span className="wl-muted wl-batch-hint">
            Proposes new workloads from the last 4 weeks of emails, meetings, and Teams chats.
            {suggestAccountIndex.options.length > 0
              ? (suggestScansAll
                  ? ' Scanning all accounts.'
                  : ` Scoped to ${suggestEffectiveLabels.length} account${suggestEffectiveLabels.length === 1 ? '' : 's'}.`)
              : null}
          </span>
        </div>
        {suggestFlash ? <div className="wl-suggest-flash">{suggestFlash}</div> : null}
        {suggestions.length ? (
          <section className="wl-suggestions">
            <div className="wl-suggestions-head">
              <h3><SparkleRegular /> Suggested workloads <span className="wl-count">({suggestions.length})</span></h3>
              <p className="wl-muted">
                Proposed from the last 4 weeks of emails, meetings, and Teams chats. Approve to convert a
                suggestion into a workload, open it to add opportunities and milestones, or delete to permanently dismiss it (it will not be suggested again).
              </p>
            </div>
            <div className="wl-grid">
              {suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  onOpen={() => setOpenSuggestionId(suggestion.id)}
                  onApprove={approveSuggestion}
                  onDelete={deleteSuggestion}
                />
              ))}
            </div>
          </section>
        ) : null}
      </section>

      {showCreate ? (
        <CreateWorkloadModal
          opportunityOptions={opportunityOptions}
          onCreated={onWorkloadCreated}
          onClose={() => setShowCreate(false)}
        />
      ) : null}

      {(() => {
        const openSuggestion = suggestions.find((s) => s.id === openSuggestionId);
        if (!openSuggestion) return null;
        return (
          <SuggestionModal
            suggestion={openSuggestion}
            refreshSuggestions={refreshSuggestions}
            onApprove={approveSuggestion}
            onDelete={deleteSuggestion}
            setError={setMutationError}
            onClose={() => setOpenSuggestionId(null)}
          />
        );
      })()}

      {(() => {
        const openWorkload = workloads.find((w) => w.id === openWorkloadId);
        if (!openWorkload) return null;
        return (
          <WorkloadModal
            workload={openWorkload}
            milestoneOptions={milestoneOptions}
            refreshCards={refresh}
            onDelete={deleteWorkload}
            onOpenMilestone={openMilestoneDetail}
            onClose={() => setOpenWorkloadId(null)}
            parentNameByTpid={parentNameByTpid}
            batchApi={batchApi}
          />
        );
      })()}

      <DetailCard
        detail={msDetail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setMsDetail(null)}
        onSelect={setMsDetail}
        teamApi={teamApi}
      />
      {workflowOpen ? (
        <BatchWorkflowPopup batchApi={batchApi} onClose={() => setWorkflowOpen(false)} />
      ) : null}
      {flash ? (
        <div className={`flash-message flash-${flash.type === 'error' ? 'error' : flash.type === 'warning' ? 'warning' : 'success'}`}>
          {flash.msg}
        </div>
      ) : null}
    </div>
  );
}

// Thin page wrapper — the standalone Workload Management route renders the full workspace.
// The same workspace is embedded (compact header) as a section inside the Action Center.
export default function WorkloadManagement() {
  return <WorkloadsWorkspace />;
}
