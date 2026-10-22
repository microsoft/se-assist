import { Routes, Route, NavLink, Navigate, useLocation, useParams, Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import Dashboard from './components/Dashboard';
import WorkloadManagement from './components/WorkloadManagement';
import CustomerDetail from './components/CustomerDetail';
import Milestones from './components/Milestones';
import MilestoneTimeline from './components/MilestoneTimeline';
import HokActivities from './components/HokActivities';
import Consumption from './components/Consumption';
import ConsumptionAccount from './components/ConsumptionAccount';
import PowerBIReports from './components/PowerBIReports';
import FoundryDeepDives from './components/FoundryDeepDives';
import Accelerators from './components/Accelerators';
import Settings from './components/Settings';
import Documentation from './components/Documentation';
import MyOrg from './components/MyOrg';
import StakeholderInfluence from './components/StakeholderInfluence';
import Agenda from './components/Agenda';
import CustomerActivity from './components/CustomerActivity';
import ActionCenter from './components/ActionCenter';
import DeepResearch from './components/DeepResearch';
import Products from './components/Products';
import AssistantBubble from './components/AssistantBubble';
import ErrorBoundary from './components/ErrorBoundary';
import TaskBubble from './components/TaskBubble';
import SetupTutorial from './components/SetupTutorial';
import GuidedTour from './components/GuidedTour';
import ModelActivityBanner from './components/ModelActivityBanner';
import { runMsxAutoSyncIfDue } from './lib/msxAutoSync';
import { NAV, GUIDED_TOUR_NAV_KEY } from './lib/navConfig';
import { getHiddenNav, NAV_PREFS_EVENT, SIDEBAR_MINIMIZED_KEY } from './lib/navPrefs';
import { usePersistedState } from './hooks/usePersistedState';
import { shouldAutoShowSetup, markSetupSeen, OPEN_SETUP_EVENT } from './lib/onboarding';
import { runSetupChecks } from './lib/setupSteps';
import { inElectron, onAccountRosterChanged, ACCOUNT_ROSTER_CHANGED_EVENT } from './electronBridge';
import {
  SparkleRegular, CheckmarkCircleRegular, CompassNorthwestRegular, ChevronRightRegular,
  ChevronDoubleLeftRegular, ChevronDoubleRightRegular,
} from '@fluentui/react-icons';
import { useRosterTpids } from './hooks/useRosterTpids';
import { useDbQuery } from './hooks/useDb';

function ActiveAccountBoundary({ children }) {
  const { tpid, id } = useParams();
  const location = useLocation();
  const focusTpid = new URLSearchParams(location.search).get('tpid');
  const { rosterTpids, loading, error } = useRosterTpids();
  const { data: customers, loading: customerLoading, error: customerError } = useDbQuery(
    'SELECT tpid FROM active_customers WHERE id = ?', [id || null],
  );
  if (loading || (id && customerLoading)) return <div role="status">Loading active account…</div>;
  if (error || customerError) return <div role="alert">{error || customerError}</div>;
  if (!id && !tpid && !focusTpid) return children;
  const accountTpid = tpid || focusTpid || customers[0]?.tpid;
  if (!accountTpid || !rosterTpids.includes(String(accountTpid))) {
    return <div role="alert">This account is archived or unavailable. Re-add its TPID in <Link to="/settings?section=accounts">User Home</Link> to restore its history and resume work.</div>;
  }
  return children;
}

// Build the sidebar list from NAV minus any tabs the user has hidden, dropping a
// section header when all of its tabs are hidden so no empty group remains.
function filterNav(nav, hidden) {
  const hiddenSet = new Set(hidden);
  const out = [];
  for (let i = 0; i < nav.length; i++) {
    const item = nav[i];
    if (item.section) {
      let hasVisible = false;
      for (let j = i + 1; j < nav.length && !nav[j].section; j++) {
        if (!hiddenSet.has(nav[j].path)) { hasVisible = true; break; }
      }
      if (hasVisible) out.push(item);
    } else if (!hiddenSet.has(item.path)) {
      out.push(item);
    }
  }
  return out;
}

// Visible sub-pages grouped under their parent tab's path. Only a visible parent
// with at least one visible sub-page becomes a group with an arrow. A sub-page
// whose parent is hidden stays listed on its own so it remains reachable.
function groupSubPages(visibleNav) {
  const visiblePaths = new Set(visibleNav.map((n) => n.path).filter(Boolean));
  const groups = new Map();
  for (const item of visibleNav) {
    if (!item.parent || !visiblePaths.has(item.parent)) continue;
    if (!groups.has(item.parent)) groups.set(item.parent, []);
    groups.get(item.parent).push(item);
  }
  return groups;
}

// Same rule NavLink uses to mark a tab active: the path itself or a route under it.
function isOnPath(pathname, path) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

const subPageList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// Every tab that has sub-pages. All of them start collapsed each time the app launches.
const GROUP_PARENTS = [...new Set(NAV.filter((n) => n.parent).map((n) => n.parent))];
const NARROW_WINDOW = '(max-width: 999px)';

export default function App() {
  const [hiddenNav, setHiddenNav] = useState(getHiddenNav);
  const location = useLocation();
  const [rosterRevision, setRosterRevision] = useState(0);
  useEffect(() => onAccountRosterChanged((roster) => {
    window.dispatchEvent(new CustomEvent(ACCOUNT_ROSTER_CHANGED_EVENT, { detail: roster }));
    setRosterRevision((revision) => revision + 1);
  }), []);

  // Keep the sidebar in sync when the User Home customizer changes which tabs are
  // hidden — mirrors the custom-event pattern used elsewhere in the app.
  useEffect(() => {
    const handler = () => setHiddenNav(getHiddenNav());
    window.addEventListener(NAV_PREFS_EVENT, handler);
    return () => window.removeEventListener(NAV_PREFS_EVENT, handler);
  }, []);

  const visibleNav = useMemo(() => filterNav(NAV, hiddenNav), [hiddenNav]);
  const subPages = useMemo(() => groupSubPages(visibleNav), [visibleNav]);

  // Parent tabs whose sub-pages are collapsed. Deliberately not saved: every launch starts
  // with all groups collapsed, and an expanded group stays open until the app restarts.
  const [collapsed, setCollapsed] = useState(() => new Set(GROUP_PARENTS));
  const toggleGroup = (path) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  // Icon-only sidebar, remembered on this machine. Below 1,000 px it is shown icon-only so the
  // page keeps its width; expanding it there lasts until the window is widened again.
  const [minimizedPref, setMinimizedPref] = usePersistedState(SIDEBAR_MINIMIZED_KEY, false);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WINDOW).matches);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW_WINDOW);
    const update = () => {
      setNarrow(query.matches);
      if (!query.matches) setNarrowExpanded(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const minimized = narrow ? !narrowExpanded : minimizedPref === true;
  const toggleMinimized = () => (narrow ? setNarrowExpanded((cur) => !cur) : setMinimizedPref((cur) => cur !== true));

  // First-run guided setup tutorial. Auto-opens once on a genuine first run (Electron only),
  // and can be reopened anytime — from User Home via OPEN_SETUP_EVENT, or from the persistent
  // launcher pinned at the bottom of the sidebar. Always mounted here so it survives navigation.
  const [setupOpen, setSetupOpen] = useState(false);
  // Live {done,total} for the sidebar launcher label ("Resume setup" vs "Review setup"). Seeded
  // by a check on mount + window focus, and kept fresh by the modal via onStatus while it's open.
  const [setupStatus, setSetupStatus] = useState(null);

  useEffect(() => {
    if (!inElectron()) return undefined;
    let alive = true;
    const check = () => { runSetupChecks().then((r) => { if (alive) setSetupStatus(r); }).catch(() => {}); };
    check();
    window.addEventListener('focus', check);
    return () => { alive = false; window.removeEventListener('focus', check); };
  }, []);

  useEffect(() => {
    if (inElectron() && shouldAutoShowSetup()) {
      const t = setTimeout(() => setSetupOpen(true), 1200); // let the first paint settle
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);
  useEffect(() => {
    const open = () => setSetupOpen(true);
    window.addEventListener(OPEN_SETUP_EVENT, open);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, open);
  }, []);
  // Closing the modal just hides it (the launcher stays). Dismiss/Finish/Skip also persists
  // "seen" so the first-run auto-open never fires again.
  const closeSetup = () => setSetupOpen(false);
  const dismissSetup = () => { setSetupOpen(false); markSetupSeen(); };

  const setupAllDone = !!setupStatus && setupStatus.total > 0 && setupStatus.done === setupStatus.total;

  // Guided Tour — a spotlight walkthrough launched from the sidebar. Not auto-shown; the button
  // is permanent (below Guided Setup) unless hidden via User Home → Customize navigation.
  const [tourOpen, setTourOpen] = useState(false);
  const tourHidden = hiddenNav.includes(GUIDED_TOUR_NAV_KEY);

  // Background MSX auto-sync (milestones + HoK). Lives here because App is always mounted,
  // so the schedule keeps running regardless of which tab is open. Each tick is a no-op
  // unless the user has enabled auto-sync and the interval has elapsed. A first check runs
  // shortly after launch so an overdue sync isn't held back for a full tick.
  useEffect(() => {
    const kick = () => { runMsxAutoSyncIfDue().catch(() => { /* background best-effort */ }); };
    const startup = setTimeout(kick, 45_000);
    const timer = setInterval(kick, 5 * 60 * 1000);
    return () => { clearTimeout(startup); clearInterval(timer); };
  }, []);

  return (
    <div className="app-layout">
      <nav className={`app-sidebar${minimized ? ' is-minimized' : ''}`}>
        <div className="nav-brand">
          <img src="./app-icon.svg" width="24" height="24" alt="" aria-hidden="true" />
          <span className="nav-brand-name">SE Assist</span>
        </div>
        {visibleNav.map((item, i) => {
          if (item.section) {
            return minimized
              ? <div key={i} className="nav-section-divider" role="separator" aria-label={item.section} />
              : <div key={i} className="nav-section-title">{item.section}</div>;
          }
          if (item.parent && subPages.has(item.parent) && collapsed.has(item.parent)) return null;
          const children = subPages.get(item.path);
          const isCollapsed = !!children && collapsed.has(item.path);
          // While a collapsed group's sub-page is open, highlight the parent so the sidebar
          // still shows where you are.
          const holdsActive = isCollapsed && children.some((c) => isOnPath(location.pathname, c.path));
          const link = (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `nav-item${item.parent ? ' nav-item-child' : ''}${isActive || holdsActive ? ' active' : ''}`
              }
              end={item.path === '/'}
              title={minimized ? item.label : undefined}
            >
              <item.icon className="nav-icon" />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          );
          // Icon mode has no room for the arrows; sub-pages keep whatever state the group was in.
          if (!children || minimized) return link;
          const childNames = subPageList.format(children.map((c) => c.label));
          return (
            <div key={item.path} className="nav-group">
              {link}
              <button
                type="button"
                className="nav-group-toggle"
                aria-expanded={!isCollapsed}
                aria-label={`${item.label} sub-pages`}
                title={`${isCollapsed ? 'Show' : 'Hide'} ${childNames}`}
                onClick={() => toggleGroup(item.path)}
              >
                <ChevronRightRegular className="nav-group-chevron" />
              </button>
            </div>
          );
        })}
        <div className="nav-footer">
          <button
            type="button"
            className={`nav-setup-btn${setupAllDone ? ' done' : ''}`}
            onClick={() => setSetupOpen(true)}
            title={setupAllDone
              ? 'Review your guided setup'
              : `Resume the guided setup${minimized && setupStatus ? ` (${setupStatus.done} of ${setupStatus.total} done)` : ''}`}
          >
            {setupAllDone ? <CheckmarkCircleRegular className="nav-btn-icon" /> : <SparkleRegular className="nav-btn-icon" />}
            <span className="nav-btn-label">Guided Setup</span>
            {!setupAllDone && setupStatus ? (
              <span className="nav-setup-count">{setupStatus.done}/{setupStatus.total}</span>
            ) : null}
          </button>
          {!tourHidden ? (
            <button
              type="button"
              className="nav-tour-btn"
              onClick={() => setTourOpen(true)}
              title="Take the guided tour of where the valuable actions are"
            >
              <CompassNorthwestRegular className="nav-btn-icon" />
              <span className="nav-btn-label">Guided Tour</span>
            </button>
          ) : null}
          <button
            type="button"
            className="nav-minimize-btn"
            onClick={toggleMinimized}
            aria-label={minimized ? 'Expand sidebar' : 'Minimize sidebar'}
            title={minimized ? (narrow ? 'Expand sidebar. The window is narrow, so the sidebar starts icon-only.' : 'Expand sidebar') : 'Minimize sidebar'}
          >
            {minimized ? <ChevronDoubleRightRegular /> : <ChevronDoubleLeftRegular />}
          </button>
        </div>
      </nav>

      <main className="app-content">
        <ModelActivityBanner />
        <ErrorBoundary resetKey={`${location.pathname}:${rosterRevision}`}>
        <Routes key={location.pathname === '/settings' ? 'settings' : rosterRevision}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/action-center" element={<ActionCenter />} />
          <Route path="/deep-research" element={<DeepResearch />} />
          <Route path="/workload-management" element={<WorkloadManagement />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/email" element={<CustomerActivity />} />
          {/* Customers-by-SSP moved into User Home → SSP Configuration; redirect old links. */}
          <Route path="/customers" element={<Navigate to="/settings" replace />} />
          <Route path="/customers/:id" element={<ActiveAccountBoundary><CustomerDetail /></ActiveAccountBoundary>} />
          <Route path="/milestones" element={<Milestones view="table" />} />
          <Route path="/milestone-timeline" element={<MilestoneTimeline />} />
          <Route path="/milestone-map" element={<Milestones view="diagram" />} />
          <Route path="/hok-activities" element={<HokActivities />} />
          <Route path="/consumption" element={<ActiveAccountBoundary><Consumption /></ActiveAccountBoundary>} />
          <Route path="/consumption/:tpid" element={<ActiveAccountBoundary><ConsumptionAccount /></ActiveAccountBoundary>} />
          <Route path="/powerbi-reports" element={<ActiveAccountBoundary><PowerBIReports /></ActiveAccountBoundary>} />
          <Route path="/foundry-deep-dives" element={<ActiveAccountBoundary><FoundryDeepDives /></ActiveAccountBoundary>} />
          <Route path="/my-org" element={<MyOrg />} />
          <Route path="/influence-map" element={<ActiveAccountBoundary><StakeholderInfluence /></ActiveAccountBoundary>} />
          <Route path="/products" element={<Products />} />
          <Route path="/accelerators" element={<Accelerators />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/documentation" element={<Documentation />} />
        </Routes>
        </ErrorBoundary>
      </main>

      <TaskBubble key={`tasks:${rosterRevision}`} />
      <AssistantBubble key={`assistant:${rosterRevision}`} />
      {setupOpen && (
        <SetupTutorial
          onClose={closeSetup}
          onDismiss={dismissSetup}
          onStatus={setSetupStatus}
          onStartTour={() => { dismissSetup(); setTourOpen(true); }}
        />
      )}
      {tourOpen && <GuidedTour onClose={() => setTourOpen(false)} />}
    </div>
  );
}
