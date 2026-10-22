import { useState, useCallback, useRef, useEffect } from 'react';
import { Spinner, Textarea, Button } from '@fluentui/react-components';
import {
  ChatSparkleRegular, SendRegular, DismissRegular, SparkleRegular, MailRegular, OpenRegular,
} from '@fluentui/react-icons';
import { secretaryScan, openExternal } from '../electronBridge';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const NO_LINK = 'SE Assist has no stored Outlook link for this email. Find it in Outlook by its subject.';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const isCount = value => Number.isInteger(value) && value >= 0;
// Which stored text the analyzed emails were read from, and whether their sender could be matched to you.
const analyzedDetail = ({ bodySources: { full, condensed, preview }, sentByYou }) => [
  full && `${full} full text`, condensed && `${condensed} condensed`, preview && `${preview} preview only`,
].filter(Boolean).join(', ') + `; ${sentByYou === null ? 'emails you sent cannot be identified until you sign in under User Home → Microsoft 365 sign-in' : `${sentByYou} sent by you`}`;

export default function SecretarySection({ userName }) {
  const [items, setItems] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [secLog, setSecLog] = useState([
    { role: 'assistant', text: 'Find direct tasks and shared customer/team follow-ups from the last 24 hours, ranked by priority. I read only email SE Assist has already pulled and matched to your customer accounts, not your live mailbox, so results are only as current as the last pull. Shared follow-ups are not personal assignments. Use the optional chat for a wider period, one account, or direct assignments only.' },
  ]);
  const [secInput, setSecInput] = useState('');
  const [scanned, setScanned] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const selected = items.find(item => item.id === selectedId) || null;
  const [openingEmailId, setOpeningEmailId] = useState(null);
  const [emailOpenError, setEmailOpenError] = useState(null);
  const secScrollRef = useRef(null);
  const scanningRef = useRef(false);

  useEffect(() => {
    if (secScrollRef.current) secScrollRef.current.scrollTop = secScrollRef.current.scrollHeight;
  }, [secLog, scanning]);

  const runScan = useCallback(async (guidance = '') => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    if (guidance) setSecLog(log => [...log, { role: 'user', text: guidance }]);
    try {
      const res = await secretaryScan({ userName, guidance, ...(guidance ? {} : { days: 1 }) });
      if (!res?.ok) throw new Error(res?.error || 'Scan failed.');
      if (!Array.isArray(res.items) || !res.scope?.label || res.source !== 'local-customer-emails'
        || typeof res.pulledAt !== 'string' || Number.isNaN(Date.parse(res.pulledAt))
        || !Array.isArray(res.pullWarnings) || !Array.isArray(res.unreadable)
        || ![res.scanned, res.analyzed, res.excluded, res.duplicatesMerged].every(isCount)
        || ![res.bodySources?.full, res.bodySources?.condensed, res.bodySources?.preview].every(isCount)
        || !(res.sentByYou === null || isCount(res.sentByYou))
        || !Array.isArray(res.models)
        || res.items.some(item => !['direct', 'shared'].includes(item.ownership))) {
        throw new Error('Restart SE Assist to load the Secretary scan of pulled customer email.');
      }
      setItems(res.items);
      const direct = res.items.filter(item => item.ownership === 'direct').length;
      const shared = res.items.length - direct;
      setScanned({
        direct, shared, scope: res.scope, total: res.scanned, analyzed: res.analyzed, excluded: res.excluded, unreadable: res.unreadable,
        pulledAt: res.pulledAt, pullWarnings: res.pullWarnings, bodySources: res.bodySources, sentByYou: res.sentByYou,
        duplicatesMerged: res.duplicatesMerged, models: res.models, reasoningEffort: res.reasoningEffort || null,
      });
      setSelectedId(res.items[0]?.id || null);
      const coverage = `${plural(res.analyzed, 'readable email')} analyzed; ${res.excluded} excluded as done; ${plural(res.unreadable.length, 'unreadable email')} not assessed`;
      const freshness = `Customer email last pulled ${new Date(res.pulledAt).toLocaleString()}.${res.pullWarnings.length ? ` See the ${plural(res.pullWarnings.length, 'pull warning')} below.` : ''}`;
      setSecLog(log => [...log, {
        role: 'assistant',
        text: `${res.items.length
          ? `Found ${plural(direct, 'direct task')} and ${plural(shared, 'shared follow-up')} for ${res.scope.label} (${coverage}).`
          : res.scanned === 0 ? `No pulled customer email was found for ${res.scope.label}.`
            : res.unreadable.length
              ? `No items identified in the readable emails for ${res.scope.label}. Coverage is incomplete: ${coverage}. Review the unreadable emails in Outlook.`
              : `No direct tasks or shared follow-ups identified for ${res.scope.label} (${coverage}).`} ${freshness}`,
      }]);
    } catch (err) {
      setSecLog(log => [...log, { role: 'error', text: err.message || String(err) }]);
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, [userName]);

  const sendGuidance = () => {
    const value = secInput.trim();
    if (!value || scanning) return;
    setSecInput('');
    runScan(value);
  };
  const openEmail = async item => {
    if (openingEmailId) return;
    setOpeningEmailId(item.id);
    setEmailOpenError(null);
    try {
      if (!item.webLink) throw new Error(NO_LINK);
      await openExternal(item.webLink);
    } catch (err) {
      setEmailOpenError({ itemId: item.id, message: `Could not open the source email: ${err.message || String(err)}` });
    } finally { setOpeningEmailId(null); }
  };
  const dismissItem = id => {
    const remaining = items.filter(item => item.id !== id);
    setItems(remaining);
    if (selectedId === id) setSelectedId(remaining[0]?.id || null);
  };

  return (
    <section className="ac-section ac-secretary">
      <div className="ac-section-head">
        <span className="ac-section-icon suggested"><ChatSparkleRegular /></span>
        <h3>Secretary</h3>
        {items.length ? <span className="ac-section-count active">{items.length}</span> : null}
        <span className="ac-muted sec-head-hint">Direct tasks and shared follow-ups, with ownership kept explicit.</span>
      </div>
      <div className="sec-cols">
        <div className="sec-col sec-agent">
          <div className="sec-agent-log" ref={secScrollRef}>
            {secLog.map((message, index) => (
              <div key={index} className={`sec-chat-row ${message.role === 'user' ? 'me' : ''}`}>
                <div className={`sec-chat-bubble ${message.role}`} role={message.role === 'error' ? 'alert' : undefined}>{message.text}</div>
              </div>
            ))}
            {scanning && <div className="sec-chat-row"><div className="sec-chat-bubble assistant sec-thinking"><Spinner size="tiny" /> Reading pulled customer email…</div></div>}
          </div>
          <div className="sec-agent-foot">
            <button type="button" className="btn btn-primary sec-scan-btn" onClick={() => runScan('')} disabled={scanning}>
              {scanning ? <Spinner size="tiny" /> : <SparkleRegular />} Find all ToDo in the last 24 hours
            </button>
            <div className="sec-agent-input">
              <Textarea value={secInput} onChange={(_event, data) => setSecInput(data.value)}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendGuidance(); } }}
                placeholder="Search further back or by account (optional)…" aria-label="Optional Secretary search"
                resize="none" appearance="filled-darker" style={{ flex: 1, minHeight: 34 }} disabled={scanning} />
              <Button appearance="primary" icon={<SendRegular />} onClick={sendGuidance} disabled={scanning || !secInput.trim()} title="Send" />
            </div>
          </div>
        </div>
        <div className="sec-col sec-list">
          {items.length ? [...items].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]).map(item => (
            <button key={item.id} type="button" className={`sec-task${item.id === selectedId ? ' is-active' : ''}`} onClick={() => setSelectedId(item.id)}>
              <span className={`sec-pri sec-pri-${item.priority}`}>{PRIORITY_LABEL[item.priority]}</span>
              <span className="sec-task-main">
                <span className="sec-task-title">{item.title}</span>
                <span className={`sec-task-ownership ${item.ownership}`}>{item.ownership === 'shared' ? 'Shared follow-up' : 'Direct task'}</span>
                <span className="sec-task-sub">{item.account || item.from || item.subject || ''}</span>
              </span>
            </button>
          )) : <div className="sec-empty ac-muted">{scanned
            ? scanned.total === 0 ? 'No pulled customer email was found for this period.'
              : scanned.unreadable.length ? 'No items identified in readable emails. Review the incomplete coverage below.'
                : 'No direct tasks or shared follow-ups identified in the pulled customer email.'
            : 'Find todos from the last 24 hours to show them here.'}</div>}
        </div>
        <div className="sec-col sec-reader">
          {selected ? <>
            <div className="sec-reader-head">
              <span className={`sec-pri sec-pri-${selected.priority}`}>{PRIORITY_LABEL[selected.priority]}</span>
              <h4 className="sec-reader-title">{selected.title}</h4>
            </div>
            <div className="sec-reader-meta">
              {selected.from && <span><MailRegular style={{ fontSize: 12, verticalAlign: '-2px' }} /> {selected.from}</span>}
              {selected.account && <span>· {selected.account}</span>}
              {selected.date && <span>· {new Date(selected.date).toLocaleDateString()}</span>}
            </div>
            {selected.subject && <div className="sec-reader-subject">{selected.subject}</div>}
            <p className="sec-reader-summary">{selected.summary || 'No summary.'}</p>
            <div className="sec-ownership-note">
              {selected.ownership === 'shared'
                ? `Shared follow-up — not assigned to you.${selected.owner ? ` Owner / coordinating team: ${selected.owner}.` : ' The owner is not confirmed.'}`
                : `Direct task${selected.owner ? ` — ${selected.owner}` : ''}.`}
            </div>
            {selected.excerpt && <div className="sec-reader-excerpt">{selected.excerpt}</div>}
            <div className="sec-reader-actions">
              <button type="button" className="btn btn-secondary wl-sm" onClick={() => openEmail(selected)}
                disabled={Boolean(openingEmailId) || !selected.webLink}
                title={selected.webLink ? 'Open the source email in Outlook on the web' : NO_LINK}>
                {openingEmailId === selected.id ? <Spinner size="tiny" /> : <OpenRegular />} Open email
              </button>
              <button type="button" className="btn btn-secondary wl-sm" onClick={() => dismissItem(selected.id)}><DismissRegular /> Dismiss</button>
            </div>
            {!selected.webLink && <div className="sec-flash sec-flash-error" role="alert">{NO_LINK}</div>}
            {emailOpenError?.itemId === selected.id && <div className="sec-flash sec-flash-error" role="alert">{emailOpenError.message}</div>}
          </> : <div className="sec-empty ac-muted">Select a task to see the details.</div>}
        </div>
      </div>
      {scanned && <div className="sec-scan-coverage">
        <div className="ac-muted">
          Pulled customer email only · last pulled {new Date(scanned.pulledAt).toLocaleString()}
          {' · '}{scanned.scope.since ? new Date(scanned.scope.since).toLocaleString() : 'All pulled history'} – {new Date(scanned.scope.until).toLocaleString()} · {plural(scanned.total, 'customer email')} in range
          {' · '}{scanned.analyzed} analyzed{scanned.analyzed > 0 && ` (${analyzedDetail(scanned)})`}
          {scanned.duplicatesMerged > 0 && ` · ${plural(scanned.duplicatesMerged, 'duplicate copy', 'duplicate copies')} merged`}
          {' · '}{scanned.excluded} excluded as done
          {scanned.models.length > 0 && <>
            {' · '}Model: {scanned.models.join(', ')}{scanned.reasoningEffort ? ` · ${scanned.reasoningEffort} reasoning` : ''}
          </>}
        </div>
        {scanned.pullWarnings.length > 0 && <div className="work-output-note" role="status">
          <strong>The pulled email may be incomplete or out of date:</strong>
          {scanned.pullWarnings.map((warning, index) => <div key={index}>{warning}</div>)}
          <div>To refresh it, use User Home → WorkIQ Outlook and Teams Sync → Pull new items, then find todos again.</div>
        </div>}
        {scanned.unreadable.length > 0 && <div className="work-output-note" role="status">
          <strong>Incomplete coverage: {plural(scanned.unreadable.length, 'email')} could not be read and {scanned.unreadable.length === 1 ? 'was' : 'were'} not assessed.</strong>
          {scanned.unreadable.map(message => <div key={message.sourceMessageId} className="sec-unreadable-message">
            <div>{message.subject}</div>
            <div>{message.reason}</div>
            <button type="button" className="btn btn-secondary wl-sm"
              disabled={Boolean(openingEmailId) || !message.webLink}
              onClick={() => openEmail({ id: message.sourceMessageId, webLink: message.webLink })}>
              <OpenRegular /> Open in Outlook
            </button>
            {!message.webLink && <div>{NO_LINK}</div>}
            {emailOpenError?.itemId === message.sourceMessageId && <div role="alert">{emailOpenError.message}</div>}
          </div>)}
        </div>}
      </div>}
    </section>
  );
}
