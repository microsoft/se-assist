import { Spinner } from '@fluentui/react-components';
import {
  CheckmarkCircleRegular, DismissCircleRegular, ArrowClockwiseRegular, SparkleRegular,
} from '@fluentui/react-icons';

// Shared "Milestone AI" workflow model + popup, used by BOTH the workload-popup batch run
// (many milestones) and the milestone-details single run. Each run is a short, named pipeline; the
// popup shows every milestone churning through its steps in plain language and lets the SE retry
// from the first failed step. Steps are idempotent/additive, so resuming never corrupts or
// duplicates work.

export const MILESTONE_AI_STEPS = {
  dealTeam: { label: 'Join deal team', hint: 'Add you to this milestone’s deal team' },
  find: { label: 'Gather related activity', hint: 'Link recent emails, meetings & chats' },
  comment: { label: 'Draft status comment', hint: 'Summarize the recent activity' },
  hok: { label: 'Suggest next activities', hint: 'Propose Hands-on-Keyboard activities' },
};

// The full pipeline order. Callers pass a subset (e.g. ['find'] for Find-Related-only).
export const MILESTONE_AI_FULL_KEYS = ['dealTeam', 'find', 'comment', 'hok'];

export function makeStepList(keys) {
  return (keys || MILESTONE_AI_FULL_KEYS).map((key) => ({ key, status: 'pending', error: '' }));
}
export function setStep(steps, key, patch) {
  return (steps || []).map((s) => (s.key === key ? { ...s, ...patch } : s));
}
// Index of the earliest failed step (where "retry from here onward" resumes). -1 when none failed.
export function firstFailedStepIndex(steps) {
  return (steps || []).findIndex((s) => s.status === 'failed');
}
export function stepsHaveFailure(steps) {
  return (steps || []).some((s) => s.status === 'failed');
}
export function stepsAllSettled(steps) {
  return (steps || []).length > 0 && (steps || []).every((s) => s.status === 'ok' || s.status === 'skipped');
}

function StepIcon({ status }) {
  if (status === 'running') return <Spinner size="tiny" />;
  if (status === 'ok') return <CheckmarkCircleRegular className="mai-icon ok" />;
  if (status === 'failed') return <DismissCircleRegular className="mai-icon fail" />;
  if (status === 'skipped') return <span className="mai-icon skip">–</span>;
  return <span className="mai-icon pending">○</span>;
}

/**
 * Presentational workflow popup. Pure — all run/retry logic stays with the caller.
 *
 * @param {object} props
 * @param {{id:string, name:string, sub?:string, steps:{key,status,error}[]}[]} props.milestones
 * @param {boolean} props.running
 * @param {string} [props.statusNote]  Live status line (e.g. "Working — Milestone X (2 of 6)…").
 * @param {string} [props.error]       Batch-wide abort message (e.g. no provider configured).
 * @param {(id:string)=>void} [props.onRetryMilestone]  Retry one milestone from its first failure.
 * @param {()=>void} [props.onRetryAll]                 Retry every failing milestone (batch only).
 * @param {()=>void} props.onClose
 */
export function MilestoneAiWorkflowPopup({
  milestones = [], running, statusNote, error, onRetryMilestone, onRetryAll, onClose,
}) {
  const anyFailure = milestones.some((m) => stepsHaveFailure(m.steps));
  const allDone = milestones.length > 0 && !running && milestones.every((m) => stepsAllSettled(m.steps));
  return (
    <div className="eng-detail-backdrop mai-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card wl-modal-card mai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind"><SparkleRegular /> Milestone AI</span>
          <div className="eng-detail-head-actions">
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="mai-status">
          {running ? (
            <><Spinner size="tiny" /> {statusNote || 'Working…'}</>
          ) : allDone ? (
            <span className="mai-status-ok"><CheckmarkCircleRegular /> All steps complete.</span>
          ) : anyFailure ? (
            <span className="mai-status-warn">Some steps need attention — retry from where they failed.</span>
          ) : 'Ready.'}
        </div>
        {error ? <div className="alert-error mai-abort">{error}</div> : null}

        <div className="mai-list">
          {milestones.map((m) => {
            const failed = stepsHaveFailure(m.steps);
            const done = stepsAllSettled(m.steps);
            return (
              <section className="mai-ms" key={m.id}>
                <div className="mai-ms-head">
                  <span className="mai-ms-name">{m.name}</span>
                  {m.sub ? <span className="mai-ms-sub"> · {m.sub}</span> : null}
                  {done && !failed ? <span className="mai-ms-badge ok">Done</span> : null}
                  {failed ? <span className="mai-ms-badge warn">Needs retry</span> : null}
                </div>
                <ol className="mai-steps">
                  {(m.steps || []).map((s) => {
                    const def = MILESTONE_AI_STEPS[s.key] || { label: s.key, hint: '' };
                    return (
                      <li className={`mai-step mai-step-${s.status}`} key={s.key}>
                        <StepIcon status={s.status} />
                        <span className="mai-step-body">
                          <span className="mai-step-label">{def.label}</span>
                          <span className="mai-step-hint">{def.hint}</span>
                          {s.status === 'failed' && s.error ? <span className="mai-step-err">{s.error}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {failed && onRetryMilestone ? (
                  <div className="mai-ms-actions">
                    <button className="btn btn-secondary wl-sm" disabled={running} onClick={() => onRetryMilestone(m.id)}>
                      <ArrowClockwiseRegular /> Retry failed steps
                    </button>
                  </div>
                ) : null}
              </section>
            );
          })}
          {!milestones.length ? <div className="wl-muted" style={{ padding: '12px 0' }}>Preparing…</div> : null}
        </div>

        <div className="wl-card-footer wl-modal-footer">
          {anyFailure && onRetryAll ? (
            <button className="btn btn-primary" disabled={running} onClick={onRetryAll}>
              <ArrowClockwiseRegular /> Retry all failures
            </button>
          ) : null}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
