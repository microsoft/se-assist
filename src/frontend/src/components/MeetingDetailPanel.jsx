import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import {
  DismissRegular, OpenRegular, VideoRegular, CalendarLtrRegular, SparkleRegular,
  ChevronRightRegular, ChevronDownRegular, FlagRegular, AddRegular, LinkRegular,
  DocumentTextRegular, ChatRegular, CopyRegular, DeleteRegular,
} from '@fluentui/react-icons';
import {
  getSignalDetail, untagSignal, openExternal, prepareMeetingBrief,
  getMeetingNotes, saveMeetingNotes, getMeetingMilestoneLinks, linkMeetingMilestone,
  unlinkMeetingMilestone, suggestMilestoneComment, suggestMilestoneHokActivity, dbQuery,
  getMsxSettings, fetchMeetingTranscript, summarizeMeetingTranscript,
  getMeetingTasks, createMeetingTasks, saveCustomerTodo, deleteCustomerTodo,
} from '../electronBridge';
import { useTeamApi } from '../hooks/useTeamApi';
import { TASK_CATEGORIES, DetailCard } from './Milestones';
import { formatLocalDateTime } from '../lib/datetime';
import { productCatalogForPrompt } from '../lib/microsoftProducts';
import { TaskAssignmentStatus, TaskCustomerPicker, TaskWorkloadPicker, useTaskAssignmentOptions } from './TaskAssignments';

const EMPTY_NOTES = { preparation_notes: '', transcript: '', summary: '', personal_notes: '' };

const RESPONSE_LABEL = {
  accepted: 'Accepted', tentativelyAccepted: 'Tentative', declined: 'Declined',
  notResponded: 'No response', none: '', organizer: 'Organizer',
};

// Candidate milestones for the account(s) this meeting is tagged to. Grouped/labelled by
// opportunity + account so the picker reads clearly. Scoped by tpid via the same
// milestone -> opportunity -> customer chain the rest of the app uses.
// Candidate milestones for the meeting's tagged accounts, restricted to ones the user can act
// on: ACTIVE (not completed / cancelled / hygiene-duplicate / lost-to-competitor) and
// UNCOMMITTED (commitment recommendation is not "Committed" = option-set 861980003). These
// mirror the isInactiveMs / isCommittedMs helpers in Milestones.jsx so the meeting picker shows
// the same population as the app's "Active + Uncommitted" milestone views.
const CANDIDATE_MILESTONES_SQL = (n) => `
  SELECT m.milestone_id, m.name, m.status_label, m.milestone_date,
         o.name AS opportunity_name, cu.tpid AS customer_tpid, cu.name AS customer_name
  FROM active_milestones m
  JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
  JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
  WHERE cu.tpid IN (${Array(n).fill('?').join(',')})
    AND LOWER(COALESCE(m.status_label, '')) NOT LIKE '%complete%'
    AND LOWER(COALESCE(m.status_label, '')) NOT LIKE '%cancel%'
    AND LOWER(COALESCE(m.status_label, '')) NOT LIKE '%duplicate%'
    AND LOWER(COALESCE(m.status_label, '')) NOT LIKE '%lost to competitor%'
    AND COALESCE(m.commitment_recommendation, 0) <> 861980003
  ORDER BY cu.name, o.name, COALESCE(m.milestone_date, '9999-12-31'), m.name`;

// The SSP (Cloud and AI Specialist) configured on the account team, per tagged account. Only
// rows with an email are returned (the email is what a Teams deep-link chat needs). Account
// name resolves to the top-parent for display.
const ACCOUNT_SSP_SQL = (n) => `
  SELECT r.tpid, r.person_name AS ssp_name, r.person_email AS ssp_email,
         COALESCE(
           (SELECT c.name FROM active_customers c
             WHERE c.tpid = r.tpid AND (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '')
             LIMIT 1),
           'TPID ' || r.tpid
         ) AS account_name
  FROM active_customer_account_team_roles r
  WHERE r.role = 'Cloud and AI Specialist'
    AND r.person_email IS NOT NULL AND TRIM(r.person_email) <> ''
    AND r.tpid IN (${Array(n).fill('?').join(',')})
  ORDER BY account_name`;

function parseJsonList(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Display-only: strip email addresses out of a meeting's agenda/body text. The attendee list
// already shows people (and their addresses), so repeating raw emails inside the pasted invite
// body is noise. Removes bracketed/parenthesized forms first (e.g. "Mark Moore <m@x.com>" →
// "Mark Moore", "Jane (j@x.com) said" → "Jane said"), then any bare address, and tidies the
// spacing/punctuation left behind. Never mutates the stored body_text — only what is rendered.
const EMAIL_RE = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}';
function stripEmails(text) {
  let s = String(text || '');
  s = s.replace(new RegExp(`<\\s*${EMAIL_RE}\\s*>`, 'gi'), '');   // <m@x.com> / < m@x.com >
  s = s.replace(new RegExp(`\\(\\s*${EMAIL_RE}\\s*\\)`, 'gi'), ''); // (m@x.com)
  s = s.replace(new RegExp(`\\[\\s*${EMAIL_RE}\\s*\\]`, 'gi'), ''); // [m@x.com]
  s = s.replace(new RegExp(EMAIL_RE, 'gi'), '');                    // bare m@x.com
  s = s.replace(/<\s*>|\(\s*\)|\[\s*\]/g, '');                      // empty brackets left behind
  s = s.replace(/[ \t]{2,}/g, ' ');                                // collapse runs of spaces
  s = s.replace(/[ \t]+([;,.])/g, '$1');                           // no space before punctuation
  return s.replace(/[ \t]+$/gm, '').trim();                        // trim trailing spaces per line
}

// Display-only: remove the Outlook "forwarded invite" header preamble whose recipient lists
// duplicate the Attendees section. Strips a leading "FYI", the "-----Original Appointment-----"
// marker, and the From:/Sent:/To:/Cc:/Bcc: segments (each bounded by the NEXT header keyword so
// it can never run past Subject/When/Where into real agenda text). Subject:/When:/Where: are
// kept — "When:" carries the recurrence and "Where:" the location, which the fixed detail rows
// above don't fully show. Names (without emails) inside the kept segments are harmless.
const INVITE_KW = 'From|Sent|To|Cc|Bcc|Subject|When|Where';
function stripInviteHeaders(text) {
  let s = String(text || '');
  s = s.replace(/\bFYI\b[:.]?\s*/i, '');
  s = s.replace(/-{2,}\s*Original (?:Appointment|Message)\s*-{2,}/gi, ' ');
  const drop = new RegExp(`\\b(?:From|Sent|To|Cc|Bcc):\\s*[\\s\\S]*?(?=\\b(?:${INVITE_KW}):|$)`, 'gi');
  s = s.replace(drop, ' ').replace(drop, ' '); // twice: clears back-to-back From→Sent→To→Cc
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

// Compose both for the rendered agenda/notes: drop the forwarding header block, then any
// remaining stray emails. Returns '' when nothing meaningful is left (pure recipient dumps).
function cleanAgenda(text) {
  return stripEmails(stripInviteHeaders(text));
}
function personLabel(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  return p.name || p.emailAddress?.name || p.address || p.emailAddress?.address || '';
}
function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Row({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 92, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

// Collapsible section with a clickable header. Used for the long attendee/body lists so the
// panel opens compact and the user expands what they need.
function Collapsible({ title, defaultOpen = false, children, style }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)', ...style }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none',
          border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', font: 'inherit',
          fontSize: 12, fontWeight: 600,
        }}
      >
        {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
        <span>{title}</span>
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

// One persisted, COLLAPSIBLE free-text note block (prep / transcript / summary / personal),
// used in the workspace 2×2 grid. Collapsed by default; the header always shows the label, a
// filled dot when there's content, the save state, and any header action (Prepare / Fetch).
// Autosaves (debounced) on change; the textarea + status line show only when expanded.
function CollapsibleNoteField({
  label, value, onChange, onSave, saveState, placeholder, minRows = 4,
  headerRight, status, open, onToggle, disabled = false,
}) {
  const hasContent = !!String(value || '').trim();
  const [copyState, setCopyState] = useState(null);
  useEffect(() => { setCopyState(null); }, [value]);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this window.');
      await navigator.clipboard.writeText(String(value ?? ''));
      setCopyState({ ok: true, text: 'Copied' });
    } catch (error) {
      setCopyState({ ok: false, text: `Could not copy ${label.toLowerCase()}: ${error.message || String(error)}` });
    }
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, background: 'none',
              border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', font: 'inherit',
              fontSize: 12, fontWeight: 600, textAlign: 'left',
            }}
          >
            {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            {!open && hasContent ? (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} title="Has content" />
            ) : null}
          </button>
          <Button
            size="small" appearance="subtle" icon={<CopyRegular />}
            aria-label={`Copy ${label.toLowerCase()}`}
            title={hasContent ? `Copy all ${label.toLowerCase()}` : `No ${label.toLowerCase()} to copy`}
            disabled={!hasContent} onClick={copy}
            style={{ minWidth: 24, height: 24, padding: 2, flexShrink: 0 }}
          />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {saveState === 'pending' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Unsaved</span>}
          {saveState === 'saving' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Saving…</span>}
          {saveState === 'saved' && <span style={{ fontSize: 11, color: 'var(--accent)' }}>Saved</span>}
          {saveState && !['pending', 'saving', 'saved'].includes(saveState) && (
            <span role="alert" style={{ fontSize: 11, color: 'var(--danger)' }}>{saveState}</span>
          )}
          {headerRight}
        </span>
      </div>
      {copyState && (
        <div role={copyState.ok ? 'status' : 'alert'} style={{ padding: '0 10px 6px', fontSize: 11, color: copyState.ok ? 'var(--accent)' : 'var(--danger)' }}>
          {copyState.text}
        </div>
      )}
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          <textarea
            value={value}
            aria-label={label}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onSave()}
            rows={minRows}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit',
              fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)', background: 'var(--card)',
              border: '1px solid var(--border)', borderRadius: 6, padding: 8,
            }}
          />
        </div>
      )}
      {status && <div style={{ padding: '0 10px 8px' }}>{status}</div>}
    </div>
  );
}

/**
 * MeetingDetailPanel — the rich meeting popup. Shows meeting metadata (details, expandable
 * attendees + body, attachments, Join / Open / Prepare) and an action workspace: a persisted
 * preparation brief / transcript / summary / personal notes, a milestone link picker that
 * writes the canonical signal_links graph (so the link also shows in the milestone detail
 * panel), and Generate-comment / Generate-HoK-activity actions that reuse the existing
 * milestone AI + CRM write paths against the linked milestone. Fails loud everywhere.
 */
export default function MeetingDetailPanel(props) {
  return <MeetingDetailWorkspace key={props.eventId} {...props} />;
}

function MeetingDetailWorkspace({ eventId, onClose, onTagsChanged, onTasksChanged }) {
  const teamApi = useTeamApi({});

  const [state, setState] = useState({ loading: true, error: '', item: null });
  const [tags, setTags] = useState([]);
  const [removing, setRemoving] = useState('');
  const [removeError, setRemoveError] = useState('');

  // Persisted notes
  const [notes, setNotes] = useState(EMPTY_NOTES);
  const notesRef = useRef(EMPTY_NOTES);
  const savedNotes = useRef(EMPTY_NOTES);
  const noteSaveQueue = useRef(Promise.resolve());
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesError, setNotesError] = useState('');
  const [closeError, setCloseError] = useState('');
  const [notesRevision, setNotesRevision] = useState(0);
  const [saveState, setSaveState] = useState({}); // field -> 'saving' | 'saved' | errorString
  // Which workspace note blocks are expanded. All collapsed by default; AI actions auto-open
  // the block they fill so the user sees the result.
  const [openNote, setOpenNote] = useState({ preparation_notes: false, transcript: false, summary: false, personal_notes: false });
  const toggleNote = useCallback((k) => setOpenNote((o) => ({ ...o, [k]: !o[k] })), []);
  const openNoteBlock = useCallback((k) => setOpenNote((o) => ({ ...o, [k]: true })), []);
  const saveTimers = useRef({});

  // Prepare (AI brief)
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState('');

  // Fetch-transcript-from-Teams state
  const [workflowStep, setWorkflowStep] = useState('');
  const workflowLock = useRef(false);
  const workflowBusy = !!workflowStep;
  const [transcriptNote, setTranscriptNote] = useState(''); // honest status line under the field
  const [transcriptNoteTone, setTranscriptNoteTone] = useState('muted'); // 'muted' | 'accent' | 'danger'

  // Summarize-transcript (AI) state
  const [summaryNote, setSummaryNote] = useState('');
  const [summaryNoteTone, setSummaryNoteTone] = useState('muted');

  const [taskData, setTaskData] = useState({ tasks: [], canCreateTasks: false, actionItemCount: 0 });
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [tasksNote, setTasksNote] = useState('');
  const [savingTask, setSavingTask] = useState('');
  const assignments = useTaskAssignmentOptions();

  // Milestone linking
  const [links, setLinks] = useState([]); // linked milestones for this meeting
  const [candidates, setCandidates] = useState([]);
  const [candLoading, setCandLoading] = useState(false);
  const [pickMilestone, setPickMilestone] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [targetMilestone, setTargetMilestone] = useState(''); // which linked ms comment/HoK acts on

  // SSP(s) configured on the account team for this meeting's tagged account(s).
  const [ssps, setSsps] = useState([]);

  // Milestone detail popup (opened by clicking a linked-milestone chip). Reuses the shared
  // DetailCard from active_Milestones.jsx — the same milestone details popup used across the app.
  const [msDetail, setMsDetail] = useState(null);
  const [crmBaseUrl, setCrmBaseUrl] = useState('');

  // Generate comment
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentNote, setCommentNote] = useState('');
  const [commentError, setCommentError] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const [commentSaved, setCommentSaved] = useState('');

  // Generate HoK activity
  const [hokBusy, setHokBusy] = useState(false);
  const [hokNote, setHokNote] = useState('');
  const [hokError, setHokError] = useState('');
  const [hokForm, setHokForm] = useState(null); // { subject, category, dueDate, description } | null
  const [savingHok, setSavingHok] = useState(false);
  const [hokSaved, setHokSaved] = useState('');

  const load = useCallback(async () => {
    setState({ loading: true, error: '', item: null });
    try {
      const res = await getSignalDetail({ medium: 'meeting', id: eventId });
      if (!res?.ok) throw new Error(res?.error || 'Could not load meeting detail.');
      setState({ loading: false, error: '', item: res.item });
      setTags(res.item?.tags || []);
    } catch (err) {
      setState({ loading: false, error: err?.message || String(err), item: null });
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  // Load persisted notes.
  useEffect(() => {
    let alive = true;
    setNotesLoading(true);
    setNotesError('');
    (async () => {
      try {
        const res = await getMeetingNotes({ eventId });
        if (!res?.ok) throw new Error(res?.error || 'Could not load meeting notes.');
        if (!alive) return;
        const n = res.notes || {};
        const loaded = {
          preparation_notes: n.preparation_notes || '',
          transcript: n.transcript || '',
          summary: n.summary || '',
          personal_notes: n.personal_notes || '',
        };
        notesRef.current = loaded;
        savedNotes.current = loaded;
        setNotes(loaded);
      } catch (error) {
        if (alive) setNotesError(error.message || String(error));
      } finally {
        if (alive) setNotesLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [eventId, notesRevision]);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError('');
    try {
      const result = await getMeetingTasks({ eventId });
      if (!result?.ok) throw new Error(result?.error || 'Could not load meeting Tasks.');
      setTaskData(result);
    } catch (error) {
      setTasksError(error.message || String(error));
    } finally {
      setTasksLoading(false);
    }
  }, [eventId]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  // Load linked milestones.
  const loadLinks = useCallback(async () => {
    try {
      const res = await getMeetingMilestoneLinks({ eventId });
      if (res?.ok) {
        setLinks(res.links || []);
        setTargetMilestone((cur) => cur || res.links?.[0]?.milestone_id || '');
      }
    } catch { /* non-fatal */ }
  }, [eventId]);
  useEffect(() => { loadLinks(); }, [loadLinks]);

  // Load candidate milestones for the meeting's tagged accounts (re-derives when tags change).
  const tpids = useMemo(() => tags.map((t) => String(t.tpid)).filter(Boolean), [tags]);
  useEffect(() => {
    let alive = true;
    if (!tpids.length) { setCandidates([]); return; }
    setCandLoading(true);
    (async () => {
      try {
        const rows = await dbQuery(CANDIDATE_MILESTONES_SQL(tpids.length), tpids);
        if (alive) setCandidates(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setCandidates([]);
      } finally {
        if (alive) setCandLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [tpids]);

  // Load the SSP(s) configured on the account team for the meeting's tagged account(s).
  useEffect(() => {
    let alive = true;
    if (!tpids.length) { setSsps([]); return undefined; }
    (async () => {
      try {
        const rows = await dbQuery(ACCOUNT_SSP_SQL(tpids.length), tpids);
        if (alive) setSsps(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setSsps([]);
      }
    })();
    return () => { alive = false; };
  }, [tpids]);

  const item = state.item;

  // ── Notes autosave (debounced) ──────────────────────────────────────
  const persistNote = useCallback((field, value) => {
    // Serialize autosaves so an older blur/debounce cannot overwrite a newer generated note.
    const pending = noteSaveQueue.current.then(async () => {
      if (savedNotes.current[field] === value) {
        setSaveState(previous => previous[field] && notesRef.current[field] === value ? { ...previous, [field]: 'saved' } : previous);
        return { ok: true };
      }
      setSaveState(previous => ({ ...previous, [field]: 'saving' }));
      try {
        const res = await saveMeetingNotes({ eventId, patch: { [field]: value } });
        if (!res?.ok) throw new Error(res?.error || 'Save failed.');
        savedNotes.current = { ...savedNotes.current, [field]: value };
        if (notesRef.current[field] === value) setSaveState(previous => ({ ...previous, [field]: 'saved' }));
        return { ok: true };
      } catch (error) {
        const message = error.message || String(error);
        setSaveState(previous => ({ ...previous, [field]: message }));
        return { ok: false, error: message };
      }
    });
    noteSaveQueue.current = pending;
    return pending;
  }, [eventId]);

  const replaceNote = useCallback((field, value) => {
    notesRef.current = { ...notesRef.current, [field]: value };
    setNotes(notesRef.current);
  }, []);

  const onNoteChange = useCallback((field, value) => {
    replaceNote(field, value);
    setSaveState(previous => ({ ...previous, [field]: 'pending' }));
    if (field === 'transcript' || field === 'summary') {
      setTaskData(previous => ({ ...previous, canCreateTasks: false }));
      setTasksNote('Notes changed. Summarize again to refresh to-do items; existing Tasks are unchanged.');
    }
    if (saveTimers.current[field]) clearTimeout(saveTimers.current[field]);
    saveTimers.current[field] = setTimeout(() => {
      delete saveTimers.current[field];
      persistNote(field, value);
    }, 900);
  }, [persistNote, replaceNote]);

  const flushNote = useCallback((field) => {
    if (saveTimers.current[field]) { clearTimeout(saveTimers.current[field]); delete saveTimers.current[field]; }
    return persistNote(field, notesRef.current[field]);
  }, [persistNote]);

  const flushNotes = useCallback(async (fields) => {
    const results = await Promise.all(fields.map(flushNote));
    const failed = results.find(result => !result.ok);
    if (failed) throw new Error(`Could not save meeting notes: ${failed.error}`);
  }, [flushNote]);

  useEffect(() => () => {
    for (const field of Object.keys(saveTimers.current)) flushNote(field);
  }, [flushNote]);

  const closePanel = async () => {
    setCloseError('');
    try {
      if (!notesLoading && !notesError) {
        await flushNotes(workflowLock.current ? ['preparation_notes', 'personal_notes'] : Object.keys(EMPTY_NOTES));
      }
      onClose();
    } catch (error) {
      setCloseError(error.message || String(error));
    }
  };

  const removeTag = useCallback(async (tpid) => {
    setRemoving(tpid); setRemoveError('');
    try {
      const res = await untagSignal({ medium: 'meeting', id: eventId, tpid });
      if (!res?.ok) throw new Error(res?.error || 'Could not remove the tag.');
      setTags((prev) => prev.filter((t) => String(t.tpid) !== String(tpid)));
      if (onTagsChanged) onTagsChanged({ medium: 'meeting', id: eventId, tpid, remaining: res.remaining });
    } catch (err) {
      setRemoveError(err?.message || String(err));
    } finally {
      setRemoving('');
    }
  }, [eventId, onTagsChanged]);

  const runPrepare = useCallback(async () => {
    setPreparing(true); setPrepareError('');
    try {
      const pending = await flushNote('preparation_notes');
      if (!pending.ok) throw new Error(pending.error);
      const res = await prepareMeetingBrief({ eventId, products: productCatalogForPrompt() });
      if (!res?.ok) throw new Error(res?.error || 'Preparation failed.');
      const brief = res.reply || '';
      replaceNote('preparation_notes', brief);
      const saved = await persistNote('preparation_notes', brief);
      if (!saved.ok) throw new Error(saved.error);
      openNoteBlock('preparation_notes');
    } catch (err) {
      setPrepareError(err?.message || String(err));
    } finally {
      setPreparing(false);
    }
  }, [eventId, persistNote, openNoteBlock, replaceNote, flushNote]);

  // Open a Teams 1:1 chat with the account SSP, prefilled with a question about whether this
  // meeting maps to a milestone. Uses the Teams deep link (users + message), opened via the
  // OS handler — the same openExternal path used for Join / Open in Outlook.
  const askSspInTeams = useCallback((ssp) => {
    if (!ssp?.ssp_email) return;
    const first = String(ssp.ssp_name || '').trim().split(/\s+/)[0] || 'there';
    const subject = (item?.title || '').trim() || '(this meeting)';
    const message = `Hi ${first}, was there a milestone for this meeting? ${subject}`;
    const url = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(ssp.ssp_email)}&message=${encodeURIComponent(message)}`;
    openExternal(url);
  }, [item]);

  const buildTasks = async () => {
    setWorkflowStep('creating');
    setTasksError('');
    setTasksNote('Step 3 of 3: Creating SE Assist Tasks...');
    try {
      const result = await createMeetingTasks({ eventId });
      if (!result?.ok) throw new Error(result?.error || 'Could not create meeting Tasks.');
      setTaskData(result);
      const counts = result.actionItemCount
        ? `${result.createdCount} created, ${result.existingCount} already saved${result.deletedCount ? `, ${result.deletedCount} previously deleted (not restored)` : ''}.`
        : 'No to-do items recorded; no new Tasks were created.';
      setTasksNote(`Step 3 of 3: ${counts}${result.customerNote ? ` ${result.customerNote}` : ''}`);
      assignments.reload();
      onTasksChanged?.();
      return true;
    } catch (error) {
      setTasksNote('');
      setTasksError(`Step 3 of 3 failed: ${error.message || String(error)} The saved summary is unchanged; retry creating Tasks.`);
      return false;
    }
  };

  const summarizeAndCreateTasks = async (transcript) => {
    setWorkflowStep('summarizing');
    openNoteBlock('summary');
    setSummaryNote('Step 2 of 3: Generating a concise recap and to-do items...');
    setSummaryNoteTone('muted');
    setTasksError('');
    setTasksNote('');
    try {
      const result = await summarizeMeetingTranscript({ eventId, transcript });
      if (!result?.ok || !result.summary || !Array.isArray(result.actionItems)) {
        throw new Error(result?.message || result?.error || 'Could not summarize the transcript.');
      }
      // The main process saves the summary and structured actions atomically.
      replaceNote('summary', result.summary);
      savedNotes.current = { ...savedNotes.current, transcript, summary: result.summary };
      setSaveState(previous => ({ ...previous, summary: 'saved' }));
      setTaskData(previous => ({ ...previous, canCreateTasks: true, actionItemCount: result.actionItems.length }));
      setSummaryNoteTone('accent');
      setSummaryNote(`Step 2 of 3: ${result.meta?.reused ? 'Reused the saved recap' : 'Summary and to-do items saved'}${result.meta?.clipped ? ' (only the first 48,000 transcript characters were analyzed)' : ''}.`);
    } catch (error) {
      setSummaryNoteTone('danger');
      setSummaryNote(`Step 2 of 3 failed: ${error.message || String(error)} No new Tasks were created.`);
      return false;
    }
    return buildTasks();
  };

  const runFetchTranscript = async () => {
    if (workflowLock.current) return;
    workflowLock.current = true;
    setWorkflowStep('fetching');
    setTranscriptNote('Step 1 of 3: Fetching the Teams transcript...');
    setTranscriptNoteTone('muted');
    setSummaryNote('');
    setTasksNote('');
    setTasksError('');
    try {
      await flushNotes(['transcript', 'summary']);
      const res = await fetchMeetingTranscript({ eventId });
      if (res?.ok && res.hasTranscript && res.transcript) {
        replaceNote('transcript', res.transcript);
        if (savedNotes.current.transcript !== res.transcript) {
          setTaskData(previous => ({ ...previous, canCreateTasks: false }));
        }
        const saved = await persistNote('transcript', res.transcript);
        if (!saved.ok) throw new Error(saved.error);
        openNoteBlock('transcript');
        const who = Array.isArray(res.speakers) && res.speakers.length ? ` · ${res.speakers.length} speaker${res.speakers.length === 1 ? '' : 's'}` : '';
        setTranscriptNoteTone('accent');
        setTranscriptNote(`Step 1 of 3: Teams transcript saved${who}.`);
        await summarizeAndCreateTasks(res.transcript);
      } else if (res?.ok && res.hasTranscript === false) {
        setTranscriptNoteTone('muted');
        setTranscriptNote(`${res.message || 'No transcript found for this meeting.'} Summary and Tasks were not changed.`);
      } else {
        throw new Error(res?.message || res?.error || 'Could not fetch the transcript.');
      }
    } catch (err) {
      setTranscriptNoteTone('danger');
      setTranscriptNote(`Step 1 of 3 failed: ${err?.message || String(err)} Summary and Task creation did not run.`);
    } finally {
      setWorkflowStep('');
      workflowLock.current = false;
    }
  };

  const runSummarize = async () => {
    if (workflowLock.current) return;
    workflowLock.current = true;
    setWorkflowStep('summarizing');
    try {
      await flushNotes(['transcript', 'summary']);
      await summarizeAndCreateTasks(notesRef.current.transcript);
    } catch (error) {
      setSummaryNoteTone('danger');
      setSummaryNote(`${error.message || String(error)} Summary and Task creation did not run.`);
    } finally {
      setWorkflowStep('');
      workflowLock.current = false;
    }
  };

  const runCreateTasks = async () => {
    if (workflowLock.current) return;
    workflowLock.current = true;
    setWorkflowStep('creating');
    try {
      await flushNotes(['transcript', 'summary']);
      await buildTasks();
    } catch (error) {
      setTasksError(error.message || String(error));
    } finally {
      setWorkflowStep('');
      workflowLock.current = false;
    }
  };

  const updateTask = async (task, patch) => {
    setSavingTask(task.id);
    setTasksError('');
    try {
      const result = await saveCustomerTodo({ id: task.id, ...patch });
      if (!result?.ok || !result.todo) throw new Error(result?.error || 'Could not update the Task. Reload Tasks to check its saved state.');
      setTaskData(previous => ({ ...previous, tasks: previous.tasks.map(current => current.id === task.id ? result.todo : current) }));
      onTasksChanged?.();
    } catch (error) {
      setTasksError(error.message || String(error));
    } finally {
      setSavingTask('');
    }
  };

  const removeTask = async (task) => {
    setSavingTask(task.id);
    setTasksError('');
    try {
      const result = await deleteCustomerTodo({ id: task.id });
      if (!result?.ok) throw new Error(result?.error || 'Could not delete the Task.');
      setTaskData(previous => ({ ...previous, tasks: previous.tasks.filter(current => current.id !== task.id) }));
      setTasksNote('Task deleted. Retrying the same to-do items will not restore it.');
      onTasksChanged?.();
    } catch (error) {
      setTasksError(error.message || String(error));
    } finally {
      setSavingTask('');
    }
  };

  const doLink = useCallback(async () => {
    if (!pickMilestone) return;
    setLinkBusy(true); setLinkError('');
    try {
      const res = await linkMeetingMilestone({ eventId, milestoneId: pickMilestone });
      if (!res?.ok) throw new Error(res?.error || 'Could not link the milestone.');
      setPickMilestone('');
      await loadLinks();
    } catch (err) {
      setLinkError(err?.message || String(err));
    } finally {
      setLinkBusy(false);
    }
  }, [eventId, pickMilestone, loadLinks]);

  const doUnlink = useCallback(async (milestoneId) => {
    setLinkError('');
    const prev = links;
    setLinks((cur) => cur.filter((l) => l.milestone_id !== milestoneId));
    if (targetMilestone === milestoneId) setTargetMilestone('');
    try {
      const res = await unlinkMeetingMilestone({ eventId, milestoneId });
      if (!res?.ok) throw new Error(res?.error || 'Could not unlink the milestone.');
      await loadLinks();
    } catch (err) {
      setLinks(prev); // revert — never silently drop a failed unlink
      setLinkError(err?.message || String(err));
    }
  }, [eventId, links, targetMilestone, loadLinks]);

  const targetName = useMemo(
    () => links.find((l) => l.milestone_id === targetMilestone)?.milestone_name || '',
    [links, targetMilestone],
  );

  // Load the CRM base URL once so the milestone popup can render its "Open in CRM" link.
  useEffect(() => {
    let alive = true;
    getMsxSettings().then((s) => { if (alive) setCrmBaseUrl(s?.crmUrl || ''); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Resolve the full local milestone row by id, then open the shared DetailCard (the same
  // milestone details popup used elsewhere). If the milestone isn't mirrored locally, say so
  // plainly instead of opening an empty panel (fail loud, no silent empty state).
  const openMilestoneDetail = useCallback(async (milestoneId) => {
    if (!milestoneId) return;
    setLinkError('');
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
        setLinkError('This milestone is not in the local dataset yet — sync from CRM to view its details.');
      }
    } catch (err) {
      setLinkError(err?.message || String(err));
    }
  }, []);

  const genComment = useCallback(async () => {
    if (!targetMilestone) return;
    setCommentBusy(true); setCommentError(''); setCommentNote(''); setCommentSaved('');
    try {
      const res = await suggestMilestoneComment({ milestoneId: targetMilestone });
      if (!res?.ok) throw new Error(res?.error || 'Could not generate a suggestion.');
      if (res.hasActivity && res.suggestion) setCommentDraft(res.suggestion);
      else setCommentNote(res.message || 'No recent activity found to summarize.');
    } catch (err) {
      setCommentError(err?.message || String(err));
    } finally {
      setCommentBusy(false);
    }
  }, [targetMilestone]);

  const addComment = useCallback(async () => {
    const text = commentDraft.trim();
    if (!text || !targetMilestone) return;
    setSavingComment(true); setCommentError(''); setCommentSaved('');
    try {
      await teamApi.addMilestoneComment(targetMilestone, text);
      setCommentDraft('');
      setCommentSaved(targetName || 'the milestone');
    } catch (err) {
      setCommentError(err?.message || String(err));
    } finally {
      setSavingComment(false);
    }
  }, [commentDraft, targetMilestone, teamApi, targetName]);

  const genHok = useCallback(async () => {
    if (!targetMilestone) return;
    setHokBusy(true); setHokError(''); setHokNote(''); setHokSaved('');
    try {
      const res = await suggestMilestoneHokActivity({ milestoneId: targetMilestone });
      if (!res?.ok) throw new Error(res?.error || 'Could not generate a HoK activity suggestion.');
      const list = Array.isArray(res.suggestions) && res.suggestions.length
        ? res.suggestions : (res.suggestion ? [res.suggestion] : []);
      if (res.hasSignal && list.length) {
        const s = list[0];
        setHokForm({ subject: s.subject || '', category: s.category || '', dueDate: '', description: s.description || '' });
        if (list.length > 1) setHokNote(`Found ${list.length} activities from the linked signals; loaded the first.`);
      } else {
        setHokNote(res.message || 'No related signals are linked to this milestone yet.');
      }
    } catch (err) {
      setHokError(err?.message || String(err));
    } finally {
      setHokBusy(false);
    }
  }, [targetMilestone]);

  const addHok = useCallback(async () => {
    if (!hokForm || !hokForm.subject.trim() || !targetMilestone) return;
    setSavingHok(true); setHokError(''); setHokSaved('');
    try {
      await teamApi.addActivity('ms', targetMilestone, {
        subject: hokForm.subject.trim(),
        taskCategory: hokForm.category,
        dueDate: hokForm.dueDate,
        description: hokForm.description,
      });
      setHokForm(null);
      setHokSaved(targetName || 'the milestone');
    } catch (err) {
      setHokError(err?.message || String(err));
    } finally {
      setSavingHok(false);
    }
  }, [hokForm, targetMilestone, teamApi, targetName]);

  const attendees = parseJsonList(item?.attendees_json);
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const agendaText = cleanAgenda(item?.body_text);
  const linkedIds = new Set(links.map((l) => l.milestone_id));
  const linkableCandidates = candidates.filter((c) => !linkedIds.has(c.milestone_id));

  // When the Guided Tour is on screen, show a SAMPLE SSP + "Ask in Teams" affordance if the real
  // account has none, so the walkthrough matches the real experience. The sample has no email, so
  // askSspInTeams() short-circuits (clicking it does nothing) — it's purely illustrative.
  const inTour = typeof document !== 'undefined' && !!document.querySelector('.tour-root');
  const SAMPLE_SSP = { tpid: '__tour_sample__', ssp_name: 'Jordan Avery', account_name: '' };

  return (
    <>
    <div className="eng-detail-backdrop" onClick={closePanel}>
      <div className="eng-detail-card eng-detail-card-wide" data-tour="mtg-panel" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <CalendarLtrRegular style={{ fontSize: 20, color: 'var(--accent)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>Meeting</div>
              <div style={{ fontWeight: 700, fontSize: 15, wordBreak: 'break-word' }}>
                {item?.title || (state.loading ? 'Loading…' : '(no subject)')}
              </div>
            </div>
          </div>
          <Button size="small" appearance="subtle" icon={<DismissRegular />} onClick={closePanel} title="Close" aria-label="Close meeting" />
        </div>

        {state.loading && (
          <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}><Spinner size="small" label="Loading meeting…" /></div>
        )}
        {state.error && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--danger-tint)', borderRadius: 6, color: 'var(--danger)', fontSize: 12 }}>
            {state.error}
          </div>
        )}
        {closeError && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{closeError} Your edits are still in this panel.</div>}

        {item && (
          <>
            {/* Top: details + actions (left) | attendees, attachments, tagged accounts (right) */}
            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
              {/* Left — details + Join / Open in Outlook */}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Row label="Organizer">{item.from_name ? `${item.from_name}${item.from_address ? ` <${item.from_address}>` : ''}` : (item.from_address || '—')}</Row>
                  <Row label="Start">{item.item_date ? formatLocalDateTime(item.item_date) : '—'}</Row>
                  <Row label="End">{item.end_at ? formatLocalDateTime(item.end_at) : '—'}</Row>
                  <Row label="Location">{item.location}</Row>
                  <Row label="Online">{item.is_online_meeting ? 'Yes' : 'No'}</Row>
                  <Row label="Importance">{item.importance}</Row>
                  <Row label="Sensitivity">{item.sensitivity}</Row>
                  {item.is_cancelled ? <Row label="Status"><span style={{ color: 'var(--danger)' }}>Cancelled</span></Row> : null}
                </div>
                {((item.is_online_meeting && item.online_meeting_url) || item.web_link) && (
                  <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {item.is_online_meeting && item.online_meeting_url && (
                      <Button size="small" appearance="primary" icon={<VideoRegular />} onClick={() => openExternal(item.online_meeting_url)}>
                        Join
                      </Button>
                    )}
                    {item.web_link && (
                      <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={() => openExternal(item.web_link)}>
                        Open in Outlook
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Right — attendees (collapsible), attachments (collapsible, even if empty), tagged accounts */}
              <div style={{ minWidth: 0 }}>
                {attendees.length > 0 && (
                  <Collapsible title={`Attendees (${attendees.length})`} style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 240, overflowY: 'auto' }}>
                      {attendees.map((a, i) => {
                        const name = personLabel(a);
                        if (!name) return null;
                        const addr = a.address || a.emailAddress?.address || '';
                        const lbl = RESPONSE_LABEL[a.response] ?? '';
                        return (
                          <div key={`${addr || name}-${i}`} style={{ fontSize: 12, color: 'var(--text)' }}>
                            {name}
                            {addr && a.name ? <span style={{ color: 'var(--text-faint)' }}> · {addr}</span> : null}
                            {lbl ? <span style={{ color: 'var(--text-muted)' }}> — {lbl}</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  </Collapsible>
                )}

                {/* Attachments — collapsed by default even when empty (honest: only what the sync captured). */}
                <Collapsible
                  title={`Attachments${attachments.length ? ` (${attachments.length})` : ''}`}
                  style={attendees.length ? undefined : { marginTop: 0, paddingTop: 0, borderTop: 'none' }}
                >
                  {attachments.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {item.has_attachments
                        ? 'This meeting has attachments — open it in Outlook to view them.'
                        : 'No attachments captured by the calendar sync. If the invite has files, open it in Outlook.'}
                    </span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {attachments.map((a, i) => (
                        <div key={i} style={{ fontSize: 12, color: 'var(--text)' }}>
                          {a.name}{a.size ? <span style={{ color: 'var(--text-faint)' }}> · {fmtBytes(a.size)}</span> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </Collapsible>

                {/* Tagged accounts */}
                <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                    Tagged accounts {tags.length ? `(${tags.length})` : ''}
                  </div>
                  {tags.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No account tags on this meeting.</span>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {tags.map((t) => (
                        <span key={t.tpid} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--accent-tint)',
                          border: '1px solid var(--accent-tint)', color: 'var(--text-secondary)', borderRadius: 14,
                          padding: '3px 6px 3px 10px', fontSize: 12, maxWidth: '100%',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.account_name || t.tpid}</span>
                          <Button
                            size="small" appearance="subtle"
                            icon={removing === String(t.tpid) ? <Spinner size="tiny" /> : <DismissRegular />}
                            disabled={removing === String(t.tpid)} onClick={() => removeTag(t.tpid)}
                            title="Remove this account tag" style={{ minWidth: 20, height: 20, padding: 0 }}
                          />
                        </span>
                      ))}
                    </div>
                  )}
                  {removeError && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{removeError}</div>}
                </div>
              </div>
            </div>

            {/* Agenda / notes — full width; forwarding header (From/To/Cc) + emails stripped for
                display (those people are in Attendees). Hidden when nothing meaningful remains. */}
            {agendaText && (
              <Collapsible title="Agenda / notes">
                <pre style={{
                  margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)', background: 'var(--surface-2)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: 10,
                  fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5, maxHeight: 280, overflowY: 'auto',
                }}>
                  {agendaText}
                </pre>
              </Collapsible>
            )}

            {/* ── Workspace: notes, linking, generation ─────────────────── */}
            <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '2px solid var(--border)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Meeting workspace</div>
              {notesLoading && <Spinner size="tiny" label="Loading meeting notes..." />}
              {notesError && (
                <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>
                  {notesError} Notes and generation are unavailable until they can be loaded.{' '}
                  <Button size="small" onClick={() => setNotesRevision(value => value + 1)}>Retry notes</Button>
                </div>
              )}

              {/* Two columns — left: Preparation notes / Personal notes; right: Transcript /
                  Summary (personal under prep, summary under transcript). Independent columns so
                  expanding one block never leaves a gap in the other. All collapsed by default;
                  AI actions auto-open the block they fill. */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <CollapsibleNoteField
                    label="Preparation notes" value={notes.preparation_notes}
                    open={openNote.preparation_notes} onToggle={() => toggleNote('preparation_notes')}
                    onChange={(v) => onNoteChange('preparation_notes', v)} onSave={() => flushNote('preparation_notes')}
                    saveState={saveState.preparation_notes} minRows={5}
                    disabled={notesLoading || !!notesError || preparing}
                    placeholder="Use Prepare to generate an AI brief, or write your own prep notes."
                    headerRight={(
                      <button type="button" data-tour="mtg-prepare" className="mtg-inline-btn" disabled={preparing || notesLoading || !!notesError} onClick={runPrepare} title="Generate an AI meeting brief">
                        {preparing ? <Spinner size="tiny" /> : <SparkleRegular />} {notes.preparation_notes ? 'Re-prepare' : 'Prepare'}
                      </button>
                    )}
                    status={prepareError ? <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--danger)' }}>{prepareError}</div> : null}
                  />
                  <CollapsibleNoteField
                    label="Personal notes" value={notes.personal_notes}
                    open={openNote.personal_notes} onToggle={() => toggleNote('personal_notes')}
                    onChange={(v) => onNoteChange('personal_notes', v)} onSave={() => flushNote('personal_notes')}
                    saveState={saveState.personal_notes} minRows={4}
                    disabled={notesLoading || !!notesError}
                    placeholder="Your private notes for this meeting."
                  />
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <CollapsibleNoteField
                    label="Transcript" value={notes.transcript}
                    open={openNote.transcript} onToggle={() => toggleNote('transcript')}
                    onChange={(v) => onNoteChange('transcript', v)} onSave={() => { if (!workflowLock.current) flushNote('transcript'); }}
                    saveState={saveState.transcript} minRows={5}
                    disabled={notesLoading || !!notesError || workflowBusy}
                    placeholder="Paste the transcript, or pull it from Teams (meetings you organized). Fetching also summarizes and creates Tasks."
                    headerRight={item.is_online_meeting ? (
                      <button type="button" data-tour="mtg-transcript" className="mtg-inline-btn" disabled={workflowBusy || notesLoading || !!notesError || tasksLoading || !!savingTask} onClick={runFetchTranscript} title="Fetch transcript, summarize to-do items, then create SE Assist Tasks">
                        {workflowBusy ? <Spinner size="tiny" /> : <DocumentTextRegular />} Fetch from Teams
                      </button>
                    ) : null}
                    status={transcriptNote ? (
                      <div role={transcriptNoteTone === 'danger' ? 'alert' : 'status'} style={{ marginTop: 4, fontSize: 11.5, color: transcriptNoteTone === 'danger' ? 'var(--danger)' : transcriptNoteTone === 'accent' ? 'var(--accent)' : 'var(--text-muted)' }}>{transcriptNote}</div>
                    ) : null}
                  />
                  <CollapsibleNoteField
                    label="Summary" value={notes.summary}
                    open={openNote.summary} onToggle={() => toggleNote('summary')}
                    onChange={(v) => onNoteChange('summary', v)} onSave={() => { if (!workflowLock.current) flushNote('summary'); }}
                    saveState={saveState.summary} minRows={4}
                    disabled={notesLoading || !!notesError || workflowBusy}
                    placeholder="A concise recap with clear to-do items. Editing it requires a fresh summary before creating new Tasks."
                    headerRight={(
                      <button type="button" className="mtg-inline-btn"
                        disabled={workflowBusy || notesLoading || !!notesError || tasksLoading || !!savingTask || !notes.transcript.trim()}
                        onClick={runSummarize} title="Summarize the saved or pasted transcript and create Tasks"
                      >
                        {workflowStep === 'summarizing' ? <Spinner size="tiny" /> : <SparkleRegular />} Summarize + Tasks
                      </button>
                    )}
                    status={summaryNote ? (
                      <div role={summaryNoteTone === 'danger' ? 'alert' : 'status'} style={{ marginTop: 4, fontSize: 11.5, color: summaryNoteTone === 'danger' ? 'var(--danger)' : summaryNoteTone === 'accent' ? 'var(--accent)' : 'var(--text-muted)' }}>{summaryNote}</div>
                    ) : null}
                  />
                </div>
              </div>

              <section aria-label="Meeting Tasks" data-tour="mtg-tasks" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>SE Assist Tasks ({taskData.tasks.length})</span>
                  <Button size="small" appearance="subtle" onClick={loadTasks} disabled={tasksLoading || workflowBusy || !!savingTask}>Reload Tasks</Button>
                  <Button size="small" onClick={runCreateTasks}
                    disabled={!taskData.canCreateTasks || workflowBusy || notesLoading || !!notesError || tasksLoading || !!savingTask}
                    icon={workflowStep === 'creating' ? <Spinner size="tiny" /> : <AddRegular />}
                    title={taskData.canCreateTasks ? 'Create any missing Tasks from the saved to-do items; existing Tasks are kept' : 'Generate a summary with to-do items first'}
                  >
                    Create Tasks from summary
                  </Button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Local Tasks, not CRM activities. A single tagged customer is preselected; otherwise choose a customer below. Workload is optional.
                </div>
                {tasksLoading && <Spinner size="tiny" label="Loading meeting Tasks..." />}
                {tasksError && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{tasksError}</div>}
                {tasksNote && <div role="status" style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>{tasksNote}</div>}
                {taskData.tasks.length > 0 && <TaskAssignmentStatus state={assignments} />}
                {!tasksLoading && !tasksError && !taskData.tasks.length && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No meeting Tasks yet.</div>
                )}
                <ul aria-label="Meeting Task list" style={{ padding: 0, margin: '8px 0 0', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {taskData.tasks.map(task => (
                    <li key={task.id} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{task.title}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            {task.status}{task.dueAt ? ` - due ${task.dueAt}` : ''}{savingTask === task.id ? ' - Saving...' : ''}
                          </div>
                          {task.description && <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 4 }}>{task.description}</div>}
                        </div>
                        <Button size="small" disabled={workflowBusy || !!savingTask}
                          onClick={() => updateTask(task, { status: task.status === 'done' ? 'open' : 'done' })}
                          aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} Task: ${task.title}`}
                        >{task.status === 'done' ? 'Reopen' : 'Done'}</Button>
                        <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={workflowBusy || !!savingTask}
                          onClick={() => removeTask(task)} aria-label={`Delete Task: ${task.title}`} title="Delete Task" />
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
                        <TaskCustomerPicker state={assignments} taskTitle={task.title}
                          profileId={task.profileId} customerName={task.customerName}
                          disabled={workflowBusy || !!savingTask} onChange={value => updateTask(task, { profileId: value })} />
                        <TaskWorkloadPicker state={assignments} taskTitle={task.title}
                          workloadId={task.workloadId} workloadName={task.workloadName}
                          disabled={workflowBusy || !!savingTask} onChange={value => updateTask(task, { workloadId: value })} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Milestone linking */}
              <div data-tour="mtg-link" style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                  <LinkRegular /> Linked milestones {links.length ? `(${links.length})` : ''}
                </div>

                {/* Account SSP — ask them in Teams whether this meeting maps to a milestone. */}
                {(tpids.length > 0 || inTour) && (
                  ssps.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                      {ssps.map((s) => (
                        <div key={s.tpid} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            SSP{ssps.length > 1 && s.account_name ? ` · ${s.account_name}` : ''}:
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text)' }}>{s.ssp_name}</span>
                          <button
                            type="button"
                            className="mtg-inline-btn teams-chat-btn"
                            onClick={() => askSspInTeams(s)}
                            title={`Ask ${s.ssp_name} in Teams whether this meeting maps to a milestone`}
                          >
                            <ChatRegular /> Ask in Teams
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : inTour ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>SSP:</span>
                      <span style={{ fontSize: 12, color: 'var(--text)' }}>{SAMPLE_SSP.ssp_name}</span>
                      <button
                        type="button"
                        className="mtg-inline-btn teams-chat-btn"
                        onClick={() => askSspInTeams(SAMPLE_SSP)}
                        title="Ask the account's SSP in Teams whether this meeting maps to a milestone"
                      >
                        <ChatRegular /> Ask in Teams
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 10 }}>
                      No SSP is configured on this account’s team.
                    </div>
                  )
                )}
                {links.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {links.map((l) => (
                      <span key={l.milestone_id} title={l.opportunity_name || ''} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)',
                        border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 14,
                        padding: '3px 6px 3px 10px', fontSize: 12, maxWidth: '100%',
                      }}>
                        <FlagRegular style={{ fontSize: 12, color: 'var(--accent)' }} />
                        <span
                          role="button"
                          tabIndex={0}
                          title="View milestone details"
                          onClick={() => openMilestoneDetail(l.milestone_id)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMilestoneDetail(l.milestone_id); } }}
                          style={{
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220,
                            cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline',
                          }}
                        >
                          {l.milestone_name || l.milestone_id}
                        </span>
                        <Button
                          size="small" appearance="subtle" icon={<DismissRegular />}
                          onClick={() => doUnlink(l.milestone_id)} title="Unlink this milestone"
                          style={{ minWidth: 20, height: 20, padding: 0 }}
                        />
                      </span>
                    ))}
                  </div>
                )}
                {tpids.length === 0 ? (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    Tag this meeting to an account first, then pick one of the account’s milestones to link.
                  </span>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={pickMilestone}
                      onChange={(e) => setPickMilestone(e.target.value)}
                      style={{ flex: 1, minWidth: 220, padding: '6px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
                    >
                      <option value="">{candLoading ? 'Loading milestones…' : (linkableCandidates.length ? 'Select a milestone to link…' : 'No active, uncommitted milestones for this account')}</option>
                      {linkableCandidates.map((c) => (
                        <option key={c.milestone_id} value={c.milestone_id}>
                          {(c.opportunity_name ? `${c.opportunity_name} — ` : '')}{c.name}{c.status_label ? ` (${c.status_label})` : ''}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="small" appearance="primary" icon={linkBusy ? <Spinner size="tiny" /> : <AddRegular />}
                      disabled={!pickMilestone || linkBusy} onClick={doLink}
                    >
                      Link
                    </Button>
                  </div>
                )}
                {tpids.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-faint)' }}>
                    Showing active, uncommitted milestones for this meeting’s account.
                  </div>
                )}
                {linkError && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{linkError}</div>}
              </div>

              {/* Generate comment / HoK — act on the target linked milestone */}
              <div style={{ marginTop: 16 }}>
                {links.length === 0 ? (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    Link a milestone above to generate a progress comment or a HoK activity from this meeting.
                  </span>
                ) : (
                  <>
                    {links.length > 1 && (
                      <div style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 8 }}>Act on:</span>
                        <select
                          value={targetMilestone}
                          onChange={(e) => setTargetMilestone(e.target.value)}
                          style={{ padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
                        >
                          {links.map((l) => <option key={l.milestone_id} value={l.milestone_id}>{l.milestone_name || l.milestone_id}</option>)}
                        </select>
                      </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <Button size="small" appearance="primary" icon={commentBusy ? <Spinner size="tiny" /> : <SparkleRegular />} disabled={commentBusy || !targetMilestone} onClick={genComment}>
                        Generate comment
                      </Button>
                      <Button size="small" appearance="primary" icon={hokBusy ? <Spinner size="tiny" /> : <SparkleRegular />} disabled={hokBusy || !targetMilestone} onClick={genHok}>
                        Generate HoK activity
                      </Button>
                    </div>

                    {commentNote && <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{commentNote}</div>}
                    {commentError && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{commentError}</div>}
                    {commentSaved && <div style={{ marginTop: 8, color: 'var(--accent)', fontSize: 12 }}>Comment added to {commentSaved}.</div>}
                    {commentDraft && (
                      <div style={{ marginTop: 8 }}>
                        <textarea
                          value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} rows={4}
                          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
                        />
                        <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                          <Button size="small" appearance="primary" disabled={savingComment || !commentDraft.trim()} onClick={addComment}>
                            {savingComment ? 'Adding…' : `Add to ${targetName || 'milestone'}`}
                          </Button>
                          <Button size="small" appearance="subtle" onClick={() => setCommentDraft('')}>Discard</Button>
                        </div>
                      </div>
                    )}

                    {hokNote && <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>{hokNote}</div>}
                    {hokError && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{hokError}</div>}
                    {hokSaved && <div style={{ marginTop: 8, color: 'var(--accent)', fontSize: 12 }}>HoK activity created on {hokSaved}.</div>}
                    {hokForm && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
                        <input
                          value={hokForm.subject} onChange={(e) => setHokForm((f) => ({ ...f, subject: e.target.value }))}
                          placeholder="Activity subject"
                          style={{ padding: '6px 8px', fontSize: 12, background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
                        />
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <select
                            value={hokForm.category} onChange={(e) => setHokForm((f) => ({ ...f, category: e.target.value }))}
                            style={{ flex: 1, minWidth: 160, padding: '6px 8px', fontSize: 12, background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
                          >
                            <option value="">Category…</option>
                            {TASK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                          <input
                            type="date" value={hokForm.dueDate} onChange={(e) => setHokForm((f) => ({ ...f, dueDate: e.target.value }))}
                            style={{ padding: '6px 8px', fontSize: 12, background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
                          />
                        </div>
                        <textarea
                          value={hokForm.description} onChange={(e) => setHokForm((f) => ({ ...f, description: e.target.value }))} rows={3}
                          placeholder="Description"
                          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button size="small" appearance="primary" disabled={savingHok || !hokForm.subject.trim()} onClick={addHok}>
                            {savingHok ? 'Creating…' : `Create on ${targetName || 'milestone'}`}
                          </Button>
                          <Button size="small" appearance="subtle" onClick={() => setHokForm(null)}>Discard</Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>

    {/* Milestone details popup — the shared DetailCard, stacked above this panel. Clicking
        its backdrop closes only the milestone popup and returns here. */}
    {msDetail && (
      <DetailCard
        detail={msDetail}
        crmBaseUrl={crmBaseUrl}
        onOpenExternal={openExternal}
        onClose={() => setMsDetail(null)}
        onSelect={setMsDetail}
        teamApi={teamApi}
      />
    )}
    </>
  );
}
