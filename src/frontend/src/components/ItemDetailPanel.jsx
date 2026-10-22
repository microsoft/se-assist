import { useEffect, useState, useCallback } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { DismissRegular, OpenRegular, VideoRegular, MailRegular, CalendarLtrRegular, ChatRegular } from '@fluentui/react-icons';
import { getSignalDetail, untagSignal, openExternal } from '../electronBridge';
import { formatLocalDateTime } from '../lib/datetime';

const MEDIUM_META = {
  email: { label: 'Email', icon: MailRegular },
  meeting: { label: 'Meeting', icon: CalendarLtrRegular },
  chat: { label: 'Teams Chat', icon: ChatRegular },
};

// Attendee RSVP status → display label (mirrors the Graph responseStatus values).
const RESPONSE_LABEL = {
  accepted: 'Accepted',
  tentativelyAccepted: 'Tentative',
  declined: 'Declined',
  notResponded: 'No response',
  none: '',
  organizer: 'Organizer',
};

function parseJsonList(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(v)) return v;
    return [];
  } catch { return []; }
}

function personLabel(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  return p.name || p.emailAddress?.name || p.address || p.emailAddress?.address || '';
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

/**
 * ItemDetailPanel — a shared popup that surfaces the full metadata for a single
 * signal item (email / meeting / chat) plus every customer-account tag attached
 * to it. Each tag is a removable chip: removing it soft-rejects the underlying
 * *_customer_links row (match_method='ai-rejected'), the same convention every
 * read path already filters out, so the change is non-breaking and survives the
 * next ingest. Failures are surfaced verbatim (no silent fallback).
 */
export default function ItemDetailPanel({ medium, id, onClose, onTagsChanged }) {
  const [state, setState] = useState({ loading: true, error: '', item: null });
  const [tags, setTags] = useState([]);
  const [removing, setRemoving] = useState('');
  const [removeError, setRemoveError] = useState('');

  const load = useCallback(async () => {
    setState({ loading: true, error: '', item: null });
    try {
      const res = await getSignalDetail({ medium, id });
      if (!res?.ok) throw new Error(res?.error || 'Could not load item detail.');
      setState({ loading: false, error: '', item: res.item });
      setTags(res.item?.tags || []);
    } catch (err) {
      setState({ loading: false, error: err?.message || String(err), item: null });
    }
  }, [medium, id]);

  useEffect(() => { load(); }, [load]);

  const removeTag = useCallback(async (tpid) => {
    setRemoving(tpid);
    setRemoveError('');
    try {
      const res = await untagSignal({ medium, id, tpid });
      if (!res?.ok) throw new Error(res?.error || 'Could not remove the tag.');
      setTags((prev) => prev.filter((t) => String(t.tpid) !== String(tpid)));
      if (onTagsChanged) onTagsChanged({ medium, id, tpid, remaining: res.remaining });
    } catch (err) {
      setRemoveError(err?.message || String(err));
    } finally {
      setRemoving('');
    }
  }, [medium, id, onTagsChanged]);

  const meta = MEDIUM_META[medium] || { label: 'Item', icon: MailRegular };
  const Icon = meta.icon;
  const item = state.item;

  return (
    <div className="eng-detail-backdrop" onClick={onClose}>
      <div className="eng-detail-card eng-detail-card-wide" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <Icon style={{ fontSize: 20, color: 'var(--accent)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>{meta.label}</div>
              <div style={{ fontWeight: 700, fontSize: 15, wordBreak: 'break-word' }}>
                {item?.title || (state.loading ? 'Loading…' : '(no subject)')}
              </div>
            </div>
          </div>
          <Button size="small" appearance="subtle" icon={<DismissRegular />} onClick={onClose} title="Close" />
        </div>

        {state.loading && (
          <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}><Spinner size="small" label="Loading item…" /></div>
        )}

        {state.error && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--danger-tint)', border: '1px solid var(--danger-tint)', borderRadius: 6, color: 'var(--danger)', fontSize: 12 }}>
            {state.error}
          </div>
        )}

        {item && (
          <>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {medium === 'email' && (
                <>
                  <Row label="From">{item.from_name ? `${item.from_name}${item.from_address ? ` <${item.from_address}>` : ''}` : (item.from_address || '—')}</Row>
                  <Row label="To">{parseJsonList(item.to_json).map(personLabel).filter(Boolean).join(', ') || '—'}</Row>
                  {parseJsonList(item.cc_json).length > 0 && (
                    <Row label="Cc">{parseJsonList(item.cc_json).map(personLabel).filter(Boolean).join(', ')}</Row>
                  )}
                  <Row label="Sent">{item.item_date ? formatLocalDateTime(item.item_date) : '—'}</Row>
                  {item.received_at && <Row label="Received">{formatLocalDateTime(item.received_at)}</Row>}
                  <Row label="Folder">{item.folder}</Row>
                  <Row label="Importance">{item.importance}</Row>
                  <Row label="Attachments">{item.has_attachments ? 'Yes' : 'No'}</Row>
                </>
              )}
              {medium === 'meeting' && (
                <>
                  <Row label="Organizer">{item.from_name ? `${item.from_name}${item.from_address ? ` <${item.from_address}>` : ''}` : (item.from_address || '—')}</Row>
                  <Row label="Start">{item.item_date ? formatLocalDateTime(item.item_date) : '—'}</Row>
                  <Row label="End">{item.end_at ? formatLocalDateTime(item.end_at) : '—'}</Row>
                  <Row label="Location">{item.location}</Row>
                  <Row label="Online">{item.is_online_meeting ? 'Yes' : 'No'}</Row>
                  <Row label="Importance">{item.importance}</Row>
                  <Row label="Sensitivity">{item.sensitivity}</Row>
                  {item.is_cancelled ? <Row label="Status"><span style={{ color: 'var(--danger)' }}>Cancelled</span></Row> : null}
                </>
              )}
              {medium === 'chat' && (
                <>
                  <Row label="Type">{item.chat_type}</Row>
                  <Row label="Members">{item.member_count != null ? String(item.member_count) : '—'}</Row>
                  <Row label="Last from">{item.last_message_from}</Row>
                  <Row label="Last message">{item.item_date ? formatLocalDateTime(item.item_date) : '—'}</Row>
                  <Row label="Unread">{item.has_unread ? 'Yes' : 'No'}</Row>
                </>
              )}
            </div>

            {/* Actions — open the item in its native app. Meetings can have both a
                Join link (online_meeting_url) and an Outlook link (web_link). */}
            {(item.web_link || item.online_meeting_url || item.online_url) && (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {medium === 'meeting' && item.is_online_meeting && item.online_meeting_url && (
                  <Button size="small" appearance="primary" icon={<VideoRegular />} onClick={() => openExternal(item.online_meeting_url)}>
                    Join online meeting
                  </Button>
                )}
                {item.web_link && (
                  <Button
                    size="small"
                    appearance={medium === 'meeting' && item.is_online_meeting && item.online_meeting_url ? 'subtle' : 'primary'}
                    icon={<OpenRegular />}
                    onClick={() => openExternal(item.web_link)}
                  >
                    Open in {medium === 'chat' ? 'Teams' : 'Outlook'}
                  </Button>
                )}
                {!item.web_link && (item.online_meeting_url || item.online_url) && medium !== 'meeting' && (
                  <Button size="small" appearance="primary" icon={<OpenRegular />} onClick={() => openExternal(item.online_meeting_url || item.online_url)}>
                    Open in {medium === 'chat' ? 'Teams' : 'Outlook'}
                  </Button>
                )}
              </div>
            )}

            {/* Attendees (meetings) — listed with RSVP status when available. */}
            {medium === 'meeting' && parseJsonList(item.attendees_json).length > 0 && (
              <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                  Attendees ({parseJsonList(item.attendees_json).length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 220, overflowY: 'auto' }}>
                  {parseJsonList(item.attendees_json).map((a, i) => {
                    const name = personLabel(a);
                    if (!name) return null;
                    const addr = a.address || a.emailAddress?.address || '';
                    const label = RESPONSE_LABEL[a.response] ?? '';
                    return (
                      <div key={`${addr || name}-${i}`} style={{ fontSize: 12, color: 'var(--text)' }}>
                        {name}
                        {addr && a.name ? <span style={{ color: 'var(--text-faint)' }}> · {addr}</span> : null}
                        {label ? <span style={{ color: 'var(--text-muted)' }}> — {label}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Account tags */}
            <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                Tagged accounts {tags.length ? `(${tags.length})` : ''}
              </div>
              {tags.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No account tags on this item.</span>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {tags.map((t) => (
                    <span
                      key={t.tpid}
                      title={[t.match_method, t.tier, t.confidence != null ? `conf ${t.confidence}` : null].filter(Boolean).join(' · ')}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: 'var(--accent-tint)', border: '1px solid var(--accent-tint)', color: 'var(--text-secondary)',
                        borderRadius: 14, padding: '3px 6px 3px 10px', fontSize: 12, maxWidth: '100%',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.account_name || t.tpid}
                      </span>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={removing === String(t.tpid) ? <Spinner size="tiny" /> : <DismissRegular />}
                        disabled={removing === String(t.tpid)}
                        onClick={() => removeTag(t.tpid)}
                        title="Remove this account tag"
                        style={{ minWidth: 20, height: 20, padding: 0 }}
                      />
                    </span>
                  ))}
                </div>
              )}
              {removeError && (
                <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{removeError}</div>
              )}
            </div>

            {/* Body / agenda / messages */}
            {medium === 'chat' && Array.isArray(item.messages) && item.messages.length > 0 && (
              <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Recent messages</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {item.messages.map((m, i) => (
                    <div key={i} style={{ fontSize: 12 }}>
                      <div style={{ color: 'var(--text-muted)' }}>
                        {m.sender_name || 'Unknown'}{m.sent_at ? ` · ${formatLocalDateTime(m.sent_at)}` : ''}
                      </div>
                      <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{m.excerpt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {medium !== 'chat' && item.body_text && (
              <div className="eng-detail-section" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--canvas)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                  {medium === 'meeting' ? 'Agenda / notes' : 'Body'}
                </div>
                <pre style={{
                  margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)', background: 'var(--surface-2)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: 10,
                  fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5, maxHeight: 260, overflowY: 'auto',
                }}>
                  {item.body_text}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
