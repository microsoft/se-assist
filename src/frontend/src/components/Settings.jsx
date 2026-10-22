import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Textarea, Spinner, Switch, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, useRestoreFocusTarget } from '@fluentui/react-components';
import {
  SettingsRegular, PeopleRegular, ShieldCheckmarkRegular,
  GlobeRegular, InfoRegular, ChevronDownRegular, ChevronRightRegular,
  CheckmarkCircleRegular, DismissCircleRegular, ArrowSyncRegular,
  PersonRegular, SparkleRegular, CloudArrowDownRegular, WandRegular,
  WarningRegular, DeleteRegular, BookRegular, AppsListDetailRegular,
  WeatherSunnyRegular, WeatherMoonRegular, PaintBrushRegular,
  DatabaseRegular, FolderRegular, ArrowDownloadRegular, CompassNorthwestRegular,
} from '@fluentui/react-icons';
import {
  getMsxSettings, getAccountRoster, saveAccountRoster, getAuthStatus, inElectron, ACCOUNT_ROSTER_CHANGED_EVENT,
  entraSignIn, entraSignOut, entraStatus,
  githubSignInStart, githubSignInWait, githubSignOut, githubStatus, copilotProbe, modelProviderStatus,
  copilotListModels, copilotSetModel, copilotSetUtilityModel,
  deriveOwnedAccounts, m365IngestRun, m365IngestStatus, m365AutoIngestSet, onM365IngestProgress,
  workiqStatus, workiqConnect,
  wipeLocalData, getAppVersion, listAiAgents,
  dbBackupList, dbBackupNow, dbBackupExport, dbBackupOpenFolder, dbBackupSettings, dbBackupRestore,
} from '../electronBridge';
import { useDbQuery } from '../hooks/useDb';
import { syncAll, syncInProgress } from '../lib/sync';
import {
  getMsxAutoSyncConfig, setMsxAutoSyncConfig, getMsxAutoSyncLog,
  runMsxAutoSyncNow, MSX_AUTOSYNC_EVENT,
} from '../lib/msxAutoSync';
import { IDENTITY_UPDATED_EVENT } from '../territoryContext';
import { NAV, LOCKED_PATHS, GUIDED_TOUR_NAV_KEY } from '../lib/navConfig';
import { getHiddenNav, setHiddenNav, NAV_PREFS_EVENT } from '../lib/navPrefs';
import { getTheme, setTheme, THEME_PREFS_EVENT } from '../lib/themePrefs';
import { formatLocalDateTime } from '../lib/datetime';
import { openSetupGuide } from '../lib/onboarding';
import SspConfiguration from './SspConfiguration';

const SYNC_STEPS = [
  { key: 'customers', label: 'Customers' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'hok', label: 'HoK Activities' },
  { key: 'contacts', label: 'Contacts' },
];

// Small rounded chip used to show an agent's knowledge/tools/memory in the About section.
function pillStyle(color) {
  return {
    fontSize: 11, fontWeight: 500, color,
    background: `${color}14`, border: `1px solid ${color}33`,
    borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
  };
}

// Change log — packaged (distributed) releases only. Newest first. Add a new entry
// here each time the app is rebuilt and the version in package.json is bumped.
const CHANGELOG = [
  {
    version: '2.2.1',
    notes: [
      'Account-team Teams drafts: Message in Teams prefills a greeting using the contact first name and account for SSP, ATS and AE.',
      'Milestone Teams messages: Message owner copies a formatted greeting with the milestone name as a clickable MSX link and opens the owner chat. Paste with Ctrl+V, then review and send manually. Original compact button labels are retained.',
    ],
  },
  {
    version: '2.2.0',
    notes: [
      'Deep Research: search locally stored customer email by account and keyword, save research subjects, and load email results 20 at a time with See more.',
      'Work Outputs: saved situation briefs, action checklists, reply drafts and optional technical recommendations. Retry, refresh, refine or stop individual areas without discarding successful results. Create local Tasks, workloads and reviewable Outlook reply-all drafts; nothing is sent automatically.',
      'Research gaps: classify open questions and research eligible gaps. Answers require verifiable supporting quotes; new evidence marks affected outputs as needing refresh.',
      'Stakeholder Influence Map: account-specific signals grounded in local email, meetings and transcripts, with optional Copilot analysis and private corrections. Scores are inferred signals, not facts about people.',
      'Foundry Deep-Dives: rolling-90-day token usage, offering/model/region trends, engagement history and customer/subscription views, with separate query and source-refresh timestamps.',
      'Native Anthropic consumption: completed-month USD spend and trends, separate from ordinary Azure ACR. Includes account drill-down—not token estimates or a per-Claude-model breakdown.',
      'Updated app identity and documentation: consistent app/tray/installer icons and three architecture views.',
      'Active-account roster: saved User Home TPIDs are the sole active roster, with a 500-TPID limit. Removing an account archives it without deleting its history; re-adding restores access. Discovery and sign-in do not silently activate accounts.',
    ],
  },
  {
    version: '2.1.0',
    notes: [
      'Milestone AI now runs as a live workflow panel that shows each milestone moving through its steps and lets you retry a failed step — one milestone or all at once — from both the workload popup and a milestone’s own details popup.',
      'Suggest Workloads now permanently dismisses the suggestions you delete and won’t re-propose the same idea (even lightly reworded) on future runs.',
      'The Guided Tour was rebuilt with numbered call-out boxes on each highlighted area and new stops for the account glance, the Azure consumption leaderboard, and My Org — and you can launch it from Guided Setup.',
      'A rendering error on one page now shows a clear message instead of blanking the whole app.',
      'The customer “glance” popup now has a “Message in Teams” button for each account’s SSP, ATS, and AE.',
      'Assorted fixes, reliability improvements, and UI polish across Milestone AI, Suggest Workloads, Azure Consumption, and deal-team membership.',
    ],
  },
  {
    version: '2.0.0',
    notes: [
      'Customers, reorganized: the old “Customer Activity” tab is now simply “Customers” (under Explore Data), and setting each account’s SSP moved into User Home → SSP Configuration (a clean one-row-per-account table: Customer, TPID, SSP Name, SSP Email). Opening an account anywhere now brings up a fast “account glance” popup — SSP, pipeline stats, team, associated workloads, all-time email/meeting/chat and contact totals, recent activity, and links to the full profile, Milestones, and Azure Consumption — reachable from the Customers cards, the Action Center, the SSP Configuration rows, and the account rows on the Milestones table and timeline.',
      'Refined account metrics everywhere: opportunity and milestone cards now lead with YOUR active + uncommitted pipeline (with the account total in smaller text beside it), a fiscal-year HoK Activities count, and account-health Overdue-comment and Blocked-milestone tiles. The same three panels appear on the customer profile and in the glance popup, and clicking one opens the matching page pre-filtered to “My Milestones”.',
      'New three-state territory toggle: the milestone views (Map, Milestones, Timeline) now cycle All Milestones → My Milestones → Discover Mode. “Discover Mode - My SSPs” surfaces active milestones owned by one of your configured SSPs that you’re NOT already on the deal team of — a fast way to find work you should be joining. Excellence Metrics and HoK Activities are now fixed to your own milestones (no toggle), and the Action Center’s Overdue-comment and Blocked-milestone counts are always your own, so they no longer balloon to the whole territory.',
      'Action Center is more clickable: in “Milestones due or overdue”, clicking a milestone opens its detail popup; in “Accounts to re-engage”, clicking an account opens its glance popup; and the Excellence Metrics HoK tile now counts FY activities and links straight to that filtered list.',
      'Workload popup — milestone tools: a new “Find Related” button links just the related emails, meetings, and Teams chats across the workload’s milestones (additive — it only ever adds net-new links, never overwriting your set). “Link milestone” moved next to the Milestones header and is now “Link More”, and the AI buttons share one consistent look. After a Milestone AI run, each suggested comment or activity has a “Reject” button, and once everything for a milestone is rejected its now-empty block disappears.',
      'AI models: SE Assist never silently swaps your selected model. If you pick a model that a given API can’t serve (e.g. a Responses-only flagship like GPT-5.6), the app now routes that exact model through the API it does support instead of quietly substituting a different one — and if it truly can’t run, it tells you clearly rather than returning another model’s output. Model calls also carry a timeout so a stuck request can’t hang a feature.',
      'Reliability fixes: restoring a database backup is safer — the snapshot you pick can no longer be rotated away mid-restore, a failed restore can’t leave the app without a database, and a successful restore now cleanly restarts the app so every part reconnects to the restored data. Milestone target dates now always show the correct calendar day (they could appear one day early in some time zones).',
    ],
  },
  {
    version: '1.0.18',
    notes: [
      'New guided first-run setup: a “Welcome to SE Assist” guide walks you through the seven things to get running — sign in with Microsoft, connect an AI model, connect Microsoft 365 Copilot, add your accounts, sync from MSX, pull your Outlook/Teams activity, and set each account’s SSP — each step showing its live status (connected, last run, accounts configured). A “Resume setup / Review setup” button sits at the bottom of the sidebar so you can reopen it anytime.',
      'Azure Consumption (ACR) works again after another MSX-I data-source move: MSXI retired the SL5 Power BI report/model SE Assist was querying, so the pages had started showing stale cached numbers. SE Assist now points at the current SL5 model, so live consumption loads again — and it clears its ACR cache automatically whenever the underlying model changes.',
      'The Action Center is reworked around your day: Today’s meetings gains prev/next day navigation; “Active workloads” is now an Outlook-style reader — pick a workload on the left and its details show on the right (account, SSP, description, and milestones grouped by opportunity, each with a count of linked emails, meetings, and Teams chats you can click into). “Overdue comments” and “Blocked milestones” sit together above a “Milestones due or overdue” list scoped to active, uncommitted milestones on your deal teams (overdue dates in red), and “Open Milestones” pre-filters to exactly that set. The Workloads and Agenda sections are collapsed by default, and every section now has a clearer header.',
      'Workloads: the “Milestone AI” run (Find signal → Comment → HoK activity) now lives inside each workload’s popup and runs across just that workload’s milestones. Overview and Milestones are always shown, with milestones grouped by opportunity and each milestone showing its linked email/meeting/chat counts (clickable to the milestone’s details). Suggested (draft) workloads now render greyed-out in both light and dark themes so they’re never confused with real, active workloads.',
      'The Customers tab is now “Customers by SSP”: set each account’s Cloud & AI Specialist by email and their name is filled in automatically from the directory (SSP names are no longer typed by hand). Columns are SSP Name, SSP Email, Customer Name, and TPID, and you can sort by SSP or customer name.',
      'Navigation tidy-up: the app now opens on the Action Center; Milestone Map and Milestone Timeline moved under Milestones (hidden by default for new users, with links to them on the Milestones page); and User Home moved to the top of the Reference group.',
      'Reliability and polish: quitting the app while an Outlook/Teams pull is running now cleanly stops the background ingestion instead of leaving it running; account tags on meetings, emails, and chats resolve to the correct top-parent account; and light-mode text contrast was tuned for readability.',
    ],
  },
  {
    version: '1.0.17',
    notes: [
      'Meetings are now first-class: click any meeting (in the Action Center or Agenda) to open a rich meeting popup. It shows the details, an expandable attendee list, a cleaned agenda (with the forwarded From/To/Cc header block and email addresses stripped out, since attendees are listed separately), and attachments. A workspace holds four saved note blocks — Preparation notes, Transcript, Summary, and Personal notes — plus one-click actions: “Prepare” writes an AI meeting brief, and “Fetch from Teams” pulls the real Teams transcript for meetings you organized and automatically summarizes it. You can link the meeting to a milestone (which also shows on the milestone), and ask the account’s SSP in Teams — with a pre-filled message — whether the meeting maps to a milestone.',
      'The Action Center is reworked: the top now shows today’s meetings as a compact one-day calendar (overlapping meetings sit side by side, empty gaps are collapsed) alongside two at-a-glance cards — Overdue comments and Blocked milestones. Workload Management and the Agenda calendar are now embedded here, so the standalone Workload Management and Agenda tabs were retired (their pages still work and are reachable from the Action Center).',
      'Data & backups: your locally-authored data (meeting notes, transcripts, summaries, manual milestone links, workloads) is now protected. SE Assist takes automatic snapshots on launch and before every upgrade, and User Home → Data & backups lets you back up now, export a copy to OneDrive/a network share, and restore a previous snapshot. This data can’t be re-pulled from Microsoft 365 or CRM, so it now has a safety net.',
      'Milestones page adds two ID search boxes — paste an opportunity or milestone GUID to jump straight to its details — and the opportunity/milestone detail popups now show (and copy) the record’s ID.',
      'Fixes and polish: account tags on meetings/emails/chats now show the correct top-parent account name instead of a child account; the New-workload account picker lists only parent accounts; Reference → Accelerators is now “Solutions” with featured cards (Azure SRE Agent, Project Perception deck, Claude Code + Foundry guide); and User Home layout tidied (Appearance + Customize navigation on one row).',
    ],
  },
  {
    version: '1.0.16',
    notes: [
      'New “Action Center” (hidden by default — turn it on in User Home → Customize navigation): a single “what needs doing today” list that pulls together customer meetings to prep, suggested workloads to review, recent emails/meetings/chats not yet assigned to a workload, accounts you haven’t contacted in over 14 days, and workload milestones that are due or overdue. Each item jumps you to the right page, and you can generate a meeting brief right from the list.',
      'The Email page is now “Customer Activity” (also hidden by default): one small card per customer account — grouped by the account’s SSP, with a separate “SSP Not Set” group — showing how many emails, meetings, and Teams chats were recent, plus a “Last contact” line that turns red once an account has been quiet for more than 14 days. Open an account to see its emails (blue), meetings (green), and chats (purple) in one list, and assign any item to a workload — or spin up a new workload for that customer — right there.',
      'New way to create a workload: the “New workload” button now opens a popup with a “Discover” step. Describe the workload and pick an account, and AI scans that account’s recent emails, meetings, and Teams chats to find the related items and pre-fill the workload’s title, description, category, opportunities, and milestones — all of which you can edit before creating. Opening a workload now uses a clean popup with every section collapsed by default.',
      'Workload and HoK activity categories now use the standard MSX task-category names (Architecture Design Session, Assessment, Blocker Escalation, Consumption Plan, Demo, PoC/Pilot, RFP/RFI, Technical Close/Win Plan, Workshop), trimmed to the set the team actually uses and consistent across the app.',
    ],
  },
  {
    version: '1.0.15',
    notes: [
      'New “Suggest workloads” in Workload Management: pulls the last week of your emails, meetings, and Teams chats and proposes one or more workloads — each with a title, a short description, and the customer account it’s for. Suggestions show as cards tagged “Suggested” with Approve and Delete; “Build details” lets you attach the account’s opportunities and their milestones (a milestone can only be added under an opportunity you’ve already added) before you approve. Approving turns a suggestion into a real workload, carrying over the opportunities and milestones you chose; deleting one never stops it from being suggested again on a future run. You can scope which accounts to consider before running, and it tells you clearly if no AI model is configured.',
      'New Email “Priority Inbox”: a fast triage view over your ingested email that needs no AI. Messages are grouped into conversation threads, matched to the right customer account, and ranked by a transparent priority score with a clear “needs reply” flag when the newest message came from the customer. Marking a thread as handled is saved locally and never changes the original email.',
    ],
  },
  {
    version: '1.0.12',
    notes: [
      'My Org’s customer interaction map now shows real relationships instead of an inflated, blank diagram: broadcast emails, all‑hands invites, and large Teams spaces (which used to pull in thousands of unrelated Microsoft people) are excluded, the strongest contacts on each side are shown, and the legend notes when the view is capped.',
    ],
  },
  {
    version: '1.0.11',
    notes: [
      'Azure Consumption (ACR) works again after the MSX‑I data source moved: MSXI migrated its ACR (SL5) Power BI model to a new dataset on 18 Aug 2026 and retired the old one, which is why the pages had started showing an authorization error. SE Assist now queries the new model, so live consumption loads again. Figures are scoped to organic Azure actuals to match the official MSXI ACR report, and the app clears its ACR cache automatically whenever the underlying model changes.',
      'Azure Consumption (ACR) now degrades gracefully when it can’t reach the live model: instead of a full‑page error, each page shows your most recent cached data with a clear “Data as of …, live refresh is unavailable” note (plus quick links to re‑authorize in Power BI), and refreshes in the background. Secondary sections load on demand so the first view paints quickly.',
      'Workload Management is now card‑based: one card per workload, tagged with its milestone(s) and customer(s), and filterable the same way as the Milestone Map (all / your customers / by SSP). Each workload holds Actions (small steps with due dates and stages), optional Workflows and reusable Assets that cut down the actions you do by hand, and stage Templates you can save from one workload and re‑apply to another.',
      'My Org shows more of the reporting line: the manager chain now nests all the way up above the person you’re viewing, and the diagram is more compact (tighter spacing, no photo bubbles). A new per‑customer interaction map plots the Microsoft (internal) and customer/partner (external) people who have been in contact as name bubbles with connecting lines, alongside the existing internal‑contacts search.',
      'Refreshed navigation preferences and the in‑app documentation to match the current feature set.',
    ],
  },
  {
    version: '1.0.10',
    notes: [
      'Workload Management tracks customer and internal deliverables with status, linked MSX milestones, and local to-do lists. It starts hidden for new users and can be enabled from User Home → Customize navigation.',
      'The shared territory control now scopes Excellence Metrics, Milestone Map, Milestone Timeline, Milestones, and HoK Activities between your milestones and the full territory. Milestone views also include active-only and uncommitted-only controls.',
      'Excellence Metrics now includes the FY2027 engagement scorecard and overdue-comment buckets for 30–59, 60–89, and 90+ days. Azure Consumption excludes an incomplete current month from trend comparisons.',
      'Milestone and HoK detail handling is more complete: reusable detail panels show the full record, newly created HoK activities update the local cache immediately, and HoK creation supports a description.',
      'New-user navigation is quieter: Workload Management and Agenda start hidden, and the navigation customizer starts collapsed. Existing saved navigation choices are preserved.',
      'The in-app guide and Obsidian vault have been rewritten as current-state documentation, with obsolete pages and broken links removed.',
    ],
  },
  {
    version: '1.0.9',
    notes: [
      'Creating a HoK Activity from the milestone details panel now reliably posts to the MSX Dynamics website — a mismatched task association meant some activities were silently not saved even though the panel reported success.',
      'New background auto-sync for Milestones & HoK Activities (Settings → Data sync): turn it on, pick an interval (30 min to 12 hours), and the app keeps them fresh while it’s open — with a “Run now” button and a live “Last auto-sync” line showing when it ran, how many items updated, and how long it took. Customers and contacts still refresh from the manual Sync button.',
      'Customer-data ingestion (WorkIQ) now shows a “Last auto-run” line under the auto-ingest option — when it last ran, how many items it pulled, and how long it took — so you can confirm background ingestion is actually working.',
      'Azure Consumption (ACR): new product trend chart in the Service Hierarchy section — pick up to 10 products (options follow the selected service level) and compare their monthly ACR on one line chart.',
      'Azure Consumption (ACR): a fiscal year with no data now loads cleanly instead of spinning and retrying, and when the model returns nothing for your whole roster the page says so plainly (the data source may be refreshing or your access changed) rather than implying $0. Being off corpnet/VPN now fails fast with a clear message instead of a long hang.',
    ],
  },
  {
    version: '1.0.8',
    notes: [
      'New “Related signals” on each milestone: an AI agent scans the account’s recent emails, meetings, and Teams chats and surfaces the ones tied to that specific milestone, each with a short reason. Links are saved (and editable) so opening a milestone doesn’t re-run the AI every time.',
      'New “Suggest comment” on a milestone: drafts a concise progress note from the emails, meetings, and Teams chats that happened since your last comment.',
      'Improved customer linking during ingestion, so more emails, meetings, and Teams chats attach to the correct account.',
      'Milestones and HoK Activities tables can now be expanded or collapsed by account: each account section has a chevron you can click, plus “expand / collapse” all controls next to the Opportunity column header.',
      'Adding a milestone comment no longer creates a duplicate (and an extra AI-summary) comment on the MSX Dynamics website — only your comment is written.',
      'Adding a comment or joining a milestone deal team no longer refreshes the page and jumps you back to the top; your scroll position stays put.',
      'The “Add comment” box in the milestone details panel is now a word-wrapped, multi-line text area (Enter sends, Shift+Enter adds a new line).',
      'Milestones now roll up to their parent (TPID) account instead of individual child accounts, in both the Milestone Map diagram and the Milestones table.',
      'The Dashboard no longer caps the account list at 16 — all of your accounts are shown.',
    ],
  },
  {
    version: '1.0.7',
    notes: [
      'Azure Consumption (ACR): the Fiscal years selector now reads oldest → newest (FY24 on the left) and no longer offers the far-future fiscal year that had no meaningful data.',
      'Your Fiscal years and Service level choices now persist and stay in sync across both the portfolio and per-customer ACR pages, instead of resetting on each visit.',
      'Reworked the ACR Strategic section (combined Super/Strategic/Sub pillar chart with a dropdown), added an “ACR by Customer” chart to the top of the portfolio page, and moved Subscriptions to the bottom of the per-customer page.',
      'Removed the low-value “Account breakdowns” section (including the Service Influencer view, which just duplicated the service hierarchy) to reduce clutter.',
      'Fixed ACR charts intermittently failing to load (“fetch failed”) on customer pages: live Power BI queries are now rate-limited and retried with staggered backoff so the many charts on a page no longer overwhelm the connection at once.',
    ],
  },
  {
    version: '1.0.6',
    notes: [
      'New in-app Documentation area (Settings → Documentation, also in the sidebar): an Introduction covering every feature and where to find it, a Setting up as a new user checklist, and an Operating the application guide.',
    ],
  },
  {
    version: '1.0.5',
    notes: [
      'Ingestion AI (customer alias generation and weak-link verification) now runs exclusively on Claude Haiku 4.5 via the connected GitHub Copilot — the previous gpt-4o-mini fallback has been removed.',
      'If GitHub Copilot isn’t connected (or a call fails), imports continue on exact customer names and now show a clear “imports are degraded” notice with the specific reason, instead of silently switching models. Reconnect Copilot and run “Pull new items” again to complete AI enrichment.',
    ],
  },
  {
    version: '1.0.4',
    notes: [
      'Faster, higher-quality ingestion AI: customer alias generation and weak-link verification now run on Claude Haiku 4.5 (via GitHub Copilot) when connected, falling back to the previous model when it isn’t.',
      'Report generation and the larger AI features remain on your selected model in Settings → AI Model.',
    ],
  },
  {
    version: '1.0.3',
    notes: [
      'Fixed slow repeated ingestion: AI name aliases and link checks now cache incrementally and survive transient model hiccups, so a completed pass stays cached and “Pull new items” runs in seconds instead of redoing all the AI work.',
      'Incremental pulls now use lighter AI caps than a full backfill, keeping day-to-day syncs fast.',
    ],
  },
  {
    version: '1.0.2',
    notes: [
      'Smarter customer linking: emails, meetings, and chats now match accounts by identity and confidence tiers, with AI-generated name aliases (and exact-name fallback when no model is available).',
      'Ingestion now tells you when another pass will pull in more, so large territories converge over a few cached runs instead of one long wait.',
      'My Org search now also finds people who own CRM milestones and opportunities for the selected account, not just those on emails/meetings/chats.',
      'Fixed fresh-user onboarding so a brand-new user’s first WorkIQ sync is correctly scoped to their accounts.',
      'Reorganized AI features into dedicated, specialized agents for more consistent summaries and advice.',
    ],
  },
  {
    version: '1.0.1',
    notes: [
      'Bundled an embeddable Python runtime so customer-data ingestion works in the packaged app with no system Python.',
      'Fixed WorkIQ launch in the packaged app — it now uses the locally installed binary and never reaches the blocked npm registry.',
      'Added local-data privacy controls: delete all local data, plus Teams staging cleanup.',
      'Surfaced silent ingestion/sync failures as explicit state; the Territory toggle now enables right after the first sync.',
      'HoK Activities: removed the task cap and paged the full owned set.',
    ],
  },
  {
    version: '1.0.0',
    notes: [
      'Initial packaged release: MSX/Dynamics customer, milestone, and HoK (POC) management.',
      'Azure Consumption (ACR) portfolio and per-customer panels.',
      'In-app Microsoft (MSAL) sign-in and GitHub Copilot / Azure AI Foundry model providers.',
      'AI features: comprehensive customer summary, Sales Play Advisor, tech-stack and consumption analysis.',
      'WorkIQ email / meeting / Teams ingestion, Seismic DocCenter content, and Key Contacts with LinkedIn — all stored locally in SQLite.',
    ],
  },
];

function describeSyncResult(key, result) {
  if (!result) return '';
  let detail = '';
  if (key === 'customers') detail = `${result.accounts ?? 0} accounts`;
  else if (key === 'milestones') detail = result.note || `${result.milestones ?? 0} milestones · ${result.opportunities ?? 0} opportunities`;
  else if (key === 'hok') detail = `${result.tasks ?? 0} activities`;
  else if (key === 'contacts') detail = `${result.contacts ?? 0} contacts · ${result.withLinkedIn ?? 0} on LinkedIn`;
  else return '';
  // Surface swallowed request failures (e.g. Dataverse throttling) so a partial pull is
  // never presented as complete.
  const failed = result.failedRequests ?? 0;
  if (failed > 0) detail += ` · ⚠ ${failed} request${failed === 1 ? '' : 's'} failed`;
  return detail;
}

// The reason WorkIQ is unusable, written to follow a sentence that has no final period yet.
function workIqDetail(status) {
  const text = String(status?.error || status?.autoReconnect?.lastError || '').trim().replace(/\.+$/, '');
  return text ? `: ${text}.` : '.';
}

// Explicit badge for a background probe that failed — distinct from a genuine
// "not connected", so a probe error is never mistaken for a known-negative state.
const UnavailableBadge = (
  <span className="badge badge-warning" title="Status check failed — this may be stale">
    <WarningRegular style={{ fontSize: 12, marginRight: 4 }} />Couldn't check
  </span>
);

export default function Settings() {
  const [sections, setSections] = useState({ appearance: false, nav: false, backups: false, accounts: true, ingest: true, sync: true, wiqauth: true, auth: true, model: true, sspConfig: false, crm: false, about: false, danger: false });
  const [loading, setLoading] = useState(true);

  // App version (Settings → About), live from package.json.
  const [appVersion, setAppVersion] = useState(null);

  // Dedicated AI agents catalog (Settings → About), live from the main process.
  const [aiAgents, setAiAgents] = useState([]);
  const [aiAgentsOpen, setAiAgentsOpen] = useState(false);

  // MSX data
  const [tpids, setTpids] = useState([]);
  const [rosterReady, setRosterReady] = useState(false);
  const [rosterCustom, setRosterCustom] = useState(false);
  const [rosterDraft, setRosterDraft] = useState('');
  const [rosterSaving, setRosterSaving] = useState(false);
  const [rosterMessage, setRosterMessage] = useState(null);
  const [rosterChange, setRosterChange] = useState(null);
  const rosterSaveRef = useRef(null);
  const rosterFocusTarget = useRestoreFocusTarget();
  // After saving a roster that adds new accounts, we offer to run the CRM sync so
  // the new TPIDs get their names/details pulled. { count } = number of accounts added.
  const [syncPrompt, setSyncPrompt] = useState(null);
  const [crmUrl, setCrmUrl] = useState('');
  const [tenantId, setTenantId] = useState('');

  // Auth data
  const [authStatus, setAuthStatus] = useState(null);
  const [authMessage, setAuthMessage] = useState(null);

  // In-app Microsoft (Entra) sign-in
  const [msStatus, setMsStatus] = useState(null);
  const [msLoading, setMsLoading] = useState(false);

  // GitHub Copilot model provider
  const [provider, setProvider] = useState(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghCode, setGhCode] = useState(null); // { user_code, verification_uri }
  const [modelMessage, setModelMessage] = useState(null);

  // Copilot model catalog + selection
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [utilityModel, setUtilityModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);

  // Owned-account detection (MSX)
  const [detecting, setDetecting] = useState(false);
  const [detectDetails, setDetectDetails] = useState(null);
  // Local customer name lookup (for naming accounts in the detection reconciliation).
  const { data: customerRows } = useDbQuery(
    "SELECT tpid, name, crm_account_id, parent_crm_account_id, parenting_level FROM customers WHERE tpid IS NOT NULL AND tpid <> ''",
  );
  // tpid -> top-parent account name, for the read-only roster list on the left.
  // A TPID groups a parent account with all its children (they share the TPID),
  // so we must pick the top parent's name — not let an arbitrary child row win.
  // Same selection as Milestones/HoK: parenting_level 861980000 (Dynamics "top
  // parent") → else the account with no parent → else the first row.
  const nameByTpid = useMemo(() => {
    const byTpid = new Map();
    for (const c of customerRows || []) {
      if (c.tpid == null) continue;
      const key = String(c.tpid);
      if (!byTpid.has(key)) byTpid.set(key, []);
      byTpid.get(key).push(c);
    }
    const m = new Map();
    for (const [key, rows] of byTpid) {
      const top = rows.find((r) => Number(r.parenting_level) === 861980000)
        || rows.find((r) => !r.parent_crm_account_id)
        || rows[0];
      if (top) m.set(key, top.name);
    }
    return m;
  }, [customerRows]);

  // Configured roster ordered by customer name (A→Z) for display. Accounts not yet
  // synced (no name) sort to the bottom, then by TPID for a stable order.
  const sortedTpids = useMemo(() => {
    return [...tpids].sort((a, b) => {
      const na = nameByTpid.get(String(a)) || '';
      const nb = nameByTpid.get(String(b)) || '';
      if (na && nb) return na.localeCompare(nb);
      if (na) return -1;
      if (nb) return 1;
      return String(a).localeCompare(String(b));
    });
  }, [tpids, nameByTpid]);

  // Customer-data ingestion (WorkIQ)
  const [ingestStatus, setIngestStatus] = useState(null);
  const [autoIngestLog, setAutoIngestLog] = useState(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState(null);

  // Per-section background-probe status. Each starts 'loading', becomes 'ready' when its
  // probe resolves, or 'unavailable' when it fails — so a failed probe renders as an
  // explicit "couldn't check" state instead of masquerading as a confident "not connected".
  const [probes, setProbes] = useState({ auth: 'loading', ms: 'loading', provider: 'loading', ingest: 'loading' });
  const setProbe = useCallback((key, state) => setProbes((p) => ({ ...p, [key]: state })), []);
  const [ingestMessage, setIngestMessage] = useState(null);
  const [showBackfillInfo, setShowBackfillInfo] = useState(false);
  const [autoIngest, setAutoIngest] = useState({ enabled: false, intervalMin: 60 });
  // WorkIQ sign-in (its own admin-consented M365 Copilot OAuth, separate from MSX/GitHub).
  const [wiqStatus, setWiqStatus] = useState(null); // { connected, account, error } | null while loading
  const [wiqConnecting, setWiqConnecting] = useState(false);
  const [wiqChecking, setWiqChecking] = useState(false);
  const [wiqMessage, setWiqMessage] = useState(null);
  const [wiqProbed, setWiqProbed] = useState(false);
  // Only the newest WorkIQ check or sign-in may set the card, so a slow check cannot
  // overwrite a newer result.
  const wiqSeq = useRef(0);

  // Data sync
  const [syncing, setSyncing] = useState(false);
  const [syncSteps, setSyncSteps] = useState({}); // key -> { status, detail }
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncLastRun, setSyncLastRun] = useState(() => {
    try { return localStorage.getItem('se-assist:syncLastRun') || null; } catch { return null; }
  });
  const [msxAutoSync, setMsxAutoSync] = useState(() => getMsxAutoSyncConfig());
  const [msxAutoSyncLog, setMsxAutoSyncLog] = useState(() => getMsxAutoSyncLog());
  const [msxAutoRunning, setMsxAutoRunning] = useState(false);

  const toggle = (key) => setSections((s) => ({ ...s, [key]: !s[key] }));

  // Deep-link: the setup tutorial (and other links) can open a specific section and scroll to
  // it via ?section=<key>. We force it open (not toggle) and smooth-scroll after it renders.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const sec = searchParams.get('section');
    if (!sec) return undefined;
    setSections((s) => ({ ...s, [sec]: true }));
    const t = setTimeout(() => {
      document.getElementById(`section-${sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Clear the param so a later manual collapse isn't re-opened on re-render.
      const next = new URLSearchParams(searchParams);
      next.delete('section');
      setSearchParams(next, { replace: true });
    }, 80);
    return () => clearTimeout(t);
  }, [searchParams, setSearchParams]);

  // Danger Zone: delete all local data
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeMessage, setWipeMessage] = useState(null);

  const handleWipeLocalData = useCallback(async () => {
    setWiping(true);
    setWipeMessage(null);
    try {
      const res = await wipeLocalData();
      if (!res?.ok) {
        setWiping(false);
        setWipeConfirm(false);
        setWipeMessage({ type: 'error', text: res?.error || 'Failed to delete local data.' });
        return;
      }
      // Everything on disk is gone; reload so the renderer drops all stale state
      // and re-initialises against the now-empty database.
      setWipeMessage({ type: 'success', text: 'All local data deleted. Reloading…' });
      setTimeout(() => { try { window.location.reload(); } catch { /* noop */ } }, 600);
    } catch (err) {
      setWiping(false);
      setWipeConfirm(false);
      setWipeMessage({ type: 'error', text: err.message || String(err) });
    }
  }, []);


  const loadData = useCallback(async () => {
    setLoading(true);
    setRosterReady(false);
    try {
      // Only the roster + CRM settings gate the initial render — they drive the
      // always-visible Default Accounts and CRM sections. Everything else (auth
      // probes, model provider, ingest status, and the notoriously slow
      // `az --version` cold start) loads in the background below so it can't
      // stall the whole page for several seconds.
      const [settings, roster] = await Promise.all([getMsxSettings(), getAccountRoster()]);
      if (!Array.isArray(roster?.tpids)) throw new Error('The desktop returned an invalid saved roster.');
      const ids = roster.tpids;
      setTpids(ids);
      setRosterCustom(Boolean(roster?.isCustom));
      setRosterDraft(ids.join('\n'));
      setRosterReady(true);
      setCrmUrl(settings.crmUrl || '');
      setTenantId(settings.tenantId || '');
    } catch (e) {
      console.error('Settings load error:', e);
      setRosterMessage({ type: 'error', text: `Could not load the saved roster: ${e.message || String(e)}. Reload User Home before changing accounts.` });
    } finally {
      setLoading(false);
    }

    // Background probes — each updates its own section as it resolves; none block render.
    // On failure we mark the section 'unavailable' (and log) instead of swallowing silently,
    // so the UI can show "couldn't check" rather than a misleading "not connected".
    getAuthStatus()
      .then((a) => { setAuthStatus(a); setProbe('auth', 'ready'); })
      .catch((e) => { setProbe('auth', 'unavailable'); console.warn('[Settings] auth status probe failed:', e?.message || e); });
    entraStatus()
      .then((s) => { setMsStatus(s); setProbe('ms', 'ready'); })
      .catch((e) => { setProbe('ms', 'unavailable'); console.warn('[Settings] Microsoft status probe failed:', e?.message || e); });
    modelProviderStatus()
      .then((prov) => {
        setProvider(prov);
        setProbe('provider', 'ready');
        if (prov?.copilot?.signedIn) loadModels();
      })
      .catch((e) => { setProbe('provider', 'unavailable'); console.warn('[Settings] model provider probe failed:', e?.message || e); });
    m365IngestStatus()
      .then((st) => {
        setIngestStatus(st);
        setProbe('ingest', 'ready');
        if (st?.autoIngest) setAutoIngest(st.autoIngest);
        setAutoIngestLog(st?.autoIngestLog || null);
      })
      .catch((e) => { setProbe('ingest', 'unavailable'); console.warn('[Settings] ingest status probe failed:', e?.message || e); });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const onChange = ({ detail }) => {
      if (!Array.isArray(detail?.tpids)) return;
      const draft = [...new Set(rosterDraft.split(/[\s,]+/).filter(Boolean))].sort();
      if (JSON.stringify(draft) === JSON.stringify([...tpids].sort())) setRosterDraft(detail.tpids.join('\n'));
      setTpids(detail.tpids);
      setRosterCustom(Boolean(detail.isCustom));
      if (!rosterSaving) setRosterChange(null);
      setDetectDetails(null);
      if (!rosterSaving) setRosterMessage({ type: 'warning', text: 'The active roster changed. The saved list is up to date; review any unsaved draft before saving.' });
    };
    window.addEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ACCOUNT_ROSTER_CHANGED_EVENT, onChange);
  }, [rosterDraft, rosterSaving, tpids]);

  // Fetch the running app version once for the About section.
  useEffect(() => {
    let cancelled = false;
    getAppVersion().then((v) => { if (!cancelled && v) setAppVersion(v); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the dedicated AI agents catalog once for the About section.
  useEffect(() => {
    let cancelled = false;
    listAiAgents().then((list) => { if (!cancelled && Array.isArray(list)) setAiAgents(list); });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to live ingestion progress events from the main process.
  useEffect(() => {
    const unsub = onM365IngestProgress((payload) => {
      if (payload?.phase === 'done') {
        setIngestProgress(null);
        // An auto or manual run just finished — refresh counts and the auto-ingest log line.
        m365IngestStatus()
          .then((st) => { setIngestStatus(st); setAutoIngestLog(st?.autoIngestLog || null); })
          .catch(() => { /* best-effort refresh */ });
        return;
      }
      setIngestProgress(payload);
    });
    return unsub;
  }, []);

  // Keep the MSX auto-sync log line live: the background scheduler in App.jsx dispatches
  // this event whenever it records a run, so Settings updates without a manual refresh.
  useEffect(() => {
    const onUpdate = (e) => {
      setMsxAutoSyncLog(e?.detail || getMsxAutoSyncLog());
      try { setSyncLastRun(localStorage.getItem('se-assist:syncLastRun') || null); } catch { /* ignore */ }
    };
    window.addEventListener(MSX_AUTOSYNC_EVENT, onUpdate);
    return () => window.removeEventListener(MSX_AUTOSYNC_EVENT, onUpdate);
  }, []);

  const handleMsxAutoSyncToggle = (enabled) => {
    setMsxAutoSync(setMsxAutoSyncConfig({ enabled }));
  };
  const handleMsxAutoSyncInterval = (intervalMin) => {
    setMsxAutoSync(setMsxAutoSyncConfig({ intervalMin }));
  };
  const handleMsxAutoSyncRunNow = async () => {
    setMsxAutoRunning(true);
    try {
      const res = await runMsxAutoSyncNow();
      if (res && !res.skipped) setMsxAutoSyncLog(res);
    } finally {
      setMsxAutoRunning(false);
    }
  };

  const persistRoster = async (nextTpids) => {
    setRosterMessage(null);
    if (!rosterReady) {
      setRosterMessage({ type: 'error', text: 'The saved roster is unavailable. Reload User Home before changing accounts.' });
      return;
    }
    const before = new Set((tpids || []).map(String));
    if (syncInProgress() || ingestStatus?.running) {
      setRosterMessage({ type: 'warning', text: 'Wait for the current sync or ingestion to finish before changing your active accounts.' });
      return;
    }
    setRosterSaving(true);
    try {
      const result = await saveAccountRoster(nextTpids);
      if (result?.ok) {
        const ids = result.tpids || [];
        setTpids(ids);
        setRosterCustom(Boolean(result.isCustom));
        setRosterDraft(ids.join('\n'));
        setRosterChange(null);
        setDetectDetails(null);
        const added = ids.filter((t) => !before.has(String(t))).length;
        const kept = new Set(ids.map(String));
        const removed = [...before].filter((t) => !kept.has(t)).length;
        setRosterMessage({ type: 'success', text: `Saved ${ids.length} active account${ids.length !== 1 ? 's' : ''}. ${added} activated, ${removed} archived. Existing history and local work were preserved.` });
        // Offer to pull details for accounts that weren't in the roster before. They
        // won't have names/metadata (Customers list, Dashboard, ACR drill-in labels)
        // until a CRM sync runs, so prompt rather than silently leaving them bare.
        if (added > 0 && !syncing) {
          setSyncPrompt({ count: added });
        }
      } else {
        setRosterMessage({ type: 'error', text: result?.error || 'Could not save accounts.' });
      }
    } catch (e) {
      setRosterMessage({ type: 'error', text: e.message || 'Could not save accounts.' });
    } finally {
      setRosterSaving(false);
    }
  };

  const requestRosterSave = async (candidate) => {
    setRosterMessage(null);
    const ids = [...new Set(candidate.map(String).map((t) => t.trim()).filter(Boolean))];
    if (ids.some((t) => !/^\d{1,20}$/.test(t)) || ids.length > 500) {
      setRosterMessage({ type: 'error', text: 'Use numeric TPIDs only, with a maximum of 500 active accounts.' });
      return;
    }
    const next = new Set(ids);
    const removed = tpids.filter((t) => !next.has(String(t)));
    if (removed.length) {
      rosterSaveRef.current?.focus();
      setRosterChange({ tpids: ids, removed });
    }
    else await persistRoster(ids);
  };

  const handleSaveRoster = () => requestRosterSave(String(rosterDraft || '').split(/[\s,]+/));
  const handleResetRoster = () => requestRosterSave([]);
  const rosterDraftDirty = JSON.stringify([...new Set(String(rosterDraft || '').split(/[\s,]+/).filter(Boolean))].sort())
    !== JSON.stringify([...tpids].sort());

  const handleDetectAccounts = async () => {
    setDetecting(true);
    setRosterMessage(null);
    setDetectDetails(null);
    try {
      const owned = await deriveOwnedAccounts();
      if (!owned?.ok) {
        setRosterMessage({ type: 'error', text: owned?.error || 'Could not detect accounts. Sign in to Microsoft first.' });
        return;
      }
      const detected = (owned.tpids || []).map(String);
      if (!detected.length) {
        setRosterMessage({ type: 'error', text: 'No accounts found from your MSX signals (milestone teams, account teams, deal teams).' });
        return;
      }

      // Detection only edits the complete draft. It never activates an account.
      const currentSet = new Set((tpids || []).map(String));
      const diff = detected.filter((t) => !currentSet.has(t));

      // Name map: detected accounts (from CRM) first, then local customers table.
      const nameMap = new Map();
      for (const a of owned.accounts || []) nameMap.set(String(a.tpid), a.name);
      for (const c of customerRows || []) if (!nameMap.has(String(c.tpid))) nameMap.set(String(c.tpid), c.name);
      const nm = (t) => nameMap.get(String(t)) || `TPID ${t}`;

      const c = owned.counts || {};
      const sig = [
        c.milestones ? `${c.milestones} milestone teams` : null,
        c.accountTeams ? `${c.accountTeams} account teams` : null,
      ].filter(Boolean).join(' · ') || 'MSX';

      if (!diff.length) {
        setRosterMessage({ type: 'success', text: `Detected ${detected.length} account${detected.length !== 1 ? 's' : ''} from ${sig} — all already in your roster. Nothing to add.` });
        return;
      }

      // Merge the diff with anything the user already typed in the box (dedupe).
      const existingBox = String(rosterDraft || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const boxUnion = [...new Set([...existingBox, ...diff])];
      setRosterDraft(boxUnion.join('\n'));

      setDetectDetails({
        counts: owned.counts || {},
        diagnostics: owned.diagnostics || { signals: {}, errors: [] },
        newlyDetected: diff.map((t) => ({ tpid: t, name: nm(t) })),
        keptNotDetected: [],
        detectedCount: detected.length,
        total: (tpids || []).length + diff.length,
      });

      const type = owned.diagnostics?.errors?.length ? 'warning' : 'success';
      setRosterMessage({ type, text: `Detected ${detected.length} account${detected.length !== 1 ? 's' : ''} from ${sig}, ${diff.length} new. Remove past-role accounts from the draft, then click "Save active roster".` });
    } catch (e) {
      setRosterMessage({ type: 'error', text: e.message || 'Detection failed.' });
    } finally {
      setDetecting(false);
    }
  };

  const refreshIngestStatus = async () => {
    try {
      const st = await m365IngestStatus();
      setIngestStatus(st);
      if (st?.autoIngest) setAutoIngest(st.autoIngest);
    } catch { /* ignore */ }
  };

  // Check WorkIQ connectivity. `probe` runs an actual /me/messages read (slow, ~5-10s
  // but authoritative); pass false for a fast account-only check.
  const checkWorkIq = useCallback(async ({ probe = true } = {}) => {
    const seq = ++wiqSeq.current;
    setWiqChecking(true);
    try {
      const st = await workiqStatus({ probe });
      if (seq === wiqSeq.current) {
        setWiqStatus(st);
        // The status check repairs an expired sign-in in place; say so rather than
        // silently flipping the badge back to green.
        if (st?.reconnected) {
          setWiqMessage({ type: 'success', text: 'WorkIQ sign-in had expired and was renewed automatically.' });
        }
      }
      return st;
    } catch (e) {
      const st = { ok: false, connected: false, account: null, error: e.message || String(e) };
      if (seq === wiqSeq.current) setWiqStatus(st);
      return st;
    } finally {
      setWiqChecking(false);
    }
  }, []);

  // Fast WorkIQ check on mount (account-only, offline). A full connectivity probe runs
  // lazily the first time the Customer Data section is open. Declared after checkWorkIq
  // so the useCallback is initialized before these effects reference it.
  useEffect(() => { checkWorkIq({ probe: false }); }, [checkWorkIq]);
  useEffect(() => {
    if (sections.ingest && !wiqProbed) {
      setWiqProbed(true);
      checkWorkIq({ probe: true });
    }
  }, [sections.ingest, wiqProbed, checkWorkIq]);

  const handleWorkIqConnect = async () => {
    // A check that is still running must not overwrite this sign-in's result.
    wiqSeq.current += 1;
    setWiqConnecting(true);
    setWiqMessage({ type: 'info', text: 'Opening sign-in… complete the Microsoft prompt, then return here. SE Assist checks the connection after you sign in.' });
    try {
      const res = await workiqConnect();
      if (!res?.success) {
        setWiqMessage({ type: 'error', text: res?.error || 'WorkIQ sign-in failed or was cancelled.' });
        return;
      }
      if (!res.state) {
        setWiqMessage({ type: 'error', text: 'WorkIQ sign-in finished, but the app did not return the connection check result. Click Check.' });
        return;
      }
      wiqSeq.current += 1;
      setWiqStatus(res.state);
      const account = res.state.account || res.account;
      if (res.state.connected === true) {
        setWiqMessage({ type: 'success', text: `WorkIQ connected${account ? ` (${account})` : ''}.` });
      } else {
        const detail = String(res.state.error || '').trim().replace(/\.+$/, '');
        setWiqMessage({
          type: 'error',
          text: `Signed in${account ? ` as ${account}` : ''}, but WorkIQ still cannot read your mailbox${detail ? `: ${detail}.` : '. WorkIQ returned no error detail.'}`,
        });
      }
    } catch (e) {
      setWiqMessage({ type: 'error', text: e.message || 'WorkIQ sign-in failed.' });
    } finally {
      setWiqConnecting(false);
    }
  };

  const handleIngest = async (mode) => {
    setIngesting(true);
    setIngestMessage(null);
    setIngestProgress({ phase: 'start' });
    try {
      const res = await m365IngestRun({ mode });
      if (res?.ok) {
        const c = res.counts || {};
        const conv = res.result?.convergence || {};
        let text = `${mode === 'backfill' ? 'Backfill' : 'Ingestion'} complete — ${c.emailsCustomer || 0} customer emails, ${c.meetingsCustomer || 0} meetings, ${c.chatsCustomer || 0} chats.`;
        if (conv.needsAnotherPass) {
          const bits = [];
          if (conv.aliasesRemaining) bits.push(`${conv.aliasesRemaining} account name${conv.aliasesRemaining === 1 ? '' : 's'} still need AI aliases`);
          if (conv.weakUnverified) bits.push(`${conv.weakUnverified} uncertain link${conv.weakUnverified === 1 ? '' : 's'} await AI review`);
          text += ` More to do: ${bits.join(' and ')}. Click “Pull new items” again to continue — each pass is cached, so it gets faster and cheaper until everything resolves.`;
        }
        // Imports still ran (deterministic exact-name linking) but AI enrichment was
        // skipped because the connected GitHub Copilot couldn't be reached. Surface the
        // specific reason loudly — never a silent degrade.
        if (res.result?.degraded) {
          setIngestMessage({
            type: 'warning',
            text: `Imports are degraded — AI alias/link enrichment was skipped. ${res.result.degradedReason || 'GitHub Copilot connection error.'} Deterministic linking on exact customer names still ran; reconnect GitHub Copilot in Settings and run “Pull new items” again to complete AI enrichment.`,
          });
        } else {
          setIngestMessage({ type: conv.needsAnotherPass ? 'info' : 'success', text });
        }
      } else {
        setIngestMessage({ type: 'error', text: res?.error || 'Ingestion failed.' });
      }
    } catch (e) {
      setIngestMessage({ type: 'error', text: e.message || 'Ingestion failed.' });
    } finally {
      setIngesting(false);
      setIngestProgress(null);
      refreshIngestStatus();
    }
  };

  const handleAutoIngestToggle = async (enabled) => {
    setAutoIngest((p) => ({ ...p, enabled }));
    try {
      const res = await m365AutoIngestSet({ enabled });
      if (res?.ok) setAutoIngest({ enabled: res.enabled, intervalMin: res.intervalMin });
    } catch { /* ignore */ }
  };

  const handleIntervalChange = async (intervalMin) => {
    setAutoIngest((p) => ({ ...p, intervalMin }));
    try {
      const res = await m365AutoIngestSet({ intervalMin });
      if (res?.ok) setAutoIngest({ enabled: res.enabled, intervalMin: res.intervalMin });
    } catch { /* ignore */ }
  };

  const handleMicrosoftSignIn = async () => {
    setMsLoading(true);
    setAuthMessage(null);
    try {
      const result = await entraSignIn();
      if (result?.success) {
        setAuthMessage({ type: 'success', text: `Signed in to Microsoft${result.userName ? ` as ${result.userName}` : ''}.` });
        setMsStatus(await entraStatus());
        try { setAuthStatus(await getAuthStatus()); } catch { /* ignore */ }
      } else {
        setAuthMessage({ type: 'error', text: result?.error || 'Microsoft sign-in failed.' });
      }
    } catch (e) {
      setAuthMessage({ type: 'error', text: e.message || 'Microsoft sign-in failed.' });
    } finally {
      setMsLoading(false);
    }
  };

  const handleMicrosoftSignOut = async () => {
    setMsLoading(true);
    setAuthMessage(null);
    try {
      await entraSignOut();
      setMsStatus(await entraStatus());
      setAuthStatus(await getAuthStatus());
      setAuthMessage({ type: 'success', text: 'Signed out of Microsoft.' });
    } catch (e) {
      setAuthMessage({ type: 'error', text: e.message || 'Sign-out failed.' });
    } finally {
      setMsLoading(false);
    }
  };

  const handleGithubConnect = async () => {
    setGhLoading(true);
    setModelMessage(null);
    setGhCode(null);
    try {
      const start = await githubSignInStart();
      if (start?.error || !start?.flowId) {
        setModelMessage({ type: 'error', text: start?.error || 'Could not start GitHub sign-in.' });
        setGhLoading(false);
        return;
      }
      setGhCode({ user_code: start.user_code, verification_uri: start.verification_uri });
      const result = await githubSignInWait(start.flowId);
      setGhCode(null);
      if (result?.signedIn) {
        const probe = await copilotProbe();
        if (probe?.ok) {
          setModelMessage({ type: 'success', text: `Connected GitHub Copilot${result.login ? ` (${result.login})` : ''}. Using model ${probe.model}.` });
          loadModels();
        } else {
          setModelMessage({ type: 'error', text: `Signed in to GitHub${result.login ? ` (${result.login})` : ''}, but Copilot is unavailable: ${probe?.error || 'no active Copilot subscription.'}` });
        }
        setProvider(await modelProviderStatus());
      } else {
        setModelMessage({ type: 'error', text: result?.error || 'GitHub sign-in did not complete.' });
      }
    } catch (e) {
      setModelMessage({ type: 'error', text: e.message || 'GitHub sign-in failed.' });
    } finally {
      setGhLoading(false);
    }
  };

  const handleGithubDisconnect = async () => {
    setGhLoading(true);
    setModelMessage(null);
    try {
      await githubSignOut();
      setProvider(await modelProviderStatus());
      setModels([]);
      setSelectedModel('');
      setUtilityModel('');
      setModelMessage({ type: 'success', text: 'Disconnected GitHub Copilot.' });
    } catch (e) {
      setModelMessage({ type: 'error', text: e.message || 'Disconnect failed.' });
    } finally {
      setGhLoading(false);
    }
  };

  // Pull the live model catalog from GitHub Copilot. On first load (no saved choice),
  // auto-select the recommended latest model so the app uses it out of the box.
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await copilotListModels();
      if (!res?.ok) {
        setModels([]);
        return;
      }
      setModels(res.models || []);
      let active = res.selected || '';
      if (!active && res.recommended) {
        const applied = await copilotSetModel(res.recommended);
        active = applied?.model || res.recommended;
        try { setProvider(await modelProviderStatus()); } catch { /* ignore */ }
      }
      setSelectedModel(active || res.effective || '');
      setUtilityModel(res.utilitySelected === '__primary__' ? '' : (res.utilitySelected || ''));
    } catch {
      setModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const handleModelChange = async (modelId) => {
    setSelectedModel(modelId);
    setModelMessage(null);
    try {
      const res = await copilotSetModel(modelId);
      setProvider(await modelProviderStatus());
      const label = models.find((m) => m.id === modelId)?.name || modelId;
      setModelMessage({ type: 'success', text: `Model set to ${label}.` });
      if (res?.model && res.model !== modelId) setSelectedModel(res.model);
    } catch (e) {
      setModelMessage({ type: 'error', text: e.message || 'Could not set model.' });
    }
  };

  const handleUtilityModelChange = async (modelId) => {
    setUtilityModel(modelId);
    setModelMessage(null);
    try {
      const res = await copilotSetUtilityModel(modelId);
      if (!res?.ok) throw new Error(res?.error || 'Could not set the utility model.');
      setProvider(await modelProviderStatus());
      const label = modelId
        ? (models.find((model) => model.id === modelId)?.name || modelId)
        : 'the primary model';
      setModelMessage({ type: 'success', text: `Utility tasks will use ${label}.` });
    } catch (e) {
      setModelMessage({ type: 'error', text: e.message || 'Could not set the utility model.' });
    }
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    setSyncMessage(null);
    setSyncSteps(SYNC_STEPS.reduce((acc, s) => ({ ...acc, [s.key]: { status: 'pending' } }), {}));
    try {
      const results = await syncAll(({ step, status, result }) => {
        setSyncSteps((prev) => ({
          ...prev,
          [step]: { status, detail: status === 'done' ? describeSyncResult(step, result) : prev[step]?.detail },
        }));
      });
      const summary = SYNC_STEPS.map((s) => describeSyncResult(s.key, results[s.key])).filter(Boolean).join(' · ');
      const failedTotal = SYNC_STEPS.reduce((n, s) => n + (results[s.key]?.failedRequests ?? 0), 0);
      if (failedTotal > 0) {
        setSyncMessage({
          type: 'warning',
          text: `Sync incomplete — ${failedTotal} CRM request${failedTotal === 1 ? '' : 's'} failed (likely Dataverse throttling); counts may be under-reported. Re-run to fill the gaps. ${summary}.`,
        });
      } else {
        setSyncMessage({ type: 'success', text: `Sync complete — ${summary}.` });
      }
      const now = new Date().toISOString();
      setSyncLastRun(now);
      try { localStorage.setItem('se-assist:syncLastRun', now); } catch { /* ignore */ }
      // The sync writes the signed-in user's identity into app_settings. Notify the
      // TerritoryProvider so the "Show Full Territory" toggle enables itself immediately
      // (otherwise it stays greyed out until the app is reloaded).
      try { window.dispatchEvent(new Event(IDENTITY_UPDATED_EVENT)); } catch { /* ignore */ }
      // Refresh auth status (sync ran ensureAuth) so the Authentication card stays current.
      try { setAuthStatus(await getAuthStatus()); } catch { /* ignore */ }
    } catch (e) {
      setSyncMessage({ type: 'error', text: `Sync failed: ${e.message || e}` });
    } finally {
      setSyncing(false);
    }
  };

  const isAuthenticated = authStatus?.isAuthenticated;
  const tokenExpiry = authStatus?.expiresOn || authStatus?.expiresAt;
  const minutesRemaining = tokenExpiry
    ? Math.max(0, Math.round((new Date(tokenExpiry) - Date.now()) / 60000))
    : null;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spinner label="Loading settings…" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2><SettingsRegular style={{ fontSize: 22, marginRight: 8, verticalAlign: 'middle' }} />User Home</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          {!inElectron() && <span className="badge badge-warning">Running outside Electron — features limited</span>}
          <button type="button" className="btn btn-secondary" onClick={openSetupGuide} title="Open the Guided Setup checklist">
            <SparkleRegular /> Guided Setup
          </button>
        </div>
      </div>

      {/* Appearance + Customize navigation share one row. */}
      <div className="settings-row-2col">
        <AppearanceCustomizer open={sections.appearance} onToggle={() => toggle('appearance')} />
        <NavCustomizer open={sections.nav} onToggle={() => toggle('nav')} />
      </div>

      {/* Data & backups — protect locally-authored notes / links. */}
      <BackupCustomizer open={sections.backups} onToggle={() => toggle('backups')} />

      {/* Section 1: My Sales Accounts by TPID — full width, at the top */}
      <Section
        open={sections.accounts}
        onToggle={() => toggle('accounts')}
        anchor="section-accounts"
        icon={<PeopleRegular />}
        title="My Sales Accounts by TPID"
        badge={
          <span className="badge badge-info">
            {tpids.length} active account{tpids.length !== 1 ? 's' : ''}
          </span>
        }
      >
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Only your saved accounts are active: they appear in the workspace and are eligible for sync, ingestion,
          and AI work. Edit the complete list on the left, then <strong>Save active roster</strong>.
          Removing an account archives it without deleting its history or local work. Re-add its TPID to restore
          that history and resume pulls. After adding accounts, run <strong>Sync from CRM</strong> to refresh their details.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {/* Complete replacement draft; the saved list remains unchanged until confirmed. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Active roster (complete list, one TPID per line)
            </div>
            <Textarea
              aria-label="Active account TPIDs"
              resize="vertical"
              appearance="filled-darker"
              value={rosterDraft}
              onChange={(_e, data) => setRosterDraft(data.value)}
              placeholder={'1001\n1002\n1003'}
              style={{ width: '100%' }}
              textarea={{ style: { height: 360, maxHeight: 640, fontFamily: 'Consolas, monospace', lineHeight: 1.5 } }}
            />
            <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              <Button appearance="secondary" icon={<WandRegular />} onClick={handleDetectAccounts} disabled={!rosterReady || detecting || rosterSaving}>
                {detecting ? 'Detecting…' : 'Detect my accounts (MSX)'}
              </Button>
              <Button appearance="secondary" onClick={handleResetRoster} disabled={!rosterReady || rosterSaving || !rosterCustom || syncing || ingesting}>
                Archive all
              </Button>
              <Button {...rosterFocusTarget} ref={rosterSaveRef} appearance="primary" onClick={handleSaveRoster} disabled={!rosterReady || rosterSaving || syncing || ingesting}>
                {rosterSaving ? 'Saving…' : 'Save active roster'}
              </Button>
            </div>
          </div>
          {/* Right: read-only list of the currently configured roster (TPID + account name). */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Saved active accounts ({tpids.length})
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-3)', height: 360, overflowY: 'auto' }}>
              {tpids.length === 0 ? (
                <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 13 }}>No accounts configured.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    {sortedTpids.map((t) => (
                      <tr key={t} style={{ borderBottom: '1px solid var(--hairline)' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'Consolas, monospace', color: 'var(--text-secondary)', whiteSpace: 'nowrap', width: 1, verticalAlign: 'top' }}>{t}</td>
                        <td style={{ padding: '6px 10px', color: nameByTpid.get(String(t)) ? 'var(--text-secondary)' : 'var(--text-faint)' }}>
                          {nameByTpid.get(String(t)) || 'Not synced yet'}
                        </td>
                        <td style={{ padding: '4px 6px', width: 1 }}>
                          <Button size="small" appearance="subtle" disabled={rosterSaving || syncing || ingesting || rosterDraftDirty}
                            title={rosterDraftDirty ? 'Save your roster edits before archiving an individual account.' : 'Archive this account without deleting its history.'}
                            onClick={() => requestRosterSave(tpids.filter((id) => id !== t))}>
                            Archive
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
        {rosterMessage && (
          <div style={{ marginTop: 12 }}>
            <span className={`badge badge-${rosterMessage.type === 'success' ? 'success' : rosterMessage.type === 'warning' ? 'warning' : 'danger'}`}>
              {rosterMessage.text}
            </span>
          </div>
        )}
        {detectDetails && <DetectionDetails details={detectDetails} onDismiss={() => setDetectDetails(null)} />}
        <InfoNote>
          TPIDs are numeric account identifiers (one per line). <strong>Detect my accounts</strong> reads the
          customer accounts behind your MSX milestone teams, account teams, and deal teams, then shows any that
          aren't already active as suggestions in the editable list. Detection can include past-role accounts;
          nothing is activated until you review and save. <strong>Saving replaces the active list exactly.</strong>
          Accounts left out stay archived, not deleted. An empty saved list pauses all account-specific work.
        </InfoNote>
      </Section>

      <Dialog open={!!rosterChange} onOpenChange={(_event, data) => { if (!rosterSaving && !data.open) setRosterChange(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Archive {rosterChange?.removed.length} account{rosterChange?.removed.length !== 1 ? 's' : ''}?</DialogTitle>
            <DialogContent>
              <p>The saved roster will contain {rosterChange?.tpids.length} active accounts. The following accounts
                will disappear from active views and stop receiving pulls and new work:</p>
              <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                {(rosterChange?.removed || []).map((tpid) => <div key={tpid}>{nameByTpid.get(String(tpid)) || 'Account'} ({tpid})</div>)}
              </div>
              <p>No history, workloads, Tasks, notes, transcripts, links, dismissals, or saved outputs will be deleted.
                Re-add a TPID to restore its history and resume work.</p>
              {rosterMessage && ['error', 'warning'].includes(rosterMessage.type) && (
                <div role="alert" className={`badge badge-${rosterMessage.type === 'warning' ? 'warning' : 'danger'}`}
                  style={{ whiteSpace: 'normal' }}>
                  {rosterMessage.text}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={rosterSaving} onClick={() => setRosterChange(null)}>Cancel</Button>
              <Button appearance="primary" disabled={rosterSaving} onClick={() => persistRoster(rosterChange.tpids)}>
                {rosterSaving ? 'Saving…' : 'Archive and save roster'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Prompt to run the CRM sync after adding new accounts, so the new TPIDs
          get their names/details. Confirmation, not silent — sync needs auth/network. */}
      <Dialog open={!!syncPrompt} onOpenChange={(_e, d) => { if (!d.open) setSyncPrompt(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Refresh your activated accounts?</DialogTitle>
            <DialogContent>
              You activated {syncPrompt?.count} account{syncPrompt?.count !== 1 ? 's' : ''}.
              Previously archived history is already available. Run "Sync from CRM" to refresh current
              details and milestones, or to load a new account for the first time.
              This needs a Microsoft 365 sign-in and can take a minute.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSyncPrompt(null)}>
                Not now
              </Button>
              <Button
                appearance="primary"
                icon={<ArrowSyncRegular />}
                onClick={() => {
                  setSyncPrompt(null);
                  setSections((s) => ({ ...s, sync: true }));
                  handleSyncAll();
                }}
              >
                Sync from CRM now
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Primary connections — M365 Authentication (34%) | MSX Dynamics Sync (66%) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 34fr) minmax(0, 66fr)', gap: 16, alignItems: 'start' }}>
        <Section
          open={sections.auth}
          onToggle={() => toggle('auth')}
          anchor="section-auth"
          icon={<ShieldCheckmarkRegular />}
          title="Microsoft 365 sign-in"
          badge={
            probes.ms === 'unavailable' && !msStatus
              ? UnavailableBadge
              : msStatus?.signedIn
                ? <span className="badge badge-success">
                    <CheckmarkCircleRegular style={{ fontSize: 12, marginRight: 4 }} />
                    Connected
                  </span>
                : <span className="badge badge-danger">
                    <DismissCircleRegular style={{ fontSize: 12, marginRight: 4 }} />Not Connected
                  </span>
          }
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
            SE Assist uses your Microsoft 365 sign-in to mint access tokens for MSX (Dynamics CRM) data.
            This also mints a Power BI resource token (Requires M365 sign-in + Corpnet VPN) for ACR data.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <ReadonlyField label="Microsoft Account" value={msStatus?.signedIn ? (msStatus.userName || 'Signed in') : 'Not signed in'} />
            <ReadonlyField
              label="MSX Data Token"
              value={isAuthenticated
                ? `Active${minutesRemaining != null ? ` (${minutesRemaining}m left)` : ''}`
                : (probes.auth === 'unavailable' && !authStatus
                    ? "Couldn't check"
                    : (msStatus?.signedIn ? 'Minted on demand' : 'None'))}
            />
          </div>

          {!msStatus?.signedIn && (
            <div className="flash-message flash-warning" style={{ marginBottom: 12 }}>
              Sign in with your Microsoft account to connect MSX (Dynamics CRM). (Mail, meetings, and Teams chats come from WorkIQ — see Customer Data below.)
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {msStatus?.signedIn ? (
              <Button appearance="secondary" icon={<PersonRegular />} onClick={handleMicrosoftSignOut} disabled={msLoading}>
                {msLoading ? 'Working…' : 'Sign out of Microsoft'}
              </Button>
            ) : (
              <Button appearance="primary" icon={<PersonRegular />} onClick={handleMicrosoftSignIn} disabled={msLoading}>
                {msLoading ? 'Opening browser…' : 'Sign in with Microsoft'}
              </Button>
            )}
            {msLoading && <Spinner size="tiny" />}
          </div>

          {authMessage && (
            <div className={`flash-message flash-${authMessage.type}`} style={{ marginTop: 12 }}>
              {authMessage.text}
            </div>
          )}
        </Section>

        <Section
          open={sections.sync}
          onToggle={() => toggle('sync')}
          anchor="section-sync"
          icon={<ArrowSyncRegular />}
          title="MSX Dynamics Sync"
          badge={<span className="badge badge-info">CRM → local cache</span>}
        >
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Pull everything from Dynamics into the local cache in one pass — customer accounts,
            then opportunities &amp; milestones (and your identity), then HoK activities. Runs in order
            because each step builds on the previous. The Customers, Milestones, Dashboard, and HoK
            Activities tabs all read from this cache.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            {SYNC_STEPS.map((s, i) => {
              const st = syncSteps[s.key];
              const status = st?.status;
              return (
                <div
                  key={s.key}
                  className="card"
                  style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 180 }}
                >
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{i + 1}.</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                    {st?.detail && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{st.detail}</div>}
                  </div>
                  {status === 'running' && <Spinner size="tiny" />}
                  {status === 'done' && <CheckmarkCircleRegular style={{ color: 'var(--success-text)', fontSize: 16 }} />}
                  {status === 'error' && <DismissCircleRegular style={{ color: 'var(--pink)', fontSize: 16 }} />}
                  {status === 'pending' && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>queued</span>}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button appearance="primary" icon={<ArrowSyncRegular />} onClick={handleSyncAll} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from CRM'}
            </Button>
            <span style={{ color: 'var(--danger-text)', fontSize: 12, fontWeight: 600 }}>
              This takes time. Do not leave the page while syncing.
            </span>
            {syncing && <Spinner size="tiny" />}
            {syncMessage && (
              <span className={`badge badge-${syncMessage.type === 'success' ? 'success' : syncMessage.type === 'warning' ? 'warning' : 'danger'}`}>
                {syncMessage.text}
              </span>
            )}
            {syncLastRun && !syncing && (
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto' }}>
                Last run: {new Date(syncLastRun).toLocaleString()}
              </span>
            )}
          </div>

          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={msxAutoSync.enabled}
                onChange={(e) => handleMsxAutoSyncToggle(e.target.checked)}
              />
              Auto-sync milestones &amp; HoK activities in the background
            </label>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: msxAutoSync.enabled ? 'var(--text)' : 'var(--text-muted)' }}>
              every
              <select
                value={msxAutoSync.intervalMin}
                onChange={(e) => handleMsxAutoSyncInterval(Number(e.target.value))}
                disabled={!msxAutoSync.enabled}
                style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-strong)' }}
              >
                <option value={30}>30 min</option>
                <option value={60}>1 hour</option>
                <option value={180}>3 hours</option>
                <option value={360}>6 hours</option>
                <option value={720}>12 hours</option>
              </select>
            </span>
            <Button
              appearance="secondary"
              size="small"
              icon={<ArrowSyncRegular />}
              onClick={handleMsxAutoSyncRunNow}
              disabled={msxAutoRunning || syncing}
            >
              {msxAutoRunning ? 'Syncing…' : 'Run now'}
            </Button>
          </div>
          {(msxAutoSync.enabled || msxAutoSyncLog) && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: msxAutoSyncLog ? (msxAutoSyncLog.ok ? 'var(--success-text)' : 'var(--danger)') : 'var(--text-muted)' }}>
              {msxAutoSyncLog
                ? (msxAutoSyncLog.ok
                    ? `Last auto-sync: ${new Date(msxAutoSyncLog.at).toLocaleString()} · ${msxAutoSyncLog.items} item${msxAutoSyncLog.items === 1 ? '' : 's'} (${msxAutoSyncLog.milestones} milestones · ${msxAutoSyncLog.hok} HoK) · ${(msxAutoSyncLog.durationMs / 1000).toFixed(1)}s${msxAutoSyncLog.failedRequests ? ` · ⚠ ${msxAutoSyncLog.failedRequests} request${msxAutoSyncLog.failedRequests === 1 ? '' : 's'} failed` : ''}`
                    : `Last auto-sync failed: ${msxAutoSyncLog.error} (${new Date(msxAutoSyncLog.at).toLocaleString()})`)
                : 'No automatic syncs yet — the first happens once the interval elapses while the app is open.'}
            </div>
          )}
          <InfoNote>
            Requires a Microsoft 365 sign-in (see M365 sign-in on the left). Auto-sync refreshes
            only milestones &amp; HoK activities (customers and contacts stay under the button
            above) and runs while the app is open.
          </InfoNote>
        </Section>
      </div>

      {/* GitHub Copilot CLI — full width, above Customer Data */}
      <Section
        open={sections.model}
        onToggle={() => toggle('model')}
        anchor="section-model"
        icon={<SparkleRegular />}
        title="GitHub sign-in"
        badge={
          probes.provider === 'unavailable' && !provider
            ? UnavailableBadge
            : provider?.active === 'github-copilot'
              ? <span className="badge badge-success"><CheckmarkCircleRegular style={{ fontSize: 12, marginRight: 4 }} />Connected</span>
              : <span className="badge badge-danger"><DismissCircleRegular style={{ fontSize: 12, marginRight: 4 }} />Not connected</span>
        }
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
          SE Assist uses the Github Copilot models to power AI features. Including comprehensive summaries, tech-stack generation, and the assistant.
          Connect GitHub Copilot to use your Copilot subscription models — the same backend the Copilot CLI uses.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: provider?.copilot?.signedIn ? 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr)' : '1fr 1fr', gap: 16, marginBottom: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
            <ReadonlyField label="GitHub Copilot" value={provider?.copilot?.signedIn ? `Connected${provider.copilot.login ? ` (${provider.copilot.login})` : ''}` : 'Not connected'} />
            {provider?.copilot?.signedIn && (
              <Button appearance="secondary" icon={<DismissCircleRegular />} onClick={handleGithubDisconnect} disabled={ghLoading}>
                {ghLoading ? 'Working…' : 'Disconnect GitHub Copilot'}
              </Button>
            )}
          </div>
          <ReadonlyField label="Copilot Model" value={provider?.copilot?.model || '—'} />
          {provider?.copilot?.signedIn && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label htmlFor="copilot-model" style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Change Model {modelsLoading && <Spinner size="tiny" style={{ marginLeft: 8, verticalAlign: 'middle' }} />}
                </label>
                <Button appearance="subtle" size="small" icon={<ArrowSyncRegular />} onClick={loadModels} disabled={modelsLoading}>
                  Refresh
                </Button>
              </div>
              <select
                id="copilot-model"
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={modelsLoading || models.length === 0}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-strong)', fontSize: 13,
                }}
              >
                {models.length === 0 && <option value="">{modelsLoading ? 'Loading models…' : 'No models available'}</option>}
                {models.some((m) => m.picker) && (
                  <optgroup label="Latest models">
                    {models.filter((m) => m.picker).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.vendor ? ` — ${m.vendor}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => !m.picker) && (
                  <optgroup label="Other models">
                    {models.filter((m) => !m.picker).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.vendor ? ` — ${m.vendor}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6, marginBottom: 0 }}>
                Primary model for analysis, recommendations, and customer-facing synthesis.
              </p>
              <label htmlFor="copilot-utility-model" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, marginTop: 14, marginBottom: 6 }}>
                Utility Model (optional)
              </label>
              <select
                id="copilot-utility-model"
                value={utilityModel}
                onChange={(event) => handleUtilityModelChange(event.target.value)}
                disabled={modelsLoading || models.length === 0}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-strong)', fontSize: 13,
                }}
              >
                <option value="">Use primary model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}{model.vendor ? ` — ${model.vendor}` : ''}
                  </option>
                ))}
              </select>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6, marginBottom: 0 }}>
                Select a faster second model for bounded extraction and classification. Primary synthesis stays on the model above, and SE Assist never switches models after an error.
              </p>
            </div>
          )}
        </div>

        {ghCode && (
          <div className="flash-message flash-info" style={{ marginBottom: 12 }}>
            To connect, enter code <strong style={{ fontSize: 16, letterSpacing: 1 }}>{ghCode.user_code}</strong> at{' '}
            <a href={ghCode.verification_uri} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{ghCode.verification_uri}</a>
            {' '}(a browser tab was opened). Waiting for authorization…
          </div>
        )}

        {!provider?.copilot?.signedIn && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button appearance="primary" icon={<SparkleRegular />} onClick={handleGithubConnect} disabled={ghLoading}>
              {ghLoading ? 'Waiting for authorization…' : 'Connect GitHub Copilot'}
            </Button>
            {ghLoading && <Spinner size="tiny" />}
          </div>
        )}

        {modelMessage && (
          <div className={`flash-message flash-${modelMessage.type}`} style={{ marginTop: 12 }}>
            {modelMessage.text}
          </div>
        )}
      </Section>

      {/* WorkIQ Authentication (34%) | Customer Data (66%) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 34fr) minmax(0, 66fr)', gap: 16, alignItems: 'start' }}>
        <Section
          open={sections.wiqauth}
          onToggle={() => toggle('wiqauth')}
          anchor="section-wiqauth"
          icon={<ShieldCheckmarkRegular />}
          title="Microsoft 365 Copilot sign-in"
          badge={
            wiqStatus?.connected === true
              ? <span className="badge badge-success"><CheckmarkCircleRegular style={{ fontSize: 12, marginRight: 4 }} />Connected</span>
              : wiqStatus?.connected === false
                ? <span className="badge badge-danger"><DismissCircleRegular style={{ fontSize: 12, marginRight: 4 }} />Not connected</span>
                : <span className="badge badge-info">Checking…</span>
          }
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
            WorkIQ carries its own Microsoft 365 Copilot sign-in — separate from MSX and GitHub — and powers the
            customer emails, meetings, and Teams chats pulled in <strong>Customer Data</strong>. Connect once and
            the token is cached for background syncs.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginBottom: 12 }}>
            {wiqChecking ? (
              <Spinner size="tiny" />
            ) : wiqStatus?.connected === true ? (
              <CheckmarkCircleRegular style={{ color: 'var(--success-text)', fontSize: 18 }} />
            ) : wiqStatus?.connected === false ? (
              <DismissCircleRegular style={{ color: 'var(--danger)', fontSize: 18 }} />
            ) : (
              <InfoRegular style={{ color: 'var(--text-muted)', fontSize: 18 }} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {wiqChecking ? 'Checking WorkIQ…'
                  : wiqStatus?.connected === true ? 'WorkIQ connected'
                  : (wiqStatus?.account || wiqStatus?.knownAccount) ? 'WorkIQ sign-in expired'
                  : 'WorkIQ not connected'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(wiqStatus?.account || wiqStatus?.knownAccount)
                  ? `Account: ${wiqStatus.account || wiqStatus.knownAccount}`
                  : 'Powers customer emails, meetings & Teams chats.'}
              </div>
              {/* The session expires on its own; once an account is known the app can
                  re-acquire it silently, so say that instead of leaving the user to
                  wonder why they keep having to press a button. */}
              {wiqStatus?.connected === true && (wiqStatus?.account || wiqStatus?.knownAccount) && (
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {wiqStatus?.reconnected
                    ? 'Reconnected automatically just now.'
                    : 'Reconnects automatically when the sign-in expires.'}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Stays usable during a check: a check can wait minutes on an automatic
                reconnect, and Connect WorkIQ cancels that attempt and signs in directly. */}
            <Button
              appearance="primary"
              icon={<PersonRegular />}
              onClick={handleWorkIqConnect}
              disabled={wiqConnecting}
            >
              {wiqConnecting ? 'Signing in…' : wiqStatus?.connected === true ? 'Reconnect' : 'Connect WorkIQ'}
            </Button>
            <Button
              appearance="secondary"
              icon={wiqChecking ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
              onClick={() => { setWiqMessage(null); checkWorkIq({ probe: true }); }}
              disabled={wiqChecking || wiqConnecting}
            >
              Check
            </Button>
          </div>

          {wiqMessage && (
            <div className={`flash-message flash-${wiqMessage.type === 'success' ? 'success' : wiqMessage.type === 'error' ? 'error' : 'info'}`} style={{ marginTop: 12, marginBottom: 0 }}>
              {wiqMessage.text}
            </div>
          )}
          {!wiqMessage && wiqStatus?.connected === false && (
            <div className="flash-message flash-warning" style={{ marginTop: 12, marginBottom: 0 }}>
              {wiqStatus?.status === 403 ? (
                <>
                  WorkIQ is signed in, but Microsoft 365 denied it access{workIqDetail(wiqStatus)}
                  {' '}Signing in again does not grant access; check the account&apos;s permissions and tenant policy.
                </>
              ) : (wiqStatus?.account || wiqStatus?.knownAccount) ? (
                <>
                  WorkIQ&apos;s sign-in expired and was not renewed automatically{workIqDetail(wiqStatus)}
                  {' '}Click <strong>Connect WorkIQ</strong> and complete the Microsoft prompt.
                </>
              ) : (
                <>
                  WorkIQ isn&apos;t connected, so emails, meetings, and Teams chats can&apos;t sync. Click <strong>Connect
                  WorkIQ</strong> and complete the Microsoft prompt. Requires an M365 Copilot license. After this
                  one-time sign-in the app keeps the connection alive on its own.
                </>
              )}
            </div>
          )}
        </Section>

        <Section
          open={sections.ingest}
          onToggle={() => toggle('ingest')}
          anchor="section-ingest"
          icon={<CloudArrowDownRegular />}
          title="WorkIQ Outlook and Teams Sync"
          badge={
            probes.ingest === 'unavailable' && !ingestStatus
              ? UnavailableBadge
              : ingestStatus?.counts
                ? <span className="badge badge-info">{ingestStatus.counts.emailsCustomer || 0} emails · {ingestStatus.counts.meetingsCustomer || 0} meetings · {ingestStatus.counts.chatsCustomer || 0} chats</span>
                : <span className="badge badge-info">WorkIQ → local cache</span>
          }
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
            Pull your customer emails, meetings, and Teams chats via WorkIQ (see WorkIQ Authentication on the left),
            linked only to your detected accounts. <strong>Backfill</strong> does a wide historical pull;{' '}
            <strong>Pull new items</strong> grabs anything recent. Enable auto-ingest to keep it current in the background.
          </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <ReadonlyField label="Emails (customer)" value={ingestStatus?.counts ? `${ingestStatus.counts.emailsCustomer || 0} / ${ingestStatus.counts.emails || 0}` : '—'} />
          <ReadonlyField label="Meetings (customer)" value={ingestStatus?.counts ? `${ingestStatus.counts.meetingsCustomer || 0} / ${ingestStatus.counts.meetings || 0}` : '—'} />
          <ReadonlyField label="Chats (customer)" value={ingestStatus?.counts ? `${ingestStatus.counts.chatsCustomer || 0} / ${ingestStatus.counts.chats || 0}` : '—'} />
        </div>

        {ingestStatus?.lastError && !ingesting && (
          <div className="flash-message flash-warning" style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <WarningRegular style={{ fontSize: 16, marginTop: 1, flexShrink: 0 }} />
            <span>
              Last sync attempt failed: {ingestStatus.lastError}
              {ingestStatus.lastErrorAt && ` (${new Date(ingestStatus.lastErrorAt).toLocaleString()})`}
            </span>
          </div>
        )}

        {ingestProgress && (
          <div className="flash-message flash-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner size="tiny" />
            <span>
              {ingestProgress.phase === 'accounts' && 'Detecting your accounts…'}
              {ingestProgress.phase === 'start' && 'Starting…'}
              {ingestProgress.phase === 'degraded' && `Degraded — ${ingestProgress.detail || 'GitHub Copilot unavailable; AI enrichment skipped.'}`}
              {ingestProgress.medium && `${ingestProgress.medium}: ${ingestProgress.phase}${ingestProgress.detail ? ` — ${ingestProgress.detail}` : ''}`}
              {!ingestProgress.medium && ingestProgress.phase === 'error' && `Error: ${ingestProgress.detail}`}
            </span>
          </div>
        )}

        {!ingesting && !ingestProgress && ingestStatus?.lastResult?.convergence?.needsAnotherPass && (
          <div className="flash-message flash-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <ArrowSyncRegular style={{ fontSize: 16, marginTop: 1, flexShrink: 0 }} />
            <span>
              <strong>One more pass will pull in more.</strong>{' '}
              {(() => {
                const conv = ingestStatus.lastResult.convergence;
                const bits = [];
                if (conv.aliasesRemaining) bits.push(`${conv.aliasesRemaining} account name${conv.aliasesRemaining === 1 ? '' : 's'} still need AI aliases`);
                if (conv.weakUnverified) bits.push(`${conv.weakUnverified} uncertain link${conv.weakUnverified === 1 ? '' : 's'} still await AI review`);
                return bits.join(' and ');
              })()}. Each run is capped so it stays fast, and results are cached — click <strong>Pull new items</strong> again to continue. Repeat until this message disappears.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button appearance="primary" icon={<CloudArrowDownRegular />} onClick={() => handleIngest('backfill')} disabled={ingesting}>
            {ingesting ? 'Working…' : 'Backfill (historical)'}
          </Button>
          <Button appearance="secondary" icon={<ArrowSyncRegular />} onClick={() => handleIngest('incremental')} disabled={ingesting}>
            Pull new items
          </Button>
          <button
            type="button"
            aria-label="About Backfill vs Pull new items"
            title="About Backfill vs Pull new items"
            onClick={() => setShowBackfillInfo(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'transparent', color: 'var(--accent)',
              cursor: 'pointer', padding: 0, flexShrink: 0,
            }}
          >
            <InfoRegular style={{ fontSize: 20 }} />
          </button>
          <span style={{ color: 'var(--danger-text)', fontSize: 12, fontWeight: 600 }}>
            This takes time. Do not leave the page while syncing.
          </span>
          {ingesting && <Spinner size="tiny" />}
          {ingestStatus?.lastRunAt && !ingesting && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto' }}>
              Last run: {new Date(ingestStatus.lastRunAt).toLocaleString()}
            </span>
          )}
        </div>

        {ingestMessage && (
          <div className={`flash-message flash-${ingestMessage.type}`} style={{ marginTop: 12 }}>
            {ingestMessage.text}
          </div>
        )}

        <Dialog open={showBackfillInfo} onOpenChange={(_, d) => setShowBackfillInfo(d.open)}>
          <DialogSurface style={{ maxWidth: 620 }}>
            <DialogBody>
              <DialogTitle>Backfill vs Pull new items</DialogTitle>
              <DialogContent>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>
                  Both buttons run the same ingestion pipeline through idempotent, ID-keyed upserts, so
                  re-running is safe — nothing is duplicated or deleted. They differ only in how wide a
                  window they pull:
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, margin: '12px 0' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)' }}>Setting</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)', fontWeight: 700 }}>Backfill (historical)</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)' }}>Pull new items (incremental)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Past window', '6 months', '1 month'],
                      ['Future window (meetings)', '6 months', '3 months'],
                      ['Emails per account', '100 (up to 3 pages)', '40'],
                      ['Teams chats scanned for messages', '120', '40'],
                    ].map(([setting, backfill, incremental]) => (
                      <tr key={setting}>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--hairline)', color: 'var(--text-secondary)' }}>{setting}</td>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--hairline)', fontWeight: 700 }}>{backfill}</td>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--hairline)', color: 'var(--text-secondary)' }}>{incremental}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flash-message flash-info" style={{ marginTop: 8 }}>
                  Backfill only pulls items linked to your currently detected accounts. If you've added
                  accounts since your last pull, run account detection first so Backfill has them in scope.
                </div>

                <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 700, margin: '16px 0 4px' }}>
                  How many times do I click each?
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>
                  Run <strong>Backfill once</strong> to seed your history. After that, only use{' '}
                  <strong>Pull new items</strong> — it keeps everything current (and auto-ingest does this
                  for you in the background). You don't need to click Backfill again unless you want to widen
                  the history window.
                </p>
                <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 700, margin: '12px 0 4px' }}>
                  Why might it take more than one pass?
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>
                  To keep each run fast, the AI steps that link items to accounts are capped per run —
                  short-name/alias generation and the review of uncertain (“weak”) links. If you own many
                  accounts, the first run resolves a large batch and defers the rest. <strong>Both buttons
                  advance this</strong>, so each later <strong>Pull new items</strong> continues where the
                  last left off. Results are cached, so repeats are cheap and converge quickly. The app tells
                  you when another pass would help — after a run you'll see “One more pass will pull in more”
                  with the remaining counts; just click Pull new items again until that message is gone.
                </p>
                <div className="flash-message flash-info" style={{ marginTop: 8 }}>
                  This only applies when an AI model is available (GitHub Copilot signed in). Without one,
                  linking falls back to exact account names in a single deterministic pass — no repeats needed.
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => setShowBackfillInfo(false)}>Got it</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text)' }}>
            <input type="checkbox" checked={autoIngest.enabled} onChange={(e) => handleAutoIngestToggle(e.target.checked)} />
            Auto-ingest new items in the background
          </label>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: autoIngest.enabled ? 'var(--text)' : 'var(--text-muted)' }}>
            every
            <select
              value={autoIngest.intervalMin}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              disabled={!autoIngest.enabled}
              style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-strong)' }}
            >
              <option value={30}>30 min</option>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
              <option value={360}>6 hours</option>
              <option value={720}>12 hours</option>
            </select>
          </span>
        </div>
        {(autoIngest.enabled || autoIngestLog) && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: autoIngestLog ? (autoIngestLog.ok ? 'var(--success-text)' : 'var(--danger)') : 'var(--text-muted)' }}>
            {autoIngestLog
              ? (autoIngestLog.ok
                  ? `Last auto-run: ${new Date(autoIngestLog.at).toLocaleString()} · pulled ${autoIngestLog.items} item${autoIngestLog.items === 1 ? '' : 's'} · ${(autoIngestLog.durationMs / 1000).toFixed(1)}s`
                  : `Last auto-run failed: ${autoIngestLog.error} (${new Date(autoIngestLog.at).toLocaleString()})`)
              : 'No automatic runs yet — the first happens once the interval elapses while the app is open.'}
          </div>
        )}
        <InfoNote>
          Requires the Copilot CLI WorkIQ sign-in (the same M365 account). Only customer-related items are kept;
          everything is stored locally in SQLite. Auto-ingest runs while the app is open.
        </InfoNote>
      </Section>
      </div>

      {/* Section: SSP Configuration — assign the SSP (Cloud and AI Specialist) per account. */}
      <Section
        open={sections.sspConfig}
        onToggle={() => toggle('sspConfig')}
        icon={<PeopleRegular />}
        title="SSP Configuration"
        anchor="section-sspConfig"
      >
        <SspConfiguration />
      </Section>

      {/* Section 3: CRM Settings */}
      <Section
        open={sections.crm}
        onToggle={() => toggle('crm')}
        icon={<GlobeRegular />}
        title="CRM Settings"
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
          <ReadonlyField label="CRM URL" value={crmUrl || '—'} mono />
          <ReadonlyField label="Tenant ID" value={tenantId || '—'} mono />
        </div>
        <InfoNote>
          CRM URL and tenant are fixed Dynamics defaults built into the app.
        </InfoNote>
      </Section>

      {/* Section 4: About */}
      <Section
        open={sections.about}
        onToggle={() => toggle('about')}
        icon={<InfoRegular />}
        title="About SE Assist"
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>SE Assist</div>
          <span
            title="Installed app version"
            style={{
              fontSize: 12, fontWeight: 600, color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
              borderRadius: 999, padding: '2px 10px',
            }}
          >
            {appVersion ? `v${appVersion}` : 'version unavailable'}
          </span>
        </div>
        <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
          A desktop copilot for Microsoft FSI Solution Engineers. It brings your book of business into one
          place — MSX/Dynamics customers, milestones and HoK activities, Azure Consumption (ACR), and your
          org — and layers on AI (comprehensive summaries, Sales Play Advisor, research dossiers) grounded in
          your own WorkIQ email, meetings, and Teams signal. Persistent app data stays local on your
          machine; connected services are called directly when you sync, search, or run AI features.
        </p>

        <Link
          to="/documentation"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 14,
            padding: '8px 14px', borderRadius: 8, textDecoration: 'none',
            fontSize: 13, fontWeight: 600, color: 'var(--accent)',
            background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
          }}
        >
          <BookRegular style={{ fontSize: 16 }} /> Open Documentation (introduction, setup &amp; operating guides)
        </Link>

        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => setAiAgentsOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontWeight: 600, fontSize: 13, color: 'var(--text)',
            }}
          >
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{aiAgentsOpen ? '▾' : '▸'}</span>
            Dedicated AI agents
            {aiAgents.length > 0 && (
              <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({aiAgents.length})</span>
            )}
          </button>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '6px 0 0' }}>
            Each AI feature runs as a dedicated agent with its own instructions, knowledge, tools, and memory.
          </div>
          {aiAgentsOpen && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {aiAgents.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Agent catalog unavailable.</div>
              )}
              {aiAgents.map((a) => (
                <div
                  key={a.id}
                  style={{
                    border: '1px solid var(--canvas)', borderRadius: 8, padding: '8px 10px', background: 'var(--accent-tint)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>{a.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{a.id}</span>
                  </div>
                  {a.description && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, marginTop: 3 }}>{a.description}</div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {(a.knowledge || []).map((k) => (
                      <span key={`k-${k}`} title="knowledge" style={pillStyle('var(--accent)')}>📘 {k}</span>
                    ))}
                    {(a.tools || []).map((t) => (
                      <span key={`t-${t}`} title="tool" style={pillStyle('var(--success-text)')}>🔧 {t}</span>
                    ))}
                    {a.memory && a.memory !== 'none' && (
                      <span title="memory" style={pillStyle('var(--warning-text)')}>🧠 {a.memory}</span>
                    )}
                    {a.model?.model && (
                      <span title="Pinned model: runs only on GitHub Copilot with this model and reasoning level; never substituted"
                        style={pillStyle('var(--text-secondary)')}>
                        🤖 {a.model.model}{a.model.reasoningEffort ? ` · ${a.model.reasoningEffort} reasoning` : ''}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Change log</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            Packaged releases only. Newest first.
          </div>
          {CHANGELOG.map((rel) => (
            <div key={rel.version} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                v{rel.version}
                {appVersion === rel.version && (
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: 'var(--success-text)' }}>
                    · installed
                  </span>
                )}
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.7 }}>
                {rel.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          ))}
        </div>

        <InfoNote>
          🔒 <strong>Data Privacy:</strong> All data is stored locally in SQLite. Microsoft and GitHub sign-in tokens
          are stored encrypted via the OS keystore (Windows DPAPI) and used only to call MSX/Dynamics and your GitHub
          Copilot models. The CRM URL, tenant, and default account roster are built into the app.
        </InfoNote>
      </Section>

      {/* Section 5: Danger Zone — delete all local data */}
      <Section
        open={sections.danger}
        onToggle={() => toggle('danger')}
        icon={<DeleteRegular style={{ color: 'var(--pink)' }} />}
        title="Danger Zone"
      >
        <p style={{ margin: '0 0 12px', color: 'var(--text)', fontSize: 13 }}>
          Permanently delete <strong>all data stored locally on this device</strong>. This cannot be undone.
        </p>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>What gets removed</div>
          <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8 }}>
            <li>Customer, milestone, email, meeting &amp; Teams data (the local database)</li>
            <li>Cached ACR consumption data and generated reports</li>
            <li>Microsoft &amp; GitHub sign-in tokens — <strong>you will be signed out</strong></li>
            <li>App preferences (selected model, sync schedule)</li>
          </ul>
        </div>
        {wipeMessage && (
          <div
            style={{
              marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13,
              background: wipeMessage.type === 'error' ? 'var(--pink-tint)' : 'var(--success-tint)',
              color: wipeMessage.type === 'error' ? 'var(--pink-text)' : 'var(--success-text)',
              border: `1px solid ${wipeMessage.type === 'error' ? 'var(--pink-tint)' : 'var(--success)'}`,
            }}
          >
            {wipeMessage.text}
          </div>
        )}
        <Button
          appearance="primary"
          icon={<DeleteRegular />}
          onClick={() => { setWipeMessage(null); setWipeConfirm(true); }}
          disabled={wiping}
          style={{ background: 'var(--pink)', borderColor: 'var(--pink)' }}
        >
          Delete all local data…
        </Button>
      </Section>

      <Dialog open={wipeConfirm} onOpenChange={(_e, data) => { if (!wiping) setWipeConfirm(data.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete all local data?</DialogTitle>
            <DialogContent>
              <p style={{ margin: '0 0 8px' }}>
                This permanently erases every locally stored record — customer, milestone, email, meeting and
                Teams data, cached ACR data, generated reports, app preferences, and your Microsoft &amp; GitHub
                sign-in tokens.
              </p>
              <p style={{ margin: 0, fontWeight: 600, color: 'var(--pink-text)' }}>
                You will be signed out and this cannot be undone.
              </p>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setWipeConfirm(false)} disabled={wiping}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={wiping ? <Spinner size="tiny" /> : <DeleteRegular />}
                onClick={handleWipeLocalData}
                disabled={wiping}
                style={{ background: 'var(--pink)', borderColor: 'var(--pink)' }}
              >
                {wiping ? 'Deleting…' : 'Delete everything'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/* ── Navigation customizer (show/hide sidebar tabs) ──────────────── */

function AppearanceCustomizer({ open, onToggle }) {
  const [theme, setThemeState] = useState(getTheme);

  // Reflect changes made anywhere else (or in another window) live.
  useEffect(() => {
    const handler = () => setThemeState(getTheme());
    window.addEventListener(THEME_PREFS_EVENT, handler);
    return () => window.removeEventListener(THEME_PREFS_EVENT, handler);
  }, []);

  const choose = (next) => setThemeState(setTheme(next));

  const OPTIONS = [
    { key: 'light', label: 'Light', hint: 'Bright, default', icon: <WeatherSunnyRegular /> },
    { key: 'dark', label: 'Dark', hint: 'Dim, low-light', icon: <WeatherMoonRegular /> },
  ];

  return (
    <Section
      open={open}
      onToggle={onToggle}
      icon={<PaintBrushRegular />}
      title="Appearance"
      badge={<span className="badge badge-info">{theme === 'dark' ? 'Dark' : 'Light'} mode</span>}
    >
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Choose a light or dark color theme for the whole app. Only the colors change — every
        layout, chart, and control stays exactly the same. This preference is saved on this machine.
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {OPTIONS.map((opt) => {
          const active = theme === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => choose(opt.key)}
              aria-pressed={active}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                padding: '14px 16px', borderRadius: 8, textAlign: 'left',
                background: active ? 'var(--accent-tint)' : 'var(--card)',
                border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                color: active ? 'var(--accent)' : 'var(--text)',
              }}
            >
              <span style={{ fontSize: 24, display: 'inline-flex' }}>{opt.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{opt.label}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{opt.hint}</span>
              </span>
              {active && <CheckmarkCircleRegular style={{ marginLeft: 'auto', fontSize: 18, color: 'var(--accent)' }} />}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function fmtBackupBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const BACKUP_REASON_LABEL = {
  auto: 'Automatic', manual: 'Manual', 'pre-restore': 'Before restore', export: 'Export',
};
function backupReasonLabel(reason) {
  if (!reason) return 'Snapshot';
  if (reason.startsWith('pre-migration')) return 'Before upgrade';
  return BACKUP_REASON_LABEL[reason] || reason;
}

// Data & backups — the app's own safety net for locally-authored data (meeting notes,
// manual milestone links, workloads) that cannot be re-pulled from Graph / CRM. Surfaces the
// DB location + size, the snapshot list, and Back up / Export / Restore actions. Restore is
// guarded by a confirmation dialog and reloads the app on success so every cached query
// re-reads the restored data.
function BackupCustomizer({ open, onToggle }) {
  const [status, setStatus] = useState(null); // { dbPath, dbSize, backupsDir, backups, settings }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(''); // 'now' | 'export' | 'folder' | ''
  const [note, setNote] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(null); // backup row pending confirm
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    if (!inElectron()) { setError('Backups require the desktop app.'); return; }
    setLoading(true); setError('');
    try {
      const res = await dbBackupList();
      if (!res?.ok) throw new Error(res?.error || 'Could not read backup status.');
      setStatus(res);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open && !status) load(); }, [open, status, load]);

  const backupNow = useCallback(async () => {
    setBusy('now'); setError(''); setNote('');
    try {
      const res = await dbBackupNow();
      if (!res?.ok) throw new Error(res?.error || 'Backup failed.');
      setNote(`Backup created: ${res.backup?.name || 'snapshot'}.`);
      await load();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  }, [load]);

  const exportCopy = useCallback(async () => {
    setBusy('export'); setError(''); setNote('');
    try {
      const res = await dbBackupExport();
      if (res?.canceled) { setBusy(''); return; }
      if (!res?.ok) throw new Error(res?.error || 'Export failed.');
      setNote(`Exported a copy to: ${res.path}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  }, []);

  const openFolder = useCallback(async () => {
    setBusy('folder'); setError('');
    try {
      const res = await dbBackupOpenFolder();
      if (!res?.ok) throw new Error(res?.error || 'Could not open the folder.');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  }, []);

  const changeSetting = useCallback(async (patch) => {
    setError('');
    try {
      const res = await dbBackupSettings(patch);
      if (!res?.ok) throw new Error(res?.error || 'Could not update backup settings.');
      setStatus((s) => (s ? { ...s, settings: res.settings } : s));
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, []);

  const doRestore = useCallback(async () => {
    if (!confirmRestore) return;
    setRestoring(true); setError('');
    try {
      const res = await dbBackupRestore({ fileName: confirmRestore.name });
      if (!res?.ok) throw new Error(res?.error || 'Restore failed.');
      // The main process relaunches after a successful restore so every main-process service
      // rebinds to the restored database (a renderer-only reload would leave stale handles).
      // If for any reason it doesn't relaunch, fall back to a renderer reload after a moment.
      if (!res.relaunching) {
        window.location.reload();
      } else {
        setTimeout(() => { try { window.location.reload(); } catch { /* noop */ } }, 3000);
      }
    } catch (err) {
      setError(err?.message || String(err));
      setRestoring(false);
      setConfirmRestore(null);
    }
  }, [confirmRestore]);

  const settings = status?.settings || { enabled: true, retention: 10 };
  const backups = status?.backups || [];
  const newest = backups[0];

  return (
    <Section
      open={open}
      onToggle={onToggle}
      icon={<DatabaseRegular />}
      title="Data & backups"
      badge={newest
        ? <span className="badge badge-success">Last backup {formatLocalDateTime(newest.created_at)}</span>
        : <span className="badge badge-warning">No backups yet</span>}
    >
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Your notes, transcripts, summaries and manual milestone links live only in this app’s
        local database — they can’t be re-pulled from Microsoft 365 or CRM. SE Assist keeps
        automatic snapshots (on launch and before every upgrade) so you can recover them.
        Windows File History / OneDrive don’t cover this location, so use <strong>Export a copy…</strong>
        to keep a copy somewhere off this machine.
      </div>

      {loading && !status ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
          <Spinner size="tiny" /> Loading backup status…
        </div>
      ) : (
        <>
          {status && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--text-muted)', minWidth: 110 }}>Database</span>
                <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{status.dbPath}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--text-muted)', minWidth: 110 }}>Size</span>
                <span style={{ color: 'var(--text)' }}>{fmtBackupBytes(status.dbSize)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--text-muted)', minWidth: 110 }}>Backups folder</span>
                <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{status.backupsDir}</span>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <Button appearance="primary" icon={busy === 'now' ? <Spinner size="tiny" /> : <DatabaseRegular />} disabled={!!busy || !inElectron()} onClick={backupNow}>
              Back up now
            </Button>
            <Button appearance="secondary" icon={busy === 'export' ? <Spinner size="tiny" /> : <ArrowDownloadRegular />} disabled={!!busy || !inElectron()} onClick={exportCopy}>
              Export a copy…
            </Button>
            <Button appearance="subtle" icon={<FolderRegular />} disabled={!!busy || !inElectron()} onClick={openFolder}>
              Open folder
            </Button>
          </div>

          {note && <div style={{ marginBottom: 12, color: 'var(--accent)', fontSize: 12, wordBreak: 'break-all' }}>{note}</div>}
          {error && <div style={{ marginBottom: 12, color: 'var(--danger)', fontSize: 12 }}>{error}</div>}

          {/* Settings */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Switch checked={settings.enabled} onChange={(_e, d) => changeSetting({ enabled: d.checked })} />
              <span style={{ fontSize: 13 }}>Automatic backup on launch</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Keep newest</span>
              <input
                type="number" min={1} max={50} value={settings.retention}
                onChange={(e) => changeSetting({ retention: Number(e.target.value) })}
                style={{ width: 64, padding: '4px 6px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
              />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>snapshots</span>
            </div>
          </div>

          {/* Snapshot list */}
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            Snapshots {backups.length ? `(${backups.length})` : ''}
          </div>
          {backups.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No snapshots yet — use “Back up now”.</span>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              {backups.map((b) => (
                <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--hairline)', background: 'var(--card)' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{formatLocalDateTime(b.created_at)}</span>
                      <span className="badge badge-secondary">{backupReasonLabel(b.reason)}</span>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{b.name} · {fmtBackupBytes(b.size)}</span>
                  </span>
                  <Button size="small" appearance="secondary" icon={<ArrowSyncRegular />} disabled={!!busy || restoring} onClick={() => setConfirmRestore(b)}>
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={!!confirmRestore} onOpenChange={(_e, d) => { if (!d.open && !restoring) setConfirmRestore(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogContent>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                This replaces your current database with the snapshot from{' '}
                <strong>{confirmRestore ? formatLocalDateTime(confirmRestore.created_at) : ''}</strong>{' '}
                ({confirmRestore ? backupReasonLabel(confirmRestore.reason) : ''}). Any changes made
                since then will be replaced.
                <br /><br />
                A snapshot of the <strong>current</strong> data is saved first, so you can undo this by
                restoring the “Before restore” snapshot. The app will restart when done.
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={restoring} onClick={() => setConfirmRestore(null)}>Cancel</Button>
              <Button appearance="primary" icon={restoring ? <Spinner size="tiny" /> : <ArrowSyncRegular />} disabled={restoring} onClick={doRestore}>
                {restoring ? 'Restoring…' : 'Restore & restart'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}

function NavCustomizer({ open, onToggle }) {
  const [hidden, setHidden] = useState(getHiddenNav);

  // Reflect changes made anywhere (e.g. a future reset elsewhere) live.
  useEffect(() => {
    const handler = () => setHidden(getHiddenNav());
    window.addEventListener(NAV_PREFS_EVENT, handler);
    return () => window.removeEventListener(NAV_PREFS_EVENT, handler);
  }, []);

  const hiddenSet = new Set(hidden);
  const hiddenCount = NAV.filter((n) => n.path && hiddenSet.has(n.path)).length
    + (hiddenSet.has(GUIDED_TOUR_NAV_KEY) ? 1 : 0);

  const setVisible = (path, visible) => {
    const next = new Set(getHiddenNav());
    if (visible) next.delete(path); else next.add(path);
    setHidden(setHiddenNav([...next]));
  };

  return (
    <Section
      open={open}
      onToggle={onToggle}
      icon={<AppsListDetailRegular />}
      title="Customize navigation"
      badge={hiddenCount > 0
        ? <span className="badge badge-info">{hiddenCount} hidden</span>
        : <span className="badge badge-secondary">All shown</span>}
    >
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Choose which tabs appear in the left sidebar. Hiding a tab only removes it from the
        sidebar — the page still works and stays reachable from links elsewhere, and you can
        un-hide it here anytime. This preference is saved on this machine.
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {NAV.map((item, i) => item.section ? (
          <div
            key={`s-${i}`}
            style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
              color: 'var(--text-faint)', padding: '10px 12px 6px', background: 'var(--surface-3)',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            {item.section}
          </div>
        ) : (
          <NavRow
            key={item.path}
            item={item}
            locked={LOCKED_PATHS.includes(item.path)}
            visible={!hiddenSet.has(item.path)}
            onChange={(v) => setVisible(item.path, v)}
          />
        ))}
        {/* Sidebar launchers (not routes) that can also be hidden. */}
        <div
          style={{
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
            color: 'var(--text-faint)', padding: '10px 12px 6px', background: 'var(--surface-3)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          Guides
        </div>
        <NavRow
          item={{ icon: CompassNorthwestRegular, label: 'Guided Tour' }}
          locked={false}
          visible={!hiddenSet.has(GUIDED_TOUR_NAV_KEY)}
          onChange={(v) => setVisible(GUIDED_TOUR_NAV_KEY, v)}
        />
      </div>

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Button appearance="secondary" onClick={() => setHidden(setHiddenNav([]))} disabled={hiddenCount === 0}>
          Show all tabs
        </Button>
      </div>
    </Section>
  );
}

function NavRow({ item, locked, visible, onChange }) {
  const Icon = item.icon;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
        borderBottom: '1px solid var(--hairline)', background: 'var(--card)',
      }}
    >
      <span style={{ fontSize: 17, color: visible ? 'var(--text-secondary)' : 'var(--border-strong)', display: 'inline-flex' }}>
        <Icon />
      </span>
      <span style={{ flex: 1, fontSize: 13, color: visible ? 'var(--text)' : 'var(--text-faint)' }}>
        {item.label}
      </span>
      {locked ? (
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Always shown</span>
      ) : (
        <Switch checked={visible} onChange={(_e, d) => onChange(d.checked)} />
      )}
    </div>
  );
}

/* ── Collapsible Section ─────────────────────────────────────────── */

function Section({ open, onToggle, icon, title, badge, children, anchor }) {
  return (
    <div className="card" style={{ marginBottom: 16 }} id={anchor}>
      <div
        className="card-header-custom"
        onClick={onToggle}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none' }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {badge}
      </div>
      {open && <div className="card-body-custom">{children}</div>}
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function ReadonlyField({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: mono ? 'Consolas, monospace' : 'inherit' }}>
        {value}
      </div>
    </div>
  );
}

function InfoNote({ children }) {
  return (
    <div style={{
      marginTop: 12, padding: '8px 12px', background: 'color-mix(in srgb, var(--accent) 7%, transparent)',
      border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)', borderRadius: 6, fontSize: 12, color: 'var(--accent)', lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

// Signal labels for the detection breakdown (order = display order).
const SIGNAL_LABELS = {
  milestoneTeam: 'Milestone teams',
  ownedMilestones: 'Owned milestones',
  accountTeam: 'Account teams',
  dealTeam: 'Deal teams',
  ownedOpportunities: 'Owned opportunities',
};

// Transparent breakdown of a "Detect my accounts" run: what each MSX signal
// contributed, which queries failed, and how the detected set reconciles against
// the saved roster (so a missing account is named, not just a count that's off).
function DetectionDetails({ details, onDismiss }) {
  const { diagnostics, counts, newlyDetected, keptNotDetected } = details;
  const signals = diagnostics?.signals || {};
  const keys = Object.keys(SIGNAL_LABELS).filter((k) => k in signals);
  return (
    <div style={{
      marginTop: 12, padding: '12px 14px', background: 'var(--card)',
      border: '1px solid var(--canvas)', borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
      boxShadow: '0 1px 2px rgba(23, 32, 64, 0.04), 0 1px 3px rgba(23, 32, 64, 0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Detection breakdown</strong>
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Dismiss</button>
      </div>

      <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>Signals contributing to your book of business:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {keys.map((k) => {
          const s = signals[k];
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: s.ok ? 'var(--success-text)' : 'var(--pink)', width: 14 }}>{s.ok ? '✓' : '✕'}</span>
              <span style={{ minWidth: 150, color: 'var(--text)' }}>{SIGNAL_LABELS[k]}</span>
              <span style={{ color: 'var(--text-muted)' }}>{s.ok ? `${s.contributed} found` : `failed — ${s.error || 'query error'}`}</span>
            </div>
          );
        })}
      </div>

      {(diagnostics?.errors?.length > 0) && (
        <div style={{ marginBottom: 10, padding: '6px 10px', background: 'color-mix(in srgb, var(--pink) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--pink) 20%, transparent)', borderRadius: 6, color: 'var(--pink)' }}>
          {diagnostics.errors.length} signal{diagnostics.errors.length !== 1 ? 's' : ''} failed to query — an account reachable only through {diagnostics.errors.length > 1 ? 'those signals' : 'that signal'} may be missing. This often clears on retry (transient) or indicates that signal isn't available in your tenant.
        </div>
      )}

      {keptNotDetected.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ color: 'var(--warning-text)', fontWeight: 600 }}>Kept from your roster (not re-detected):</span>{' '}
          <span style={{ color: 'var(--text)' }}>{keptNotDetected.map((a) => a.name).join(', ')}</span>
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
            These weren't found by any MSX signal this run, but were preserved (detection merges, never drops). If one shouldn't be here, remove its TPID above.
          </div>
        </div>
      )}

      {newlyDetected.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>Newly added:</span>{' '}
          <span style={{ color: 'var(--text)' }}>{newlyDetected.map((a) => a.name).join(', ')}</span>
        </div>
      )}

      <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>
        Resolved {counts?.accounts ?? 0} account record{(counts?.accounts ?? 0) !== 1 ? 's' : ''} →{' '}
        {counts?.tpids ?? 0} top-parent TPID{(counts?.tpids ?? 0) !== 1 ? 's' : ''}
        {' '}(from {counts?.milestones ?? 0} milestones, {counts?.opportunities ?? 0} opportunities).
      </div>
    </div>
  );
}
