import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Checkbox, Field, Input, Spinner, Textarea } from '@fluentui/react-components';
import { ArrowClockwiseRegular, CopyRegular, DismissRegular, MailArrowForwardRegular, SearchRegular, SparkleRegular } from '@fluentui/react-icons';
import {
  workOutputOpen, workOutputGet, workOutputRun, workOutputCancel, workOutputTasks, workOutputReply,
  workOutputGapTriage, workOutputGapResearch, onWorkOutputProgress, openExternal, workloadCreate,
} from '../electronBridge';
import { TaskAssignmentStatus, TaskCustomerPicker, TaskWorkloadPicker, useTaskAssignmentOptions } from './TaskAssignments';

const STATUS = { idle: 'Not started', working: 'Working', ready: 'Ready', ready_with_gaps: 'Ready with gaps', failed: 'Failed', needs_input: 'Needs input' };
const current = output => output.content && ['ready', 'ready_with_gaps'].includes(output.status) && !output.needsRefresh;
const formatOutput = output => [
  output.content.content,
  ...output.content.actions.map(item => [
    `- ${item.title}${item.description ? `: ${item.description}` : ''}`,
    item.owner ? `Owner (${item.ownerStatus}): ${item.owner}` : 'Owner: unassigned',
    item.dueDate ? `Confirmed due: ${item.dueDate}` : 'Due date: unconfirmed',
    item.dependsOn.length ? `Prerequisites: ${item.dependsOn.join('; ')}` : '',
  ].filter(Boolean).join(' | ')),
  ...(output.gaps.length ? ['', 'Gaps / qualifications:', ...output.gaps.map(gap => `- ${gap}`)] : []),
].join('\n');

const GAP_KIND = { m365: 'Work data (M365)', public: 'Public docs', person: 'Ask a person', limitation: 'Research limitation' };
const GAP_STATUS = { open: 'Open', answered: 'Answered', partial: 'Partly answered', still_open: 'Still open', blocked: 'Blocked', failed: 'Failed' };
const GAP_ACTION = { open: 'Research this gap', failed: 'Retry research', blocked: 'Research again after access is fixed', still_open: 'Research again', partial: 'Research again' };
const GAP_OUTCOME = {
  answered: 'Answered. Outputs that list this question are marked Needs refresh; refresh them to use the answer.',
  partial: 'Partly answered. Outputs that list this question are marked Needs refresh; refresh them to use the answer.',
  still_open: 'The research did not answer this question, so it stays open.',
};
const MAX_GAP_BATCH = 5;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const researchable = gap => gap.listed && ['m365', 'public'].includes(gap.kind) && gap.status !== 'answered';
const gapCooling = (gap, now) => gap.error?.retryAt > now;
const queuedGap = (gap, now) => researchable(gap) && ['open', 'failed'].includes(gap.status) && !gapCooling(gap, now);
// Work still to do comes first: researchable questions, then unclassified, questions for a person,
// partly or still open, answered, research limitations, and questions no output lists any more.
const gapRank = gap => {
  if (!gap.listed) return 6;
  if (gap.status === 'answered') return 4;
  if (!gap.kind) return 1;
  if (gap.kind === 'person') return 2;
  if (gap.kind === 'limitation') return 5;
  return ['open', 'failed'].includes(gap.status) ? 0 : 3;
};
const sortGaps = gaps => [...gaps].sort((a, b) => gapRank(a) - gapRank(b));
const AREAS = ['situation', 'reply', 'actions', 'technical'];
const BLOCKED_NOTE = 'Access was denied. Saved research remains excluded; Retry will not re-request it. Verify access before using Refresh.';
const SIGN_IN = { model: '/settings?section=model', m365: '/settings?section=wiqauth' };
const retryableArea = (output, now) => output.status === 'failed' && !(output.error?.retryAt > now)
  && !output.steps.some(step => step.status === 'blocked');

// Readable titles for saved failures, derived from the saved message, HTTP status and code. The
// raw text stays under Technical details; this changes only the wording, never what is retried.
const messageOf = failure => (typeof failure === 'string' ? failure : failure?.message || '').trim();
const firstLine = text => {
  const line = text.split(/\r?\n/).find(part => part.trim())?.trim() || 'This step failed.';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};
function failureSummary(failure) {
  const text = messageOf(failure);
  const code = typeof failure === 'object' && failure?.code ? String(failure.code) : '';
  const status = (typeof failure === 'object' && Number(failure?.statusCode)) || Number(/\bHTTP (\d{3})\b/.exec(text)?.[1]) || null;
  const cooldown = 'Retry after the cooldown ends.';
  const reused = 'Retry; saved steps are reused.';
  if (/^(COPILOT_|NO_GITHUB_TOKEN|REASONING_UNSUPPORTED)/.test(code) || /GitHub Copilot|Copilot token|Copilot (Responses|chat)/i.test(text)) {
    if (status === 401 || /not connected|sign in|sign-in|Reconnect GitHub Copilot|token exchange failed: 401|returned no token/i.test(text)) {
      return { kind: 'copilot-auth', title: 'GitHub Copilot sign-in needed', hint: 'Reconnect in User Home → GitHub sign-in, then retry.' };
    }
    if (status === 429 || /rate-limited|rate limit/i.test(text)) return { kind: 'busy', title: 'GitHub Copilot is busy (rate-limited)', hint: cooldown };
    if (status === 403 || /not available for this account/i.test(text)) {
      return { kind: 'copilot-auth', title: 'GitHub Copilot access refused', hint: 'Check that this GitHub account has an active Copilot subscription, then reconnect in User Home → GitHub sign-in.' };
    }
    if (/timed out/i.test(text)) return { kind: 'timeout', title: 'GitHub Copilot timed out', hint: reused };
  }
  if (status === 429 || /TooManyRequests|rate-limited|rate limit|throttl|cooldown|AI model is busy/i.test(text)) {
    const title = /AI (model|provider)/i.test(text) ? 'AI model busy (rate-limited)'
      : /WorkIQ|Microsoft 365|Graph/i.test(text) ? 'Microsoft 365 is throttling requests' : 'Service busy (throttled)';
    return { kind: 'busy', title, hint: cooldown };
  }
  if (status === 403 || /Forbidden|ErrorAccessDenied|AccessDenied|access denial|denied mailbox access|does not grant access/i.test(text)) {
    return { kind: 'access', title: 'Access denied by the source', hint: 'Verify your access, then refresh. SE Assist cannot grant permissions.' };
  }
  if (/InvalidAuthenticationToken|TokenCreatedWithOutdatedPolicies|Connect WorkIQ|WorkIQ has no active sign-in|WorkIQ cannot read your mailbox|WorkIQ is not connected|signed in again|reconnect was attempted|Automatic reconnect|sign in to Microsoft/i.test(text)
    || (status === 401 && /WorkIQ|Microsoft|Graph|M365/i.test(text))) {
    return { kind: 'm365-auth', title: 'Microsoft 365 sign-in expired or not connected', hint: 'Reconnect WorkIQ in User Home → Microsoft 365 Copilot sign-in, then retry.' };
  }
  if (status === 401) return { kind: 'auth', title: 'Sign-in expired', hint: 'Reconnect the service named under Technical details, then retry.' };
  if (/app closed before/i.test(text)) return { kind: 'interrupted', title: 'Interrupted when SE Assist closed', hint: 'Saved evidence was kept. Retry this area.' };
  if (/was stopped/i.test(text)) return { kind: 'stopped', title: 'Stopped before finishing', hint: 'Saved evidence was kept. Retry to continue.' };
  if (/time budget|timed out/i.test(text)) {
    const title = /time budget/i.test(text) ? 'Reached the six-minute time budget' : /WorkIQ/i.test(text) ? 'Microsoft 365 (WorkIQ) timed out' : 'Timed out';
    return { kind: 'timeout', title, hint: reused };
  }
  return { kind: 'other', title: firstLine(text), hint: '' };
}
// An area that failed because the shared source-email read failed is explained by that read's error.
const sourceCause = (output, failure) => (/shared source-email read failed/i.test(messageOf(failure))
  ? output.steps.find(step => step.step === 'source email' && step.error)?.error || null : null);
const areaFailure = output => failureSummary(sourceCause(output, output.error) || output.error);
const gapOutcome = result => {
  if (!result.ok) return { tone: 'error' };
  if (result.kept) return { tone: 'warn', text: 'No further answer was found; the earlier partial answer is kept.' };
  return { tone: result.status === 'answered' ? 'success' : 'warn', text: GAP_OUTCOME[result.status] };
};
const formatAttempt = at => {
  const time = Date.parse(at || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
};

function ErrorBox({ failure, cause = null, at = null, live = false, hint, context = '' }) {
  const summary = failureSummary(cause || failure);
  const shownHint = hint ?? summary.hint;
  const attempted = formatAttempt(at);
  const details = [...new Set([messageOf(failure), messageOf(cause)])].filter(text => text && text !== summary.title);
  return (
    <div className="sec-flash sec-flash-error work-output-error" role={live ? 'alert' : undefined}>
      <div className="work-output-error-head">
        <strong>{context ? `${context}: ${summary.title}` : summary.title}</strong>
        {attempted && <span>Last attempt {attempted}</span>}
      </div>
      {shownHint && <p>{shownHint}</p>}
      {details.length > 0 && <details>
        <summary>Technical details</summary>
        {details.map(text => <p key={text}>{text}</p>)}
      </details>}
    </div>
  );
}

// Result of a read-only action (copy, open a source) that runs even while research is active.
const QuickNote = ({ note }) => note ? <div className={`sec-flash ${note.error ? 'sec-flash-error' : 'sec-flash-success'}`}
  role={note.error ? 'alert' : 'status'}>{note.text}</div> : null;

function FailureBanner({ investigation, locked, lockReason, now, retry, openSignIn }) {
  const failed = investigation.outputs.filter(output => output.status === 'failed');
  if (!failed.length) return null;
  const summaries = failed.map(areaFailure);
  const titles = [...new Set(summaries.map(summary => summary.title))];
  const retryable = failed.filter(output => retryableArea(output, now)).length;
  const m365 = summaries.some(summary => summary.kind === 'm365-auth');
  const copilot = summaries.some(summary => summary.kind === 'copilot-auth');
  const ordered = AREAS.map(area => failed.find(output => output.area === area)).filter(Boolean);
  return (
    <section className="work-output-banner" aria-label="Areas that did not finish">
      <div className="work-output-banner-text">
        <strong>{failed.length === 1 ? '1 area' : `${failed.length} areas`} did not finish{titles.length === 1 ? `: ${titles[0]}` : ''}</strong>
        <span>{ordered.map(output => output.title).join(', ')}</span>
      </div>
      <div className="work-output-controls">
        {m365 && <Button size="small" appearance="primary" disabled={locked} onClick={() => openSignIn('m365')}>Open Microsoft 365 sign-in</Button>}
        {copilot && <Button size="small" appearance="primary" disabled={locked} onClick={() => openSignIn('model')}>Open GitHub sign-in</Button>}
        {retryable > 0 && <Button size="small" appearance={m365 || copilot ? 'secondary' : 'primary'} icon={<ArrowClockwiseRegular />}
          disabled={locked} onClick={retry} title="Retries each failed area in order and stops at the first one that fails again.">
          {retryable === failed.length ? 'Retry failed areas' : `Retry ${plural(retryable, 'failed area')}`}
        </Button>}
        {locked && <span className="work-output-locked">{lockReason}</span>}
      </div>
    </section>
  );
}

function Checklist({ output, investigation, disabled, perform, update }) {
  const assignments = useTaskAssignmentOptions();
  const [selected, setSelected] = useState([]);
  const [profileId, setProfileId] = useState(investigation.defaultProfileId);
  const [workloadId, setWorkloadId] = useState(null);
  const added = new Map(investigation.createdTasks.map(item => [item.actionKey, item]));
  useEffect(() => {
    setSelected(previous => previous.filter(key => output.content.actions.some(item => item.key === key)));
  }, [output.version, output.content.actions]);
  const availableSelection = selected.filter(key => !added.has(key));
  return (
    <div className="work-output-checklist">
      {output.content.actions.map(item => (
        <div className="work-output-action" key={item.key}>
          <Checkbox label={item.title} checked={selected.includes(item.key)} disabled={disabled || added.has(item.key)}
            onChange={(_event, data) => setSelected(previous => data.checked ? [...previous, item.key] : previous.filter(key => key !== item.key))} />
          {item.description && <p>{item.description}</p>}
          <div>{item.owner ? `Owner (${item.ownerStatus}): ${item.owner}` : 'Owner: unassigned'} · {item.dueDate ? `Confirmed due: ${item.dueDate}` : 'Due date: unconfirmed'}</div>
          {item.dependsOn.length > 0 && <div>Prerequisites: {item.dependsOn.join('; ')}</div>}
          <div className="ac-muted">Evidence / qualification: {item.evidence}</div>
          {added.has(item.key) && <div className="work-output-note">{added.get(item.key).deleted ? 'Previously created Task was deleted; it will not be recreated automatically.' : 'Created as an SE Assist Task.'}</div>}
        </div>
      ))}
      {!output.content.actions.length && <p>No action items proposed.</p>}
      {output.content.actions.length > 0 && <>
        <div className="work-output-assignments">
          <TaskCustomerPicker state={assignments} profileId={profileId} onChange={setProfileId} disabled={disabled} />
          <TaskWorkloadPicker state={assignments} workloadId={workloadId} onChange={setWorkloadId} disabled={disabled} />
        </div>
        <TaskAssignmentStatus state={assignments} />
        <p className="ac-muted">Assignments apply to the selected new Tasks. Existing Tasks and their edits are preserved.</p>
        <Button size="small" disabled={disabled || !availableSelection.length || assignments.loading || Boolean(assignments.error)}
          onClick={() => perform(output.area, async () => {
            const result = await workOutputTasks({
              investigationId: investigation.id, version: output.version, actionKeys: availableSelection, profileId, workloadId,
            });
            if (!result?.ok) throw new Error(result?.error || 'Could not create the selected Tasks.');
            update(result.investigation);
            setSelected([]);
            return `Created ${result.created} SE Assist Task${result.created === 1 ? '' : 's'}. ${result.existing ? `${result.existing} already existed.` : ''}`;
          })}>Create selected Tasks</Button>
      </>}
    </div>
  );
}

function OutputCard({ output, investigation, busy, lockReason, progress, messages, error, flash, notes, run, stop, perform, quick, update, now }) {
  const [draft, setDraft] = useState(null);
  const [instruction, setInstruction] = useState('');
  useEffect(() => { setDraft(null); }, [output.focus]);
  // An unanswered technical area shows the question suggested by gap classification until the
  // user edits it. It is never generated automatically.
  const suggestion = output.area === 'technical' && !output.focus ? investigation.gapTriage?.technicalQuestion || '' : '';
  const focus = draft ?? (output.focus || suggestion);
  const suggested = draft === null && Boolean(suggestion);
  const working = busy === output.area || output.status === 'working';
  const focusChanged = focus !== output.focus;
  const isCurrent = current(output) && !working && !focusChanged;
  const cooldown = output.error?.retryAt > now;
  const status = working ? 'Working' : output.status === 'failed' ? 'Failed'
    : output.needsRefresh || (output.content && focusChanged) ? 'Needs refresh' : STATUS[output.status];
  const blocked = output.steps.some(step => step.status === 'blocked');
  const failure = error ? (output.error?.message === error ? output.error : error) : output.error;
  const cause = failure ? sourceCause(output, failure) : null;
  const accessFailure = Boolean(failure) && failureSummary(cause || failure).kind === 'access';
  return (
    <section className={`work-output-card work-output-${output.area}`} aria-label={output.title}>
      <div className="work-output-head">
        <h4>{output.title}{output.optional ? <span className="ac-muted"> · Optional</span> : null}</h4>
        <span className={`work-output-status ${working ? 'working' : status === 'Needs refresh' ? 'stale' : output.status}`} role="status">{status}</span>
      </div>
      <p className="work-output-scope">{output.scope}</p>
      <Field label={output.area === 'technical' ? 'Technical question' : output.area === 'reply' ? 'Draft focus (optional)' : 'Research focus (optional)'}
        hint={suggested ? 'Suggested from open gaps. Review or edit it; it runs only when you choose.' : undefined}>
        <Input value={focus} onChange={(_event, data) => setDraft(data.value)} maxLength={1200} disabled={Boolean(busy)}
          aria-label={`${output.title} focus`} placeholder={output.area === 'technical' ? 'Which specific product or architecture question should this answer?' : 'Narrow this area to the decision or question that matters.'} />
      </Field>
      <div className="work-output-controls">
        {working ? <Button size="small" onClick={stop}>Stop this area</Button> : <>
          {output.status === 'idle' && <Button size="small" appearance="primary" icon={<SparkleRegular />}
            disabled={Boolean(busy) || (output.area === 'technical' && !focus.trim())}
            onClick={() => run(output.area, 'generate', focus)}>Generate {output.optional ? 'recommendation' : 'this area'}</Button>}
          {output.status === 'failed' && <Button size="small" appearance="primary" icon={<ArrowClockwiseRegular />}
            disabled={Boolean(busy) || cooldown || blocked}
            onClick={() => run(output.area, 'retry')}>{cooldown ? 'Waiting for service cooldown' : 'Retry this area'}</Button>}
          {output.status !== 'idle' && <Button size="small" disabled={Boolean(busy) || cooldown || (output.area === 'technical' && !focus.trim())}
            title={blocked ? 'Recheck this area only after access has been verified. This does not grant permissions.' : 'Reprocess this area without rerunning the other outputs.'}
            onClick={() => run(output.area, 'refresh', focus)}>{blocked ? 'Refresh after access is fixed' : 'Refresh this area'}</Button>}
        </>}
        <Button size="small" icon={<CopyRegular />} disabled={!isCurrent} onClick={() => quick(`${output.area}:copy`, async () => {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
          await navigator.clipboard.writeText(output.area === 'reply' ? output.content.content : formatOutput(output));
          return 'Copied.';
        })}>Copy</Button>
        {busy && !working && <span className="work-output-locked">{lockReason}</span>}
      </div>
      <QuickNote note={notes[`${output.area}:copy`]} />
      {cooldown && <p role="status">This service permits another attempt after {new Date(output.error.retryAt).toLocaleString()}.</p>}
      {blocked && !accessFailure && <p className="work-output-note">{BLOCKED_NOTE}</p>}
      {failure && (output.status === 'needs_input' && !error
        ? <p className="work-output-note">{messageOf(failure)}</p>
        : <ErrorBox failure={failure} cause={cause} live={Boolean(error)}
          at={!error && output.status === 'failed' ? output.updatedAt : null}
          hint={blocked && accessFailure ? BLOCKED_NOTE : undefined} />)}
      {working && <div className="work-output-progress" role="status"><Spinner size="tiny" /> {progress?.label || 'Preparing this area...'}</div>}
      {output.content && !isCurrent && <div className="work-output-note" role="status">
        Previous result retained. {focusChanged ? 'The research focus has changed. Refresh this area to apply it.'
          : output.needsRefresh ? 'Upstream findings changed. Refresh this area before using it.' : 'The latest attempt is not ready; this is not its result.'}
      </div>}
      {output.content && <div className="work-output-content">{output.content.content}</div>}
      {output.gaps.length > 0 && <div className="work-output-gaps"><strong>Gaps / qualifications</strong><ul>{output.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
      {output.area === 'actions' && output.content && <Checklist output={output} investigation={investigation}
        disabled={!isCurrent || Boolean(busy)} perform={perform} update={update} />}
      {output.area === 'reply' && <Button size="small" icon={<MailArrowForwardRegular />} disabled={!isCurrent || Boolean(busy)}
        onClick={() => perform(output.area, async () => {
          const result = await workOutputReply({ investigationId: investigation.id, version: output.version });
          if (!result?.ok || !result.webLink) throw new Error(result?.error || 'Could not create the reply draft.');
          try { await openExternal(result.webLink); }
          catch (err) { throw new Error(`The reply draft was created but Outlook could not open it: ${err.message}. Find it in your Outlook Drafts.`); }
          return 'Reply-all draft opened in Outlook. Review and send it there; nothing was sent automatically.';
        })}>Open reply-all draft in Outlook</Button>}
      {output.content && <details className="work-output-refine">
        <summary>Refine this output</summary>
        <p>Rewrite saved findings only. Use Refresh for new research. Existing gaps remain in force.</p>
        <Textarea value={instruction} maxLength={2000} disabled={Boolean(busy)} aria-label={`Refine ${output.title}`}
          onChange={(_event, data) => setInstruction(data.value)} placeholder="For example: shorten this, or make the next steps more specific." />
        <Button size="small" disabled={!isCurrent || Boolean(busy) || !instruction.trim()}
          onClick={() => run(output.area, 'refine', output.focus, instruction)}>Apply refinement</Button>
      </details>}
      <details className="work-output-evidence">
        <summary>Evidence and research steps</summary>
        <p>Source email is shared. Refresh Current situation to reread it; other areas reuse it for up to 24 hours. Retry reuses successful, unexpired steps. Reply uses saved findings, not new searches.</p>
        {output.steps.length ? <ul>{output.steps.map(step => <li key={step.step}>
          {step.step}: {step.status} · {new Date(step.checkedAt).toLocaleString()}{step.error ? ` — ${step.error.message}` : ''}
        </li>)}</ul> : <p>No research yet.</p>}
        {output.sources.length > 0 ? <div className="sec-work-sources">
          <strong>Sources returned</strong>
          {output.sources.map(source => <button type="button" key={source.url} onClick={() => quick(`${output.area}:sources`, async () => {
            await openExternal(source.url);
            return '';
          })}>{source.title || source.url}</button>)}
        </div> : output.content && <p>No source links were returned; do not treat uncited research as an original-page verification.</p>}
        <QuickNote note={notes[`${output.area}:sources`]} />
        {messages?.length > 0 && <ul>{messages.map((message, index) => <li key={index}>{message}</li>)}</ul>}
      </details>
      {output.checkedAt && <div className="work-output-meta">Saved {new Date(output.checkedAt).toLocaleString()} · {output.model} · high</div>}
      {flash && <div className="sec-flash sec-flash-success" role="status">{flash}</div>}
    </section>
  );
}

function GapRow({ gap, titles, active, locked, now, research, quick, notes, outcome }) {
  const cooling = gapCooling(gap, now);
  const resultRef = useRef(null);
  // A single research run moves focus to its result when the clicked control has gone away.
  useEffect(() => {
    if (!outcome?.focus) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) resultRef.current?.focus();
  }, [outcome]);
  return (
    <li className="work-output-gap">
      <div className="work-output-gap-head">
        <span className="work-output-gap-question">{gap.text}</span>
        <span className={`work-output-status ${active ? 'working' : `gap-${gap.status}`}`}>{active ? 'Researching' : GAP_STATUS[gap.status]}</span>
      </div>
      <div className="work-output-gap-meta">
        <span className={`work-output-gap-kind ${gap.kind || 'unclassified'}`}>{GAP_KIND[gap.kind] || 'Not classified'}</span>
        <span>{gap.listed ? `Listed in ${gap.areas.map(area => titles[area] || area).join(', ')}${gap.origin && !gap.areas.includes(gap.origin) ? ` · raised by ${titles[gap.origin] || gap.origin}` : ''}` : 'No longer listed in current outputs'}</span>
      </div>
      {gap.kindReason && <p className="work-output-gap-reason">{gap.kindReason}</p>}
      {gap.answer && <div className={`work-output-gap-answer${gap.status === 'partial' ? ' partial' : ''}`}>
        <strong>{gap.status === 'partial' ? 'Partial answer' : 'Answer'}</strong>
        <p>{gap.answer}</p>
        {gap.quote && <blockquote>
          “{gap.quote}”
          <span>{gap.kind === 'public' ? 'Found verbatim in the public search summary, not an original page read.' : 'Found verbatim in the Microsoft 365 search result.'}</span>
        </blockquote>}
      </div>}
      {gap.notes.length > 0 && <ul className="work-output-gap-notes">{gap.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      {(gap.error || outcome?.text) && <div ref={resultRef} tabIndex={-1} className="work-output-gap-result">
        {gap.error && <ErrorBox failure={gap.error} at={gap.updatedAt} live={outcome?.tone === 'error'} />}
        {outcome?.text && <div className={`sec-flash ${outcome.tone === 'success' ? 'sec-flash-success' : 'sec-flash-warn'}`} role="status">{outcome.text}</div>}
      </div>}
      {gap.sources.length > 0 && <div className="sec-work-sources">
        <strong>Sources returned</strong>
        {gap.sources.map((source, index) => <button type="button" key={`${index}:${source.url}`}
          onClick={() => quick(`gap:${gap.key}:sources`, async () => {
            await openExternal(source.url);
            return '';
          })}>{source.title || source.url}</button>)}
      </div>}
      <QuickNote note={notes[`gap:${gap.key}:sources`]} />
      {gap.query && <details className="work-output-gap-query"><summary>Search used</summary><p>{gap.query}</p></details>}
      {researchable(gap) ? <div className="work-output-controls">
        <Button size="small" icon={<SearchRegular />} disabled={locked || cooling} onClick={() => research(gap.key)}
          title={gap.status === 'blocked' ? 'Recheck only after access has been verified. This does not grant permissions.' : undefined}>
          {cooling ? 'Waiting for service cooldown' : GAP_ACTION[gap.status]}
        </Button>
      </div> : gap.listed && gap.status !== 'answered' && <p className="ac-muted">{{
        person: 'Needs an answer from a person. It is not researched automatically.',
        limitation: 'Kept as a qualification of the research. It is not researched.',
      }[gap.kind] || 'Classify the gaps to decide how this question can be answered.'}</p>}
      {cooling && <p role="status">This service permits another attempt after {new Date(gap.error.retryAt).toLocaleString()}.</p>}
      {gap.checkedAt && <div className="work-output-meta">Researched {new Date(gap.checkedAt).toLocaleString()}{gap.model ? ` · ${gap.model}` : ''}</div>}
    </li>
  );
}

function GapSection({ investigation, busy, gapBatch, locked, lockReason, progress, messages, error, flash, notes, outcomes, triageLive, now, classify, research, researchOpen, stop, quick }) {
  const { gaps, gapTriage } = investigation;
  const titles = Object.fromEntries(investigation.outputs.map(output => [output.area, output.title]));
  const working = busy === 'gaps';
  const triageCooling = gapTriage.error?.retryAt > now;
  const pending = gaps.filter(gap => queuedGap(gap, now)).length;
  const listed = gaps.filter(gap => gap.listed);
  const answered = listed.filter(gap => gap.status === 'answered').length;
  // Rows keep their order while research changes a status, so a row never moves away from the
  // control just used. The order is recomputed when gaps are added, removed, classified or unlisted.
  const signature = gaps.map(gap => `${gap.key}|${gap.kind || ''}|${gap.listed ? 1 : 0}`).sort().join('\n');
  const [order, setOrder] = useState(() => ({ signature, keys: sortGaps(gaps).map(gap => gap.key) }));
  const keys = order.signature === signature ? order.keys : sortGaps(gaps).map(gap => gap.key);
  if (order.signature !== signature) setOrder({ signature, keys });
  const byKey = new Map(gaps.map(gap => [gap.key, gap]));
  const rows = keys.map(key => byKey.get(key)).filter(Boolean);
  return (
    <section className="work-output-card work-output-gap-panel" aria-label="Gaps — research and status">
      <div className="work-output-head">
        <h4>Gaps — research and status</h4>
        <span className="work-output-status">{listed.length} listed{answered ? ` · ${answered} answered` : ''}</span>
      </div>
      <p className="work-output-scope">
        Questions the outputs above could not answer. Work-data and public-docs questions can be researched; an answer is kept only
        when its supporting quote appears verbatim in the retrieved evidence, and it marks the outputs that list the question as Needs
        refresh. Questions for a person and research limitations are not researched.
      </p>
      <div className="work-output-controls">
        {working || gapBatch ? <Button size="small" onClick={stop}>Stop gap research</Button> : <>
          {gapTriage.untriaged > 0 && <Button size="small" disabled={locked || triageCooling} onClick={classify}>
            {triageCooling ? 'Waiting for service cooldown' : gapTriage.error ? 'Retry classification' : `Classify ${plural(gapTriage.untriaged, 'gap')}`}
          </Button>}
          {pending > 0 && <Button size="small" appearance="primary" icon={<SearchRegular />} disabled={locked} onClick={researchOpen}
            title="Researches open or failed work-data and public-docs gaps one at a time, and stops at the first failure.">
            {pending > MAX_GAP_BATCH ? `Research the next ${MAX_GAP_BATCH} of ${pending} open gaps` : `Research ${plural(pending, 'open gap')}`}
          </Button>}
          {locked && <span className="work-output-locked">{lockReason}</span>}
        </>}
      </div>
      {triageCooling && <p role="status">Classification can be retried after {new Date(gapTriage.error.retryAt).toLocaleString()}.</p>}
      {error && <ErrorBox failure={error} live />}
      {gapTriage.error && gapTriage.untriaged > 0 && !working && <ErrorBox failure={gapTriage.error}
        at={gapTriage.checkedAt} live={triageLive} context="Classification did not complete" />}
      {working && <div className="work-output-progress" role="status"><Spinner size="tiny" /> {progress?.label || 'Working on gaps...'}</div>}
      {flash && <div className="sec-flash sec-flash-success" role="status">{flash}</div>}
      <ul className="work-output-gap-list">
        {rows.map(gap => <GapRow key={gap.key} gap={gap} titles={titles} active={working && progress?.gapKey === gap.key}
          locked={locked} now={now} research={research} quick={quick} notes={notes} outcome={outcomes[gap.key]} />)}
      </ul>
      {messages?.length > 0 && <details className="work-output-evidence">
        <summary>Gap research activity</summary>
        <ul>{messages.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </details>}
      {gapTriage.checkedAt && !gapTriage.error && <div className="work-output-meta">
        Classified {new Date(gapTriage.checkedAt).toLocaleString()}{gapTriage.model ? ` · ${gapTriage.model}` : ''}
      </div>}
    </section>
  );
}

export default function WorkOutputsPanel({ task, userName, onClose, onBusyChange }) {
  const [investigation, setInvestigation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [batch, setBatch] = useState(false);
  const [gapBatch, setGapBatch] = useState(false);
  const [errors, setErrors] = useState({});
  const [flashes, setFlashes] = useState({});
  const [progress, setProgress] = useState({});
  const [messages, setMessages] = useState({});
  const [quickNotes, setQuickNotes] = useState({});
  const [gapOutcomes, setGapOutcomes] = useState({});
  const [triageLive, setTriageLive] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [reload, setReload] = useState(0);
  const contextRef = useRef(null);
  const actionRef = useRef(false);
  const navigate = useNavigate();

  const execute = useCallback(async (context, area, mode, focus, instruction) => {
    if (!context.alive || context.requestId) return null;
    const requestId = crypto.randomUUID();
    context.requestId = requestId;
    setBusy(area);
    setErrors(previous => ({ ...previous, [area]: '' }));
    setFlashes(previous => ({ ...previous, [area]: '' }));
    setMessages(previous => ({ ...previous, [area]: [] }));
    setGapOutcomes({});
    setProgress(previous => ({ ...previous, [area]: { label: 'Starting this area...' } }));
    try {
      const result = await workOutputRun({ investigationId: context.id, area, mode, focus, instruction, requestId, userName });
      if (!context.alive) return null;
      if (!result?.investigation) throw new Error(result?.error || 'No saved output state was returned.');
      setInvestigation(result.investigation);
      if (!result.ok) setErrors(previous => ({ ...previous, [area]: result.error || 'This area failed.' }));
      return result.investigation;
    } catch (error) {
      if (context.alive) setErrors(previous => ({ ...previous, [area]: error.message || String(error) }));
      return null;
    } finally {
      context.requestId = null;
      if (context.alive) setBusy(null);
    }
  }, [userName]);

  // Gap work shares the single-flight request slot with output runs; the service also refuses to
  // run both at once. Saved failures come back in the investigation, so only thrown errors show here.
  const executeGap = useCallback(async (context, gapKey = null) => {
    if (!context.alive || context.requestId) return null;
    const requestId = crypto.randomUUID();
    context.requestId = requestId;
    setBusy('gaps');
    if (!gapKey) setTriageLive(false);
    setProgress(previous => ({ ...previous, gaps: { label: gapKey ? 'Starting gap research...' : 'Classifying open gaps...', gapKey } }));
    try {
      const result = gapKey
        ? await workOutputGapResearch({ investigationId: context.id, gapKey, requestId, userName })
        : await workOutputGapTriage({ investigationId: context.id, requestId });
      if (!context.alive) return null;
      if (!result?.investigation) throw new Error(result?.error || 'No saved gap state was returned.');
      setInvestigation(result.investigation);
      if (!gapKey && !result.ok) setTriageLive(true);
      return result;
    } catch (error) {
      if (context.alive) setErrors(previous => ({ ...previous, gaps: error.message || String(error) }));
      return null;
    } finally {
      context.requestId = null;
      if (context.alive) setBusy(null);
    }
  }, [userName]);

  // Classification follows output runs automatically. A failed classification waits for Retry, and
  // research always waits for the user.
  const autoTriage = useCallback(async (context, latest) => {
    if (!context.alive || context.halt || !(latest.gapTriage?.untriaged > 0) || latest.gapTriage.error) return null;
    setErrors(previous => ({ ...previous, gaps: '' }));
    setFlashes(previous => ({ ...previous, gaps: '' }));
    setMessages(previous => ({ ...previous, gaps: [] }));
    return executeGap(context);
  }, [executeGap]);

  useEffect(() => {
    const context = { alive: true, id: null, requestId: null, halt: false };
    contextRef.current = context;
    const unsubscribe = onWorkOutputProgress(event => {
      if (!context.alive || event.requestId !== context.requestId || event.investigationId !== context.id) return;
      setProgress(previous => ({ ...previous, [event.area]: event }));
      setMessages(previous => ({ ...previous, [event.area]: [...(previous[event.area] || []), [event.label, event.error].filter(Boolean).join(' ')].slice(-30) }));
    });
    setLoading(true);
    setErrors({});
    const initialize = async () => {
      try {
        const result = await workOutputOpen({ task });
        if (!context.alive) return;
        if (!result?.ok || !result.investigation) throw new Error(result?.error || 'Could not open saved work outputs.');
        context.id = result.investigation.id;
        let latest = result.investigation;
        setInvestigation(latest);
        setLoading(false);
        setBatch(true);
        let completed = true;
        for (const area of latest.defaultAreas) {
          if (!context.alive || context.halt) { completed = false; break; }
          if (latest.outputs.find(output => output.area === area).status !== 'idle') continue;
          const next = await execute(context, area, 'generate');
          if (next) latest = next;
          else { completed = false; break; }
        }
        if (completed) await autoTriage(context, latest);
      } catch (error) {
        if (context.alive) setErrors(previous => ({ ...previous, panel: error.message || String(error) }));
      } finally {
        if (context.alive) { setLoading(false); setBatch(false); }
      }
    };
    initialize();
    return () => {
      context.alive = false;
      context.halt = true;
      unsubscribe();
      if (context.id && context.requestId) workOutputCancel({ investigationId: context.id }).then(result => {
        if (!result?.ok) console.error('Could not stop work output:', result?.error);
      }, error => console.error('Could not stop work output:', error));
    };
  }, [task, execute, autoTriage, reload]);

  useEffect(() => {
    onBusyChange(Boolean(busy || loading || batch || gapBatch));
    return () => onBusyChange(false);
  }, [busy, loading, batch, gapBatch, onBusyChange]);
  const retryAt = Math.max(0, ...(investigation?.outputs || []).map(output => output.error?.retryAt || 0),
    investigation?.gapTriage?.error?.retryAt || 0, ...(investigation?.gaps || []).map(gap => gap.error?.retryAt || 0));
  useEffect(() => {
    if (retryAt <= Date.now()) return undefined;
    const timer = setInterval(() => {
      setClock(Date.now());
      if (Date.now() >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  const stop = async () => {
    const context = contextRef.current;
    if (!context) return true;
    context.halt = true;
    try {
      if (context.id && context.requestId) {
        const result = await workOutputCancel({ investigationId: context.id });
        if (!result?.ok) throw new Error(result?.error || 'Could not stop the active area.');
      }
      return true;
    } catch (error) {
      setErrors(previous => ({ ...previous, panel: error.message || String(error) }));
      return false;
    }
  };
  const run = async (area, mode, focus, instruction) => {
    const context = contextRef.current;
    if (!context || batch || gapBatch || actionRef.current || context.requestId || context.batching) return;
    context.halt = false;
    const latest = await execute(context, area, mode, focus, instruction);
    if (latest) await autoTriage(context, latest);
  };
  const perform = async (area, operation) => {
    if (actionRef.current || contextRef.current?.requestId || contextRef.current?.batching || batch || gapBatch) return;
    actionRef.current = true;
    setBusy(`action:${area}`);
    setErrors(previous => ({ ...previous, [area]: '' }));
    setFlashes(previous => ({ ...previous, [area]: '' }));
    try {
      const message = await operation();
      if (contextRef.current?.alive) setFlashes(previous => ({ ...previous, [area]: message }));
    } catch (error) {
      if (contextRef.current?.alive) setErrors(previous => ({ ...previous, [area]: error.message || String(error) }));
    } finally {
      actionRef.current = false;
      if (contextRef.current?.alive) setBusy(null);
    }
  };
  // Read-only actions do not take the request slot, so they stay available while research runs.
  const quick = async (key, operation) => {
    setQuickNotes(previous => ({ ...previous, [key]: null }));
    try {
      const text = await operation();
      if (contextRef.current?.alive && text) setQuickNotes(previous => ({ ...previous, [key]: { text, error: false } }));
    } catch (error) {
      if (contextRef.current?.alive) setQuickNotes(previous => ({ ...previous, [key]: { text: error.message || String(error), error: true } }));
    }
  };
  // Retries failed areas in display order and stops at the first one that fails again, so an
  // expired sign-in or a cooldown is not repeated across the remaining areas.
  const retryFailed = async () => {
    const context = contextRef.current;
    if (!context?.id || !investigation || batch || gapBatch || actionRef.current || context.requestId || context.batching) return;
    context.halt = false;
    context.batching = true;
    setBatch(true);
    let latest = investigation;
    let completed = true;
    try {
      for (const area of AREAS) {
        if (!context.alive || context.halt) { completed = false; break; }
        if (!retryableArea(latest.outputs.find(output => output.area === area), Date.now())) continue;
        const next = await execute(context, area, 'retry');
        if (!next) { completed = false; break; }
        latest = next;
        if (next.outputs.find(output => output.area === area).status === 'failed') { completed = false; break; }
      }
      if (completed) await autoTriage(context, latest);
    } finally {
      context.batching = false;
      if (context.alive) setBatch(false);
    }
  };

  const beginGaps = () => {
    const context = contextRef.current;
    if (!context?.id || batch || gapBatch || actionRef.current || context.requestId || context.batching) return null;
    context.halt = false;
    setErrors(previous => ({ ...previous, gaps: '' }));
    setFlashes(previous => ({ ...previous, gaps: '' }));
    setMessages(previous => ({ ...previous, gaps: [] }));
    return context;
  };
  const stopGaps = async () => {
    const context = contextRef.current;
    if (!context) return;
    context.halt = true;
    if (!context.id || !context.requestId) return;
    try {
      const result = await workOutputCancel({ investigationId: context.id, area: 'gaps' });
      if (!result?.ok) throw new Error(result?.error || 'Could not stop gap research.');
    } catch (error) {
      if (context.alive) setErrors(previous => ({ ...previous, gaps: error.message || String(error) }));
    }
  };
  const classifyGaps = async () => {
    const context = beginGaps();
    if (!context) return;
    const result = await executeGap(context);
    if (result?.ok && context.alive) {
      setFlashes(previous => ({ ...previous, gaps: result.classified ? `Classified ${plural(result.classified, 'gap')}.` : 'No gaps needed classification.' }));
    }
  };
  const researchOne = async gapKey => {
    const context = beginGaps();
    if (!context) return;
    setGapOutcomes(previous => ({ ...previous, [gapKey]: null }));
    const result = await executeGap(context, gapKey);
    if (result && context.alive) setGapOutcomes(previous => ({ ...previous, [gapKey]: { ...gapOutcome(result), focus: true } }));
  };
  // Researches queued gaps one at a time, at most MAX_GAP_BATCH per click, and stops at the first
  // failure so a cooldown or permission problem is not repeated across the remaining gaps.
  const researchOpen = async () => {
    const context = beginGaps();
    if (!context) return;
    context.batching = true;
    setGapBatch(true);
    const counts = { answered: 0, partial: 0, still_open: 0 };
    const attempted = new Set();
    let latest = investigation;
    let failure = null;
    try {
      while (attempted.size < MAX_GAP_BATCH && context.alive && !context.halt) {
        const gap = sortGaps(latest.gaps).find(item => queuedGap(item, Date.now()) && !attempted.has(item.key));
        if (!gap) break;
        attempted.add(gap.key);
        setGapOutcomes(previous => ({ ...previous, [gap.key]: null }));
        const result = await executeGap(context, gap.key);
        if (!result) { failure = 'thrown'; break; }
        if (context.alive) setGapOutcomes(previous => ({ ...previous, [gap.key]: gapOutcome(result) }));
        latest = result.investigation;
        if (!result.ok) { failure = 'saved'; break; }
        counts[result.status] = (counts[result.status] || 0) + 1;
      }
    } finally {
      context.batching = false;
      if (context.alive) setGapBatch(false);
    }
    if (!context.alive) return;
    const done = counts.answered + counts.partial + counts.still_open;
    const parts = [
      counts.answered && `${counts.answered} answered`,
      counts.partial && `${counts.partial} partly answered`,
      counts.still_open && `${counts.still_open} still open`,
    ].filter(Boolean);
    const summary = [
      context.halt && 'Gap research stopped.',
      done && `Researched ${plural(done, 'gap')}: ${parts.join(', ')}.`,
      (counts.answered || counts.partial) && 'Outputs that list an answered or partly answered question are marked Needs refresh; refresh them to use the answers.',
    ].filter(Boolean);
    const remaining = latest.gaps.filter(gap => queuedGap(gap, Date.now())).length;
    if (!context.halt && !failure && remaining) summary.push(`${plural(remaining, 'more open gap')} can be researched.`);
    if (summary.length) setFlashes(previous => ({ ...previous, gaps: summary.join(' ') }));
    if (failure === 'saved' && !context.halt) {
      setErrors(previous => ({ ...previous, gaps: 'Gap research stopped at a failure; see the failed gap below.' }));
    }
  };

  const locked = Boolean(busy || batch || gapBatch);
  const areaTitle = Object.fromEntries((investigation?.outputs || []).map(output => [output.area, output.title]));
  const lockReason = !locked ? ''
    : gapBatch || (busy === 'gaps' && progress.gaps?.gapKey) ? 'Waiting for gap research to finish.'
      : busy === 'gaps' ? 'Waiting for gap classification to finish.'
        : busy?.startsWith('action:') ? 'Waiting for the current action to finish.'
          : areaTitle[busy] ? `Waiting for ${areaTitle[busy]} to finish.` : 'Waiting for the queued areas to finish.';

  return (
    <div className="sec-solve work-outputs">
      <div className="sec-solve-head">
        <SparkleRegular /><h3 className="sec-solve-title" tabIndex={-1}>Deep Research — {task.title}</h3>
        <button type="button" className="sec-solve-close" aria-label="Close outputs" disabled={actionRef.current}
          onClick={async () => { if (await stop()) onClose(); }}><DismissRegular /></button>
      </div>
      <p className="work-output-intro">Four focused deliverables, saved independently. A failed area does not erase the others. Technical research runs only when you choose. Open gaps are classified automatically; each is researched only when you choose. Copilot · high reasoning.</p>
      {task.ownership === 'shared' && <p className="work-output-intro">Shared follow-up, not a personal assignment.{task.owner ? ` Owner / coordinating team: ${task.owner}.` : ' The owner is not confirmed.'}</p>}
      {errors.panel && <ErrorBox failure={errors.panel} live />}
      {loading && <Spinner size="small" label="Opening saved outputs..." />}
      {!loading && !investigation && <Button onClick={() => setReload(value => value + 1)}>Retry opening outputs</Button>}
      {investigation && <FailureBanner investigation={investigation} locked={locked} lockReason={lockReason} now={clock}
        retry={retryFailed} openSignIn={target => navigate(SIGN_IN[target])} />}
      {investigation && <div className="work-output-grid">
        {AREAS.map(area => <OutputCard key={area}
          output={investigation.outputs.find(output => output.area === area)} investigation={investigation}
          busy={busy || (batch || gapBatch ? 'queued' : null)} lockReason={lockReason} progress={progress[area]} messages={messages[area]}
          error={errors[area]} flash={flashes[area]} notes={quickNotes} run={run} stop={stop} perform={perform} quick={quick}
          update={setInvestigation} now={clock} />)}
      </div>}
      {investigation?.gaps?.length > 0 && <GapSection investigation={investigation} busy={busy} gapBatch={gapBatch} locked={locked}
        lockReason={lockReason} progress={progress.gaps} messages={messages.gaps} error={errors.gaps} flash={flashes.gaps}
        notes={quickNotes} outcomes={gapOutcomes} triageLive={triageLive} now={clock}
        classify={classifyGaps} research={researchOne} researchOpen={researchOpen} stop={stopGaps} quick={quick} />}
      {investigation && <div className="work-output-footer">
        <Button size="small" disabled={locked || !investigation.outputs.some(output => output.area !== 'reply' && current(output))}
          onClick={() => perform('panel', async () => {
            const latest = await workOutputGet({ investigationId: investigation.id });
            if (!latest?.ok) throw new Error(latest?.error || 'Could not check saved findings.');
            setInvestigation(latest.investigation);
            const findings = latest.investigation.outputs.filter(output => output.area !== 'reply' && current(output));
            if (!findings.length) throw new Error('No current findings are ready to create a workload.');
            const result = await workloadCreate({
              name: task.title, accountName: task.account || null,
              description: findings.map(output => `${output.title}\n${formatOutput(output)}`).join('\n\n'),
            });
            if (!result?.workloadId || result.ok === false) throw new Error(result?.error || 'Could not create the workload.');
            return `Created workload "${task.title}" from the current findings.`;
          })}>Create workload from current findings</Button>
        {locked && <span className="work-output-locked">{lockReason}</span>}
        <span className="ac-muted">Research is read-only. Tasks, workloads and Outlook drafts are created only when you choose.</span>
      </div>}
      {flashes.panel && <div className="sec-flash sec-flash-success" role="status">{flashes.panel}</div>}
    </div>
  );
}
