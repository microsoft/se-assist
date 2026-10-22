import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Textarea, Spinner, Field,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular, DeleteRegular, DismissRegular,
  MailRegular, CalendarLtrRegular, ChatRegular, OpenRegular, EyeOffRegular,
  SparkleRegular, WarningRegular, SaveRegular, InfoRegular, ArrowUndoRegular,
  PersonStarRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { usePersistedState } from '../hooks/usePersistedState';
import { useForceLayout } from '../hooks/useForceLayout';
import { formatLocalDate, formatLocalDateTime } from '../lib/datetime';
import {
  getAccountRoster, influenceMapGet,
  influenceMapAnalyze, influenceOverrideSet, influenceAssessmentClear, openExternal,
} from '../electronBridge';

// Stakeholder Influence Map. Scores come from fixed rules in the main process over one
// roster account's local email, meetings and transcripts; the optional AI pass (GitHub
// Copilot only) judges stance and adopted suggestions, and every quote it returns is checked.

const MAP_WIDTH = 960;
// Approximate height of the four-line hover card, used to keep it inside the canvas.
const TOOLTIP_HEIGHT = 96;
const NOTE_MAX = 500;
const AI_MAX_PEOPLE = 25;
const TOP_PARENT_LEVEL = 861980000;

const STANCES = ['champion', 'blocker', 'neutral', 'unclear'];
const STANCE_LABEL = { champion: 'Champion', blocker: 'Blocker', neutral: 'Neutral', unclear: 'Unclear' };
const STANCE_BADGE = {
  champion: 'badge-success',
  blocker: 'badge-danger',
  neutral: 'badge-secondary',
  unclear: 'badge-warning',
};
const CONFIDENCE_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
const PROVIDER_LABEL = { 'github-copilot': 'GitHub Copilot' };
const AFFILIATION_LABEL = { customer: 'Customer', external: 'Partner / other' };
const AFFILIATION_HINT = {
  customer: 'A CRM contact of this account, or someone at a CRM contact\'s email domain.',
  external: 'Not matched to this account\'s CRM contacts: a partner, a vendor or someone unknown.',
};

const COMPONENTS = [
  {
    key: 'emailReach',
    label: 'Email reach',
    meaning: 'Linked emails they sent, or received on To or Cc.',
  },
  {
    key: 'loopedIn',
    label: 'Looped in',
    meaning: 'How many different people included them, plus the times they were added to a running thread.',
  },
  {
    key: 'initiative',
    label: 'Initiative',
    meaning: 'Email threads they started and meetings they organized.',
  },
  {
    key: 'meetingPresence',
    label: 'Meeting presence',
    meaning: 'Linked meetings they organized, or were invited to and did not decline. The calendar cannot confirm they attended.',
  },
  {
    key: 'conversationPull',
    label: 'Conversation pull',
    meaning: 'How often someone else speaks right after them, and their share of the words, in transcripts of meetings they were part of.',
  },
];

const KIND_ICON = { email: MailRegular, meeting: CalendarLtrRegular, transcript: ChatRegular };
const KIND_LABEL = { email: 'Email', meeting: 'Meeting', transcript: 'Transcript' };
const AI_SOURCE_LABEL = { email: 'Email thread', transcript: 'Transcript' };

function formatDate(value) {
  return formatLocalDate(value, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pct(value) {
  return value == null ? 'n/a' : `${Math.round(Number(value) * 100)}%`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function sharedWith(contact) {
  return [
    contact.emailThreads > 0 && plural(contact.emailThreads, 'email thread', 'email threads'),
    contact.meetings > 0 && plural(contact.meetings, 'meeting', 'meetings'),
  ].filter(Boolean).join(' · ');
}

function nodeRadius(score) {
  return 8 + (Math.max(0, Math.min(100, Number(score) || 0)) / 100) * 16;
}

function errorText(err) {
  return err?.message || String(err);
}

// Why a person has no AI judgement, stated from what the page actually knows.
function missingJudgementText(rank, assessment) {
  if (!assessment) return 'No AI analysis yet. Use Analyze with AI to judge stance from transcripts and email text.';
  if (assessment.error) return 'The saved AI analysis cannot be read, so there is no AI judgement to show.';
  if (rank > AI_MAX_PEOPLE) {
    return `Not judged: the AI looks only at the top ${AI_MAX_PEOPLE} people by score, and this person ranks #${rank}.`;
  }
  if (assessment.stale) {
    return 'Not judged: the account\'s data or your exclusions changed since the last analysis. Analyze again to include this person.';
  }
  return 'The AI returned no judgement for this person. The text it was shown may say too little about them, or they were excluded at the time. Analyze again to include them.';
}

export default function StakeholderInfluence() {
  return (
    <div className="infl-page">
      <div className="page-header">
        <h2>Stakeholder Influence Map</h2>
      </div>
      <InfluenceWorkspace />
    </div>
  );
}

function InfluenceWorkspace() {
  const navigate = useNavigate();
  const [roster, setRoster] = useState({ tpids: [], loading: true, error: '' });
  const [tpid, setTpid] = usePersistedState('influence.tpid', '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [running, setRunning] = useState(() => new Set());
  const [analysisNotices, setAnalysisNotices] = useState({}); // tpid -> { type, account, text }
  const [actionMessage, setActionMessage] = useState(null); // { type, text }
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const currentTpid = useRef('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadRoster = useCallback(async () => {
    setRoster((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await getAccountRoster();
      if (res?.ok === false) throw new Error(res.error || 'unknown error');
      const tpids = Array.isArray(res?.tpids) ? res.tpids.map((value) => String(value)) : [];
      if (mounted.current) setRoster({ tpids, loading: false, error: '' });
    } catch (err) {
      if (mounted.current) {
        setRoster({ tpids: [], loading: false, error: `Account roster unavailable: ${errorText(err)}` });
      }
    }
  }, []);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const customers = useDbQuery(
    "SELECT tpid, name, parenting_level, parent_crm_account_id FROM active_customers WHERE tpid IS NOT NULL AND tpid <> ''",
  );

  // Only roster accounts can be analysed (the main process enforces the same rule).
  // Names follow the Customers page: the group's top parent account.
  const accountOptions = useMemo(() => {
    const byTpid = new Map();
    for (const row of customers.data || []) {
      const key = String(row.tpid);
      if (!byTpid.has(key)) byTpid.set(key, []);
      byTpid.get(key).push(row);
    }
    return roster.tpids
      .map((value) => {
        const rows = byTpid.get(value) || [];
        const top = rows.find((row) => Number(row.parenting_level) === TOP_PARENT_LEVEL)
          || rows.find((row) => !row.parent_crm_account_id)
          || rows[0];
        return { tpid: value, name: top?.name || '' };
      })
      .sort((a, b) => (a.name || a.tpid).localeCompare(b.name || b.tpid, undefined, { sensitivity: 'base' }));
  }, [customers.data, roster.tpids]);

  const accountLabel = useCallback(
    (value) => accountOptions.find((option) => option.tpid === value)?.name || `TPID ${value}`,
    [accountOptions],
  );

  const rosterReady = !roster.loading && !roster.error;
  const activeTpid = rosterReady && roster.tpids.includes(String(tpid || '')) ? String(tpid) : '';

  // A remembered account that has left the roster is cleared, never swapped for another.
  useEffect(() => {
    if (rosterReady && tpid && !roster.tpids.includes(String(tpid))) setTpid('');
  }, [rosterReady, roster.tpids, tpid, setTpid]);

  const loadMap = useCallback(async (target) => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    if (!target) {
      setData(null);
      setLoadError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const res = await influenceMapGet({ tpid: target });
      if (!mounted.current || seq !== loadSeq.current) return;
      if (!res?.ok) throw new Error(res?.error || 'Influence map unavailable.');
      setData(res);
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setData(null);
      setLoadError(errorText(err));
    } finally {
      if (mounted.current && seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    currentTpid.current = activeTpid;
    setSelectedId('');
    setActionMessage(null);
    setData(null);
    loadMap(activeTpid);
  }, [activeTpid, loadMap]);

  // Results of actions that return the whole map apply only to the account they were
  // made for, and supersede any read that is still in flight.
  const applyMap = useCallback((target, res) => {
    if (!mounted.current || target !== currentTpid.current) return false;
    loadSeq.current += 1;
    setData(res);
    setLoadError('');
    setLoading(false);
    return true;
  }, []);

  const notifyAnalysis = useCallback((target, entry) => {
    if (!mounted.current) return;
    setAnalysisNotices((prev) => ({ ...prev, [target]: entry }));
  }, []);

  const dismissAnalysisNotice = useCallback((target) => {
    setAnalysisNotices((prev) => {
      if (!(target in prev)) return prev;
      const next = { ...prev };
      delete next[target];
      return next;
    });
  }, []);

  const setRunningFor = useCallback((target, on) => {
    setRunning((prev) => {
      const next = new Set(prev);
      if (on) next.add(target);
      else next.delete(target);
      return next;
    });
  }, []);

  // The analysis can take minutes. The user can switch accounts meanwhile; the result is
  // reported against the account it ran for, with a button to go back to it.
  const analyze = async () => {
    const target = activeTpid;
    if (!target || running.has(target)) return;
    const account = accountLabel(target);
    dismissAnalysisNotice(target);
    setActionMessage(null);
    setRunningFor(target, true);
    try {
      const res = await influenceMapAnalyze({ tpid: target });
      if (!res?.ok) {
        notifyAnalysis(target, { type: 'error', account, text: res?.error || 'Influence analysis failed.' });
        if (mounted.current && target === currentTpid.current) loadMap(target);
        return;
      }
      applyMap(target, res);
      const meta = res.meta || {};
      const provider = PROVIDER_LABEL[meta.provider] || meta.provider || 'the AI provider';
      notifyAnalysis(target, {
        type: 'success',
        account,
        text: `AI analysis finished on ${provider}${meta.model ? ` (${meta.model})` : ''}: `
          + `${plural(Number(meta.people) || 0, 'person', 'people')} reviewed using `
          + `${plural(Number(meta.transcripts) || 0, 'transcript', 'transcripts')} and `
          + `${plural(Number(meta.emailThreads) || 0, 'email thread', 'email threads')}.`,
      });
    } catch (err) {
      notifyAnalysis(target, { type: 'error', account, text: `Influence analysis failed: ${errorText(err)}` });
      if (mounted.current && target === currentTpid.current) loadMap(target);
    } finally {
      if (mounted.current) setRunningFor(target, false);
    }
  };

  const clearAssessment = async () => {
    const target = activeTpid;
    if (!target) return;
    const confirmed = window.confirm(
      `Delete the saved AI analysis for ${accountLabel(target)}?\n\n`
      + 'Stances the AI suggested and its quotes are removed. Your own corrections, notes and exclusions are kept.',
    );
    if (!confirmed) return;
    setBusy(true);
    setActionMessage(null);
    try {
      const res = await influenceAssessmentClear({ tpid: target });
      if (!res?.ok) throw new Error(res?.error || 'Could not delete the AI analysis.');
      if (applyMap(target, res)) {
        setActionMessage(res.cleared
          ? { type: 'success', text: 'AI analysis deleted. Your corrections, notes and exclusions were kept.' }
          : { type: 'info', text: 'There was no saved AI analysis to delete.' });
      }
    } catch (err) {
      if (mounted.current && target === currentTpid.current) {
        setActionMessage({ type: 'error', text: `Could not delete the AI analysis: ${errorText(err)}` });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // Corrections, notes, exclusions and restores. Returns { ok, error } so the caller can
  // show the failure where the user acted.
  const saveOverride = useCallback(async (personId, patch) => {
    const target = currentTpid.current;
    if (!target) return { ok: false, error: 'No account is selected.' };
    setBusy(true);
    try {
      const res = await influenceOverrideSet({ tpid: target, personId, ...patch });
      if (!res?.ok) return { ok: false, error: res?.error || 'Could not save the change.' };
      applyMap(target, res);
      return { ok: true, map: res };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [applyMap]);

  const excludePerson = async (person) => {
    const confirmed = window.confirm(
      `Exclude ${person.name} from this account's influence map?\n\n`
      + 'They are removed from the map and the ranking, their name and words are withheld from future AI '
      + 'analyses, and their AI judgement is deleted. '
      + 'Other people\'s scores do not change. You can restore them from "Excluded people".',
    );
    if (!confirmed) return { ok: false, cancelled: true };
    const result = await saveOverride(person.id, { hidden: true });
    if (result.ok) {
      setSelectedId('');
      setActionMessage({
        type: 'success',
        text: `${person.name} is excluded. Other people's scores are unchanged. Restore them from "Excluded people" below.`,
      });
    }
    return result;
  };

  const restorePerson = async (person) => {
    setActionMessage(null);
    const result = await saveOverride(person.id, { hidden: false });
    if (result.ok) {
      setActionMessage({
        type: 'success',
        text: result.map?.assessment
          ? `${person.name} is back on the map. Any AI judgement about them was deleted when they were excluded; analyze again to include them.`
          : `${person.name} is back on the map.`,
      });
    } else {
      setActionMessage({ type: 'error', text: `Could not restore ${person.name}: ${result.error}` });
    }
  };

  const people = data?.people || [];
  const selectedIndex = people.findIndex((person) => person.id === selectedId);
  const selectedPerson = selectedIndex >= 0 ? people[selectedIndex] : null;
  const isRunning = activeTpid ? running.has(activeTpid) : false;
  const copilotConnected = data?.copilotConnected === true;
  const totalPeople = Number(data?.totalPeople) || 0;
  const analyzeDisabled = !data || isRunning || data.analyzing === true || !copilotConnected
    || totalPeople === 0 || busy;
  const noticeEntries = Object.entries(analysisNotices);
  const runningElsewhere = [...running].filter((value) => value !== activeTpid);

  return (
    <>
      <div className="flash-message flash-info infl-flash">
        <InfoRegular />
        <span>
          <strong>Inferred signals, not facts.</strong> Scores come from who emails, invites and speaks
          with whom in this account&apos;s linked data. They miss hallway conversations, calls without
          transcripts and anything not linked to the account. Check the evidence before you act on it.
        </span>
      </div>

      <div className="org-toolbar infl-toolbar">
        {roster.error ? (
          <div className="flash-message flash-error infl-flash">
            <span>{roster.error}</span>
            <Button size="small" icon={<ArrowClockwiseRegular />} onClick={loadRoster}>Retry</Button>
          </div>
        ) : roster.loading ? (
          <Spinner size="tiny" label="Loading your accounts…" />
        ) : roster.tpids.length === 0 ? (
          <div className="flash-message flash-warning infl-flash">
            <span>Your account roster is empty, so there is no account to map.</span>
            <Button size="small" onClick={() => navigate('/settings?section=accounts')}>Open account roster</Button>
          </div>
        ) : (
          <>
            <Field label="Account" className="org-field-grow">
              <Select value={activeTpid} onChange={(_event, value) => setTpid(value.value)}>
                <option value="">Select an account…</option>
                {accountOptions.map((option) => (
                  <option key={option.tpid} value={option.tpid}>
                    {option.name ? `${option.name} · ${option.tpid}` : `TPID ${option.tpid}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              icon={loading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
              disabled={!activeTpid || loading}
              onClick={() => loadMap(activeTpid)}
            >
              Refresh
            </Button>
            <Button
              appearance="primary"
              icon={isRunning ? <Spinner size="tiny" /> : <SparkleRegular />}
              disabled={analyzeDisabled}
              onClick={analyze}
            >
              {isRunning ? 'Analyzing…' : 'Analyze with AI'}
            </Button>
            <Button
              icon={<DeleteRegular />}
              disabled={!data?.assessment || isRunning || data?.analyzing === true || busy}
              onClick={clearAssessment}
            >
              Delete AI analysis
            </Button>
          </>
        )}
      </div>
      {customers.error && (
        <div className="flash-message flash-error infl-flash">
          <span>Account names unavailable: {errorText(customers.error)}. Accounts are listed by TPID.</span>
        </div>
      )}

      {isRunning && (
        <div className="flash-message flash-info infl-flash">
          <Spinner size="tiny" />
          <span>
            Analyzing {accountLabel(activeTpid)} with AI. This can take a few minutes; you can switch
            accounts meanwhile and the result is reported here.
          </span>
        </div>
      )}

      {runningElsewhere.map((value) => (
        <div key={`running-${value}`} className="flash-message flash-info infl-flash">
          <Spinner size="tiny" />
          <span>Analyzing {accountLabel(value)} with AI. You can keep working; the result is reported here.</span>
          <Button size="small" onClick={() => setTpid(value)}>Show</Button>
        </div>
      ))}

      {noticeEntries.map(([value, entry]) => (
        <div key={`notice-${value}`} className={`flash-message flash-${entry.type} infl-flash`}>
          <span>
            {value !== activeTpid ? <strong>{entry.account}: </strong> : null}
            {entry.text}
          </span>
          {value !== activeTpid && <Button size="small" onClick={() => setTpid(value)}>Show</Button>}
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            aria-label="Dismiss"
            onClick={() => dismissAnalysisNotice(value)}
          />
        </div>
      ))}

      {actionMessage && (
        <div className={`flash-message flash-${actionMessage.type} infl-flash`}>
          <span>{actionMessage.text}</span>
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            aria-label="Dismiss"
            onClick={() => setActionMessage(null)}
          />
        </div>
      )}

      {!roster.error && !roster.loading && roster.tpids.length > 0 && !activeTpid && (
        <div className="card">
          <div className="card-body-custom org-empty">
            Select one of your roster accounts to map who influences its decisions.
          </div>
        </div>
      )}

      {activeTpid && loadError && (
        <div className="flash-message flash-error infl-flash">
          <span>{loadError}</span>
          <Button size="small" icon={<ArrowClockwiseRegular />} onClick={() => loadMap(activeTpid)}>Retry</Button>
        </div>
      )}

      {activeTpid && !data && !loadError && loading && (
        <div className="org-empty"><Spinner size="small" label="Reading this account's email, meetings and transcripts…" /></div>
      )}

      {activeTpid && data && (
        <>
          {!copilotConnected && (
            <div className="flash-message flash-warning infl-flash">
              <WarningRegular />
              <span>
                The AI analysis runs only on GitHub Copilot, and Copilot is not connected. The scores and
                evidence below do not need AI.
              </span>
              <Button size="small" onClick={() => navigate('/settings?section=model')}>Connect GitHub Copilot</Button>
            </div>
          )}

          {data.analyzing === true && !isRunning && (
            <div className="flash-message flash-info infl-flash">
              <Spinner size="tiny" />
              <span>An AI analysis started earlier is still running for this account. Refresh when it finishes.</span>
            </div>
          )}

          <SourcesSummary sources={data.sources} />

          <AssessmentCard assessment={data.assessment} totalPeople={totalPeople} />

          {totalPeople === 0 ? (
            <div className="card">
              <div className="card-body-custom org-empty">
                {data.hiddenPeople?.length
                  ? 'Everyone found for this account is excluded. Restore people from "Excluded people" below.'
                  : 'No people outside Microsoft were found in this account\'s linked email, meetings or transcripts yet. '
                    + 'Pulled email and meetings are linked to accounts during ingestion.'}
              </div>
            </div>
          ) : (
            <>
              <section className="card org-rel-section">
                <div className="card-header-custom">
                  <div>
                    <div className="infl-card-title"><PersonStarRegular /> Influence web</div>
                    <div className="org-rel-subtitle">
                      Who works with whom on {data.account || accountLabel(activeTpid)}. Larger nodes score higher.
                    </div>
                  </div>
                </div>
                <div className="card-body-custom infl-map-body">
                  <InfluenceGraph
                    key={activeTpid}
                    map={data.map}
                    totalPeople={totalPeople}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              </section>

              <Highlights people={people} onSelect={setSelectedId} />

              <RankedTable
                people={people}
                totalPeople={totalPeople}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </>
          )}

          <ExcludedPeople
            people={data.hiddenPeople || []}
            busy={busy}
            onRestore={restorePerson}
          />

          {selectedPerson && (
            <PersonDrawer
              key={`${activeTpid}|${selectedPerson.id}`}
              person={selectedPerson}
              rank={selectedIndex + 1}
              assessment={data.assessment}
              weights={data.weights}
              busy={busy}
              onClose={() => setSelectedId('')}
              onSave={saveOverride}
              onExclude={excludePerson}
            />
          )}
        </>
      )}
    </>
  );
}

function SourcesSummary({ sources }) {
  if (!sources) return null;
  const n = (key) => Number(sources[key]) || 0;
  const ignored = [
    n('broadcastEmails') ? plural(n('broadcastEmails'), 'broadcast email', 'broadcast emails') : '',
    n('broadcastMeetings') ? plural(n('broadcastMeetings'), 'broadcast meeting', 'broadcast meetings') : '',
    n('broadcastTranscripts')
      ? plural(n('broadcastTranscripts'), 'broadcast meeting transcript', 'broadcast meeting transcripts')
      : '',
    n('cancelledMeetings') ? plural(n('cancelledMeetings'), 'cancelled meeting', 'cancelled meetings') : '',
    n('duplicateEmails') ? plural(n('duplicateEmails'), 'duplicate email copy', 'duplicate email copies') : '',
  ].filter(Boolean);
  const broadcasts = n('broadcastEmails') + n('broadcastMeetings') + n('broadcastTranscripts');
  return (
    <div className="infl-sources">
      <span>
        Read {plural(n('emails'), 'linked email', 'linked emails')} in {plural(n('emailThreads'), 'thread', 'threads')},
        {' '}{plural(n('meetings'), 'meeting', 'meetings')} and {plural(n('transcripts'), 'transcript', 'transcripts')}
        {' '}({plural(n('transcriptTurns'), 'speaking turn', 'speaking turns')}) from this device.
      </span>
      {ignored.length > 0 && (
        <span>
          Ignored {ignored.join(', ')}.
          {broadcasts > 0 ? ' Broadcasts have more than 20 recipients or invitees, so they say little about influence.' : ''}
        </span>
      )}
      {n('unresolvedSpeakers') > 0 && (
        <span>
          {plural(n('unresolvedSpeakers'), 'transcript speaker name', 'transcript speaker names')} could not be
          matched to a person, so those turns count for no one.
        </span>
      )}
    </div>
  );
}

function AssessmentCard({ assessment, totalPeople }) {
  if (!assessment) {
    if (!totalPeople) return null;
    return (
      <div className="infl-assessment">
        <div className="infl-assessment-head"><SparkleRegular /> No AI analysis yet</div>
        <div className="infl-muted">
          Stances shown are only your own corrections. Analyze with AI to have GitHub Copilot judge who
          is a champion or a blocker, and whose suggestions were adopted, for the top {AI_MAX_PEOPLE} people,
          with quotes checked against the source. Copilot gets their names, scores and signals, and excerpts
          of the related emails and transcripts, with email addresses removed.
        </div>
      </div>
    );
  }
  const provider = PROVIDER_LABEL[assessment.provider] || assessment.provider || 'Unknown provider';
  const when = formatLocalDateTime(assessment.analyzedAt);
  return (
    <div className="infl-assessment">
      <div className="infl-assessment-head">
        <SparkleRegular /> AI analysis
        <span className="infl-muted">
          {provider}{assessment.model ? ` · ${assessment.model}` : ''}{when ? ` · ${when}` : ''}
        </span>
      </div>
      {assessment.error && (
        <div className="flash-message flash-error infl-flash"><span>{assessment.error}</span></div>
      )}
      {!assessment.error && assessment.stale && (
        <div className="flash-message flash-warning infl-flash">
          <span>
            This account&apos;s data or your exclusions changed since this analysis, so it may not cover the
            current top {AI_MAX_PEOPLE}. Analyze again to bring it up to date.
          </span>
        </div>
      )}
      {!assessment.error && assessment.caveats?.length > 0 && (
        <>
          <div className="org-rel-detail-label infl-gap-top">Caveats from the AI</div>
          <ul className="infl-caveats">
            {assessment.caveats.map((caveat, index) => <li key={index}>{caveat}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function stanceClass(stance) {
  return STANCES.includes(stance) ? stance : 'none';
}

function InfluenceGraph({ map, totalPeople, selectedId, onSelect }) {
  const nodes = map?.nodes || [];
  const edges = map?.edges || [];
  const [hover, setHover] = useState(null); // { id, x, y } — canvas-relative
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const panRef = useRef(null);
  const canvasRef = useRef(null);
  const svgRef = useRef(null);

  const height = Math.max(420, Math.min(760, 300 + nodes.length * 9));
  const positions = useForceLayout(nodes, edges, MAP_WIDTH, height);

  const activeId = hover?.id || selectedId || '';
  const neighbourIds = useMemo(() => {
    if (!activeId || !nodes.some((node) => node.id === activeId)) return null;
    const set = new Set([activeId]);
    for (const edge of edges) {
      if (edge.source === activeId) set.add(edge.target);
      if (edge.target === activeId) set.add(edge.source);
    }
    return set;
  }, [activeId, edges, nodes]);

  // Native listener so preventDefault works (React's onWheel is passive).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setView((prev) => ({
        ...prev,
        scale: Math.min(3, Math.max(0.4, prev.scale * (e.deltaY < 0 ? 1.12 : 0.89))),
      }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [nodes.length]);

  // The pan record outlives mouseup so the click that ends a drag is not taken as a selection.
  const onMouseDown = (e) => {
    panRef.current = { startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false, active: true };
  };
  const onMouseMove = (e) => {
    const pan = panRef.current;
    if (!pan?.active) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    setView((prev) => ({ ...prev, x: pan.originX + dx, y: pan.originY + dy }));
  };
  const endPan = () => {
    if (panRef.current) panRef.current.active = false;
  };

  if (!nodes.length) {
    return <div className="org-empty">No one to draw yet.</div>;
  }

  const hovered = hover ? nodes.find((node) => node.id === hover.id) : null;

  return (
    <div className="org-rel-wrap">
      <div className="org-rel-summary infl-legend">
        <span><i className="infl-dot infl-dot-champion" /> Champion</span>
        <span><i className="infl-dot infl-dot-blocker" /> Blocker</span>
        <span><i className="infl-dot infl-dot-neutral" /> Neutral</span>
        <span><i className="infl-dot infl-dot-unclear" /> Unclear</span>
        <span><i className="infl-dot infl-dot-none" /> No stance yet</span>
        <span><i className="infl-dot infl-dot-hidden" /> Hidden influencer</span>
        <span>Lines: shared email threads, meetings and transcripts (transcripts count double)</span>
      </div>

      <div className="org-rel-canvas" ref={canvasRef}>
        <svg
          ref={svgRef}
          className="org-rel-map"
          viewBox={`0 0 ${MAP_WIDTH} ${height}`}
          role="img"
          aria-label="Stakeholder influence web"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endPan}
          onMouseLeave={() => { endPan(); setHover(null); }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <g className="org-rel-edges">
              {edges.map((edge) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target) return null;
                const dim = neighbourIds && !(neighbourIds.has(edge.source) && neighbourIds.has(edge.target));
                return (
                  <line
                    key={`${edge.source}|${edge.target}`}
                    className={dim ? 'is-dim' : ''}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    strokeWidth={Math.min(6, 1 + Math.log2(edge.total + 1))}
                  >
                    <title>
                      {`${plural(edge.email, 'email thread', 'email threads')}, ${plural(edge.meeting, 'meeting', 'meetings')}, ${plural(edge.transcript, 'transcript', 'transcripts')} together`}
                    </title>
                  </line>
                );
              })}
            </g>

            {nodes.map((node) => {
              const point = positions.get(node.id);
              if (!point) return null;
              const radius = nodeRadius(node.score);
              const dim = neighbourIds && !neighbourIds.has(node.id);
              const isSelected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  transform={`translate(${point.x} ${point.y})`}
                  className={`org-rel-node infl-node infl-stance-${stanceClass(node.stance)}${dim ? ' is-dim' : ''}${isSelected ? ' is-selected' : ''}`}
                  onMouseEnter={(e) => {
                    const box = canvasRef.current?.getBoundingClientRect();
                    setHover({
                      id: node.id,
                      x: box ? e.clientX - box.left : 0,
                      y: box ? e.clientY - box.top : 0,
                    });
                  }}
                  onMouseLeave={() => setHover((prev) => (prev?.id === node.id ? null : prev))}
                  onClick={() => { if (!panRef.current?.moved) onSelect(node.id); }}
                  style={{ cursor: 'pointer' }}
                >
                  {node.hiddenInfluencer && <circle className="infl-hidden-ring" r={radius + 5} />}
                  <circle className="infl-core" r={radius} />
                  <text className="org-rel-label" textAnchor="middle" y={radius + 15}>{node.name}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {hover && hovered && (
          <div
            className="org-rel-tooltip"
            style={{
              left: Math.max(0, Math.min(hover.x + 16, (canvasRef.current?.clientWidth || MAP_WIDTH) - 260)),
              // Flip above the pointer near the bottom edge; the card clips overflow.
              top: hover.y + 16 + TOOLTIP_HEIGHT > (canvasRef.current?.clientHeight || height)
                ? Math.max(0, hover.y - TOOLTIP_HEIGHT - 8)
                : hover.y + 16,
            }}
          >
            <div className="org-rel-tooltip-name">{hovered.name}</div>
            <div className="org-rel-tooltip-head">
              Score {hovered.score} · {AFFILIATION_LABEL[hovered.affiliation] || 'Unknown'}
            </div>
            <div className="org-rel-tooltip-head">
              {hovered.stance ? STANCE_LABEL[hovered.stance] || hovered.stance : 'No stance yet'}
              {hovered.hiddenInfluencer ? ' · Hidden influencer' : ''}
            </div>
            <div className="org-rel-tooltip-empty">Click for the evidence.</div>
          </div>
        )}
      </div>

      <div className="org-rel-hint">
        {nodes.length < totalPeople
          ? `Showing the top ${nodes.length} of ${totalPeople} people by score. `
          : ''}
        Scroll to zoom, drag to pan, click a person for the evidence behind their score.
      </div>
    </div>
  );
}

function StanceBadge({ person }) {
  if (!person.stance) return <span className="infl-muted">—</span>;
  const source = person.stanceSource === 'you' ? 'you' : (person.stanceSource === 'ai' ? 'AI' : '');
  return (
    <span className="infl-stance">
      <span className={`badge ${STANCE_BADGE[person.stance] || 'badge-secondary'}`}>
        {STANCE_LABEL[person.stance] || person.stance}
      </span>
      {source && <span className="infl-muted" title={source === 'you' ? 'Your correction' : 'Suggested by the AI analysis'}>{source}</span>}
    </span>
  );
}

function ScoreBar({ score }) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return (
    <span className="infl-score" title={`Influence score ${value} of 100, relative to this account`}>
      <span className="infl-score-track"><span className="infl-score-fill" style={{ width: `${value}%` }} /></span>
      <span className="infl-score-value">{value}</span>
    </span>
  );
}

function PersonChip({ person, onSelect }) {
  return (
    <button type="button" className="infl-chip" onClick={() => onSelect(person.id)}>
      <span className="infl-chip-name">{person.name}</span>
      <span className="infl-muted">
        {person.score}
        {person.stanceSource === 'you' ? ' · you' : (person.stanceSource === 'ai' ? ' · AI' : '')}
      </span>
    </button>
  );
}

function Highlights({ people, onSelect }) {
  const groups = [
    {
      key: 'champion',
      title: 'Champions',
      people: people.filter((person) => person.stance === 'champion'),
      empty: 'None yet. Stances come from your corrections or the AI analysis.',
    },
    {
      key: 'blocker',
      title: 'Blockers',
      people: people.filter((person) => person.stance === 'blocker'),
      empty: 'None yet. Stances come from your corrections or the AI analysis.',
    },
    {
      key: 'hidden',
      title: 'Hidden influencers',
      people: people.filter((person) => person.hiddenInfluencer),
      empty: 'None found. See "Why this score" on a person for the rule.',
    },
  ];
  return (
    <div className="infl-highlights">
      {groups.map((group) => (
        <section key={group.key} className="card infl-highlight">
          <div className="card-header-custom infl-card-title">
            <i className={`infl-dot infl-dot-${group.key}`} /> {group.title}
            <span className="infl-muted">{group.people.length || ''}</span>
          </div>
          <div className="card-body-custom">
            {group.people.length ? (
              <div className="infl-chips">
                {group.people.map((person) => <PersonChip key={person.id} person={person} onSelect={onSelect} />)}
              </div>
            ) : (
              <div className="org-rel-detail-empty">{group.empty}</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function RankedTable({ people, totalPeople, selectedId, onSelect }) {
  const onKey = (event, id) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
    }
  };
  return (
    <section className="card">
      <div className="card-header-custom">
        <div>
          <div className="infl-card-title">Ranking</div>
          <div className="org-rel-subtitle">
            Scores are relative to everyone outside Microsoft on this account, so 100 is the strongest signal here,
            not an absolute measure.
          </div>
        </div>
      </div>
      <div className="card-body-custom infl-table-wrap">
        <table className="data-table infl-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Person</th>
              <th>Affiliation</th>
              <th>Score</th>
              <th>Stance</th>
              <th>Signals</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person, index) => (
              <tr
                key={person.id}
                className={`infl-row${person.id === selectedId ? ' is-selected' : ''}`}
                tabIndex={0}
                onClick={() => onSelect(person.id)}
                onKeyDown={(event) => onKey(event, person.id)}
              >
                <td className="infl-muted">{index + 1}</td>
                <td>
                  <div className="infl-person-name">{person.name}</div>
                  {person.title && <div className="infl-muted">{person.title}</div>}
                </td>
                <td title={AFFILIATION_HINT[person.affiliation] || ''}>
                  {AFFILIATION_LABEL[person.affiliation] || 'Unknown'}
                </td>
                <td><ScoreBar score={person.score} /></td>
                <td><StanceBadge person={person} /></td>
                <td>
                  <div className="infl-tags">
                    {person.hiddenInfluencer && <span className="badge infl-badge-hidden">Hidden influencer</span>}
                    {(person.tags || []).map((tag) => <span key={tag.id} className="badge badge-info">{tag.label}</span>)}
                  </div>
                </td>
                <td className="infl-muted">{person.evidenceTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {people.length < totalPeople && (
          <div className="org-rel-hint">
            Showing the top {people.length} of {totalPeople} people. Excluding people you don&apos;t need makes room
            for the next ones.
          </div>
        )}
      </div>
    </section>
  );
}

function ExcludedPeople({ people, busy, onRestore }) {
  if (!people.length) return null;
  return (
    <section className="card">
      <div className="card-header-custom">
        <div>
          <div className="infl-card-title"><EyeOffRegular /> Excluded people</div>
          <div className="org-rel-subtitle">
            Not shown or ranked. The AI sees them only as &quot;Hidden participant&quot;, without their words, though
            other people&apos;s messages may still mention them. Excluding someone does not change anyone else&apos;s score.
          </div>
        </div>
      </div>
      <div className="card-body-custom">
        <ul className="infl-excluded">
          {people.map((person) => (
            <li key={person.id}>
              <span>
                {person.name}
                <span className="infl-muted">
                  {person.affiliation
                    ? ` · ${AFFILIATION_LABEL[person.affiliation] || person.affiliation}`
                    : ' · no longer in this account\'s data'}
                </span>
              </span>
              <Button size="small" icon={<ArrowUndoRegular />} disabled={busy} onClick={() => onRestore(person)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const TAG_MEANING = {
  'frequently-looped-in': 'Their looped-in signal is at least 75% of the strongest on this account.',
  'convenes-meetings': 'They organized two or more linked meetings and their initiative is at least 50%.',
  'draws-responses': 'Their conversation pull is at least 60%: others often speak right after them.',
  'quiet-observer': 'They were in two or more transcripts where every speaker was identified, never spoke and sent no email.',
};

const SIGNAL_ROWS = [
  { key: 'sent', label: 'Emails sent' },
  { key: 'threadsStarted', label: 'Threads started', hint: 'They sent the first pulled message of the thread.' },
  { key: 'to', label: 'Emails on To' },
  { key: 'cc', label: 'Emails on Cc' },
  { key: 'loopedInBy', label: 'People who included them' },
  { key: 'addedMidThread', label: 'Added to a running thread' },
  { key: 'organized', label: 'Meetings organized' },
  {
    key: 'invited',
    label: 'Meeting invitations',
    format: (value, signals) => `${value} (${signals.required} required, ${signals.optional} optional)`,
  },
  { key: 'accepted', label: 'Invitations accepted' },
  { key: 'declined', label: 'Invitations declined' },
  { key: 'invitedBy', label: 'Organizers who invited them' },
  { key: 'meetings', label: 'Meetings counted', hint: 'Organized, or invited to and not declined.' },
  { key: 'transcripts', label: 'Transcripts they spoke in' },
  { key: 'turns', label: 'Speaking turns' },
  { key: 'words', label: 'Words spoken' },
  {
    key: 'wordShare',
    label: 'Share of words',
    hint: 'Their words as a share of all words in transcripts of meetings they were part of.',
    format: (value, signals) => (signals.covered ? pct(value) : 'n/a'),
  },
  { key: 'responsesDrawn', label: 'Times someone spoke next' },
  { key: 'respondents', label: 'Different next speakers' },
  {
    key: 'attributedMeetings',
    label: 'Fully attributed transcripts',
    hint: 'Transcripts of their meetings where every speaker was identified, so silence can be observed.',
  },
];

function ComponentBars({ person, weights }) {
  const components = person.components || {};
  const activeWeight = COMPONENTS.reduce(
    (sum, component) => sum + (components[component.key] == null ? 0 : Number(weights?.[component.key]) || 0),
    0,
  );
  return (
    <div className="infl-components">
      {COMPONENTS.map((component) => {
        const value = components[component.key];
        const share = value == null || activeWeight <= 0 ? null : (Number(weights?.[component.key]) || 0) / activeWeight;
        return (
          <div key={component.key} className="infl-component">
            <div className="infl-component-head">
              <span className="infl-component-label">{component.label}</span>
              <span className="infl-muted">
                {value == null ? 'n/a — no transcript covers them' : `${pct(value)} · counts for ${pct(share)}`}
              </span>
            </div>
            <div className="infl-bar">
              <span className="infl-bar-fill" style={{ width: value == null ? 0 : `${Math.round(value * 100)}%` }} />
            </div>
            <div className="infl-component-meaning">{component.meaning}</div>
          </div>
        );
      })}
      <div className="org-rel-hint">
        Each signal is measured against the strongest person on this account, and reaches 100% only with enough
        observations, so one email or meeting never reads as full strength.
        {person.scoreBasis === 'no-transcripts'
          ? ' No transcript covers this person, so the other four signals are re-weighted to make up the score.'
          : ''}
      </div>
    </div>
  );
}

function SourceOpenButton({ link, onOpen }) {
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={<OpenRegular />}
      disabled={!link}
      title={link ? 'Open in Outlook or Teams' : 'No link was stored for this item'}
      onClick={() => onOpen(link)}
    >
      Open
    </Button>
  );
}

function QuoteBadge({ quote, verified }) {
  if (!quote) return <span className="badge badge-secondary">No quote given</span>;
  return verified
    ? <span className="badge badge-success" title="Found word for word in the text the AI was shown">Verified</span>
    : <span className="badge badge-warning" title="Not found word for word in the text the AI was shown">Could not confirm in the source</span>;
}

function SourceLine({ source, onOpen }) {
  const date = formatDate(source?.date);
  return (
    <span className="infl-source-line">
      <span className="infl-muted">
        {AI_SOURCE_LABEL[source?.kind] || source?.kind || 'Source'}: {source?.title || '(no subject)'}
        {date ? ` · ${date}` : ''}
      </span>
      <SourceOpenButton link={source?.webLink} onOpen={onOpen} />
    </span>
  );
}

function AiJudgement({ person, rank, assessment, onOpen }) {
  const { ai } = person;
  if (!ai) return <div className="org-rel-detail-empty">{missingJudgementText(rank, assessment)}</div>;
  return (
    <div className="infl-ai">
      <div className="infl-ai-head">
        <span className={`badge ${STANCE_BADGE[ai.stance] || 'badge-secondary'}`}>{STANCE_LABEL[ai.stance] || ai.stance}</span>
        <span className="infl-muted">{CONFIDENCE_LABEL[ai.confidence] || ai.confidence}</span>
        {ai.decisionRole && <span className="badge badge-info">{ai.decisionRole}</span>}
      </div>
      <p className="infl-ai-reason">{ai.reason}</p>
      {person.override?.stance && person.override.stance !== ai.stance && (
        <div className="infl-muted">
          Your correction ({STANCE_LABEL[person.override.stance]}) is shown instead of the AI&apos;s stance.
        </div>
      )}
      {assessment?.stale && (
        <div className="infl-muted">
          This judgement comes from an analysis made before the account&apos;s data or your exclusions changed.
        </div>
      )}

      {ai.evidence?.length > 0 && (
        <>
          <div className="org-rel-detail-label infl-gap-top">What the AI based this on</div>
          <ul className="infl-quotes">
            {ai.evidence.map((item, index) => (
              <li key={`${item.source?.kind}:${item.source?.id}:${index}`} className="infl-quote">
                {item.quote && <blockquote>&ldquo;{item.quote}&rdquo;</blockquote>}
                <div className="infl-quote-meta">
                  <QuoteBadge quote={item.quote} verified={item.verified === true} />
                  <SourceLine source={item.source} onOpen={onOpen} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {ai.adoptedSuggestions?.length > 0 && (
        <>
          <div className="org-rel-detail-label infl-gap-top">Suggestions of theirs that were adopted</div>
          <ul className="infl-quotes">
            {ai.adoptedSuggestions.map((item, index) => (
              <li key={`adopted-${index}`} className="infl-quote">
                <div className="infl-person-name">{item.suggestion}</div>
                {item.adoptedAs && <div className="infl-muted">Adopted as: {item.adoptedAs}</div>}
                {item.quote && <blockquote>&ldquo;{item.quote}&rdquo;</blockquote>}
                <div className="infl-quote-meta">
                  <QuoteBadge quote={item.quote} verified={item.verified === true} />
                </div>
                {(item.sources || []).map((source, sourceIndex) => (
                  <SourceLine key={`${source.kind}:${source.id}:${sourceIndex}`} source={source} onOpen={onOpen} />
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PersonDrawer({ person, rank, assessment, weights, busy, onClose, onSave, onExclude }) {
  const savedStance = person.override?.stance || '';
  const savedNote = person.override?.note || '';
  const [stance, setStance] = useState(savedStance);
  const [note, setNote] = useState(savedNote);
  const [formError, setFormError] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [openError, setOpenError] = useState('');
  const alive = useRef(true);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus moves into the drawer once when it opens; parent re-renders must not move it again.
  useEffect(() => {
    alive.current = true;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      alive.current = false;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > NOTE_MAX;
  const dirty = stance !== savedStance || trimmedNote !== savedNote;
  const hasCorrection = Boolean(savedStance || savedNote);
  const signals = person.signals || {};
  const affiliation = AFFILIATION_LABEL[person.affiliation] || 'Unknown affiliation';
  const microsoft = person.microsoft || [];
  const microsoftTotal = person.microsoftTotal ?? microsoft.length;

  const openLink = async (link) => {
    setOpenError('');
    try {
      await openExternal(link);
    } catch (err) {
      if (alive.current) setOpenError(`Could not open the link: ${errorText(err)}`);
    }
  };

  const submit = async (patch, successText) => {
    setFormError('');
    setFormMessage('');
    const result = await onSave(person.id, patch);
    if (!alive.current) return false;
    if (result.ok) setFormMessage(successText);
    else setFormError(result.error || 'Could not save the change.');
    return result.ok;
  };

  const save = () => submit(
    { stance: stance || null, note: trimmedNote },
    stance
      ? `Saved. ${STANCE_LABEL[stance]} is shown for ${person.name} instead of any AI stance.`
      : 'Saved. No stance correction is set, so the AI\'s stance is shown if there is one.',
  );

  const clearCorrection = async () => {
    if (await submit({ stance: null, note: '' }, 'Your correction and note were removed.')) {
      setStance('');
      setNote('');
    }
  };

  const exclude = async () => {
    setFormError('');
    setFormMessage('');
    const result = await onExclude(person);
    if (alive.current && !result.ok && !result.cancelled) {
      setFormError(`Could not exclude ${person.name}: ${result.error || 'unknown error'}`);
    }
  };

  return (
    <div className="mt-drawer-overlay" onClick={onClose}>
      <div
        className="mt-drawer infl-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${person.name} influence detail`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mt-drawer-head">
          <div>
            <div className="mt-drawer-title">{person.name}</div>
            <div className="infl-muted">
              {[person.title, affiliation].filter(Boolean).join(' · ')}
            </div>
            <div className="infl-drawer-score">
              <ScoreBar score={person.score} />
              <span className="infl-muted">rank #{rank}</span>
              <StanceBadge person={person} />
            </div>
          </div>
          <Button ref={closeRef} appearance="subtle" icon={<DismissRegular />} aria-label="Close" onClick={onClose} />
        </div>

        <div className="mt-drawer-body">
          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">
              Microsoft contacts ({microsoftTotal > microsoft.length
                ? `${microsoft.length} of ${microsoftTotal}, most shared first`
                : microsoftTotal})
            </div>
            <p className="infl-muted">
              Microsoft people on the same emails or meetings, counted once per thread or meeting. Broadcasts (over 20
              people), cancelled meetings and declined invitations don&apos;t count.
            </p>
            {microsoft.length ? (
              <ul className="org-rel-people">
                {microsoft.map((contact) => (
                  <li key={contact.id}>
                    <span title={contact.email || undefined}>{contact.name}</span>
                    <span className="org-rel-people-count">{sharedWith(contact)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="org-rel-detail-empty">No Microsoft person was on the same emails or meetings.</div>
            )}
          </section>

          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">Why this score</div>
            <ComponentBars person={person} weights={weights} />
            <div className="infl-direction">
              <div>
                <strong>Inbound {pct(person.inbound)}</strong>
                <span className="infl-muted"> — how much others pull them in: people who include them and organizers who invite them.</span>
              </div>
              <div>
                <strong>Outbound {pct(person.outbound)}</strong>
                <span className="infl-muted">
                  {' '}— how much they drive: emails sent, threads started, meetings organized and, where a transcript
                  covers them, their share of the words.
                </span>
              </div>
            </div>
            <div className={person.hiddenInfluencer ? 'flash-message flash-info infl-flash' : 'org-rel-hint'}>
              {person.hiddenInfluencer
                ? 'Hidden influencer: others pull them in a lot while they rarely drive things themselves, and they were deliberately brought in (added to a running thread or invited by two or more organizers).'
                : 'Not flagged as a hidden influencer. That needs inbound of at least 60%, outbound of at most 20%, being added to a running thread or invited by two or more organizers, and at least three pieces of evidence.'}
            </div>
            {person.tags?.length > 0 && (
              <ul className="infl-tag-list">
                {person.tags.map((tag) => (
                  <li key={tag.id}>
                    <span className="badge badge-info">{tag.label}</span>
                    <span className="infl-muted">{TAG_MEANING[tag.id] || ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">Signals</div>
            <dl className="infl-signals">
              {SIGNAL_ROWS.map((row) => (
                <div key={row.key} className="infl-signal" title={row.hint || ''}>
                  <dt>{row.label}</dt>
                  <dd>{row.format ? row.format(signals[row.key], signals) : (signals[row.key] ?? 0)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">AI judgement</div>
            <AiJudgement person={person} rank={rank} assessment={assessment} onOpen={openLink} />
          </section>

          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">
              Evidence ({person.evidenceTotal > (person.evidence || []).length
                ? `newest ${(person.evidence || []).length} of ${person.evidenceTotal}`
                : person.evidenceTotal})
            </div>
            {openError && <div className="flash-message flash-error infl-flash"><span>{openError}</span></div>}
            {(person.evidence || []).length ? (
              <ul className="infl-evidence">
                {person.evidence.map((item, index) => {
                  const Icon = KIND_ICON[item.kind] || InfoRegular;
                  const date = formatDate(item.date);
                  return (
                    <li key={`${item.kind}:${item.id}:${item.role}:${index}`}>
                      <Icon className="infl-evidence-icon" aria-label={KIND_LABEL[item.kind] || item.kind} />
                      <div className="infl-evidence-text">
                        <div>
                          <span className="badge badge-secondary">{item.role}</span>{' '}
                          <span className="infl-person-name">{item.title}</span>
                        </div>
                        <div className="infl-muted">
                          {[KIND_LABEL[item.kind] || item.kind, date, item.note].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <SourceOpenButton link={item.webLink} onOpen={openLink} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="org-rel-detail-empty">No evidence items.</div>
            )}
          </section>

          <section className="infl-drawer-section">
            <div className="org-rel-detail-label">Your correction</div>
            <p className="infl-muted">
              Your stance replaces the AI&apos;s wherever this person is shown. The note is for you: it stays on this
              device and is never sent to the AI.
            </p>
            <Field label="Stance">
              <Select value={stance} disabled={busy} onChange={(_event, value) => setStance(value.value)}>
                <option value="">No correction</option>
                {STANCES.map((value) => <option key={value} value={value}>{STANCE_LABEL[value]}</option>)}
              </Select>
            </Field>
            <Field
              label="Note"
              validationState={noteTooLong ? 'error' : 'none'}
              validationMessage={noteTooLong ? `The note is ${trimmedNote.length} characters; the limit is ${NOTE_MAX}.` : undefined}
              hint={noteTooLong ? undefined : `${trimmedNote.length} / ${NOTE_MAX}`}
            >
              <Textarea value={note} disabled={busy} resize="vertical" onChange={(_event, value) => setNote(value.value)} />
            </Field>
            {formError && <div className="flash-message flash-error infl-flash"><span>{formError}</span></div>}
            {formMessage && !formError && <div className="flash-message flash-success infl-flash"><span>{formMessage}</span></div>}
            <div className="infl-actions">
              <Button
                appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <SaveRegular />}
                disabled={busy || !dirty || noteTooLong}
                onClick={save}
              >
                Save
              </Button>
              <Button disabled={busy || !hasCorrection} onClick={clearCorrection}>Clear my correction</Button>
              <Button icon={<EyeOffRegular />} disabled={busy} onClick={exclude}>Exclude from map</Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
