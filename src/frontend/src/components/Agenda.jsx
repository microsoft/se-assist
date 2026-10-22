import { useState, useMemo, useCallback } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import {
  ChevronUpRegular,
  ChevronDownRegular,
  SparkleRegular,
  VideoRegular,
  LocationRegular,
  PeopleRegular,
  DismissRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { prepareMeetingBrief, openExternal, saveMeetingNotes } from '../electronBridge';
import MeetingDetailPanel from './MeetingDetailPanel';
import { productCatalogForPrompt } from '../lib/microsoftProducts';
import { parseGraphDateTime } from '../lib/datetime';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 10;

// Local-midnight key for grouping (YYYY-MM-DD in local time).
function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Meeting start/end are stored as naive-UTC strings; parseGraphDateTime treats a
// timezone-less value as UTC so it renders in the user's local timezone.
const parseStart = parseGraphDateTime;

function fmtTime(d) {
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDayHeader(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function AgendaView({ embedded = false }) {
  const { data: meetingRows, loading, error } = useDbQuery(
    `SELECT event_id, subject, organizer_name, organizer_address, start_at, end_at,
            is_online_meeting, online_meeting_url, location, web_link,
            attendees_json, body_text, body_preview, body_source
     FROM active_meetings
     WHERE is_cancelled = 0 AND start_at IS NOT NULL AND start_at != ''
     ORDER BY start_at ASC`,
    [],
  );

  // event_id -> comma-joined linked account names (cheap join, no body_text).
  // Only the top-level (parent) account per TPID is shown — never child accounts.
  // A TPID's parent row is the one with no parent_crm_account_id; children point at it.
  const { data: linkRows, refresh: refreshLinks } = useDbQuery(
    `SELECT l.event_id AS event_id,
            GROUP_CONCAT(COALESCE(c.name, 'TPID ' || l.tpid), '||') AS accounts
     FROM active_meeting_customer_links l
     LEFT JOIN active_customers c
            ON c.tpid = l.tpid
           AND (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '')
     WHERE l.match_method <> 'ai-rejected'
     GROUP BY l.event_id`,
    [],
  );

  const accountsByEvent = useMemo(() => {
    const map = new Map();
    for (const r of linkRows || []) {
      if (r.accounts) map.set(r.event_id, r.accounts.split('||').filter(Boolean));
    }
    return map;
  }, [linkRows]);

  const meetings = useMemo(() => {
    return (meetingRows || [])
      .map((m) => ({ ...m, _start: parseStart(m.start_at), _end: parseStart(m.end_at) }))
      .filter((m) => m._start);
  }, [meetingRows]);

  const todayMidnight = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }, []);

  const { upcoming, past } = useMemo(() => {
    const up = [];
    const pa = [];
    for (const m of meetings) {
      if (m._start.getTime() >= todayMidnight) up.push(m);
      else pa.push(m);
    }
    up.sort((a, b) => a._start - b._start);
    pa.sort((a, b) => b._start - a._start); // nearest past first
    return { upcoming: up, past: pa };
  }, [meetings, todayMidnight]);

  const [beforeCount, setBeforeCount] = useState(0);
  const [afterCount, setAfterCount] = useState(PAGE);

  // AI prep state per event.
  const [prep, setPrep] = useState({}); // eventId -> { loading, reply, error, meta }

  // Meeting-details modal: the clicked meeting's event_id (opened in the shared
  // ItemDetailPanel, which fetches full metadata + account tags itself).
  const [detail, setDetail] = useState(null); // event_id string | null

  const runPrep = useCallback(async (eventId) => {
    setPrep((p) => ({ ...p, [eventId]: { loading: true } }));
    try {
      const res = await prepareMeetingBrief({ eventId, products: productCatalogForPrompt() });
      if (res && res.ok) {
        const reply = res.reply || '';
        // Auto-save the brief into the meeting's Preparation notes so it appears in the
        // meeting details popup (and survives calendar re-sync). Surface a save failure
        // honestly; the brief is still shown so it is never lost.
        let saveError = '';
        try {
          const saved = await saveMeetingNotes({ eventId, patch: { preparation_notes: reply } });
          if (!saved?.ok) saveError = saved?.error || 'Could not save to meeting details.';
        } catch (err) {
          saveError = err?.message || String(err);
        }
        setPrep((p) => ({ ...p, [eventId]: { loading: false, reply, meta: res.meta, saved: !saveError, saveError } }));
      } else {
        setPrep((p) => ({ ...p, [eventId]: { loading: false, error: (res && res.error) || 'Preparation failed.' } }));
      }
    } catch (e) {
      setPrep((p) => ({ ...p, [eventId]: { loading: false, error: e?.message || String(e) } }));
    }
  }, []);

  const dismissPrep = useCallback((eventId) => {
    setPrep((p) => {
      const next = { ...p };
      delete next[eventId];
      return next;
    });
  }, []);

  // Visible slice: nearest `beforeCount` past + nearest `afterCount` upcoming.
  const visible = useMemo(() => {
    const shownPast = past.slice(0, beforeCount);
    const shownUpcoming = upcoming.slice(0, afterCount);
    return [...shownPast, ...shownUpcoming].sort((a, b) => a._start - b._start);
  }, [past, upcoming, beforeCount, afterCount]);

  // Build the day rows across the covered range, including empty days.
  const dayRows = useMemo(() => {
    if (loading) return [];
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let rangeStart = new Date(today0);
    let rangeEnd = new Date(today0);
    if (visible.length) {
      rangeStart = new Date(visible[0]._start.getFullYear(), visible[0]._start.getMonth(), visible[0]._start.getDate());
      const last = visible[visible.length - 1]._start;
      rangeEnd = new Date(last.getFullYear(), last.getMonth(), last.getDate());
      // Always keep today inside the range so "today" is visible as an anchor.
      if (today0 < rangeStart) rangeStart = new Date(today0);
      if (today0 > rangeEnd) rangeEnd = new Date(today0);
    }

    const byDay = new Map();
    for (const m of visible) {
      const k = dayKey(m._start);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(m);
    }

    const rows = [];
    // Safety cap so a far-out meeting can't render thousands of empty days.
    const maxDays = 400;
    let cursor = new Date(rangeStart);
    let guard = 0;
    while (cursor <= rangeEnd && guard < maxDays) {
      const k = dayKey(cursor);
      rows.push({
        key: k,
        date: new Date(cursor),
        isToday: isSameLocalDay(cursor, today0),
        meetings: byDay.get(k) || [],
      });
      cursor = new Date(cursor.getTime() + DAY_MS);
      guard += 1;
    }
    return rows;
  }, [visible, loading]);

  const morePast = beforeCount < past.length;
  const moreUpcoming = afterCount < upcoming.length;

  if (loading) {
    return (
      <div>
        {embedded ? null : <div className="page-header"><h2>Agenda</h2></div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', marginTop: embedded ? 8 : 24 }}>
          <Spinner size="tiny" /> Loading meetings…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {embedded ? null : <div className="page-header"><h2>Agenda</h2></div>}
        <p style={{ color: 'var(--danger)', marginTop: 16 }}>Could not load meetings: {error}</p>
      </div>
    );
  }

  return (
    <div>
      {embedded ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          {upcoming.length} upcoming · {past.length} past · every day shown, even empty ones. “Prepare” generates an AI brief.
        </div>
      ) : (
        <>
          <div className="page-header">
            <h2>Agenda</h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {upcoming.length} upcoming · {past.length} past
            </span>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
            A compact day-by-day view of your calendar. Every day is shown, even empty ones. Use “Show More”
            to reveal earlier or later meetings, and “Prepare” to generate an AI meeting brief.
          </p>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, minHeight: 24 }}>
        {morePast && (
          <Button
            size="small"
            appearance="subtle"
            icon={<ChevronUpRegular />}
            onClick={() => setBeforeCount((c) => c + PAGE)}
          >
            Show earlier meetings
          </Button>
        )}
      </div>

      {meetings.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No meetings in the local datastore yet. Sync your calendar (WorkIQ) to populate the agenda.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {dayRows.map((row) => (
            <div
              key={row.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '132px 1fr',
                gap: 12,
                padding: '10px 0',
                borderTop: '1px solid var(--hairline)',
              }}
            >
              <div style={{ paddingTop: 2 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: row.isToday ? 'var(--accent)' : 'var(--text)',
                }}>
                  {fmtDayHeader(row.date)}
                </div>
                {row.isToday && (
                  <span className="badge badge-info" style={{ marginTop: 4, display: 'inline-block' }}>Today</span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {row.meetings.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>No meetings</div>
                ) : (
                  row.meetings.map((m) => {
                    const accounts = accountsByEvent.get(m.event_id) || [];
                    const state = prep[m.event_id];
                    return (
                      <div key={m.event_id} className="card" style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div
                            style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}
                            role="button"
                            tabIndex={0}
                            title="View meeting details"
                            onClick={() => setDetail(m.event_id)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(m.event_id); } }}
                          >
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                              {m.subject || '(no subject)'}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                              <span>
                                {fmtTime(m._start)}{m._end ? ` – ${fmtTime(m._end)}` : ''}
                              </span>
                              {m.organizer_name && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <PeopleRegular fontSize={14} /> {m.organizer_name}
                                </span>
                              )}
                              {m.is_online_meeting ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
                                  <VideoRegular fontSize={14} /> Online
                                </span>
                              ) : m.location ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <LocationRegular fontSize={14} /> {m.location}
                                </span>
                              ) : null}
                            </div>
                            {accounts.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                {accounts.map((a) => (
                                  <span key={a} className="badge badge-success">{a}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            {m.is_online_meeting && m.online_meeting_url && (
                              <Button
                                size="small"
                                appearance="subtle"
                                icon={<VideoRegular />}
                                title="Join online meeting"
                                onClick={() => openExternal(m.online_meeting_url)}
                              >
                                Join
                              </Button>
                            )}
                            <Button
                              size="small"
                              appearance="primary"
                              icon={state?.loading ? <Spinner size="tiny" /> : <SparkleRegular />}
                              disabled={state?.loading}
                              onClick={() => runPrep(m.event_id)}
                            >
                              {state?.loading ? 'Preparing…' : 'Prepare'}
                            </Button>
                          </div>
                        </div>

                        {state && !state.loading && (state.reply || state.error) && (
                          <div style={{
                            marginTop: 10,
                            background: state.error ? 'var(--danger-tint)' : 'var(--surface-2)',
                            border: `1px solid ${state.error ? 'var(--danger-tint)' : 'var(--border)'}`,
                            borderRadius: 6,
                            padding: '10px 12px',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: state.error ? 'var(--danger)' : 'var(--accent)' }}>
                                {state.error ? 'Preparation failed' : 'Meeting brief'}
                                {!state.error && state.saved ? (
                                  <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> · Saved to meeting details</span>
                                ) : null}
                              </span>
                              <Button
                                size="small"
                                appearance="subtle"
                                icon={<DismissRegular />}
                                title="Dismiss"
                                onClick={() => dismissPrep(m.event_id)}
                              />
                            </div>
                            {state.error ? (
                              <div style={{ fontSize: 12.5, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{state.error}</div>
                            ) : (
                              <>
                                <pre style={{
                                  margin: 0,
                                  whiteSpace: 'pre-wrap',
                                  fontFamily: 'inherit',
                                  fontSize: 12.5,
                                  color: 'var(--text)',
                                  lineHeight: 1.5,
                                }}>{state.reply}</pre>
                                {state.saveError ? (
                                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--danger)' }}>
                                    Couldn’t save to meeting details: {state.saveError}
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12, minHeight: 24 }}>
        {moreUpcoming && (
          <Button
            size="small"
            appearance="subtle"
            icon={<ChevronDownRegular />}
            onClick={() => setAfterCount((c) => c + PAGE)}
          >
            Show later meetings
          </Button>
        )}
      </div>

      {detail && (
        <MeetingDetailPanel
          eventId={detail}
          onClose={() => setDetail(null)}
          onTagsChanged={() => { if (refreshLinks) refreshLinks(); }}
        />
      )}
    </div>
  );
}

// Thin page wrapper — the standalone Agenda route renders the full calendar. The same view is
// embedded (compact, headerless) as a collapsible section inside the Action Center.
export default function Agenda() {
  return <AgendaView />;
}
