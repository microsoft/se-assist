// Shared milestone status / commitment / fiscal-year helpers and the account-scoped metric
// computation used by the Customer profile page and the Customer glance popup. Kept in one
// place so both surfaces show the same "refined" numbers (your active+uncommitted pipeline,
// FY HoK, overdue comments, blocked milestones).

// Closed milestone statuses — matched by label first, falling back to the numeric option set.
const CLOSED_STATUS_LABELS = new Set(['Completed', 'Cancelled', 'Lost to Competitor', 'Hygiene/Duplicate']);
const CLOSED_STATUS_CODES = new Set([861980003, 861980004, 861980005, 861980006]);

// msp_commitmentrecommendation option-set values.
export const UNCOMMITTED = 861980000;
export const COMMITTED = 861980003;

// Normalize a Dynamics GUID for comparison: strip braces, lowercase. Shared everywhere a
// milestone/regarding id is matched across tables.
export const normId = (g) => String(g || '').replace(/[{}]/g, '').toLowerCase();

// SSPs (Cloud and AI Specialists) explicitly configured on customer accounts. The distinct
// person names drive Discover mode ("milestones owned by one of My SSPs"). This is the single
// canonical query — every surface (Milestones, Timeline, HoK, Workloads, territory context)
// should use it so a whitespace-only name can never behave differently across pages.
export const SSP_NAMES_SQL = "SELECT DISTINCT person_name FROM active_customer_account_team_roles WHERE role = 'Cloud and AI Specialist' AND person_name IS NOT NULL AND TRIM(person_name) <> ''";

// Canonical tpid-keyed variant for surfaces that need the account → SSP mapping (the Workloads
// account picker, the Milestone Timeline's per-account SSP label). Same role + non-empty filter
// as SSP_NAMES_SQL, plus the tpid column.
export const SSP_ROLES_SQL = "SELECT tpid, person_name FROM active_customer_account_team_roles WHERE role = 'Cloud and AI Specialist' AND person_name IS NOT NULL AND TRIM(person_name) <> ''";

export function isActiveMilestone(m) {
  const label = m.status_label;
  if (label) return !CLOSED_STATUS_LABELS.has(label);
  return !CLOSED_STATUS_CODES.has(Number(m.milestone_status));
}

export function isInactiveMilestone(m) {
  return !isActiveMilestone(m);
}

export function isUncommittedMilestone(m) {
  return Number(m.commitment_recommendation) === UNCOMMITTED;
}

export function isCommittedMilestone(m) {
  return Number(m.commitment_recommendation) === COMMITTED;
}

export function isBlockedMilestone(m) {
  return (m.status_label || '') === 'Blocked';
}

export function parseTeamList(raw) {
  if (!raw) return [];
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(p) ? p.filter(Boolean) : [];
  } catch { return []; }
}

// The full deal-team set for a milestone: the owner plus everyone on deal_team_json.
export function milestoneTeamSet(m) {
  const team = new Set(parseTeamList(m.deal_team_json));
  if (m.owner_name) team.add(m.owner_name);
  return team;
}

// True when the signed-in user is the milestone owner or on its deal team.
export function isOnMyTeam(m, currentUserName) {
  if (!currentUserName) return false;
  return milestoneTeamSet(m).has(currentUserName);
}

// Territory-scope membership predicate shared by every milestone view (Milestones table +
// map, Milestone Timeline) so "My / Discover / All" means exactly one thing:
//   'all'      -> keep everything.
//   'mine'     -> keep milestones you're on the deal team of (owner or member).
//   'discover' -> keep milestones owned by one of your configured SSPs that you are NOT
//                 already on (candidates to join).
// `sspNameSet` is a Set of SSP display names; when identity/SSPs are unknown the predicate
// degrades safely (mine → keep all so nothing silently disappears; discover → keep none).
export function milestoneMatchesScope(m, { scope, currentUserName, sspNameSet }) {
  if (scope === 'mine') {
    if (!currentUserName) return true;
    return isOnMyTeam(m, currentUserName);
  }
  if (scope === 'discover') {
    if (!sspNameSet || !sspNameSet.has((m.owner_name || '').trim())) return false;
    if (!currentUserName) return true;
    return !isOnMyTeam(m, currentUserName); // exclude ones I'm already on
  }
  return true;
}

// Days since a milestone's most recent comment, or null if it has none.
export function latestCommentAgeDays(raw) {
  try {
    const comments = JSON.parse(raw || '[]');
    if (!Array.isArray(comments) || comments.length === 0) return null;
    const latest = comments.reduce(
      (best, c) => (!best || new Date(c.modifiedOn) > new Date(best) ? c.modifiedOn : best),
      null,
    );
    if (!latest) return null;
    return (Date.now() - new Date(latest).getTime()) / 86400000;
  } catch { return null; }
}

// A milestone's comments are "overdue" when the most recent one is older than 30 days.
export function isCommentsOverdue(raw) {
  const days = latestCommentAgeDays(raw);
  return days != null && days > 30;
}

// Microsoft fiscal year runs July 1 (prior calendar year) → June 30. FY2027 is
// 2026-07-01 through 2027-06-30. ISO bounds are exported for SQL date-range filters.
const FY = 2027;
const FY_START = new Date(Date.UTC(FY - 1, 6, 1)); // 2026-07-01
const FY_END = new Date(Date.UTC(FY, 6, 1));       // 2027-07-01 (exclusive)
export const FY_LABEL = `FY${String(FY).slice(-2)}`;
export const FY_START_ISO = FY_START.toISOString();
export const FY_END_ISO = FY_END.toISOString();

export function inFiscalYear(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return d >= FY_START && d < FY_END;
}

// HoK activity counts for one account (by tpid): total, and how many were created this fiscal
// year. Normalizes GUID formatting (braces/case) on both sides of the milestone join. Shared by
// the Customer profile page (top-parent view) and the glance popup. Bound params in order: tpid,
// FY-start ISO, FY-end ISO.
export const ACCOUNT_HOK_FY_SQL = `
WITH acct AS (SELECT crm_account_id, name FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL),
ms AS (
  SELECT LOWER(REPLACE(REPLACE(m.milestone_id, '{', ''), '}', '')) AS mid
  FROM active_milestones m LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
  WHERE o.parent_account_id IN (SELECT crm_account_id FROM acct) OR o.customer_name IN (SELECT name FROM acct)
)
SELECT
  COUNT(*) AS hok_total,
  SUM(CASE WHEN t.created_on >= ? AND t.created_on < ? THEN 1 ELSE 0 END) AS hok_fy
FROM active_hok_tasks t
WHERE LOWER(REPLACE(REPLACE(COALESCE(t.regarding_id, ''), '{', ''), '}', '')) IN (SELECT mid FROM ms)`;

// Same as ACCOUNT_HOK_FY_SQL but scoped to a SINGLE account by crm_account_id + name (mirrors the
// child-account opportunity/milestone queries on the Customer profile). Used when viewing a child
// sub-account so its HoK number matches its (child-scoped) opportunity/milestone numbers instead
// of rolling up the whole TPID family. Bound params in order: crm_account_id, name, FY-start ISO,
// FY-end ISO.
export const ACCOUNT_HOK_FY_BY_ACCT_SQL = `
WITH ms AS (
  SELECT LOWER(REPLACE(REPLACE(m.milestone_id, '{', ''), '}', '')) AS mid
  FROM active_milestones m LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
  WHERE o.parent_account_id = ? OR o.customer_name = ?
)
SELECT
  COUNT(*) AS hok_total,
  SUM(CASE WHEN t.created_on >= ? AND t.created_on < ? THEN 1 ELSE 0 END) AS hok_fy
FROM active_hok_tasks t
WHERE LOWER(REPLACE(REPLACE(COALESCE(t.regarding_id, ''), '{', ''), '}', '')) IN (SELECT mid FROM ms)`;

// Account-scoped pipeline metrics from raw opportunity + milestone rows.
//   *Active  = your (owner/deal-team) milestones that are Active AND Uncommitted, and the
//              opportunities that parent them.
//   *Total   = every opportunity / milestone on the account.
//   overdueComments = active + uncommitted milestones whose latest comment is > 30 days old.
//   blocked         = milestones in the Blocked status.
// Overdue + blocked are account-wide (an account-health signal), matching the Action Center.
export function computeAccountMilestoneMetrics({ opportunities = [], milestones = [], currentUserName = '' }) {
  const refinedMs = milestones.filter(
    (m) => isOnMyTeam(m, currentUserName) && isActiveMilestone(m) && isUncommittedMilestone(m),
  );
  const refinedOppIds = new Set(refinedMs.map((m) => m.opportunity_id).filter(Boolean));
  return {
    oppsTotal: opportunities.length,
    oppsActive: opportunities.filter((o) => refinedOppIds.has(o.opportunity_id)).length,
    msTotal: milestones.length,
    msActive: refinedMs.length,
    overdueComments: milestones.filter(
      (m) => isActiveMilestone(m) && isUncommittedMilestone(m) && isCommentsOverdue(m.comments_json),
    ).length,
    blocked: milestones.filter((m) => isBlockedMilestone(m)).length,
  };
}
