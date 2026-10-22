import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Button, Field, Input, Select, Spinner, Textarea } from '@fluentui/react-components';
import { EditRegular, ArrowLeftRegular, DeleteRegular, ChevronRightRegular, ChevronDownRegular, OpenRegular, DataTrendingRegular, SparkleRegular, OrganizationRegular, GanttChartRegular, DocumentRegular, CalendarLtrRegular, SearchRegular, PeopleTeamRegular } from '@fluentui/react-icons';
import { fmtUsd, fmtPct, monthAbbr, trendColor, defaultFiscalYear } from '../lib/acrFormat';
import { formatLocalDateTime } from '../lib/datetime';
import ItemDetailPanel from './ItemDetailPanel';
import MeetingDetailPanel from './MeetingDetailPanel';
import { TaskAssignmentStatus, TaskWorkloadPicker, useTaskAssignmentOptions } from './TaskAssignments';
import AcrFreshness from './AcrFreshness';
import { useDbQuery } from '../hooks/useDb';
import { useTerritory } from '../territoryContext';
import { computeAccountMilestoneMetrics, parseTeamList, ACCOUNT_HOK_FY_SQL, ACCOUNT_HOK_FY_BY_ACCT_SQL, FY_START_ISO, FY_END_ISO, FY_LABEL } from '../lib/milestoneMetrics';
import AccountMetricStat from './AccountMetricStat';
import {
  deleteCustomerTodo,
  deleteTimelineEvent,
  generateCustomerTechStack,
  getCloudProfiles,
  getCustomerWorkspace,
  openExternal,
  openGeneratedFile,
  prepareCustomerMeeting,
  saveCustomerTodo,
  seismicSignIn,
  seismicSearch,
  acrPeriods,
  acrPortfolio,
  generateAcrAnalysis,
  generateSalesAdvisor,
  getCustomerResearchDossier,
  openCustomerResearchDossier,
  getCustomerInsights,
  generateCustomerAnalysis,
  customerSearchDocuments,
  orgGetSchedule,
  orgFindMeetingTimes,
  dbRun,
} from '../electronBridge';

// Most recent last_synced_at (YYYY-MM-DD) across a set of MSX rows, for tile freshness.
function latestSyncDate(rows) {
  if (!rows || rows.length === 0) return '';
  let max = '';
  for (const row of rows) {
    const value = row?.last_synced_at;
    if (value && value > max) max = value;
  }
  return max ? max.slice(0, 10) : '';
}

// (Deal-team parsing comes from ../lib/milestoneMetrics: parseTeamList.)

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [cloudProfiles, setCloudProfiles] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [salesObjective, setSalesObjective] = useState('');
  const [advising, setAdvising] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [acrAnalyzing, setAcrAnalyzing] = useState(false);
  const [workspaceFlash, setWorkspaceFlash] = useState(null);
  const [openItem, setOpenItem] = useState(null); // { medium, id } — signal detail popup

  const { data: rows, loading } = useDbQuery(
    'SELECT * FROM active_customers WHERE id = ?',
    [id],
    [id]
  );

  const customer = rows[0];

  const teamsTpid = customer?.tpid || '';
  const { data: teamsChats, refresh: refreshChats } = useDbQuery(
    `SELECT c.chat_id, c.topic, c.chat_type, c.has_unread, c.last_message_at,
            c.last_message_from, c.messages_synced, l.matched_term
     FROM active_teams_chat_customer_links l
     JOIN active_teams_chats c ON c.chat_id = l.chat_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
     ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC`,
    [teamsTpid],
    [teamsTpid]
  );
  const { data: teamsProfileRows } = useDbQuery(
    `SELECT chat_count, message_count, last_activity_at FROM active_teams_customer_profile WHERE tpid = ?`,
    [teamsTpid],
    [teamsTpid]
  );
  const teamsProfile = teamsProfileRows[0];

  const { data: emailProfileRows } = useDbQuery(
    `SELECT email_count, thread_count, last_activity_at FROM active_email_customer_profile WHERE tpid = ?`,
    [teamsTpid],
    [teamsTpid]
  );
  const emailProfile = emailProfileRows[0];
  const { data: customerEmails, refresh: refreshEmails } = useDbQuery(
    `SELECT e.message_id, e.subject, e.from_name, e.received_at, l.match_method
     FROM active_email_customer_links l
     JOIN active_emails e ON e.message_id = l.message_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
     ORDER BY (e.received_at IS NULL), e.received_at DESC
     LIMIT 500`,
    [teamsTpid],
    [teamsTpid]
  );
  const { data: meetingProfileRows } = useDbQuery(
    `SELECT meeting_count, last_activity_at FROM active_meeting_customer_profile WHERE tpid = ?`,
    [teamsTpid],
    [teamsTpid]
  );
  const meetingProfile = meetingProfileRows[0];
  const { data: customerMeetings, refresh: refreshMeetings } = useDbQuery(
    `SELECT m.event_id, m.subject, m.organizer_name, m.start_at, m.is_online_meeting,
            substr(m.body_text, 1, 400) AS agenda, l.match_method
     FROM active_meeting_customer_links l
     JOIN active_meetings m ON m.event_id = l.event_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
     ORDER BY (m.start_at IS NULL), m.start_at DESC
     LIMIT 500`,
    [teamsTpid],
    [teamsTpid]
  );
  const { data: accountTeam } = useDbQuery(
    `SELECT person_name, person_email, org, email_sends, email_cc, teams_msgs, last_activity, sources
     FROM active_customer_account_team
     WHERE tpid = ?
     ORDER BY (org='microsoft') DESC, engagement DESC`,
    [teamsTpid],
    [teamsTpid]
  );
  const microsoftTeam = accountTeam.filter((p) => p.org === 'microsoft');
  const customerContacts = accountTeam.filter((p) => p.org === 'customer');

  // Manually-assigned account team by role (persisted; reused across the app).
  const { data: teamRoles, refresh: refreshTeamRoles } = useDbQuery(
    `SELECT role, person_name, person_email
     FROM active_customer_account_team_roles
     WHERE tpid = ?
     ORDER BY id`,
    [teamsTpid],
    [teamsTpid]
  );
  // Roster members with a usable email — the source of truth for availability, etc.
  const rosterTeam = useMemo(
    () => (teamRoles || [])
      .filter((r) => String(r.person_email || '').trim())
      .map((r) => ({ person_name: r.person_name, person_email: r.person_email })),
    [teamRoles],
  );

  // CRM contacts under this account, with the LinkedIn profile URL MSX stores on each
  // (msp_linkedinprofileurl). LinkedIn-linked contacts first, then alphabetical.
  const { data: crmContacts } = useDbQuery(
    `SELECT contact_id, full_name, job_title, email, linkedin_url, account_name
     FROM active_customer_contacts
     WHERE tpid = ?
     ORDER BY (linkedin_url IS NULL), full_name`,
    [teamsTpid],
    [teamsTpid]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadCloudProfileData() {
      try {
        const profiles = await getCloudProfiles();
        if (!cancelled) {
          setCloudProfiles(profiles || []);
        }
      } catch (err) {
        if (!cancelled) setCloudProfiles([]);
      }
    }
    loadCloudProfileData();
    return () => { cancelled = true; };
  }, [id, workspaceRevision]);

  const cloudProfile = useMemo(() => {
    if (!customer?.tpid) return null;
    return cloudProfiles.find((profile) => profile.tpid === customer.tpid) || null;
  }, [cloudProfiles, customer?.tpid]);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      if (!cloudProfile?.id) {
        setWorkspace(null);
        return;
      }
      try {
        const nextWorkspace = await getCustomerWorkspace(cloudProfile.id);
        if (!nextWorkspace?.ok) throw new Error(nextWorkspace?.error || 'Could not load customer Tasks.');
        if (!cancelled) {
          setWorkspace(nextWorkspace);
        }
      } catch (err) {
        if (!cancelled) setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
      }
    }
    loadWorkspace();
    return () => { cancelled = true; };
  }, [cloudProfile?.id, workspaceRevision]);

  const { data: children, loading: loadChildren } = useDbQuery(
    'SELECT * FROM active_customers WHERE parent_crm_account_id = ? AND crm_account_id IS NOT NULL ORDER BY name',
    [customer?.crm_account_id || ''],
    [customer?.crm_account_id]
  );

  // A child account belongs to a parent within its TPID family. Relationship
  // intelligence (profile, Teams, email, account team, AI summaries) is keyed by
  // TPID and lives on the parent profile, so child pages show only per-account data.
  const isChild = Boolean(customer?.parent_crm_account_id);

  // Deep-links that carry this account's TPID into the pipeline / activity / consumption
  // tabs so those pages open pre-filtered to this customer.
  const tpidParam = customer?.tpid ? encodeURIComponent(String(customer.tpid).trim()) : '';
  const milestonesLink = tpidParam ? `/milestones?tpid=${tpidParam}` : '/milestones';
  const milestoneMapLink = tpidParam ? `/milestone-map?tpid=${tpidParam}` : '/milestone-map';
  const milestoneTimelineLink = tpidParam ? `/milestone-timeline?tpid=${tpidParam}` : '/milestone-timeline';
  const hokLink = tpidParam ? `/hok-activities?tpid=${tpidParam}` : '/hok-activities';

  const { data: parentRows } = useDbQuery(
    'SELECT id, name, tpid FROM active_customers WHERE crm_account_id = ? LIMIT 1',
    [customer?.parent_crm_account_id || ''],
    [customer?.parent_crm_account_id]
  );
  const parentAccount = parentRows[0];

  const { data: opportunities } = useDbQuery(
    isChild
      ? `SELECT * FROM active_opportunities
         WHERE parent_account_id = ? OR customer_name = ?
         ORDER BY estimated_close_date DESC, updated_at DESC`
      : `SELECT * FROM active_opportunities
         WHERE parent_account_id IN (
           SELECT crm_account_id FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL
         )
         OR parent_account_id = ? OR customer_name = ?
         ORDER BY estimated_close_date DESC, updated_at DESC`,
    isChild
      ? [customer?.crm_account_id || '', customer?.name || '']
      : [customer?.tpid || '', customer?.crm_account_id || '', customer?.name || ''],
    [isChild, customer?.tpid, customer?.crm_account_id, customer?.name]
  );

  const { data: milestones } = useDbQuery(
    isChild
      ? `SELECT m.*, o.name as opportunity_name, o.customer_name
         FROM active_milestones m
         LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
         WHERE o.parent_account_id = ? OR o.customer_name = ?
         ORDER BY m.milestone_date DESC, m.updated_at DESC`
      : `SELECT m.*, o.name as opportunity_name, o.customer_name
         FROM active_milestones m
         LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
         WHERE o.parent_account_id IN (
           SELECT crm_account_id FROM active_customers WHERE tpid = ? AND crm_account_id IS NOT NULL
         )
         OR o.parent_account_id = ? OR o.customer_name = ?
         ORDER BY m.milestone_date DESC, m.updated_at DESC`,
    isChild
      ? [customer?.crm_account_id || '', customer?.name || '']
      : [customer?.tpid || '', customer?.crm_account_id || '', customer?.name || ''],
    [isChild, customer?.tpid, customer?.crm_account_id, customer?.name]
  );

  const workspaceTodos = workspace?.todos || [];
  const workspaceTranscripts = workspace?.transcripts || [];
  const workspaceAiBriefs = workspace?.aiBriefs || [];
  const workspaceTechStacks = workspace?.techStacks || [];
  const workspaceAcrAnalyses = workspace?.acrAnalyses || [];
  const workspaceSalesAdvisories = workspace?.salesAdvisories || [];
  const workspaceCustomerAnalyses = workspace?.customerAnalyses || [];

  const opportunitiesSyncedAt = useMemo(() => latestSyncDate(opportunities), [opportunities]);
  const milestonesSyncedAt = useMemo(() => latestSyncDate(milestones), [milestones]);

  // Profile metrics show BOTH the full account numbers and the current user's own
  // scope (owner or on the milestone deal team). This is independent of the global
  // territory toggle so the profile always exposes both views.
  const { currentUserName, setScope } = useTerritory();
  // Open a pre-filtered page scoped to "My Milestones" so the destination's my/discover/all
  // filter matches these account panels (which count your active+uncommitted pipeline).
  const goMine = useCallback((path) => { setScope('mine'); navigate(path); }, [setScope, navigate]);
  // Account HoK activity counts (total + this fiscal year) for the refined HoK panel. Scoped the
  // same way as the opportunity/milestone queries above — by TPID family for a top-parent, or by
  // the single account for a child — so all three panels stay internally consistent.
  const { data: hokRows } = useDbQuery(
    isChild ? ACCOUNT_HOK_FY_BY_ACCT_SQL : ACCOUNT_HOK_FY_SQL,
    isChild
      ? [customer?.crm_account_id || '', customer?.name || '', FY_START_ISO, FY_END_ISO]
      : [customer?.tpid || '', FY_START_ISO, FY_END_ISO],
    [isChild, customer?.tpid, customer?.crm_account_id, customer?.name],
  );
  const hok = hokRows?.[0] || {};
  // Refined account pipeline metrics (shared with the glance popup): your active + uncommitted
  // opportunities/milestones vs. account totals, plus account-wide overdue/blocked health.
  const metrics = useMemo(
    () => computeAccountMilestoneMetrics({ opportunities: opportunities || [], milestones: milestones || [], currentUserName }),
    [opportunities, milestones, currentUserName],
  );

  const teamsMessageCount = teamsProfile?.message_count ?? 0;
  // Teams data comes from the personal Copilot CLI + WorkIQ ingest (local cache).
  const teamsFromCli = teamsChats.length > 0;
  const teamsTileChats = teamsChats.length;
  const teamsTileMessages = teamsMessageCount;
  const teamsTileSource = teamsFromCli ? 'local CLI cache' : 'not_configured';

  async function completeTodo(todo) {
    await updateTodo(todo, { status: 'done' });
  }

  async function updateTodo(todo, patch) {
    if (!cloudProfile?.id) return;
    setSavingWorkspace(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await saveCustomerTodo({ id: todo.id, ...patch });
      if (!nextWorkspace?.ok) throw new Error(nextWorkspace?.error || 'Could not update the Task.');
      if (nextWorkspace.profile?.id === cloudProfile.id) setWorkspace(nextWorkspace);
      else setWorkspaceRevision(value => value + 1);
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function removeTodo(todo) {
    if (!cloudProfile?.id) return;
    setSavingWorkspace(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await deleteCustomerTodo({ profileId: cloudProfile.id, id: todo.id });
      if (!nextWorkspace?.ok) throw new Error(nextWorkspace?.error || 'Could not delete the Task.');
      setWorkspace(nextWorkspace);
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function generateComprehensiveSummary() {
    if (!cloudProfile?.id) return;
    setSavingWorkspace(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await prepareCustomerMeeting({
        profileId: cloudProfile.id,
        customer,
        opportunities,
        milestones,
      });
      setWorkspace(nextWorkspace);
      setWorkspaceFlash({ type: 'success', msg: 'Comprehensive customer summary generated.' });
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function generateTechStack() {
    if (!cloudProfile?.id) return;
    setSavingWorkspace(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await generateCustomerTechStack({
        profileId: cloudProfile.id,
        customer,
        opportunities,
        milestones,
      });
      setWorkspace(nextWorkspace);
      setWorkspaceFlash({ type: 'success', msg: 'Customer tech stack generated.' });
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function generateSalesPlay() {
    if (!cloudProfile?.id) return;
    setAdvising(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await generateSalesAdvisor({
        profileId: cloudProfile.id,
        customer,
        opportunities,
        milestones,
        objective: salesObjective,
      });
      if (nextWorkspace?.ok === false) {
        setWorkspaceFlash({ type: 'error', msg: nextWorkspace.error || 'Sales play generation failed.' });
      } else {
        setWorkspace(nextWorkspace);
        const newest = nextWorkspace?.salesAdvisories?.[0];
        if (newest?.metadata?.htmlPath) openGeneration(newest.metadata.htmlPath);
        setWorkspaceFlash({ type: 'success', msg: 'Sales play generated — opening the playbook.' });
      }
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setAdvising(false);
    }
  }

  async function generateCustomerAnalysisPlay() {
    if (!cloudProfile?.id) return;
    setAnalyzing(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await generateCustomerAnalysis({
        profileId: cloudProfile.id,
        customer,
        opportunities,
        milestones,
      });
      if (nextWorkspace?.ok === false) {
        setWorkspaceFlash({ type: 'error', msg: nextWorkspace.error || 'Customer analysis failed.' });
      } else {
        setWorkspace(nextWorkspace);
        const newest = nextWorkspace?.customerAnalyses?.[0];
        if (newest?.metadata?.htmlPath) openGeneration(newest.metadata.htmlPath);
        setWorkspaceFlash({ type: 'success', msg: 'Customer analysis generated — opening the briefing.' });
      }
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setAnalyzing(false);
    }
  }

  async function generateAcrAnalysisPlay() {
    if (!cloudProfile?.id) return;
    setAcrAnalyzing(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await generateAcrAnalysis({
        profileId: cloudProfile.id,
        customer,
        opportunities,
        milestones,
      });
      if (nextWorkspace?.ok === false) {
        setWorkspaceFlash({ type: 'error', msg: nextWorkspace.error || 'Azure consumption analysis failed.' });
      } else {
        setWorkspace(nextWorkspace);
        const newest = nextWorkspace?.acrAnalyses?.[0];
        if (newest?.metadata?.htmlPath) openGeneration(newest.metadata.htmlPath);
        setWorkspaceFlash({ type: 'success', msg: 'Azure consumption analysis generated — opening the briefing.' });
      }
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setAcrAnalyzing(false);
    }
  }

  async function openGeneration(htmlPath) {
    if (!htmlPath) return;
    const result = await openGeneratedFile(htmlPath);
    if (result && result.ok === false) {
      setWorkspaceFlash({ type: 'error', msg: `Could not open file: ${result.error || 'unknown error'}` });
    }
  }

  async function deleteGeneration(id) {
    if (!cloudProfile?.id || !id) return;
    setSavingWorkspace(true);
    setWorkspaceFlash(null);
    try {
      const nextWorkspace = await deleteTimelineEvent({ profileId: cloudProfile.id, id });
      setWorkspace(nextWorkspace);
      setWorkspaceFlash({ type: 'success', msg: 'Generation deleted.' });
    } catch (err) {
      setWorkspaceFlash({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSavingWorkspace(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spinner size="large" label="Loading customer…" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div style={{ color: 'var(--pink)', padding: 48, textAlign: 'center' }}>
        Customer not found.{' '}
        <Link to="/email" style={{ color: 'var(--accent)' }}>
          Back to Customers
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>{customer.name}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            appearance="subtle"
            icon={<ArrowLeftRegular />}
            onClick={() => navigate(-1)}
          >
            Back
          </Button>
          <Button
            appearance="primary"
            icon={<EditRegular />}
            onClick={() => navigate(`/customers/${id}/edit`)}
          >
            Edit
          </Button>
        </div>
      </div>

      {isChild && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--accent)' }}>
          <div className="card-body-custom" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Child account under{' '}
            {parentAccount ? (
              <Link to={`/customers/${parentAccount.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {parentAccount.name}
              </Link>
            ) : (
              <span style={{ fontWeight: 600 }}>TPID {customer.tpid}</span>
            )}
            . Relationship intelligence — profile &amp; health, todos, assets, Teams, email,
            account team, and AI summaries — is shared across the account family and lives on
            the parent profile. This page shows only details specific to this account.
          </div>
        </div>
      )}

      {isChild ? (
        <>
          {/* At-a-glance metrics: full account numbers + your own scope */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
            <AccountMetricStat label="Active Opportunities" primary={metrics.oppsActive} total={metrics.oppsTotal} onClick={() => goMine(milestonesLink)} hint="Your active, uncommitted opportunities · open in Milestones (My Milestones)" />
            <AccountMetricStat label="Active Milestones" primary={metrics.msActive} total={metrics.msTotal} onClick={() => goMine(milestonesLink)} hint="Your active, uncommitted milestones · open in Milestones (My Milestones)" />
            <AccountMetricStat label={`HoK Activities ${FY_LABEL}`} primary={Number(hok.hok_fy) || 0} total={Number(hok.hok_total) || 0} onClick={() => goMine(hokLink)} hint={`HoK activities created in ${FY_LABEL} · open in HoK Activities (My Milestones)`} />
          </div>

          {/* Info cards row */}
          <Collapsible title="Account Details" defaultOpen>
            <AccountDetailsGrid customer={customer} />
          </Collapsible>

          {customer.description && (
            <Collapsible title="CRM Description">
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{customer.description}</div>
            </Collapsible>
          )}
          {customer.notes && (
            <Collapsible title="Notes">
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{customer.notes}</div>
            </Collapsible>
          )}
        </>
      ) : (
        <>
          {/* MSX Metrics (left) and ACR Metrics (right), side by side. */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Customer MSX Metrics — sales-pipeline signal; each metric links into its tab,
                pre-filtered to this account, and the button opens the Milestone Map. */}
            <div className="card" style={{ marginBottom: 20, flex: 1, minWidth: 320 }}>
              <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>Customer MSX Metrics</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Button
                    appearance="primary"
                    size="small"
                    icon={<OrganizationRegular />}
                    onClick={() => navigate(milestoneMapLink)}
                    title="Open this account in the Milestone Map"
                  >
                    Milestone Map
                  </Button>
                  <Button
                    appearance="secondary"
                    size="small"
                    icon={<GanttChartRegular />}
                    onClick={() => navigate(milestoneTimelineLink)}
                    title="Open this account in the Milestone Timeline"
                  >
                    Milestone Timeline
                  </Button>
                </div>
              </div>
              <div className="card-body-custom">
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
                  <AccountMetricStat label="Active Opportunities" primary={metrics.oppsActive} total={metrics.oppsTotal} onClick={() => goMine(milestonesLink)} hint="Your active, uncommitted opportunities · open in Milestones (My Milestones)" />
                  <AccountMetricStat label="Active Milestones" primary={metrics.msActive} total={metrics.msTotal} onClick={() => goMine(milestonesLink)} hint="Your active, uncommitted milestones · open in Milestones (My Milestones)" />
                  <AccountMetricStat label={`HoK Activities ${FY_LABEL}`} primary={Number(hok.hok_fy) || 0} total={Number(hok.hok_total) || 0} onClick={() => goMine(hokLink)} hint={`HoK activities created in ${FY_LABEL} · open in HoK Activities (My Milestones)`} />
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <AccountMetricStat label="Overdue Comments" primary={metrics.overdueComments} tone="danger" onClick={() => goMine(`${milestonesLink}&overdue=true`)} hint="Active, uncommitted milestones whose latest comment is over 30 days old · open in Milestones (My Milestones)" />
                  <AccountMetricStat label="Blocked Milestones" primary={metrics.blocked} tone="danger" onClick={() => goMine(`${milestonesLink}&status=Blocked`)} hint="Milestones in the Blocked status · open in Milestones (My Milestones)" />
                </div>
              </div>
            </div>

            {/* Customer ACR Metrics — Azure consumption signal; opens Azure Consumption pre-filtered. */}
            <div style={{ flex: 1, minWidth: 320 }}>
              <CustomerAcrMetrics customer={customer} />
            </div>
          </div>

          {/* Account Team (66%, left) and Team Availability (34%, right), side by side. */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Account Team — manually assign the team by role; persisted and reused elsewhere. */}
            <div style={{ flex: '66 1 0', minWidth: 340 }}>
              <AccountTeamRoster
                tpid={teamsTpid}
                roles={teamRoles}
                suggestions={microsoftTeam}
                onSaved={refreshTeamRoles}
              />
            </div>

            {/* Team Availability — free/busy across the saved account team (falls back to discovered). */}
            <div style={{ flex: '34 1 0', minWidth: 280 }}>
              <AccountTeamAvailability team={rosterTeam.length ? rosterTeam : microsoftTeam} />
            </div>
          </div>
        </>
      )}

      {!isChild && (
      <>
      {workspaceFlash && (
        <div className={`flash-message flash-${workspaceFlash.type}`} style={{ marginBottom: 12 }}>
          {workspaceFlash.msg}
        </div>
      )}
      <div style={{ marginBottom: 20 }}>
        <TodoList
          todos={workspaceTodos}
          saving={savingWorkspace}
          onComplete={completeTodo}
          onDelete={removeTodo}
          onWorkloadChange={(todo, workloadId) => updateTodo(todo, { workloadId })}
        />
      </div>
      </>
      )}

      {!isChild && (
      <Collapsible title="Customer About and Syncing">
        {/* Firmographics & CRM about — background context, not sales/relationship signal. */}
        <h3 style={{ margin: '4px 0 12px', fontSize: 15, color: 'var(--text)' }}>Account Details</h3>
        <AccountDetailsGrid customer={customer} />

        {customer.description && (
          <>
            <h3 style={{ margin: '24px 0 8px', fontSize: 15, color: 'var(--text)' }}>CRM Description</h3>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{customer.description}</div>
          </>
        )}
        {customer.notes && (
          <>
            <h3 style={{ margin: '24px 0 8px', fontSize: 15, color: 'var(--text)' }}>Notes</h3>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{customer.notes}</div>
          </>
        )}

      {/* Copilot CLI with WorkIQ MCP Server Data — personal CLI-ingested signal */}
      <h3 style={{ margin: '28px 0 12px', fontSize: 15, color: 'var(--text)' }}>Copilot CLI with WorkIQ MCP Server Data</h3>
      <p style={{ margin: '-6px 0 14px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Teams chats, emails, and meetings below are ingested through <strong>GitHub Copilot CLI</strong> +
        the <strong>WorkIQ MCP Server</strong>, running as your signed-in account. If a section is empty,
        run the differential sync (or the <code>tools/teams</code>, <code>tools/email</code>, and{' '}
        <code>tools/meetings</code> datastore tools) from a Copilot CLI agent session to pull and link your data.
      </p>
      <WorkspaceList
        title={`Related Teams Chats${teamsChats.length ? ` (${teamsChats.length})` : ''}${
          teamsProfile ? ` · ${teamsProfile.message_count} messages analyzed` : ''
        }`}
        empty={
          customer?.tpid
            ? 'No Teams chats linked to this account yet. Pull them through GitHub Copilot CLI + the WorkIQ MCP Server by running the Teams datastore tool (tools/teams) from a Copilot CLI agent session.'
            : 'This customer has no TPID, so Teams chats cannot be matched.'
        }
        items={teamsChats.map((chat) => ({
          id: chat.chat_id,
          medium: 'chat',
          title: `${chat.has_unread ? '🔴 ' : ''}${chat.topic || '(unnamed chat)'}`,
          detail: [
            chat.chat_type,
            (chat.last_message_at || '').slice(0, 10) || 'no date',
            chat.last_message_from || null,
            chat.messages_synced ? 'messages ingested' : null,
            chat.matched_term ? `matched: ${chat.matched_term}` : null,
          ].filter(Boolean).join(' · '),
        }))}
        onOpenItem={(item) => setOpenItem({ medium: 'chat', id: item.id })}
      />

      <WorkspaceList
        title={`Related Emails${customerEmails.length ? ` (${customerEmails.length})` : ''}${
          emailProfile ? ` · ${emailProfile.email_count} analyzed` : ''
        }`}
        empty={
          customer?.tpid
            ? 'No customer emails linked yet. Pull them through GitHub Copilot CLI + the WorkIQ MCP Server by running the email datastore tool (tools/email) from a Copilot CLI agent session.'
            : 'This customer has no TPID, so emails cannot be matched.'
        }
        items={customerEmails.map((mail) => ({
          id: mail.message_id,
          medium: 'email',
          title: mail.subject || '(no subject)',
          detail: [
            (mail.received_at || '').slice(0, 10) || 'no date',
            mail.from_name || null,
            mail.match_method === 'alias-thread' ? 'thread match' : 'matched',
          ].filter(Boolean).join(' · '),
        }))}
        onOpenItem={(item) => setOpenItem({ medium: 'email', id: item.id })}
      />

      <WorkspaceList
        title={`Related Meetings${customerMeetings.length ? ` (${customerMeetings.length})` : ''}${
          meetingProfile ? ` · ${meetingProfile.meeting_count} analyzed` : ''
        }`}
        empty={
          customer?.tpid
            ? 'No customer meetings linked yet. Pull them through GitHub Copilot CLI + the WorkIQ MCP Server by running the meeting datastore tool (tools/meetings) from a Copilot CLI agent session.'
            : 'This customer has no TPID, so meetings cannot be matched.'
        }
        items={customerMeetings.map((mtg) => ({
          id: mtg.event_id,
          medium: 'meeting',
          title: mtg.subject || '(no subject)',
          detail: [
            formatLocalDateTime(mtg.start_at) || 'no date',
            mtg.organizer_name || null,
            mtg.is_online_meeting ? 'online' : 'in-person',
            mtg.match_method === 'alias-series' ? 'series match'
              : mtg.match_method === 'contact' ? 'contact match' : 'matched',
          ].filter(Boolean).join(' · '),
          body: mtg.agenda,
        }))}
        onOpenItem={(item) => setOpenItem({ medium: 'meeting', id: item.id })}
      />

      <WorkspaceList
        title={`Internal Contacts from WorkIQ${microsoftTeam.length ? ` (${microsoftTeam.length})` : ''}`}
        empty={
          customer?.tpid
            ? 'No account team derived yet. Run tools/account_team to build it from Teams + email.'
            : 'This customer has no TPID, so an account team cannot be derived.'
        }
        items={microsoftTeam.map((p) => ({
          id: p.person_email || p.person_name,
          title: p.person_name,
          detail: [
            p.person_email || null,
            `${p.email_sends} sent · ${p.email_cc} cc · ${p.teams_msgs} Teams`,
            p.last_activity ? `last ${(p.last_activity || '').slice(0, 10)}` : null,
          ].filter(Boolean).join(' · '),
        }))}
      />

      {customerContacts.length > 0 && (
        <WorkspaceList
          title={`External Contacts from WorkIQ (${customerContacts.length})`}
          empty="No customer-side contacts identified yet."
          items={customerContacts.map((p) => ({
            id: p.person_email || p.person_name,
            title: p.person_name,
            detail: [
              p.person_email || null,
              `${p.email_sends} sent · ${p.teams_msgs} Teams`,
              p.last_activity ? `last ${(p.last_activity || '').slice(0, 10)}` : null,
            ].filter(Boolean).join(' · '),
          }))}
        />
      )}

      {customer?.tpid && (
        <KeyContacts contacts={crmContacts} onOpenLinkedIn={(url) => openExternal(url)} />
      )}

      {/* Child Accounts */}
      {!loadChildren && children.length > 0 && (
        <Collapsible title={`Child Accounts (${children.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>City</th>
                  <th>Country</th>
                  <th>Segment</th>
                </tr>
              </thead>
              <tbody>
                {children.map((ch) => (
                  <tr key={ch.id}>
                    <td>
                      <Link to={`/customers/${ch.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                        {ch.name}
                      </Link>
                    </td>
                    <td>{ch.city || '—'}</td>
                    <td>{ch.country || '—'}</td>
                    <td>{ch.industry_segment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        </Collapsible>
      )}
      </Collapsible>
      )}

      {!isChild && (
      <>
        {/* Account Documents — tenant-wide Unified Search for this account's collateral. */}
        <AccountDocuments customer={customer} />

        {/* Relevant Content (Seismic) at left, Research Dossier at right. */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 320 }}>
            <SeismicContent customer={customer} opportunities={opportunities} milestones={milestones} />
          </div>
          <div style={{ flex: 1, minWidth: 320 }}>
            <ResearchDossierCard customer={customer} />
          </div>
        </div>

      <Collapsible title="AI Features" defaultOpen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '-4px 0 0' }}>
      <Collapsible
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><SparkleRegular style={{ fontSize: 16, color: 'var(--violet)' }} />Sales Play Advisor</span>}
        style={{ borderColor: 'color-mix(in srgb, var(--violet) 20%, transparent)', marginBottom: 0 }}
      >
        <div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
            An AI pre-sales coach for <strong style={{ color: 'var(--text)' }}>{customer?.name || 'this account'}</strong>
            {customer?.tpid ? ` (TPID ${customer.tpid})` : ''}. It grounds a concrete plan — talk tracks, use-case
            pitches, PoCs, demos, and specific people to engage — in this account's consumption, tech stack,
            opportunities, milestones, contacts, and recent signal. Scoped to this account only.
          </p>
          <Field label="Objective (optional) — steer the plan, e.g. “expand their AI footprint” or “win the data platform deal”">
            <Input
              value={salesObjective}
              onChange={(_e, d) => setSalesObjective(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !advising && cloudProfile) generateSalesPlay(); }}
              placeholder="Leave blank for a full-account plan"
              disabled={advising}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <Button
              appearance="primary"
              icon={<SparkleRegular />}
              onClick={generateSalesPlay}
              disabled={!cloudProfile || advising}
              title={!cloudProfile ? 'Cloud profile unavailable' : 'Generate an account sales playbook'}
            >
              {advising ? 'Building your sales play…' : 'Generate Sales Play'}
            </Button>
            {advising && <Spinner size="tiny" />}
            {!cloudProfile && <span style={{ color: 'var(--warning-text)', fontSize: 12 }}>Cloud profile unavailable for this customer.</span>}
          </div>

          {workspaceSalesAdvisories.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Saved sales plays</div>
              {workspaceSalesAdvisories.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hairline)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.title}>{a.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {a.occurredAt ? new Date(a.occurredAt).toLocaleString() : ''}{a.metadata?.objective ? ` · ${a.metadata.objective}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {a.metadata?.htmlPath && (
                      <Button size="small" appearance="secondary" icon={<OpenRegular />} onClick={() => openGeneration(a.metadata.htmlPath)}>Open</Button>
                    )}
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => deleteGeneration(a.id)} title="Delete this sales play" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Collapsible>

      <CustomerAnalysisSection
        customer={customer}
        opportunities={opportunities}
        milestones={milestones}
        profileId={cloudProfile?.id || null}
        cloudProfile={cloudProfile}
        analyses={workspaceCustomerAnalyses}
        analyzing={analyzing}
        onGenerate={generateCustomerAnalysisPlay}
        openGeneration={openGeneration}
        deleteGeneration={deleteGeneration}
      />

      <WorkspaceList
        title="AI Customer Summaries"
        empty="No summaries generated yet."
        collapsibleItems
        onOpenItem={openGeneration}
        onDeleteItem={deleteGeneration}
        action={
          <Button
            appearance="primary"
            size="small"
            onClick={generateComprehensiveSummary}
            disabled={!cloudProfile || savingWorkspace}
          >
            {savingWorkspace ? 'Generating summary…' : 'Generate Customer Comprehensive Summary'}
          </Button>
        }
        items={workspaceAiBriefs.map((brief) => ({
          id: brief.id,
          title: brief.title,
          detail: brief.occurredAt,
          body: brief.summary,
          htmlPath: brief.metadata?.htmlPath || null,
        }))}
      />

      <WorkspaceList
        title="Customer Tech Stack"
        empty="No tech stack generated yet. Click Generate to inventory this customer's technology (Microsoft + third-party) from active_opportunities, milestones, Teams, and email."
        collapsibleItems
        onOpenItem={openGeneration}
        onDeleteItem={deleteGeneration}
        action={
          <Button
            appearance="primary"
            size="small"
            onClick={generateTechStack}
            disabled={!cloudProfile || savingWorkspace}
          >
            {savingWorkspace ? 'Generating…' : 'Generate Tech Stack'}
          </Button>
        }
        items={workspaceTechStacks.map((ts) => ({
          id: ts.id,
          title: ts.title,
          detail: ts.occurredAt,
          body: ts.summary,
          htmlPath: ts.metadata?.htmlPath || null,
        }))}
      />

      <WorkspaceList
        title="Azure Consumption Analysis"
        empty="No consumption analysis yet. Click “AI Macro-Trend Analysis” to generate an opportunities-and-risks briefing from this customer's monthly Azure spend, profile, and tech stack."
        collapsibleItems
        onOpenItem={openGeneration}
        onDeleteItem={deleteGeneration}
        action={
          <Button
            appearance="primary"
            size="small"
            icon={<SparkleRegular />}
            onClick={generateAcrAnalysisPlay}
            disabled={!cloudProfile || acrAnalyzing}
            title={!cloudProfile ? 'Cloud profile unavailable' : 'AI macro-trend analysis: opportunities & risks'}
          >
            {acrAnalyzing ? 'Analyzing…' : 'AI Macro-Trend Analysis'}
          </Button>
        }
        items={workspaceAcrAnalyses.map((a) => ({
          id: a.id,
          title: a.title,
          detail: a.occurredAt,
          body: a.summary,
          htmlPath: a.metadata?.htmlPath || null,
        }))}
      />
      </div>
      </Collapsible>
      </>
      )}

      {openItem && (openItem.medium === 'meeting' ? (
        <MeetingDetailPanel
          eventId={openItem.id}
          onClose={() => setOpenItem(null)}
          onTasksChanged={() => setWorkspaceRevision(value => value + 1)}
          onTagsChanged={() => {
            if (refreshChats) refreshChats();
            if (refreshEmails) refreshEmails();
            if (refreshMeetings) refreshMeetings();
          }}
        />
      ) : (
        <ItemDetailPanel
          medium={openItem.medium}
          id={openItem.id}
          onClose={() => setOpenItem(null)}
          onTagsChanged={() => {
            if (refreshChats) refreshChats();
            if (refreshEmails) refreshEmails();
            if (refreshMeetings) refreshMeetings();
          }}
        />
      ))}

    </div>
  );
}

function InfoRow({ label, value, badge }) {
  const display = value ?? '—';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {badge && value ? (
        <span className={`badge badge-${badge}`}>{display}</span>
      ) : (
        <span>{display}</span>
      )}
    </div>
  );
}

// Firmographics grid (shared by the child layout and the "Customer About and Syncing" section).
function AccountDetailsGrid({ customer }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Account Overview</div>
        <InfoRow label="TPID" value={customer.tpid} badge="secondary" />
        <InfoRow label="Segment" value={customer.industry_segment} />
        <InfoRow
          label="Tier"
          value={customer.tier}
          badge={customer.tier === 'Strategic' ? 'danger' : customer.tier === 'Premium' ? 'warning' : 'secondary'}
        />
        <InfoRow label="Revenue" value={customer.revenue ? `$${Number(customer.revenue).toLocaleString()}` : null} />
        <InfoRow label="Employees" value={customer.employees} />
      </div>
      <div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Contact &amp; Location</div>
        <InfoRow label="City" value={customer.city} />
        <InfoRow label="Country" value={customer.country} />
        <InfoRow label="Phone" value={customer.phone} />
        <InfoRow
          label="Website"
          value={customer.website ? (
            <a href={customer.website} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{customer.website}</a>
          ) : null}
        />
        <InfoRow label="CRM ID" value={customer.crm_account_id} badge="info" />
        <InfoRow label="Last CRM Sync" value={customer.last_crm_sync} />
      </div>
    </div>
  );
}

// One KPI tile for the Customer ACR Metrics section.
function AcrKpi({ label, value, sub, color, valueSize = 24 }) {
  return (
    <div className="stat-card" style={{ flex: 1, minWidth: 150 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: valueSize, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      {sub != null && sub !== '' && (
        <div style={{ fontSize: 12, color: color || 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

// Customer-scoped Azure consumption KPIs (latest ACR, MoM change, FY total, top service),
// pulled from the same MSX-I portfolio endpoint the Azure Consumption tab uses — scoped to
// this one TPID. The button opens that tab pre-filtered to this account.
function CustomerAcrMetrics({ customer }) {
  const navigate = useNavigate();
  const tpid = customer?.tpid ? String(customer.tpid).trim() : '';
  const level = 2;
  const [fy, setFy] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await acrPeriods();
        if (cancelled || !p?.ok) return;
        setFy((cur) => cur || defaultFiscalYear(p.fiscalYears));
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (force = false) => {
    if (!tpid || !fy) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await acrPortfolio({ tpids: [tpid], fiscalYear: fy, level, force });
      if (res?.ok) {
        setData(res);
        if (res.cache?.status !== 'missing' && (!res.accounts || res.accounts.length === 0)) {
          setMessage({ type: 'info', text: `No Azure consumption recorded for this account in ${fy}.` });
        }
      } else if (res?.code === 'NO_ACCOUNT') {
        setMessage({ type: 'warning', text: 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load ACR.' });
      } else {
        setMessage({ type: 'error', text: res?.error || 'Failed to load ACR.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Failed to load ACR.' });
    } finally {
      setLoading(false);
    }
  }, [tpid, fy]);

  useEffect(() => { if (tpid && fy) load(false); }, [tpid, fy, load]);

  const totals = data?.totals;
  const topService = data?.serviceMix?.[0] || null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <DataTrendingRegular style={{ fontSize: 16 }} /> Customer ACR Metrics{data?.fiscalYear ? ` · ${data.fiscalYear}` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <Spinner size="tiny" />}
          {tpid && (
            <Button
              appearance="primary"
              size="small"
              icon={<DataTrendingRegular />}
              onClick={() => navigate(`/consumption/${encodeURIComponent(tpid)}`)}
              title="Open the expanded per-account consumption page (tables, trend, and AI models)"
            >
              ACR Details
            </Button>
          )}
        </div>
      </div>
      <div className="card-body-custom">
        {!tpid ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No TPID on this account, so Azure consumption cannot be loaded.</div>
        ) : (
          <>
            {message && (
              <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 10 }}>{message.text}</div>
            )}
            {data?.cache?.status !== 'missing' && totals ? (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <AcrKpi label={`Latest ACR${data.latestMonth ? ` · ${monthAbbr(data.latestMonth)}` : ''}`} value={fmtUsd(totals.latest)} />
                <AcrKpi label="MoM change" value={fmtUsd(totals.momDollar)} sub={fmtPct(totals.momPct)} color={trendColor(totals.momDollar)} />
                <AcrKpi label={`${data.fiscalYear} total`} value={fmtUsd(totals.grandTotal)} />
                <AcrKpi
                  label="Top service"
                  value={topService ? (topService.service.length > 18 ? `${topService.service.slice(0, 17)}…` : topService.service) : '—'}
                  sub={topService ? fmtUsd(topService.total) : ''}
                  valueSize={16}
                />
              </div>
            ) : loading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading consumption…</div>
            ) : data?.cache?.status === 'missing' ? (
              <div style={{ color: 'var(--warning-text)', fontSize: 13 }}>
                {data.cache.error?.message || 'Loading consumption data…'}
              </div>
            ) : !message ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No consumption data.</div>
            ) : null}
            <AcrFreshness cache={data?.cache} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Account Documents (WorkIQ Unified Search, feature 1) ─────────────────────
function fileKindLabel(mime) {
  const m = String(mime || '');
  if (/presentation/.test(m)) return 'PPT';
  if (/spreadsheet|excel/.test(m)) return 'XLS';
  if (/word|document/.test(m)) return 'DOC';
  if (/pdf/.test(m)) return 'PDF';
  if (/onenote/.test(m)) return 'NOTE';
  if (/html/.test(m)) return 'HTML';
  return 'FILE';
}
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function CustomerAnalysisSection({
  customer,
  opportunities,
  milestones,
  profileId,
  cloudProfile,
  analyses,
  analyzing,
  onGenerate,
  openGeneration,
  deleteGeneration,
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!customer?.name && !customer?.tpid) {
      setError('This customer has no name or TPID to analyze.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getCustomerInsights({
        customer,
        opportunities,
        milestones,
        profileId,
        includeAcr: true,
      });
      if (res?.ok === false) {
        setError(res.error || 'Insights are only available in the desktop app.');
        setInsights(null);
      } else {
        setInsights(res);
      }
    } catch (e) {
      setError(e.message || 'Could not compute customer insights.');
    } finally {
      setLoading(false);
    }
  }, [customer, opportunities, milestones, profileId]);

  // Compute deterministic insights the first time the card is expanded, and
  // refresh whenever the underlying opportunity/milestone counts change.
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer?.tpid, (opportunities || []).length, (milestones || []).length]);

  const CONF = {
    high: { bg: 'var(--success-tint)', fg: 'var(--success-text)', label: 'High confidence' },
    medium: { bg: 'var(--warning-tint)', fg: 'var(--warning-text)', label: 'Medium confidence' },
    low: { bg: 'var(--hairline)', fg: 'var(--text-secondary)', label: 'Low confidence' },
  };
  const SEV = {
    positive: { bg: 'var(--success-tint)', border: 'var(--success)', fg: 'var(--success-text)' },
    warning: { bg: 'var(--warning-tint)', border: 'var(--warning)', fg: 'var(--warning-text)' },
    info: { bg: 'var(--hairline)', border: 'var(--border)', fg: 'var(--text-secondary)' },
  };
  const PRI = {
    high: { bg: 'var(--danger-tint)', border: 'var(--danger-tint)', fg: 'var(--danger)', label: 'High' },
    medium: { bg: 'var(--warning-tint)', border: 'var(--warning)', fg: 'var(--warning-text)', label: 'Medium' },
    low: { bg: 'var(--hairline)', border: 'var(--border)', fg: 'var(--text-secondary)', label: 'Low' },
  };

  const conf = insights ? (CONF[insights.confidence] || CONF.low) : null;

  return (
    <div className="card" style={{ marginBottom: 0, borderColor: 'color-mix(in srgb, var(--accent) 20%, transparent)' }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <DataTrendingRegular style={{ fontSize: 16, color: 'var(--accent)' }} /> Priorities &amp; Opportunities
        {insights && conf ? (
          <span
            style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: conf.fg, background: conf.bg, borderRadius: 10, padding: '2px 8px' }}
          >
            {conf.label}
          </span>
        ) : null}
      </div>
      {open && (
        <div className="card-body-custom">
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            A deterministic read on <strong style={{ color: 'var(--text)' }}>{customer?.name || 'this account'}</strong> — it
            joins the research dossier, MSX opportunities &amp; milestones, and Azure consumption momentum into the
            customer&apos;s <strong style={{ color: 'var(--text)' }}>priorities</strong>, Microsoft{' '}
            <strong style={{ color: 'var(--text)' }}>opportunity areas</strong>, and tailored{' '}
            <strong style={{ color: 'var(--text)' }}>next-best-actions</strong>. Every claim is grounded in this account&apos;s
            data; missing sources are called out, not guessed.
          </p>

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
              <Spinner size="tiny" /> Analyzing this account&apos;s signals…
            </div>
          )}

          {error && (
            <div className="flash-message flash-warning" style={{ marginBottom: 10 }}>{error}</div>
          )}

          {!loading && insights && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, fontSize: 11.5 }}>
                {[
                  { on: insights.dataCoverage?.hasDossier, label: 'Research dossier' },
                  {
                    on: insights.dataCoverage?.hasAcr,
                    label: insights.dataCoverage?.acrSource === 'local-cache' ? 'Azure consumption (cached)' : 'Azure consumption',
                    title: insights.dataCoverage?.acrSource === 'local-cache'
                      ? `From a local cache — last successful online fetch on ${String(insights.dataCoverage?.acrAsOf || '').slice(0, 10) || 'an earlier session'}. Reconnect + sign in for live numbers.`
                      : (insights.dataCoverage?.hasAcr ? 'Live Azure consumption' : 'Signal missing'),
                  },
                  { on: insights.dataCoverage?.openOpportunities > 0, label: `${insights.dataCoverage?.openOpportunities || 0} open opps` },
                  { on: insights.dataCoverage?.milestones > 0, label: `${insights.dataCoverage?.milestones || 0} milestones` },
                ].map((c) => (
                  <span
                    key={c.label}
                    style={{
                      color: c.on ? 'var(--success-text)' : 'var(--text-faint)',
                      background: c.on ? 'var(--success-tint)' : 'var(--surface-2)',
                      border: `1px solid ${c.on ? 'var(--success)' : 'var(--canvas)'}`,
                      borderRadius: 10,
                      padding: '2px 9px',
                      fontWeight: 600,
                    }}
                    title={c.title || (c.on ? 'Signal present' : 'Signal missing')}
                  >
                    {c.on ? '✓ ' : '○ '}{c.label}
                  </span>
                ))}
              </div>

              {insights.priorities?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                    Customer priorities
                  </div>
                  {insights.priorities.map((p, i) => (
                    <div key={`p${i}`} style={{ padding: '7px 0', borderBottom: '1px solid var(--hairline)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{p.title}</span>
                        {p.confidence && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, color: (CONF[p.confidence] || CONF.low).fg, background: (CONF[p.confidence] || CONF.low).bg, borderRadius: 8, padding: '1px 7px' }}>
                            {p.confidence}
                          </span>
                        )}
                        {p.source && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>· {p.source}</span>}
                      </div>
                      {p.detail && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.45 }}>{p.detail}</div>}
                    </div>
                  ))}
                </div>
              )}

              {insights.opportunityAreas?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                    Opportunity areas
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {insights.opportunityAreas.map((a, i) => {
                      const s = SEV[a.severity] || SEV.info;
                      return (
                        <div key={`o${i}`} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: '8px 11px' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: s.fg }}>{a.title}</div>
                          {a.detail && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>{a.detail}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {insights.suggestions?.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                    Suggested next-best-actions
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {insights.suggestions.map((sg, i) => {
                      const pr = PRI[sg.priority] || PRI.low;
                      return (
                        <div key={`s${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <span style={{ flexShrink: 0, marginTop: 1, fontSize: 10.5, fontWeight: 700, color: pr.fg, background: pr.bg, border: `1px solid ${pr.border}`, borderRadius: 8, padding: '2px 8px', minWidth: 52, textAlign: 'center' }}>
                            {pr.label}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{sg.title}</div>
                            {sg.detail && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>{sg.detail}</div>}
                            {sg.rationale && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2, fontStyle: 'italic' }}>Why: {sg.rationale}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {insights.notes?.length > 0 && (
                <div style={{ marginTop: 12, background: 'var(--warning-tint)', border: '1px solid var(--warning)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--warning-text)', marginBottom: 4 }}>Data gaps</div>
                  <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--warning-text)', fontSize: 12, lineHeight: 1.5 }}>
                    {insights.notes.map((n, i) => <li key={`n${i}`}>{n}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button
                appearance="primary"
                icon={<SparkleRegular />}
                onClick={onGenerate}
                disabled={!cloudProfile || analyzing}
                title={!cloudProfile ? 'Cloud profile unavailable' : 'Generate an AI-narrated analysis briefing'}
              >
                {analyzing ? 'Building the analysis…' : 'Generate AI Analysis'}
              </Button>
              {analyzing && <Spinner size="tiny" />}
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                Narrates the facts above into a shareable briefing (Foundry).
              </span>
            </div>
            {!cloudProfile && (
              <div style={{ color: 'var(--warning-text)', fontSize: 12, marginTop: 6 }}>Cloud profile unavailable for this customer.</div>
            )}

            {analyses?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Saved analyses</div>
                {analyses.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hairline)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.title}>{a.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {a.occurredAt ? new Date(a.occurredAt).toLocaleString() : ''}{a.metadata?.confidence ? ` · ${a.metadata.confidence} confidence` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {a.metadata?.htmlPath && (
                        <Button size="small" appearance="secondary" icon={<OpenRegular />} onClick={() => openGeneration(a.metadata.htmlPath)}>Open</Button>
                      )}
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => deleteGeneration(a.id)} title="Delete this analysis" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResearchDossierCard({ customer }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null); // { found, available, account, lastUpdated, topics, reason }
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    const name = (customer?.name || '').trim();
    if (!name && !customer?.tpid) {
      setMeta({ found: false, available: true, reason: 'This customer has no name to match against a research dossier.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await getCustomerResearchDossier({ name, tpid: customer?.tpid });
      if (res?.ok === false) {
        setMessage({ type: 'warning', text: res.error || 'Research dossiers are only available in the desktop app.' });
        setMeta(null);
      } else {
        setMeta(res);
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Could not check for a research dossier.' });
    } finally {
      setLoading(false);
    }
  }, [customer?.name, customer?.tpid]);

  // Check for a dossier the first time the card is expanded.
  useEffect(() => {
    if (open && !meta && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function openDossier() {
    setOpening(true);
    setMessage(null);
    try {
      const res = await openCustomerResearchDossier({ name: customer?.name, tpid: customer?.tpid });
      if (res?.ok === false) {
        setMessage({ type: 'warning', text: res.error || 'Research dossiers are only available in the desktop app.' });
        return;
      }
      if (!res.found) {
        setMeta((m) => ({ ...(m || {}), found: false, available: res.available !== false, reason: res.reason }));
        setMessage({ type: 'info', text: res.reason || 'No research dossier found for this account.' });
        return;
      }
      const opened = await openGeneratedFile(res.htmlPath);
      if (opened && opened.ok === false) {
        setMessage({ type: 'error', text: `Could not open the dossier: ${opened.error || 'unknown error'}` });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Could not open the research dossier.' });
    } finally {
      setOpening(false);
    }
  }

  const found = !!meta?.found;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <DocumentRegular style={{ fontSize: 16, color: 'var(--violet)' }} /> Research Dossier
        {found ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` · ${meta.account}`}</span> : null}
      </div>
      {open && (
        <div className="card-body-custom">
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
            The curated pre-sales research note for this account — financial &amp; strategic priorities, technology
            footprint, AI &amp; data initiatives, buying committee, regulatory posture, triggers, and Microsoft pitch
            mapping. Rendered from the research vault into a printable briefing.
          </p>

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
              <Spinner size="tiny" /> Checking for a dossier…
            </div>
          )}

          {message && (
            <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 10 }}>{message.text}</div>
          )}

          {!loading && found && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <Button
                  appearance="primary"
                  size="small"
                  icon={<OpenRegular />}
                  onClick={openDossier}
                  disabled={opening}
                  title={`Open the research dossier for ${meta.account}`}
                >
                  {opening ? 'Opening…' : 'Open research dossier'}
                </Button>
                {opening && <Spinner size="tiny" />}
                {meta.lastUpdated && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Updated {meta.lastUpdated}</span>
                )}
              </div>
              {meta.topics?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {meta.topics.filter((t) => t.title && t.title.toLowerCase() !== 'snapshot').map((t) => (
                    <span
                      key={t.num}
                      className="badge badge-secondary"
                      style={{ fontSize: 11 }}
                      title={`Section ${t.num}`}
                    >
                      {t.title}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {!loading && meta && !found && (
            <div style={{ color: 'var(--warning-text)', fontSize: 13, background: 'var(--warning-tint)', border: '1px solid var(--warning)', borderRadius: 8, padding: '8px 12px' }}>
              {meta.reason || 'No research dossier is available for this account yet.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AccountDocuments({ customer }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(customer?.name || '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { docs, total, more }
  const [message, setMessage] = useState(null);

  const run = useCallback(async (query) => {
    const q = String(query ?? term).trim();
    if (q.length < 2) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await customerSearchDocuments({ query: q, size: 20 });
      if (res?.ok) {
        setResult(res);
        if (!res.docs?.length) setMessage({ type: 'info', text: `No documents found for “${q}”.` });
      } else {
        setMessage({ type: 'warning', text: res?.error || 'Search failed. Ensure the Copilot CLI WorkIQ sign-in is valid.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Search failed.' });
    } finally {
      setLoading(false);
    }
  }, [term]);

  // Auto-run once when first expanded.
  useEffect(() => {
    if (open && !result && !loading && (customer?.name || '').trim().length >= 2) run(customer.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <DocumentRegular style={{ fontSize: 16 }} /> Account Documents
        {result?.total ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` · ${result.total}${result.more ? '+' : ''}`}</span> : null}
      </div>
      {open && (
        <div className="card-body-custom">
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
            Decks, QBRs, and notes about this account from across the tenant (Microsoft Search — SharePoint/OneDrive
            you have access to). Signs in with your Microsoft identity via WorkIQ.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Input
              value={term}
              onChange={(_e, d) => setTerm(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) run(); }}
              placeholder="Search term (account name, project, …)"
              contentBefore={<SearchRegular />}
              style={{ flex: 1, maxWidth: 420 }}
            />
            <Button appearance="primary" size="small" onClick={() => run()} disabled={loading || term.trim().length < 2}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
            {loading && <Spinner size="tiny" />}
          </div>

          {message && (
            <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 10 }}>{message.text}</div>
          )}

          {result?.docs?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {result.docs.map((doc) => (
                <div key={doc.id} className="card" style={{ padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span className="badge badge-secondary" style={{ flexShrink: 0, marginTop: 2 }}>{fileKindLabel(doc.mimeType)}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.name}>{doc.name}</span>
                      {doc.webUrl && (
                        <Button size="small" appearance="subtle" icon={<OpenRegular />} title="Open in SharePoint/OneDrive" onClick={() => openExternal(doc.webUrl)}>Open</Button>
                      )}
                    </div>
                    {doc.summary ? <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{doc.summary}</div> : null}
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                      {[
                        doc.lastModifiedBy || doc.createdBy || null,
                        doc.lastModifiedDateTime ? new Date(doc.lastModifiedDateTime).toLocaleDateString() : null,
                        doc.size ? fmtBytes(doc.size) : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
              {result.more && (
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>More results available — refine the search term to narrow.</div>
              )}
            </div>
          )}

          {!result && !loading && !message && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading documents…</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Account Team roster (manual role assignments, persisted per account) ──────────
// Grouped role catalog. Editing writes to customer_account_team_roles and is reused
// by other surfaces (e.g. Team Availability free/busy).
const ACCOUNT_TEAM_GROUPS = [
  {
    name: 'Core Account Team',
    roles: ['Account Executive', 'Account Technology Strategist', 'Customer Success Account Manager'],
  },
  {
    name: 'Cloud & AI Solution Team',
    roles: [
      'Cloud and AI Specialist',
      'Cloud and AI Infra Solution Engineer',
      'Cloud and AI Data Solution Engineer',
      'Cloud and AI Apps Solution Engineer',
    ],
  },
  {
    name: 'Specialists & Solution Engineers',
    roles: [
      'Cloud Solution Architect',
      'Security Specialist',
      'Security Solution Engineer',
      'AI Workforce Specialist',
      'Copilot Studio Solution Engineer',
      'AI Business Solution Specialist',
      'Power Platform Solution Engineer',
      'Dynamics 365 Solution Engineer',
    ],
  },
];

// Canonical role lookup (case-insensitive) built from the catalog above.
const CANONICAL_ROLES = (() => {
  const m = new Map();
  for (const g of ACCOUNT_TEAM_GROUPS) for (const r of g.roles) m.set(r.toLowerCase(), r);
  return m;
})();

// RFC-4180-ish CSV reader: handles quoted fields (embedded commas, quotes, newlines).
// Throws on an unterminated quote so malformed input fails loudly.
function parseCsvRecords(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      field += c; continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { record.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    field += c;
  }
  if (inQuotes) throw new Error('Unterminated quoted field — check your quotes.');
  record.push(field);
  records.push(record);
  return records;
}

function csvEscape(s) {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Serialize current role values as a full-state CSV (one line per catalog role).
function buildTeamCsv(values) {
  const lines = ['Role,Name,Email'];
  for (const g of ACCOUNT_TEAM_GROUPS) {
    for (const role of g.roles) {
      const v = values[role] || {};
      lines.push([role, v.name || '', v.email || ''].map(csvEscape).join(','));
    }
  }
  return lines.join('\n');
}

// Parse a Role,Name,Email CSV into a values object. Validates structure and roles;
// throws with a line-specific message on any problem (no silent fallback).
function parseTeamCsv(text) {
  const records = parseCsvRecords(text).filter((r) => r.some((f) => String(f).trim() !== ''));
  if (!records.length) throw new Error('No data found. Add at least one "Role,Name,Email" row.');
  let start = 0;
  const first = records[0].map((f) => String(f).trim().toLowerCase());
  if (first[0] === 'role' && (first[1] === 'name' || first[1] === 'person_name')) start = 1;
  const out = {};
  for (let idx = start; idx < records.length; idx++) {
    const row = records[idx];
    const ln = idx + 1;
    if (row.length < 2 || row.length > 3) {
      throw new Error(`Line ${ln}: expected 2–3 columns (Role, Name, Email) but found ${row.length}.`);
    }
    const roleRaw = String(row[0] || '').trim();
    if (!roleRaw) throw new Error(`Line ${ln}: role is required.`);
    const canonical = CANONICAL_ROLES.get(roleRaw.toLowerCase());
    if (!canonical) throw new Error(`Line ${ln}: unrecognized role "${roleRaw}".`);
    out[canonical] = { name: String(row[1] || '').trim(), email: String(row[2] || '').trim() };
  }
  return out;
}

function AccountTeamRoster({ tpid, roles, suggestions, onSaved }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvError, setCsvError] = useState('');
  const [csvSaving, setCsvSaving] = useState(false);

  // Seed the editor from persisted rows (and re-seed after a save round-trips).
  useEffect(() => {
    const next = {};
    for (const r of roles || []) {
      next[r.role] = { name: r.person_name || '', email: r.person_email || '' };
    }
    setValues(next);
  }, [roles]);

  const suggestionList = useMemo(
    () => (suggestions || []).filter((p) => p.person_name),
    [suggestions],
  );
  const emailByName = useMemo(() => {
    const m = new Map();
    for (const p of suggestionList) m.set(String(p.person_name).toLowerCase(), p.person_email || '');
    return m;
  }, [suggestionList]);

  const setName = (role, name) => setValues((v) => {
    const existingEmail = v[role]?.email || '';
    const email = existingEmail || emailByName.get(String(name).toLowerCase()) || '';
    return { ...v, [role]: { name, email } };
  });
  const setEmail = (role, email) => setValues((v) => ({ ...v, [role]: { name: v[role]?.name || '', email } }));

  const filledCount = useMemo(
    () => Object.values(values).filter((v) => String(v.name || '').trim() || String(v.email || '').trim()).length,
    [values],
  );

  const persist = useCallback(async (valuesToSave) => {
    await dbRun('DELETE FROM customer_account_team_roles WHERE tpid = ?', [tpid]);
    for (const [role, val] of Object.entries(valuesToSave)) {
      const name = String(val?.name || '').trim();
      const email = String(val?.email || '').trim();
      if (!name && !email) continue;
      await dbRun(
        `INSERT INTO customer_account_team_roles (tpid, role, person_name, person_email)
         VALUES (?, ?, ?, ?)`,
        [tpid, role, name, email],
      );
    }
  }, [tpid]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      await persist(values);
      setStatus({ type: 'success', text: 'Account team saved.' });
      onSaved?.();
    } catch (e) {
      setStatus({ type: 'error', text: e.message || 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }, [persist, values, onSaved]);

  const openCsv = useCallback(() => {
    setCsvError('');
    setCsvText(buildTeamCsv(values));
    setCsvOpen(true);
  }, [values]);

  const saveCsv = useCallback(async () => {
    let parsed;
    try {
      parsed = parseTeamCsv(csvText);
    } catch (e) {
      setCsvError(e.message || 'Invalid CSV.');
      return;
    }
    setCsvSaving(true);
    setCsvError('');
    try {
      await persist(parsed);
      setValues(parsed);
      setCsvOpen(false);
      setStatus({ type: 'success', text: 'Account team saved from CSV.' });
      onSaved?.();
    } catch (e) {
      setCsvError(e.message || 'Save failed.');
    } finally {
      setCsvSaving(false);
    }
  }, [csvText, persist, onSaved]);

  const listId = `team-suggest-${tpid}`;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <PeopleTeamRegular style={{ fontSize: 16 }} /> Account Team
        {filledCount ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` · ${filledCount}`}</span> : null}
      </div>
      {open && (
        <div className="card-body-custom">
          <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 14 }}>
            Assign your account team by role. Saved to this account and reused across the app (e.g. Team Availability).
          </div>
          <datalist id={listId}>
            {suggestionList.map((p, i) => <option key={i} value={p.person_name} />)}
          </datalist>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {ACCOUNT_TEAM_GROUPS.map((group) => (
              <div key={group.name}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  {group.name}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {group.roles.map((role) => (
                    <div key={role} style={{ display: 'grid', gridTemplateColumns: '200px 1fr 1fr', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{role}</div>
                      <Input
                        size="small"
                        list={listId}
                        placeholder="Name"
                        value={values[role]?.name || ''}
                        onChange={(_e, d) => setName(role, d.value)}
                      />
                      <Input
                        size="small"
                        type="email"
                        placeholder="Email (optional)"
                        value={values[role]?.email || ''}
                        onChange={(_e, d) => setEmail(role, d.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {status && (
            <div className={`flash-message flash-${status.type}`} style={{ marginTop: 12 }}>{status.text}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Button appearance="primary" size="small" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save Account Team'}
            </Button>
            <Button appearance="secondary" size="small" onClick={openCsv} disabled={saving}>
              Edit as CSV
            </Button>
          </div>
          {csvOpen && (
            <div className="eng-detail-backdrop" onClick={() => setCsvOpen(false)}>
              <div className="eng-detail-card" style={{ width: 860, maxWidth: '95vw' }} onClick={(e) => e.stopPropagation()}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Edit Account Team as CSV</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 12 }}>
                  One row per role: <code>Role,Name,Email</code>. The header line is optional. Roles must match
                  the catalog names. Saving replaces the entire account team with these rows.
                </div>
                <Textarea
                  value={csvText}
                  onChange={(_e, d) => setCsvText(d.value)}
                  resize="vertical"
                  style={{ width: '100%' }}
                  textarea={{ wrap: 'off', style: { minHeight: 260, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, whiteSpace: 'nowrap', overflowX: 'auto' } }}
                />
                {csvError && (
                  <div style={{ color: 'var(--pink)', fontSize: 12.5, marginTop: 10, fontWeight: 600 }}>{csvError}</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                  <Button appearance="secondary" size="small" onClick={() => setCsvOpen(false)} disabled={csvSaving}>
                    Cancel
                  </Button>
                  <Button appearance="primary" size="small" onClick={saveCsv} disabled={csvSaving}>
                    {csvSaving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Account Team Availability (WorkIQ getSchedule / findMeetingTimes, feature 4) ──
const AVAIL_COLORS = { 0: 'var(--success-text)', 1: 'var(--warning-text)', 2: 'var(--pink)', 3: 'var(--violet)', 4: 'var(--text-faint)' };
const AVAIL_LABELS = { 0: 'Free', 1: 'Tentative', 2: 'Busy', 3: 'Out of office', 4: 'Working elsewhere' };
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 18;
const SCHEDULE_TZ = 'Eastern Standard Time';

function dayOption(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const label = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow'
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return { iso, label };
}

function AvailabilityStrip({ view }) {
  const cells = String(view || '').slice(0, WORK_END_HOUR - WORK_START_HOUR).split('');
  if (!cells.length) return <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 1 }}>
      {cells.map((c, i) => {
        const hour = WORK_START_HOUR + i;
        const label = `${((hour + 11) % 12) + 1}${hour < 12 ? 'am' : 'pm'} · ${AVAIL_LABELS[c] || 'Unknown'}`;
        return <div key={i} title={label} style={{ width: 16, height: 18, borderRadius: 2, background: AVAIL_COLORS[c] || 'var(--border)' }} />;
      })}
    </div>
  );
}

function AccountTeamAvailability({ team }) {
  const emails = useMemo(
    () => (team || [])
      .map((p) => ({ name: p.person_name, email: String(p.person_email || '').trim() }))
      .filter((p) => p.email)
      .slice(0, 10),
    [team],
  );
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [schedules, setSchedules] = useState(null);
  const [message, setMessage] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [loadedKey, setLoadedKey] = useState('');

  const nameByEmail = useMemo(() => {
    const m = new Map();
    for (const p of emails) m.set(p.email.toLowerCase(), p.name);
    return m;
  }, [emails]);

  const load = useCallback(async () => {
    if (!emails.length) return;
    const day = dayOption(offset);
    setLoading(true);
    setMessage(null);
    setSuggestions(null);
    setLoadedKey(`${offset}`);
    try {
      const res = await orgGetSchedule({
        emails: emails.map((p) => p.email),
        start: `${day.iso}T${String(WORK_START_HOUR).padStart(2, '0')}:00:00`,
        end: `${day.iso}T${String(WORK_END_HOUR).padStart(2, '0')}:00:00`,
        timeZone: SCHEDULE_TZ,
        intervalMinutes: 60,
      });
      if (res?.ok) {
        setSchedules(res.schedules || []);
      } else {
        setMessage({ type: 'warning', text: res?.error || 'Could not load availability. Requires Microsoft sign-in + corpnet/VPN.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Could not load availability.' });
    } finally {
      setLoading(false);
    }
  }, [emails, offset]);

  useEffect(() => {
    if (open && emails.length && !loading && loadedKey !== `${offset}`) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offset, emails.length]);

  const suggest = useCallback(async () => {
    if (!emails.length) return;
    const day = dayOption(offset);
    setSuggesting(true);
    setMessage(null);
    try {
      const res = await orgFindMeetingTimes({
        emails: emails.map((p) => p.email),
        start: `${day.iso}T${String(WORK_START_HOUR).padStart(2, '0')}:00:00`,
        end: `${day.iso}T${String(WORK_END_HOUR).padStart(2, '0')}:00:00`,
        timeZone: SCHEDULE_TZ,
        durationMinutes: 30,
        maxCandidates: 5,
      });
      if (res?.ok) {
        setSuggestions(res.suggestions || []);
        if (!res.suggestions?.length) {
          setMessage({ type: 'info', text: `No common 30-min slot found${res.emptyReason ? ` (${res.emptyReason})` : ''}.` });
        }
      } else {
        setMessage({ type: 'warning', text: res?.error || 'Suggestion failed.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Suggestion failed.' });
    } finally {
      setSuggesting(false);
    }
  }, [emails, offset]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        <CalendarLtrRegular style={{ fontSize: 16 }} /> Team Availability
        {emails.length ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` · ${emails.length}`}</span> : null}
      </div>
      {open && (
        <div className="card-body-custom">
          {!emails.length ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No internal account-team members with email were found for this account.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <Field label="Day" style={{ minWidth: 150 }}>
                  <Select value={String(offset)} onChange={(_e, d) => setOffset(Number(d.value))} size="small" disabled={loading}>
                    {[0, 1, 2, 3, 4].map((o) => <option key={o} value={o}>{dayOption(o).label}</option>)}
                  </Select>
                </Field>
                <Button appearance="secondary" size="small" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>
                <Button appearance="primary" size="small" icon={<SparkleRegular />} onClick={suggest} disabled={suggesting || loading}>
                  {suggesting ? 'Finding…' : 'Suggest 30-min slot'}
                </Button>
                {(loading || suggesting) && <Spinner size="tiny" />}
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-muted)', alignItems: 'center' }}>
                  {[0, 1, 2, 3].map((k) => (
                    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: AVAIL_COLORS[k], display: 'inline-block' }} />{AVAIL_LABELS[k]}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 8 }}>
                {`${WORK_START_HOUR > 12 ? WORK_START_HOUR - 12 : WORK_START_HOUR}${WORK_START_HOUR < 12 ? 'am' : 'pm'}–${WORK_END_HOUR > 12 ? WORK_END_HOUR - 12 : WORK_END_HOUR}pm ET · hourly`}
              </div>

              {message && (
                <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 10 }}>{message.text}</div>
              )}

              {suggestions?.length > 0 && (
                <div className="flash-message flash-info" style={{ marginBottom: 12 }}>
                  <strong>Suggested slots:</strong>{' '}
                  {suggestions.map((s, i) => (
                    <span key={i} style={{ marginRight: 10 }}>
                      {s.start ? new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}
                      {s.availabilityPct != null ? ` (${s.availabilityPct}% free)` : ''}
                      {i < suggestions.length - 1 ? ' ·' : ''}
                    </span>
                  ))}
                </div>
              )}

              {schedules?.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {schedules.map((s) => (
                    <div key={s.email} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 180, minWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }} title={s.email}>
                        {nameByEmail.get(s.email.toLowerCase()) || s.email}
                      </div>
                      {s.error
                        ? <span style={{ color: 'var(--warning-text)', fontSize: 12 }}>unresolved</span>
                        : <AvailabilityStrip view={s.availabilityView} />}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Card whose body collapses behind a clickable header. Collapsed by default to keep
// the (long) customer profile compact; pass defaultOpen to start expanded.
function Collapsible({ title, defaultOpen = false, right = null, children, style }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ marginBottom: 20, ...style }}>
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
          {title}
        </span>
        {right}
      </div>
      {open && <div className="card-body-custom">{children}</div>}
    </div>
  );
}

function CollapsibleItem({ item, onOpen, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--surface-2)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
        <div
          onClick={() => setOpen((o) => !o)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 6, flex: 1, minWidth: 0 }}
        >
          {open ? <ChevronDownRegular style={{ fontSize: 14, marginTop: 2 }} /> : <ChevronRightRegular style={{ fontSize: 14, marginTop: 2 }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.detail}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          {item.htmlPath && onOpen && (
            <Button
              size="small"
              appearance="subtle"
              icon={<OpenRegular />}
              title="Open formatted report in browser"
              onClick={() => onOpen(item.htmlPath)}
            >
              Open
            </Button>
          )}
          {onDelete && (
            <Button
              size="small"
              appearance="subtle"
              icon={<DeleteRegular />}
              title="Delete this generation"
              onClick={() => onDelete(item.id)}
            />
          )}
        </div>
      </div>
      {open && item.body && (
        <pre style={{
          margin: '8px 0 0 20px',
          whiteSpace: 'pre-wrap',
          color: 'var(--text)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 10,
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          {item.body}
        </pre>
      )}
    </div>
  );
}

function WorkspaceList({ title, empty, items, defaultOpen = false, collapsibleItems = false, action = null, onOpenItem = null, onDeleteItem = null }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
          {title}{!open && items.length ? ` (${items.length})` : ''}
        </span>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      {open && (
      <div className="card-body-custom">
        {items.length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{empty}</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((item) => (
              collapsibleItems ? (
                <CollapsibleItem key={item.id} item={item} onOpen={onOpenItem} onDelete={onDeleteItem} />
              ) : (
              <div
                key={item.id}
                onClick={onOpenItem ? () => onOpenItem(item) : undefined}
                style={onOpenItem ? { cursor: 'pointer', borderRadius: 6, padding: '4px 6px', margin: '-4px -6px' } : undefined}
                className={onOpenItem ? 'workspace-list-clickable' : undefined}
                title={onOpenItem ? 'Open details' : undefined}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.detail}</div>
                {item.body && (
                  <pre style={{
                    margin: '8px 0 0',
                    whiteSpace: 'pre-wrap',
                    color: 'var(--text)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 10,
                    fontFamily: 'inherit',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}>
                    {item.body}
                  </pre>
                )}
              </div>
              )
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function SeismicContent({ customer, opportunities = [], milestones = [] }) {
  const [open, setOpen] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false); // set when a search reports no session
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // { total, docs } | null
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState(null);

  // Default search terms: the customer's solution plays + workloads (fallback: name).
  const suggestions = useMemo(() => {
    const set = new Set();
    for (const o of opportunities) { if (o.sales_play) set.add(String(o.sales_play)); }
    for (const m of milestones) { if (m.workload) set.add(String(m.workload)); }
    return [...set].filter(Boolean).slice(0, 8);
  }, [opportunities, milestones]);

  const defaultTerm = suggestions[0] || customer?.name || '';

  const runSearch = async (term, interactive = false) => {
    const q = String(term ?? query).trim();
    if (!q) return;
    setQuery(q);
    setLoading(true);
    setMessage(null);
    try {
      // Silent-first: the persistent Seismic session authenticates without a prompt when
      // it exists (e.g. after an app restart). Only when that reports no session do we
      // surface the Connect button.
      const res = await seismicSearch({ term: q, pageSize: 20, interactive });
      if (res?.ok) {
        setResults({ total: res.total || res.docs.length, docs: res.docs || [] });
        setNeedsAuth(false);
      } else if (res?.authed === false) {
        setNeedsAuth(true);
        setMessage({ type: 'warning', text: 'Connect to Seismic to search DocCenter content.' });
      } else {
        setMessage({ type: 'error', text: res?.error || 'Search failed.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Search failed.' });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setMessage(null);
    try {
      const s = await seismicSignIn();
      if (s?.signedIn) { setNeedsAuth(false); await runSearch(defaultTerm); }
      else setMessage({ type: 'error', text: s?.error || 'Sign-in did not complete.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Sign-in failed.' });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="card">
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        Relevant Content (Seismic){results?.docs?.length ? ` (${results.docs.length})` : ''}
      </div>
      {open && (
        <div className="card-body-custom">
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
            Search Microsoft Seismic DocCenter for enablement content (decks, playcards, FAQs) relevant to this
            customer. Signs in with your Microsoft identity via Seismic.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Button
              appearance={needsAuth ? 'primary' : 'secondary'}
              size="small"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? 'Connecting…' : 'Connect to Seismic'}
            </Button>
            {connecting && <Spinner size="tiny" />}
            {!needsAuth && !connecting && (
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                Optional — searching signs you in automatically.
              </span>
            )}
          </div>

          <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <Input
                  value={query}
                  onChange={(_e, d) => setQuery(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                  placeholder={defaultTerm ? `Search Seismic (e.g. ${defaultTerm})` : 'Search Seismic…'}
                  style={{ flex: 1 }}
                />
                <Button appearance="primary" size="small" onClick={() => runSearch()} disabled={loading}>
                  {loading ? 'Searching…' : 'Search'}
                </Button>
              </div>

              {suggestions.length > 0 && !results && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, alignSelf: 'center' }}>Suggested:</span>
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => runSearch(s)}
                      style={{ background: 'var(--border)', border: '1px solid var(--border-strong)', color: 'var(--text)', borderRadius: 12, padding: '2px 10px', cursor: 'pointer', fontSize: 12 }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </>

          {message && (
            <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 10 }}>
              {message.text}
            </div>
          )}

          {results && (
            results.docs.length === 0 ? (
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No matching content found.</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  Showing {results.docs.length}{results.total > results.docs.length ? ` of ${results.total}` : ''} result{results.docs.length !== 1 ? 's' : ''}
                </div>
                {results.docs.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {[d.format, d.profile, d.updated ? `updated ${String(d.updated).slice(0, 10)}` : null, d.rating ? `★ ${d.rating}` : null].filter(Boolean).join(' · ')}
                      </div>
                      {d.description && (
                        <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 }}>{d.description.slice(0, 160)}{d.description.length > 160 ? '…' : ''}</div>
                      )}
                    </div>
                    {d.url && (
                      <button
                        onClick={() => openExternal(d.url)}
                        title="Open in Seismic"
                        style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12 }}
                      >
                        Open <OpenRegular style={{ fontSize: 12 }} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function KeyContacts({ contacts, onOpenLinkedIn }) {
  const [open, setOpen] = useState(false);
  const withLi = contacts.filter((c) => c.linkedin_url).length;
  return (
    <div className="card">
      <div
        className="card-header-custom"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDownRegular style={{ fontSize: 14 }} /> : <ChevronRightRegular style={{ fontSize: 14 }} />}
        External Contacts from MSX Dynamics{contacts.length ? ` (${contacts.length})` : ''}{withLi ? ` · ${withLi} on LinkedIn` : ''}
      </div>
      {open && (
        <div className="card-body-custom">
          {contacts.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No CRM contacts synced for this account yet. Run “Sync from CRM” in Settings to pull them.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {contacts.map((c) => (
                <div
                  key={c.contact_id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{c.full_name || '(no name)'}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {[c.job_title, c.account_name, c.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  {c.linkedin_url && (
                    <button
                      onClick={() => onOpenLinkedIn(c.linkedin_url)}
                      title="View on LinkedIn"
                      style={{
                        flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: 'none', border: '1px solid var(--accent)', color: 'var(--accent)',
                        borderRadius: 4, padding: '2px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12,
                      }}
                    >
                      LinkedIn <OpenRegular style={{ fontSize: 12 }} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoList({ todos, saving, onComplete, onDelete, onWorkloadChange }) {
  const assignments = useTaskAssignmentOptions(todos.length > 0);
  return (
    <div className="card">
      <div className="card-header-custom">Current Todos{todos.length ? ` (${todos.length})` : ''}</div>
      <div className="card-body-custom">
        {todos.length > 0 && <TaskAssignmentStatus state={assignments} />}
        {todos.length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No customer todos yet.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {todos.map((todo) => (
              <div key={todo.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{todo.title}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {todo.status}{todo.dueAt ? ` · due ${todo.dueAt}` : ''}
                    </div>
                    {todo.description && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>{todo.description}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'start' }}>
                    {todo.status !== 'done' && (
                      <Button size="small" onClick={() => onComplete(todo)} disabled={saving}>Done</Button>
                    )}
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      aria-label={`Delete Task: ${todo.title}`}
                      onClick={() => onDelete(todo)}
                      disabled={saving}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <TaskWorkloadPicker
                    state={assignments} taskTitle={todo.title}
                    workloadId={todo.workloadId} workloadName={todo.workloadName}
                    disabled={saving} onChange={value => onWorkloadChange(todo, value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
