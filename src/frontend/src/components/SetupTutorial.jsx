import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@fluentui/react-components';
import {
  CheckmarkCircleFilled, CircleRegular, DismissRegular, ArrowRightRegular,
  ArrowClockwiseRegular, SparkleRegular, ShieldCheckmarkRegular,
  PeopleRegular, ArrowSyncRegular, CloudArrowDownRegular, ClipboardTaskListLtrRegular,
  FlagRegular, DataTrendingRegular, PulseRegular, BoardRegular, PersonRegular,
} from '@fluentui/react-icons';
import { SETUP_STEPS } from '../lib/setupSteps';

// Per-step icons (the shared step definitions are UI-free; the modal maps an icon per key).
const STEP_ICONS = {
  auth: ShieldCheckmarkRegular,
  model: SparkleRegular,
  wiqauth: ShieldCheckmarkRegular,
  accounts: PeopleRegular,
  sync: ArrowSyncRegular,
  ingest: CloudArrowDownRegular,
  ssp: PersonRegular,
};

// Orientation: where the main work happens. Clicking navigates and minimizes the guide.
const TOUR = [
  { icon: ClipboardTaskListLtrRegular, label: 'Action Center', path: '/action-center', desc: 'Your daily home — today’s meetings, overdue comments, blocked milestones, workloads and the calendar in one place.' },
  { icon: PulseRegular, label: 'Customer Activity', path: '/email', desc: 'One card per account: recent emails, meetings and chats, plus who’s gone quiet for over 14 days.' },
  { icon: FlagRegular, label: 'Milestones', path: '/milestones', desc: 'Your engagement milestones with comments, HoK activities and linked signals. Search by ID to jump straight to one.' },
  { icon: BoardRegular, label: 'Workloads', path: '/action-center', desc: 'Track deliverables tied to milestones and customers — created by hand, by AI “Discover”, or from a suggestion.' },
  { icon: DataTrendingRegular, label: 'Azure Consumption', path: '/consumption', desc: 'ACR trends and AI capacity for your accounts, from the MSX-I Power BI models.' },
];

/**
 * SetupTutorial — first-run guided setup + orientation. Two views ("Get set up" checklist with
 * live status, and a short "What’s where" tour). Each setup step deep-links into its User Home
 * section (or the matching page); clicking closes the modal so the user can act, then reopens
 * from the sidebar launcher. Purely a navigator over existing flows — it never re-implements
 * sign-in/sync, so it can't drift from the real setup. It renders ONLY the modal — the persistent
 * "Resume/Review setup" launcher lives in the sidebar (App). onClose closes the modal; onDismiss
 * also persists "seen". onStatus reports {done,total} so the launcher label can stay in sync.
 */
export default function SetupTutorial({ onClose, onDismiss, onStatus, onStartTour }) {
  const navigate = useNavigate();
  const [view, setView] = useState('setup'); // 'setup' | 'tour'
  const [status, setStatus] = useState({}); // key -> { done, detail }
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    const entries = await Promise.all(SETUP_STEPS.map(async (s) => {
      try { return [s.key, await s.check()]; } catch { return [s.key, { done: false, detail: '' }]; }
    }));
    const map = Object.fromEntries(entries);
    setStatus(map);
    setChecking(false);
    if (onStatus) {
      const done = SETUP_STEPS.reduce((n, s) => n + (map[s.key]?.done ? 1 : 0), 0);
      onStatus({ done, total: SETUP_STEPS.length });
    }
  }, [onStatus]);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-check when the window regains focus (e.g. after the user completed a step in User Home).
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const doneCount = SETUP_STEPS.reduce((n, s) => n + (status[s.key]?.done ? 1 : 0), 0);
  const allDone = doneCount === SETUP_STEPS.length;

  // Navigate to where a step is completed: a User Home section (?section=) for the setup
  // sections, or a full page path for steps that live elsewhere (e.g. SSPs → Customers). Closing
  // the modal returns to the sidebar launcher.
  const goToStep = useCallback((step) => {
    if (step.path) navigate(step.path);
    else navigate(`/settings?section=${step.section}`);
    onClose();
  }, [navigate, onClose]);

  const goToTour = useCallback((path) => {
    navigate(path);
    onClose();
  }, [navigate, onClose]);
  // ── Full modal ──────────────────────────────────────────────────
  return (
    <div className="setup-backdrop" onClick={onClose}>
      <div className="setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="setup-head">
          <div style={{ minWidth: 0 }}>
            <div className="setup-eyebrow">Welcome to SE Assist</div>
            <div className="setup-title">Guided Setup</div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button type="button" className="setup-icon-btn" title="Close" onClick={onClose}><DismissRegular /></button>
          </div>
        </div>

        <div className="setup-tabs">
          <button type="button" className={`setup-tab${view === 'setup' ? ' active' : ''}`} onClick={() => setView('setup')}>Get set up</button>
          <button type="button" className={`setup-tab${view === 'tour' ? ' active' : ''}`} onClick={() => setView('tour')}>What’s where</button>
        </div>

        {view === 'setup' ? (
          <div className="setup-body">
            <div className="setup-progress-row">
              <div className="setup-progress-track"><div className="setup-progress-fill" style={{ width: `${(doneCount / SETUP_STEPS.length) * 100}%` }} /></div>
              <span className="setup-progress-label">{allDone ? 'All set 🎉' : `${doneCount} of ${SETUP_STEPS.length} complete`}</span>
              <button type="button" className="setup-refresh" onClick={refresh} disabled={checking} title="Re-check status">
                {checking ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
              </button>
            </div>

            <div className="setup-steps">
              {SETUP_STEPS.map((s, i) => {
                const st = status[s.key];
                const done = !!st?.done;
                const Icon = STEP_ICONS[s.key] || SparkleRegular;
                return (
                  <div key={s.key} className={`setup-step${done ? ' done' : ''}`}>
                    <span className="setup-step-state">
                      {checking && st === undefined ? <Spinner size="tiny" />
                        : done ? <CheckmarkCircleFilled className="setup-check" />
                          : <CircleRegular className="setup-circle" />}
                    </span>
                    <span className="setup-step-body">
                      <span className="setup-step-title"><Icon /> {i + 1}. {s.title}</span>
                      <span className="setup-step-desc">{s.desc}</span>
                      {st?.detail ? (
                        <span className={`setup-step-status${done ? ' ok' : ''}`}>{st.detail}</span>
                      ) : null}
                    </span>
                    <button type="button" className={`btn ${done ? 'btn-secondary' : 'btn-primary'} setup-step-btn`} onClick={() => goToStep(s)}>
                      {done ? 'Review' : 'Set up'} <ArrowRightRegular />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="setup-note">
              Each step opens the matching section in <strong>User Home</strong>. Come back here anytime from
              User Home → <em>Guided Setup</em>; this panel updates as you complete steps.
            </div>
          </div>
        ) : (
          <div className="setup-body">
            <div className="setup-note" style={{ marginTop: 0, marginBottom: 12 }}>
              A quick map of where the work happens. Many tabs start hidden for new users — turn any on from
              User Home → <em>Customize navigation</em>.
            </div>
            <div className="setup-tour">
              {TOUR.map((t) => {
                const Icon = t.icon;
                return (
                  <button key={t.label} type="button" className="setup-tour-item" onClick={() => goToTour(t.path)}>
                    <span className="setup-tour-icon"><Icon /></span>
                    <span className="setup-tour-body">
                      <span className="setup-tour-label">{t.label} <ArrowRightRegular /></span>
                      <span className="setup-tour-desc">{t.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="setup-foot">
          <button type="button" className="setup-skip" onClick={onDismiss}>Skip for now</button>
          {allDone ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={onDismiss}>Finish</button>
              {onStartTour ? (
                <button type="button" className="btn btn-primary" onClick={onStartTour}>✨ Start Guided Tour</button>
              ) : null}
            </div>
          ) : (
            <span className="setup-foot-hint">You can finish setup later — the app works as each step is completed.</span>
          )}
        </div>
      </div>
    </div>
  );
}
