import { useState } from 'react';
import {
  InfoRegular, RocketRegular, PlayCircleRegular, BookRegular,
} from '@fluentui/react-icons';

const PAGES = [
  { key: 'overview', icon: InfoRegular, label: 'Overview' },
  { key: 'setup', icon: RocketRegular, label: 'First-time setup' },
  { key: 'operations', icon: PlayCircleRegular, label: 'Using SE Assist' },
];

const C = {
  head: 'var(--text)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  border: 'var(--canvas)',
  accent: 'var(--accent)',
  soft: 'var(--accent-tint)',
};

export default function Documentation() {
  const [page, setPage] = useState('overview');

  return (
    <div className="page-header-wrap" style={{ maxWidth: 940 }}>
      <div className="page-header">
        <div className="page-header-left">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookRegular style={{ fontSize: 22 }} /> Documentation
          </h2>
        </div>
      </div>
      <p style={{ margin: '0 0 16px', color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
        Current guidance for understanding, configuring, and operating SE Assist.
      </p>

      <div
        role="tablist"
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20,
          borderBottom: `1px solid ${C.border}`, paddingBottom: 12,
        }}
      >
        {PAGES.map((p) => {
          const active = page === p.key;
          return (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPage(p.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                color: active ? 'var(--card)' : C.body,
                background: active ? C.accent : 'var(--card)',
                border: `1px solid ${active ? C.accent : C.border}`,
              }}
            >
              <p.icon style={{ fontSize: 16 }} /> {p.label}
            </button>
          );
        })}
      </div>

      {page === 'overview' && <OverviewPage />}
      {page === 'setup' && <SetupPage />}
      {page === 'operations' && <OperationsPage />}
    </div>
  );
}

function DocCard({ title, children }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header-custom" style={{ fontSize: 15 }}>{title}</div>
      <div className="card-body-custom">{children}</div>
    </div>
  );
}

function P({ children }) {
  return (
    <p style={{ margin: '0 0 12px', color: C.body, fontSize: 13, lineHeight: 1.7 }}>
      {children}
    </p>
  );
}

function Feature({ name, where, what, value }) {
  return (
    <div
      style={{
        padding: '12px 14px', marginBottom: 10, borderRadius: 8,
        background: C.soft, border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: C.head }}>{name}</div>
        {where && (
          <span
            style={{
              fontSize: 11, fontWeight: 600, color: C.accent,
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
              borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap',
            }}
          >
            {where}
          </span>
        )}
      </div>
      <div style={{ marginTop: 6, color: C.body, fontSize: 12.5, lineHeight: 1.65 }}>{what}</div>
      {value && (
        <div style={{ marginTop: 6, color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
          <strong style={{ color: C.body }}>Why it matters:</strong> {value}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
      <div
        style={{
          flex: '0 0 auto', width: 26, height: 26, borderRadius: '50%',
          background: C.accent, color: 'var(--card)', fontWeight: 700, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {n}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: C.head, marginBottom: 4 }}>{title}</div>
        <div style={{ color: C.body, fontSize: 12.5, lineHeight: 1.7 }}>{children}</div>
      </div>
    </div>
  );
}

function Note({ children, tone = 'info' }) {
  const tones = {
    info: { bg: 'color-mix(in srgb, var(--accent) 6%, transparent)', bd: 'color-mix(in srgb, var(--accent) 20%, transparent)', fg: 'var(--text-secondary)' },
    warning: { bg: 'color-mix(in srgb, var(--warning-text) 7%, transparent)', bd: 'color-mix(in srgb, var(--warning-text) 20%, transparent)', fg: 'var(--warning-text)' },
  };
  const t = tones[tone] || tones.info;
  return (
    <div
      style={{
        padding: '10px 12px', margin: '0 0 14px', borderRadius: 8,
        background: t.bg, border: `1px solid ${t.bd}`, color: t.fg,
        fontSize: 12.5, lineHeight: 1.65,
      }}
    >
      {children}
    </div>
  );
}

function OverviewPage() {
  return (
    <>
      <DocCard title="What SE Assist is">
        <P>
          SE Assist is a local-first Electron desktop application for Microsoft Solution
          Engineers. It combines MSX/Dynamics customer and milestone data, Azure Consumed Revenue,
          Microsoft 365 signal from WorkIQ, internal organization data, customer research, and AI
          assistance in one workspace.
        </P>
        <P>
          Persistent application data is stored in a SQLite database on this machine. SE Assist
          still calls the connected Microsoft, GitHub Copilot, Power BI, and Seismic services when
          you sign in, sync data, search content, or run an AI feature.
        </P>
      </DocCard>

      <DocCard title="Navigation and defaults">
        <P>
          The sidebar is grouped into <strong>Workspaces</strong>, <strong>Explore Data</strong>,
          and <strong>Reference</strong>. The app opens on the <strong>Action Center</strong>.
          Open <strong>User Home → Customize navigation</strong> to show or hide pages. The
          customizer is collapsed when User Home opens, and the User Home page itself is always
          available.
        </P>
        <P>
          Sub-pages appear indented under their parent tab: <strong>Deep Research</strong> under
          Action Center, <strong>Model Quotas</strong> and <strong>Foundry Deep-Dives</strong>{' '}
          under Azure Consumption, and <strong>Milestone Map</strong> and{' '}
          <strong>Milestone Timeline</strong> under Milestones.
          All groups start collapsed each time the app launches; click the small arrow on the
          parent tab to show or hide its sub-pages until the next launch. The arrow appears only
          when at least one sub-page is shown. If a sub-page is open while its group is collapsed,
          the parent tab is highlighted instead.
        </P>
        <P>
          <strong>Guided Setup</strong> and <strong>Guided Tour</strong> sit at the bottom of the
          sidebar. Click <strong>&lt;&lt;</strong> to the left of Guided Tour to shrink the sidebar
          to icons; hover an icon to see its name, and click <strong>&gt;&gt;</strong> to restore
          full width. The sidebar remembers this choice. Icon mode has no group arrows, so
          sub-pages stay shown or hidden as their group was. When the window is narrower than
          1,000 px, the sidebar shows icons only; expanding it there lasts until the window is
          widened again. The menu bar is hidden; press Alt to show it.
        </P>
        <Note>
          For a user with no saved navigation preference, <strong>Action Center</strong>,{' '}
          <strong>Deep Research</strong>, <strong>Milestone Map</strong>,{' '}
          <strong>Milestone Timeline</strong>, <strong>Microsoft Products</strong>, and{' '}
          <strong>Solutions</strong> start hidden.
          Expand Customize navigation and switch them on when you want them in the sidebar.
          Existing saved choices are preserved.
        </Note>
      </DocCard>

      <DocCard title="Workspaces">
        <Feature
          name="Action Center"
          where="Workspaces → Action Center"
          what="The daily home and default landing page: today's meetings as a compact one-day calendar with prev/next day navigation; at-a-glance Overdue-comment and Blocked-milestone cards; a due/overdue milestone list (active, uncommitted, on your deal teams); an Outlook-style Active-workloads reader (pick a workload, see its account, SSP, description, and milestones grouped by opportunity with linked email/meeting/chat counts); accounts to re-engage; and the embedded Workloads workspace and Agenda calendar."
          value="One prioritized place for what needs doing, with the Workloads and Agenda sections collapsed until you need them."
        />
        <Feature
          name="Deep Research"
          where="Workspaces → Action Center → Deep Research"
          what="Find an email SE Assist has already pulled. The list shows the 20 newest eligible stored emails, and See more at the bottom adds the next 20 older ones. Choose an active customer account on the left to list only email linked to it (each account shows how many emails are linked to it), or All customer accounts for active-account and unassigned/internal email. Keyword search on the right searches that eligible email, or only the chosen account's; every word must match the subject, sender, recipients, customer account, or words in the email. Each email shows its active customer account tags, or No customer account. Archived-only email and saved research subjects are hidden without deleting them; re-add their TPID in User Home to restore access. The list never reads your mailbox live, shows the last eligible pull time, and says so if stored email changes while you page through it. Open a result in an email details panel and choose Deep Research. The email becomes a saved research subject and its current situation, action checklist, and reply draft start automatically; a technical recommendation runs when you ask a technical question. Gaps — research and status lists each open question the outputs raised, with its status. The questions are classified automatically as work data, public documentation, ask a person, or a research limitation. Research this gap, or Research open gaps (up to 5, stopping at the first failure), searches Microsoft 365 or public documentation for work-data and public-docs questions only when you choose. An answer is kept only when its supporting quote appears word for word in what was found, and the outputs that list the question are marked Needs refresh so you can refresh them to use it. Rows keep their order while a gap is researched, and the result appears under the question. If the technical recommendation has no question yet, one may be suggested from the open gaps; review it, because it runs only when you choose. Every former Secretary Solve action is here: per-area retry, refresh, stop, refine, and copy; a reply-all draft in Outlook; and Task and workload creation. Errors give a plain title, what to do next, and the time of the last attempt; the original message is under Technical details. When areas fail, a banner names them, offers Open Microsoft 365 sign-in or Open GitHub sign-in when a sign-in caused the failure, and offers Retry failed areas, which stops at the first area that fails again. Deep Research reads the source email again live through WorkIQ and runs only on GitHub Copilot with your selected model. Protected (Microsoft Purview) email cannot be researched. One area or gap job runs at a time; controls that must wait say what they are waiting for, and Copy and source links stay available. Leaving the page stops the job; saved work is kept. Subjects stay saved until you remove them, and removing one keeps the Tasks and workloads created from it."
          value="Turn any pulled email into saved, source-backed next steps without leaving SE Assist."
        />
        <Feature
          name="Excellence Metrics"
          where="Workspaces → Excellence Metrics"
          what="Shows customer, opportunity, milestone, and HoK counts; the FY2027 engagement scorecard; overdue-comment buckets; milestone status totals; Azure Consumption entry; and an account table with drill-down links."
          value="Start with the current delivery and engagement picture."
        />
        <Feature
          name="Azure Consumption"
          where="Workspaces → Azure Consumption"
          what="Analyzes portfolio and per-account Azure Consumed Revenue with persistent fiscal-year and product filters; KPIs; customer and product trends; strategic breakdowns; a detailed service hierarchy with its own service-level selector; and local metric snapshots. Its Model Quotas sub-page shows AI model quota allocation (TPM or PTU) across your customers, and for each customer by subscription, model, quota type, and region."
        />
        <Feature
          name="Foundry Deep-Dives"
          where="Workspaces → Azure Consumption → Foundry Deep-Dives"
          what="Queries the live Foundry leadership semantic model for the TPIDs saved in your sales-account roster. Choose a customer, then filter its rolling 90 days of token usage by subscription, region, week, provider, model, offering, or engagement level. The page shows KPIs, offering mix, weekly offering/model/region trends, engagement history, and a weekly customer/subscription/model matrix."
          value="Inspect 3P model adoption and movement without leaving the customer scope configured in SE Assist."
        />
      </DocCard>

      <DocCard title="Explore Data and Reference">
        <Feature
          name="Customers"
          where="Explore Data → Customers"
          what="One card per account, grouped by the account's SSP, showing recent emails, meetings, and Teams chats, plus a 'Last contact' line that turns red once an account has been quiet for more than 14 days. Open an account for a fast glance — pipeline, team, workloads, contacts, and recent activity — or jump to its full profile. Each account's SSP is configured in User Home → SSP Configuration. Message in Teams addresses the selected SSP, ATS, or AE and prefills 'Hi {first name}, can we talk about {account}?'; review and send it in Teams."
        />
        <Feature
          name="Milestones"
          where="Explore Data → Milestones"
          what="The filterable MSX milestone table grouped by parent account, with status/commitment controls, account expansion, CRM links, and the shared milestone detail panel. Links at the top open the Milestone Map (a pannable/zoomable account → opportunity → milestone map) and Milestone Timeline (a monthly/fiscal-year Gantt with comment and HoK markers) — both hidden from the sidebar by default."
        />
        <Feature
          name="HoK Activities"
          where="Explore Data → HoK Activities"
          what="Lists MSX HoK tasks by account, supports open/completed filtering and customer scoping, links to CRM, and opens related opportunity or milestone details."
        />
        <Feature
          name="My Org"
          where="Explore Data → My Org"
          what="Maps the Microsoft organization for your hierarchy, a selected individual, a customer account, or an AI-assisted product need. Results support map/list layouts and person details such as groups and upcoming meetings."
        />
        <Feature
          name="Stakeholder Influence Map"
          where="Explore Data → Influence Map"
          what="Estimates who shapes a roster account's decisions from data already on this device: linked email (who sends, who is copied, who loops people in or adds them mid-thread), meeting invitations and attendance, and who others respond to in saved transcripts. Fixed rules score only people outside Microsoft from 0 to 100, ignore emails and meetings with more than 20 recipients, cancelled meetings, and duplicate email copies, and show the emails, meetings, and transcripts behind every score. Clicking a person also lists the Microsoft people who were on the same emails or meetings, counted once per thread or meeting. It highlights champions, blockers, and hidden influencers who are pulled in often but say little. Optional Analyze with AI judges stance and adopted suggestions for the top 25 people on GitHub Copilot, marks each quote as verified or not found in the source, and saves nothing if the response is cut off or invalid. You can correct a person's stance, keep a private note, or exclude them."
          value="Find the champions and blockers who influence a decision but rarely appear on the email thread."
        />
        <Note>
          Stakeholder Influence Map scores are inferred signals, not facts about people. They miss
          hallway conversations, calls without transcripts, and anything not linked to the account, so
          check the evidence before acting on it. Analyze with AI sends the top people&apos;s names,
          scores, and signals, plus excerpts of the related emails and transcripts with email addresses
          removed, to GitHub Copilot.
        </Note>
        <Feature
          name="User Home"
          where="Reference → User Home"
          what="Manages the sidebar, sales-account roster, Microsoft and GitHub connections, MSX sync, WorkIQ ingestion, data backups, CRM settings, the guided setup, application information, and local-data deletion."
        />
        <Feature
          name="Workload Management"
          where="Embedded in the Action Center → Workloads"
          what="Organizes customer and internal delivery as manually ordered cards with All, Customer, and SSP filters. Workloads hold opportunities, milestones, stages, actions, assets, Tasks, and grounded communication assignments. 'Suggest workloads' proposes account-resolved drafts from the previous week's activity; open a draft to select opportunities and their milestones, approve it into a normal workload, or permanently dismiss that account/concept. Existing workloads can be saved and reused as templates."
          value="Scale repeatable delivery patterns and keep each effort tied to its customer and MSX outcomes."
        />
        <Feature
          name="Microsoft Products"
          where="Reference → Microsoft Products"
          what="A searchable product catalog grouped by category and filterable by capability labels, with Microsoft Learn links. Hidden from the sidebar by default; turn it on in User Home → Customize navigation."
        />
        <Feature
          name="Solutions"
          where="Reference → Solutions"
          what="Featured solution accelerators and references (Azure SRE Agent, Foundry solution templates, Azure Verified Modules, the Azure AI Landing Zone, and the MCAPS accelerator catalog). Hidden from the sidebar by default; turn it on in User Home → Customize navigation."
        />
        <Feature
          name="Documentation"
          where="Reference → Documentation"
          what="This current overview, first-time setup guide, and operating guide."
        />
      </DocCard>

      <DocCard title="Customer workspace">
        <P>
          Selecting a customer opens its account workspace. Top-parent profiles include account
          details, MSX metrics, editable Microsoft account-team roles, team availability,
          local Tasks, WorkIQ Teams/email/meeting signal, internal and external contacts,
          child accounts, account documents, Seismic content, the research dossier, Azure
          Consumption, and saved AI outputs.
        </P>
        <P>
          The research dossier is optional. Windows installers do not include a customer research
          vault; set SE_ASSIST_VAULT_DIR before launching to use your own vault containing Accounts.
          Without one, dossier actions report that the capability is unavailable.
        </P>
        <P>
          Child-account pages focus on their own account details and explain which intelligence
          rolls up to the top-parent workspace.
        </P>
      </DocCard>

      <DocCard title="Milestone detail panel">
        <P>
          The Milestones table, Milestone Map, Milestone Timeline, and HoK Activities reuse one
          detail panel for opportunity and milestone records. For a milestone you can inspect its
          fields, join or leave the milestone team, read and add comments, draft a comment with AI,
          find and manage related emails/meetings/chats, review HoK activities, create a completed
          HoK activity, and open the record in CRM.
        </P>
        <P>
          For a milestone, Message owner keeps the owner as the recipient and
          copies a formatted message greeting them by first name. The milestone name is a
          clickable hyperlink to its MSX record. Press Ctrl+V in Teams to paste the message,
          then review and send it yourself. The paste step preserves the hyperlink formatting.
          Missing names or MSX links, clipboard failures, and Teams-opening failures are reported
          explicitly. Opportunity-owner chats still use Message owner with no prefilled message.
          Nothing is sent automatically.
        </P>
      </DocCard>

      <DocCard title="AI features and floating helpers">
        <P>
          AI features use the selected GitHub Copilot model when Copilot is connected. That
          connection is an explicit provider choice: if it fails, SE Assist shows the Copilot
          error and does not silently switch to Foundry. A configured Azure AI Foundry deployment
          is eligible only when GitHub Copilot is not connected. Features that require AI show a
          clear configuration error when no provider is available.
        </P>
        <P>
          Model work shares one visible request queue with foreground/background priority,
          cancellation, pacing, and provider cooldowns. The default reasoning effort is high.
          An optional Utility Model can handle bounded extraction and classification while the
          primary model remains responsible for synthesis.
        </P>
        <P>
          Action Center Secretary, hidden for now, is the exception to model selection. Its search-scope and
          todo-scan calls always run on GitHub Copilot model gpt-5.6-luna with high reasoning,
          whichever models you select. Secretary requires GitHub Copilot and shows a clear error
          instead of using Foundry, switching models, or lowering reasoning. Deep Research also
          requires GitHub Copilot and never uses Foundry; it runs on your selected model. User
          Home → About SE Assist marks pinned agents with their model.
        </P>
        <P>
          The Stakeholder Influence Map's Analyze with AI also requires GitHub Copilot and never
          uses Foundry. It runs on your selected primary model. Its signal scores need no AI.
        </P>
        <Feature
          name="Customer AI outputs"
          where="Customer workspace → AI Features"
          what="Generates and saves Sales Play Advisor reports, comprehensive customer summaries, customer tech stacks, Azure Consumption macro-trend analyses, and research-based customer analyses as openable HTML artifacts."
        />
        <Feature
          name="Meeting preparation"
          where="Action Center / Agenda"
          what="Builds an inline preparation brief for a selected meeting from the linked account context."
        />
        <Feature
          name="Milestone related signal and comment suggestion"
          where="Milestone detail"
          what="Finds specific WorkIQ emails, meetings, and Teams chats related to a milestone, saves editable links, summarizes momentum, and can draft a progress comment from activity since the last comment."
        />
        <Feature
          name="Secretary, Deep Research, and Work Agent"
          where="Action Center, Action Center → Deep Research, and generated task investigations"
          what="Secretary is hidden from Action Center for now. When shown, it finds todos in the customer email SE Assist has already pulled, on GitHub Copilot gpt-5.6-luna with high reasoning. It never reads your mailbox live, so results are only as current as the last Pull new items or auto-ingest run. Its coverage line shows when email was last pulled, pull problems that limit coverage, emails it could not read, and the model that ran. Deep Research searches the same pulled email, then reads the chosen source email again live and saves independent situation, action, reply, and technical areas (Work Outputs) with their own sources, gaps, errors, retry, refresh, and cancellation state, and tracks each open gap's classification, research status, and verified answer. Work Agent investigates one action with live Microsoft 365 and public-web tools."
        />
        <Feature
          name="Meeting transcript and Tasks"
          where="Agenda meeting detail"
          what="Fetches a Teams transcript through WorkIQ, saves notes and a grounded recap, extracts structured actions, and creates idempotent local Tasks that can be assigned to a customer and optionally to a workload."
        />
        <Feature
          name="SE Assist Copilot"
          where="Bottom-right on every page"
          what="Answers prioritization questions about pressing milestones and customer signal using the current user's local data."
        />
        <Feature
          name="Quick task"
          where="Bottom-right on every page"
          what="Adds a local Task with an action, customer, optional workload, and optional due date without calling an AI model."
        />
      </DocCard>
    </>
  );
}

function SetupPage() {
  return (
    <>
      <DocCard title="Before you start">
        <P>
          First-time setup happens in <strong>Workspaces → User Home</strong>. The connection and
          sync sections use separate identities for separate systems:
        </P>
        <Feature
          name="Microsoft 365 sign-in"
          what="Connects MSX/Dynamics and supplies the Power BI token used for Azure Consumption, Model Quotas, and Foundry Deep-Dives. Power BI pages also require corpnet/VPN and access to their semantic models."
        />
        <Feature
          name="GitHub sign-in"
          what="Connects GitHub Copilot and lets you select a model for AI features."
        />
        <Feature
          name="Microsoft 365 Copilot sign-in"
          what="Connects WorkIQ for Outlook email, calendar meetings, Teams chats, Microsoft 365 search, organization data, and availability."
        />
      </DocCard>

      <DocCard title="First-time setup">
        <Step n="1" title="Sign in to Microsoft 365">
          In <strong>Microsoft 365 sign-in</strong>, select <strong>Sign in with Microsoft</strong>.
          Complete the browser prompt. This establishes the identity used for MSX sync and the
          milestone scope toggle.
        </Step>
        <Step n="2" title="Detect and save your sales accounts">
          In <strong>My Sales Accounts by TPID</strong>, select{' '}
          <strong>Detect my accounts (MSX)</strong>. Detection checks milestone teams, account
          teams, and deal teams, and may include accounts from past roles. Review the complete
          draft on the left, leave only the accounts you currently work on, and select{' '}
          <strong>Save active roster</strong>. You can also paste the complete TPID list manually.
          Saving replaces the list exactly; it does not add to the previous roster.
          Removed accounts are archived, not deleted: their history, workloads, Tasks, notes,
          transcripts, links, dismissals, and Work Outputs remain stored locally. Re-add the
          same TPID to restore that history and resume account pulls. An empty list pauses
          account-specific work; internal/unassigned work stays available.
        </Step>
        <Step n="3" title="Sync MSX Dynamics">
          In <strong>MSX Dynamics Sync</strong>, select <strong>Sync from CRM</strong>. The sync
          loads customers, opportunities, milestones, HoK activities, and contacts into the local
          cache in dependency order for saved active accounts only. Archived accounts do not
          receive new sync work. Roster changes wait for running account work to finish.
        </Step>
        <Step n="4" title="Connect GitHub Copilot">
          In <strong>GitHub sign-in</strong>, select <strong>Connect GitHub Copilot</strong>,
          complete the device flow, then choose the primary model used by summaries, reports,
          milestone helpers, meeting preparation, and the assistant. Optionally choose a Utility
          Model for bounded extraction and classification; otherwise those tasks use the primary
          model.
        </Step>
        <Step n="5" title="Connect WorkIQ">
          In <strong>Microsoft 365 Copilot sign-in</strong>, select{' '}
          <strong>Connect WorkIQ</strong> and complete the Microsoft prompt. This connection
          requires a Microsoft 365 Copilot license and is separate from the MSX sign-in. After the
          prompt, SE Assist checks the connection with a real mailbox read and shows the error
          WorkIQ reports if that read fails.
        </Step>
        <Step n="6" title="Seed Outlook and Teams data">
          In <strong>WorkIQ Outlook and Teams Sync</strong>, select{' '}
          <strong>Backfill (historical)</strong>. It pulls a six-month historical window for the
          saved account roster. If the page says another pass can resolve more aliases or uncertain
          links, use <strong>Pull new items</strong> until that notice clears.
        </Step>
        <Step n="7" title="Configure SSPs, navigation, and automation">
          On <strong>User Home → SSP Configuration</strong>, set each account's SSP by entering their email (the
          name auto-fills from the directory). Expand <strong>Customize navigation</strong> to show
          optional pages such as Milestone Map and Milestone Timeline. Enable
          MSX auto-sync and WorkIQ auto-ingest if you want background refreshes while the app is open.
        </Step>
        <Step n="8" title="Protect local work">
          Open <strong>Data &amp; backups</strong>. Confirm automatic launch backups are enabled,
          create a manual snapshot, and export a copy to OneDrive or another protected location.
          Workloads, Tasks, meeting notes, transcripts, manual links, and saved Deep Research
          outputs do not have an upstream system that can recreate them.
        </Step>
      </DocCard>

      <DocCard title="When a connection is unavailable">
        <Note tone="warning">
          SE Assist does not present a failed connection as a successful one. MSX, WorkIQ, ACR,
          Seismic, and AI features show the underlying unavailable or error state. WorkIQ
          ingestion can still store deterministically matched items without GitHub Copilot, but
          the page marks the run as degraded because AI alias and uncertain-link enrichment did
          not run.
        </Note>
      </DocCard>
    </>
  );
}

function OperationsPage() {
  return (
    <>
      <DocCard title="Keep MSX data current">
        <Feature
          name="Full CRM sync"
          where="User Home → MSX Dynamics Sync"
          what="Sync from CRM refreshes customers, opportunities, milestones, HoK activities, and contacts. Use it after changing the account roster or when the full local CRM cache needs to be refreshed."
        />
        <Feature
          name="MSX auto-sync"
          where="User Home → MSX Dynamics Sync"
          what="Refreshes milestones and HoK activities every 30 minutes, 1 hour, 3 hours, 6 hours, or 12 hours while the app is open. Customers and contacts remain part of the full manual sync."
        />
      </DocCard>

      <DocCard title="Keep WorkIQ data current">
        <Feature
          name="Backfill (historical)"
          where="User Home → WorkIQ Outlook and Teams Sync"
          what="Pulls a six-month past window, six months of future meetings, up to 100 emails per account, and messages from up to 120 chats. Use it to seed history for the current account roster."
        />
        <Feature
          name="Pull new items"
          where="User Home → WorkIQ Outlook and Teams Sync"
          what="Runs an idempotent incremental pull with a one-month past window, three months of future meetings, up to 40 emails per account, and messages from up to 40 chats."
        />
        <Feature
          name="Auto-ingest"
          where="User Home → WorkIQ Outlook and Teams Sync"
          what="Runs the incremental pull on a 30-minute to 12-hour interval while the app is open and reports the last automatic result."
        />
        <Note>
          Both ingestion modes use ID-keyed upserts, so repeating a run does not duplicate or
          delete items. Only items linked to the saved account roster are retained as customer
          signal. Deep Research search, and Action Center Secretary when shown, read only this
          pulled email, not your live mailbox, so keep auto-ingest on or use Pull new items
          before searching.
        </Note>
      </DocCard>

      <DocCard title="Scope milestone-driven pages">
        <P>
          The top-right territory control on the milestone views cycles through three states:{' '}
          <strong>Showing All Milestones</strong> → <strong>Showing My Milestones</strong> →{' '}
          <strong>Discover Mode - My SSPs</strong>. Discover Mode surfaces active milestones owned
          by one of your configured SSPs that you are <em>not</em> already on the deal team of — a
          fast way to find work you should be joining. The control is shared by the Milestones
          table, Milestone Map, and Milestone Timeline; Excellence Metrics and HoK Activities are
          fixed to your own milestones. Sync from CRM once so the app can resolve your identity and
          enable the control, and set your accounts' SSPs in User Home → SSP Configuration so
          Discover Mode has owners to match.
        </P>
      </DocCard>

      <DocCard title="Work with customers and delivery">
        <P>
          Use <strong>Excellence Metrics</strong> for engagement KPIs and overdue comments,{' '}
          the <strong>Action Center</strong> for today's meetings and the embedded calendar,{' '}
          <strong>Customers</strong> for account workspaces, and the milestone pages for
          table, map, and timeline views of delivery. HoK Activities is the task-oriented view of
          MSX work.
        </P>
        <P>
          Use <strong>Workloads</strong> (in the Action Center) for a personal, local record of
          customer or internal deliverables. Link existing MSX milestones to preserve the
          connection to formal delivery records, run Milestone AI across a workload's milestones,
          and use local Tasks for steps that do not belong in MSX. Suggest workloads uses the
          previous seven days of account-linked email, meetings, and Teams chats. Approving a
          suggestion creates a normal workload; dismissing it permanently suppresses that concept
          for the same account.
        </P>
      </DocCard>

      <DocCard title="Run and monitor AI work">
        <P>
          The model-activity banner reports running, queued, and provider-cooldown work across the
          application. Foreground requests take priority over background enrichment, but work that
          is already running is not preempted. Cancel a feature from its own UI when cancellation
          is available.
        </P>
        <Note tone="warning">
          SE Assist never changes AI providers or models after an error. If a connected Copilot
          session fails, reconnect it or deliberately disconnect it before using a separately
          configured Foundry deployment. A long rate-limit cooldown shows the retry time instead
          of waiting indefinitely.
        </Note>
      </DocCard>

      <DocCard title="Azure Consumption workflow">
        <P>
          Choose one or more fiscal years and optional Service Level 2 products. These filters
          persist across portfolio and per-account pages. Top services and the Top service KPI
          always use Service Level 2. Use the KPI and customer charts for portfolio movement,
          product sections for category trends, and Service hierarchy for detailed rows and product
          comparison. The Service hierarchy matrix has its own Service level selector, which sets
          its depth and is remembered across pages. <strong>Refresh</strong> bypasses the in-memory and persistent query
          caches; <strong>Snapshot</strong> writes FY26/FY27 account metrics to the local
          analytics tables.
        </P>
        <P>
          Open <strong>Apps</strong> on a portfolio or account page to load{' '}
          <strong>Anthropic consumption (XCR)</strong>, directly below Foundry Models.
          It uses the ACR dataset's native <code>XCR - Anthropic</code> consumption, not a
          token-based estimate. It follows selected accounts and fiscal years, shows completed
          months and USD totals to the cent, and offers customer drill-down. Product filters do
          not apply to this card. Ordinary Azure ACR totals, charts and snapshots are unchanged.
          A per-Claude-model spend breakdown is not available. The card has its own freshness
          label and refresh; the page's <strong>Refresh</strong> also refreshes it while Apps is open.
        </P>
      </DocCard>

      <DocCard title="Foundry Deep-Dives workflow">
        <P>
          Open <strong>Azure Consumption → Foundry Deep-Dives</strong> and choose a customer from
          the configured TPID roster. The page covers the rolling 90 days ending today. Use the
          customer-wide filters to narrow every KPI, chart, and matrix row by subscription,
          region, week, provider, model and version, offering, or engagement level.
        </P>
        <P>
          The first load queries Power BI unless the same signed-in identity has a result in the
          15-minute memory cache. <strong>Refresh</strong> bypasses that cache. The footer reports
          <strong>Queried</strong> and <strong>Semantic model refreshed</strong> separately; a
          freshness lookup failure is shown instead of presenting the query time as source
          freshness. Foundry usage data is not saved to the local database.
        </P>
      </DocCard>

      <DocCard title="Local storage, connected services, and deletion">
        <P>
          The durable application cache is stored at{' '}
          <code>%APPDATA%\se-assist\seassist.db</code>. Microsoft and GitHub tokens are handled by
          the Electron main process and protected with the operating-system keystore. Seismic
          authentication stays in its persistent Electron browser session.
        </P>
        <P>
          Syncs, searches, and AI requests send the necessary request data to the service you
          explicitly connected; SE Assist does not operate a separate cloud backend for storing or
          synchronizing your local database.
        </P>
        <P>
          SE Assist takes pre-migration snapshots and, when enabled, a launch-time snapshot when
          the newest backup is at least 20 hours old. <strong>User Home → Data &amp; backups</strong>
          can create, export, validate, and restore snapshots; a successful restore relaunches the
          application against the restored database. Use <strong>Danger Zone</strong> only when
          intentionally deleting local application data.
        </P>
      </DocCard>
    </>
  );
}
