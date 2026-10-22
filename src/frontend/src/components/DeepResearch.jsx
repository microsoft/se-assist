import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Button, Combobox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Option, Spinner,
  useArrowNavigationGroup, useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular, AttachRegular, BeakerRegular, BuildingRegular, ChevronDownRegular, DeleteRegular,
  DocumentSearchRegular, ImportantRegular, LockClosedRegular, OpenRegular, SearchRegular,
} from '@fluentui/react-icons';
import {
  emailDetail, emailSearch, openExternal, workOutputList, workOutputOpen, workOutputRemove,
} from '../electronBridge';
import { useTerritory } from '../territoryContext';
import { formatLocalDate, formatLocalDateTime } from '../lib/datetime';
import WorkOutputsPanel from './WorkOutputsPanel';

const PULL_PATH = 'User Home → WorkIQ Outlook and Teams Sync → Pull new items';
const SEARCH_ERROR = 'Restart SE Assist to load Deep Research email search.';
const DETAIL_ERROR = 'Restart SE Assist to load Deep Research email details.';
const SUBJECTS_ERROR = 'Restart SE Assist to load Deep Research subjects.';
const PAGE_SIZE = 20;
const MAX_ACCOUNT_TAGS = 3;
const ALL_ACCOUNTS = 'All customer accounts';
const AREAS = [['situation', 'Situation'], ['actions', 'Actions'], ['reply', 'Reply'], ['technical', 'Technical']];
const STATUS = {
  idle: 'Not started', working: 'Working', ready: 'Ready', ready_with_gaps: 'Ready with gaps',
  failed: 'Failed', needs_input: 'Needs input',
};
const STATUS_TONE = { working: 'working', ready: 'ready', ready_with_gaps: 'warn', needs_input: 'warn', failed: 'failed' };
const BODY_LABEL = {
  full: 'Full stored text',
  condensed: 'Condensed text stored by the email pull',
  preview: 'Preview only — the email pull stored just the opening of this message',
};

const isCount = value => Number.isInteger(value) && value >= 0;
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
const errorText = error => String(error?.message || error)
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
// Fits a value to a saved research-subject field without splitting a surrogate pair.
const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
};
const personText = person => {
  const name = person?.name || '';
  const address = person?.address || '';
  return name && address ? `${name} <${address}>` : name || address;
};
const recipients = list => {
  const named = list.map(personText).filter(Boolean);
  const blank = list.length - named.length;
  return [...named, ...(blank ? [`${plural(blank, 'recipient')} with no stored name or address`] : [])].join('; ');
};
const dateText = value => (value ? formatLocalDateTime(value) || `Unreadable date: ${value}` : 'No date stored');
const shortDate = value => (value
  ? formatLocalDate(value, { month: 'short', day: 'numeric', year: 'numeric' }) || 'Unreadable date'
  : 'No date');
const subjectText = subject => subject.trim() || '(no subject)';
// The account list opens below the field, or above it when there is no room, and keeps its own height cap.
const PICKER_POSITION = { position: 'below', align: 'start', fallbackPositions: ['above'], autoSize: false };
const scrollBehavior = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// One page of the stored email list. An older desktop process answers without accounts or paging.
function readablePage(result, account) {
  return ['recent', 'search'].includes(result.mode) && typeof result.query === 'string'
    && (result.account?.tpid ?? null) === account
    && Array.isArray(result.results) && Array.isArray(result.accounts)
    && [result.total, result.storedCount, result.unreadablePullTimes].every(isCount)
    && (result.pulledAt === null || typeof result.pulledAt === 'string')
    && (result.nextCursor === null || typeof result.nextCursor === 'string')
    && result.results.every(email => typeof email?.messageId === 'string' && typeof email.subject === 'string'
      && Array.isArray(email.accounts))
    && result.accounts.every(entry => typeof entry?.tpid === 'string' && typeof entry.label === 'string'
      && isCount(entry.emailCount));
}

function accountTags(accounts) {
  if (!accounts.length) {
    return [<span key="account-none" className="dr-tag muted" title="SE Assist has not linked this email to a customer account.">
      No customer account</span>];
  }
  const rest = accounts.slice(MAX_ACCOUNT_TAGS);
  const tags = accounts.slice(0, MAX_ACCOUNT_TAGS).map((label, index) => (
    <span key={`account-${index}`} className="dr-tag account" title={`Customer account: ${label}`}>
      <BuildingRegular /><span>{label}</span>
    </span>));
  if (rest.length) {
    tags.push(<span key="account-more" className="dr-tag account" title={`Also linked to ${rest.join(', ')}`}>
      +{rest.length} more</span>);
  }
  return tags;
}

// `accounts` adds customer account chips to a list row. The detail dialog lists the accounts in full instead.
function EmailTags({ email, bodySource, accounts = null, id }) {
  const tags = accounts ? accountTags(accounts) : [];
  if (email.isProtected) tags.push(<span key="protected" className="dr-tag warn"><LockClosedRegular /> Protected</span>);
  if (bodySource === 'preview') tags.push(<span key="preview" className="dr-tag warn">Preview only</span>);
  if (bodySource === null) tags.push(<span key="empty" className="dr-tag warn">No stored text</span>);
  if (email.hasAttachments) tags.push(<span key="attach" className="dr-tag"><AttachRegular /> Attachments</span>);
  if (String(email.importance).toLowerCase() === 'high') {
    tags.push(<span key="high" className="dr-tag"><ImportantRegular /> High importance</span>);
  }
  if (email.copies > 1) {
    tags.push(<span key="copies" className="dr-tag"
      title="SE Assist stored this message more than once, for example as a sent and a received copy. They are shown as one email.">
      {plural(email.copies, 'stored copy', 'stored copies')}</span>);
  }
  return tags.length ? <span className="dr-tags" id={id}>{tags}</span> : null;
}

// `accountName` names the customer account the list is narrowed to, if any.
function searchStatus(search, accountName) {
  const { mode, total, results, storedCount, pulledAt, unreadablePullTimes, query } = search;
  const linked = accountName ? ` linked to ${accountName}` : '';
  const shown = results.length.toLocaleString();
  const found = storedCount === 0 ? `No email is stored in SE Assist yet. Pull email from ${PULL_PATH}.`
    : mode === 'recent'
      ? total === 0 ? `No stored email${linked}.`
        : results.length < total ? `Showing the ${shown} most recent of ${plural(total, 'stored email')}${linked}.`
          : `Showing ${plural(total, 'stored email')}${linked}.`
      : total === 0 ? `No stored email${linked} matches “${query}”.`
        : results.length < total ? `${plural(total, 'matching email')}${linked}, showing the newest ${shown}.`
          : `${plural(total, 'matching email')}${linked}.`;
  const pulled = pulledAt ? `Last pulled ${dateText(pulledAt)}.` : 'No email pull time is recorded.';
  const unreadable = unreadablePullTimes ? ` ${plural(unreadablePullTimes, 'pull time')} could not be read.` : '';
  return `${found} ${pulled}${unreadable}`;
}

// Narrows the list to email linked to one customer account. Typing filters the accounts.
function AccountPicker({ accounts, selected, onSelect }) {
  const [filter, setFilter] = useState(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const options = accounts || [];
  const shown = selected ? selected.label : ALL_ACCOUNTS;
  const needle = (filter || '').trim().toLowerCase();
  const visible = needle ? options.filter(entry => entry.label.toLowerCase().includes(needle)) : options;
  // A focused box showing the chosen account keeps it selected, so typing replaces it instead of appending.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (filter === null && input && document.activeElement === input) input.select();
  }, [filter, shown]);
  return (
    <Combobox ref={inputRef} className="dr-account-picker" aria-label="Customer account"
      value={filter ?? shown} selectedOptions={[selected?.tpid ?? '']}
      placeholder="Type to find a customer account" disabled={!accounts} open={open}
      title={accounts ? undefined : 'Customer accounts appear once the stored email list loads.'}
      onOpenChange={(_event, data) => {
        setOpen(data.open);
        // Opening starts a new search; closing shows the chosen account again.
        setFilter(data.open ? current => current ?? '' : null);
      }}
      onBlur={() => setFilter(null)}
      onChange={event => {
        setFilter(event.target.value);
        setOpen(true);
      }}
      onOptionSelect={(_event, data) => {
        // Fluent reports a cleared selection once typed text stops prefix-matching an option.
        // The selection is controlled here, so keep filtering rather than closing the list.
        if (data.optionValue === undefined) return;
        setOpen(false);
        setFilter(null);
        onSelect(data.optionValue ? { tpid: data.optionValue, label: data.optionText } : null);
      }}
      positioning={PICKER_POSITION} listbox={{ style: { maxHeight: 320 } }}>
      <Option value="" text={ALL_ACCOUNTS}>{ALL_ACCOUNTS}</Option>
      {visible.map(entry => (
        <Option key={entry.tpid} value={entry.tpid} text={entry.label}>
          <span className="dr-account-option">
            <span className="dr-account-name" title={entry.label}>{entry.label}</span>
            <span className="dr-account-count" title={`${plural(entry.emailCount, 'stored email')} linked`}>
              {entry.emailCount.toLocaleString()}
            </span>
          </span>
        </Option>))}
      {!options.length && <Option disabled value="no-accounts" text="No linked email">
        No stored email is linked to a customer account yet</Option>}
      {options.length > 0 && !visible.length && <Option disabled value="no-matches" text="No matching accounts">
        No matching customer accounts</Option>}
    </Combobox>
  );
}

export default function DeepResearch() {
  const { currentUserName } = useTerritory();

  const [query, setQuery] = useState('');
  const [account, setAccount] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const [search, setSearch] = useState(null);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState(null);
  const [more, setMore] = useState({ loading: false, error: null });
  const searchSeq = useRef(0);
  const moreSeq = useRef(0);
  // Where keyboard focus goes once “See more” finishes: the first email it added.
  const moreFocus = useRef(null);
  const moreRef = useRef(null);
  const resultsRef = useRef(null);
  const refreshRef = useRef(null);
  // Rows that open a dialog get focus back when it closes; arrow keys move between email rows.
  const restoreFocusTarget = useRestoreFocusTarget();
  const resultsNavigation = useArrowNavigationGroup({ axis: 'vertical' });
  const trimmedQuery = query.trim();
  const refreshSearch = useCallback(() => setSearchRefresh(value => value + 1), []);
  // Shows the selected account under its current label, which changes when another account gets the same name.
  const picked = account && { tpid: account.tpid, label: accounts?.find(entry => entry.tpid === account.tpid)?.label ?? account.label };

  // Dialogs stay mounted and toggle `open`: unmounting an open Fluent Dialog leaves the app root
  // aria-hidden. Their data is kept after closing so the exit animation still has content.
  const [detail, setDetail] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [opening, setOpening] = useState(false);
  const [starting, setStarting] = useState(false);
  const detailSeq = useRef(0);
  const startingRef = useRef(false);

  const [subjects, setSubjects] = useState(null);
  const [subjectsLoading, setSubjectsLoading] = useState(true);
  const [subjectsError, setSubjectsError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const subjectsSeq = useRef(0);
  const wasBusy = useRef(false);
  const panelRef = useRef(null);
  const subjectsHeadRef = useRef(null);
  const subjectsListRef = useRef(null);

  useEffect(() => {
    const seq = ++searchSeq.current;
    moreSeq.current++;
    setSearching(true);
    setMore({ loading: false, error: null });
    const tpid = account?.tpid ?? null;
    const timer = setTimeout(async () => {
      try {
        const result = await emailSearch({ query: trimmedQuery, account: tpid, limit: PAGE_SIZE });
        if (seq !== searchSeq.current) return;
        if (!result?.ok) throw new Error(result?.error || 'Email search failed.');
        if (!readablePage(result, tpid)) throw new Error(SEARCH_ERROR);
        // The label is missing when no stored email is linked to the account any more.
        setSearch({ ...result, seq, accountName: result.account ? result.account.label ?? account.label : null, changed: false });
        setAccounts(result.accounts);
        setSearchError(null);
      } catch (error) {
        if (seq !== searchSeq.current) return;
        setSearch(null);
        setSearchError(errorText(error));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, trimmedQuery ? 250 : 0);
    return () => clearTimeout(timer);
  }, [trimmedQuery, account, searchRefresh]);

  // “See more” continues after the last email shown, with the same account and search words.
  const loadMore = async () => {
    if (!search?.nextCursor || searching || more.loading) return;
    const token = ++moreSeq.current;
    const base = search;
    const tpid = base.account?.tpid ?? null;
    moreFocus.current = { seq: base.seq, from: base.results.length };
    setMore({ loading: true, error: null });
    try {
      const result = await emailSearch({ query: base.query, account: tpid, cursor: base.nextCursor, limit: PAGE_SIZE });
      if (token !== moreSeq.current) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not read more stored email.');
      if (!readablePage(result, tpid) || result.mode !== base.mode || result.query !== base.query) throw new Error(SEARCH_ERROR);
      setSearch(previous => {
        if (previous?.seq !== base.seq) return previous;
        const listed = new Set(previous.results.map(email => email.messageId));
        return {
          ...previous,
          results: [...previous.results, ...result.results.filter(email => !listed.has(email.messageId))],
          nextCursor: result.nextCursor,
          total: result.total,
          storedCount: result.storedCount,
          pulledAt: result.pulledAt,
          unreadablePullTimes: result.unreadablePullTimes,
          accountName: result.account ? result.account.label ?? previous.accountName : null,
          // Email pulled or relinked since the first page is not in this list until it is refreshed.
          changed: previous.changed || result.total !== previous.total || result.storedCount !== previous.storedCount
            || result.pulledAt !== previous.pulledAt,
        };
      });
      setAccounts(result.accounts);
      setMore({ loading: false, error: null });
    } catch (error) {
      if (token !== moreSeq.current) return;
      setMore({ loading: false, error: `Could not show more email: ${errorText(error)}` });
    }
  };

  // Focus follows “See more” only when it was left there (or lost when the button disappeared), so a
  // finished page never pulls focus away from somewhere else.
  useEffect(() => {
    const pending = moreFocus.current;
    if (!pending || more.loading) return;
    moreFocus.current = null;
    if (pending.seq !== search?.seq) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== moreRef.current) return;
    const rows = resultsRef.current?.querySelectorAll('.dr-result') || [];
    (rows[pending.from] || moreRef.current || rows[rows.length - 1])?.focus();
  }, [search, more.loading]);

  const selectAccount = useCallback(next => {
    setAccount(previous => ((previous?.tpid ?? null) === (next?.tpid ?? null) ? previous : next));
  }, []);

  const loadSubjects = useCallback(async () => {
    const seq = ++subjectsSeq.current;
    setSubjectsLoading(true);
    try {
      const result = await workOutputList();
      if (seq !== subjectsSeq.current) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not load research subjects.');
      if (!Array.isArray(result.subjects)
        || result.subjects.some(subject => typeof subject?.id !== 'string' || !subject.areas || typeof subject.areas !== 'object')) {
        throw new Error(SUBJECTS_ERROR);
      }
      setSubjects(result.subjects);
      setSubjectsError(null);
    } catch (error) {
      if (seq !== subjectsSeq.current) return;
      setSubjects(null);
      setSubjectsError(errorText(error));
    } finally {
      if (seq === subjectsSeq.current) setSubjectsLoading(false);
    }
  }, []);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);
  // Refresh the saved statuses once the open research stops working.
  useEffect(() => {
    if (wasBusy.current && !busy) loadSubjects();
    wasBusy.current = busy;
  }, [busy, loadSubjects]);

  // Brings the research workspace into view and puts keyboard focus on its heading, so keyboard and
  // screen-reader users continue where the work is. Focusing it also stops a closing dialog from
  // sending focus back to the email row.
  const scrollToPanel = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    panel.querySelector('.sec-solve-title')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!selected?.id) return undefined;
    const frame = requestAnimationFrame(scrollToPanel);
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, scrollToPanel]);
  // Closing the panel removes its focused Close button, so focus returns to the subject's row once the
  // panel is gone and the rows are enabled again, or to the list heading when that row is unavailable.
  const closeFocus = useRef(null);
  const closePanel = useCallback(() => {
    closeFocus.current = selected?.id || null;
    setSelected(null);
  }, [selected?.id]);
  useEffect(() => {
    const id = closeFocus.current;
    if (!id || selected || busy) return;
    closeFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const row = [...(subjectsListRef.current?.querySelectorAll('.dr-subject-main') || [])]
      .find(button => button.dataset.subjectId === id);
    (row && !row.disabled ? row : subjectsHeadRef.current)?.focus();
  }, [selected, busy]);

  const openDetail = useCallback(async preview => {
    const seq = ++detailSeq.current;
    setActionError(null);
    setDetail({ preview, email: null, loading: true, error: null });
    setDetailOpen(true);
    try {
      const result = await emailDetail({ messageId: preview.messageId });
      if (seq !== detailSeq.current) return;
      if (!result?.ok) throw new Error(result?.error || 'Could not open this email.');
      const email = result.email;
      if (email?.messageId !== preview.messageId || typeof email.subject !== 'string'
        || typeof email.body?.text !== 'string' || typeof email.webLink !== 'string'
        || ![email.to, email.cc, email.accounts, email.warnings].every(Array.isArray)) {
        throw new Error(DETAIL_ERROR);
      }
      setDetail({ preview, email, loading: false, error: null });
    } catch (error) {
      if (seq !== detailSeq.current) return;
      setDetail({ preview, email: null, loading: false, error: errorText(error) });
    }
  }, []);

  const closeDetail = () => {
    detailSeq.current++;
    setDetailOpen(false);
    setActionError(null);
  };

  const openInOutlook = async email => {
    if (opening) return;
    setOpening(true);
    setActionError(null);
    try {
      await openExternal(email.webLink);
    } catch (error) {
      setActionError(`Could not open the source email: ${errorText(error)}`);
    } finally {
      setOpening(false);
    }
  };

  const startResearch = async email => {
    if (startingRef.current || busy || email.isProtected) return;
    startingRef.current = true;
    setStarting(true);
    setActionError(null);
    try {
      const subject = email.subject.trim();
      const result = await workOutputOpen({
        task: {
          title: clip(subjectText(subject), 300),
          sourceMessageId: email.messageId,
          subject: clip(subject, 500),
          from: clip(personText(email.from), 500),
          account: clip(email.accountLabel || '', 300),
          webLink: email.webLink,
          date: email.date || '',
        },
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not save the research subject.');
      const { id, task } = result.investigation || {};
      if (typeof id !== 'string' || typeof task?.title !== 'string') throw new Error('Restart SE Assist to start Deep Research.');
      detailSeq.current++;
      setDetailOpen(false);
      // The panel is already open: wait for the dialog to start closing before moving focus to it.
      if (selected?.id === id) requestAnimationFrame(scrollToPanel);
      else setSelected({ id, task });
      loadSubjects();
    } catch (error) {
      setActionError(`Could not start Deep Research: ${errorText(error)}`);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const confirmRemove = async () => {
    const target = removing?.subject;
    if (!target || removing.working || busy) return;
    setRemoving(previous => ({ ...previous, working: true, error: null }));
    try {
      const result = await workOutputRemove({ investigationId: target.id });
      if (!result?.ok) throw new Error(result?.error || 'Could not remove the research subject.');
      if (result.removed !== target.id) throw new Error('Restart SE Assist to remove Deep Research subjects.');
      setSelected(previous => (previous?.id === target.id ? null : previous));
      setRemoveOpen(false);
      // The removed row's button is gone, so focus moves to the list heading instead of an older row.
      subjectsHeadRef.current?.focus();
      loadSubjects();
    } catch (error) {
      setRemoving(previous => (previous
        ? { ...previous, working: false, error: `Could not remove this research subject: ${errorText(error)}` }
        : previous));
    }
  };

  const email = detail?.email || null;

  const subjectRow = subject => {
    const { task } = subject;
    const active = selected?.id === subject.id;
    const saved = AREAS.filter(([area]) => subject.areas[area] && subject.areas[area] !== 'idle');
    return (
      <li key={subject.id} className={`dr-subject${active ? ' is-active' : ''}`}>
        <button type="button" className="dr-subject-main" disabled={!task || (busy && !active)} data-subject-id={subject.id}
          aria-current={active ? 'true' : undefined}
          onClick={() => (active ? scrollToPanel() : setSelected({ id: subject.id, task }))}>
          <span className="dr-subject-title">{task ? task.title : 'Unreadable research subject'}</span>
          {task
            ? <span className="dr-subject-sub">{[task.from, task.account, task.date && shortDate(task.date)].filter(Boolean).join(' · ') || 'No sender, account, or date saved'}</span>
            : <span className="dr-subject-error">{subject.error}</span>}
          <span className="dr-tags">
            {active && busy
              ? <span className="dr-tag working"><Spinner size="extra-tiny" /> Research running below</span>
              : saved.length
                ? saved.map(([area, label]) => (
                  <span key={area} className={`dr-tag ${STATUS_TONE[subject.areas[area]] || ''}`}>
                    {label}: {STATUS[subject.areas[area]] || subject.areas[area]}
                  </span>))
                : <span className="dr-tag">{Object.keys(subject.areas).length ? 'Not started' : 'No saved areas'}</span>}
          </span>
          <span className="dr-subject-updated">Last activity: {dateText(subject.updatedAt)}</span>
        </button>
        <Button appearance="subtle" size="small" icon={<DeleteRegular />} disabled={busy} {...restoreFocusTarget}
          title={busy ? 'Stop the active research area before removing a subject.' : 'Remove this research subject'}
          aria-label={`Remove research subject ${task
            ? [task.title, task.date && shortDate(task.date)].filter(Boolean).join(', ') : 'that could not be read'}`}
          onClick={() => { setRemoving({ subject, working: false, error: null }); setRemoveOpen(true); }} />
      </li>
    );
  };

  return (
    <div className="ac-page dr-page">
      <div className="page-header">
        <div className="page-header-left">
          <h2>Deep Research</h2>
          <p className="ac-intro">
            Find an email SE Assist has pulled, by customer account or keyword, open it, and send it to Deep Research. Each research
            subject saves a current situation, an action checklist, and a reply draft, plus a technical recommendation when you ask
            for one. Every area is saved independently, so a failed area does not erase the others.
          </p>
        </div>
      </div>

      <div className="ac-sections">
        <section className="ac-section dr-search">
          <div className="ac-section-head">
            <span className="ac-section-icon email"><SearchRegular /></span>
            <h3>Find an email</h3>
            <span className="ca-muted sec-head-hint">Email already pulled into SE Assist, newest first.</span>
          </div>
          <div className="dr-search-body">
            <div className="dr-search-bar">
              <AccountPicker accounts={accounts} selected={picked} onSelect={selectAccount} />
              <Input type="search" className="dr-keyword" value={query} onChange={(_event, data) => setQuery(data.value)}
                maxLength={200} contentBefore={<SearchRegular />} spellCheck={false}
                placeholder={picked ? 'Search this account’s email…' : 'Search all stored email…'}
                aria-label={picked ? `Search this account’s email (${picked.label})` : 'Search all stored email'} />
              {/* disabledFocusable keeps keyboard focus on Refresh while the list reloads. */}
              <Button ref={refreshRef} icon={<ArrowClockwiseRegular />} disabledFocusable={searching} onClick={refreshSearch}
                title="Read the stored email again, for example after a pull">Refresh</Button>
            </div>
            {searchError && <div className="sec-flash sec-flash-error" role="alert">{searchError}</div>}
            {!search && searching && !searchError && <Spinner size="small" label="Reading stored email…" />}
            {search && <>
              <div className="dr-status ca-muted" role="status">
                {searching && <Spinner size="extra-tiny" />}
                <span>{searchStatus(search, search.accountName)}</span>
              </div>
              {search.changed && <div className="sec-flash dr-flash-info dr-flash-row" role="status">
                <span>Stored email changed after this list loaded, for example by a new pull. Refresh to list the newest email first.</span>
                {/* This notice goes away after the refresh, so focus moves to the main Refresh button first. */}
                <Button size="small" disabledFocusable={searching}
                  onClick={() => { refreshRef.current?.focus(); refreshSearch(); }}>Refresh</Button>
              </div>}
              {search.results.length > 0 && <div className="dr-results" key={search.seq}>
                <ul className="dr-result-list" aria-label="Stored emails" ref={resultsRef} {...resultsNavigation}>
                  {search.results.map((result, index) => {
                    const id = `dr-result-${search.seq}-${index}`;
                    const sender = personText(result.from) || 'Unknown sender';
                    const tags = EmailTags({ email: result, bodySource: result.bodySource, accounts: result.accounts, id: `${id}-tags` });
                    // The row is named by subject, sender and date; its tags and preview are read as its description.
                    const described = [tags && `${id}-tags`, result.snippet && `${id}-snippet`].filter(Boolean).join(' ');
                    return (
                      <li key={result.messageId}>
                        <button type="button" className="dr-result" onClick={() => openDetail(result)} {...restoreFocusTarget}
                          aria-label={`${subjectText(result.subject)} · ${sender} · ${shortDate(result.date)}`}
                          aria-describedby={described || undefined}>
                          <span className="dr-result-top">
                            <span className="dr-result-subject">{subjectText(result.subject)}</span>
                            <span className="dr-result-date">{shortDate(result.date)}</span>
                          </span>
                          <span className="dr-result-sub">{sender}</span>
                          {tags}
                          {result.snippet && <span className="dr-result-snippet" id={`${id}-snippet`}>{result.snippet}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {search.nextCursor && <div className="dr-more">
                  {more.error
                    ? <div className="sec-flash sec-flash-error dr-flash-row" role="alert">
                      <span>{more.error}</span>
                      <Button size="small" ref={moreRef} onClick={loadMore} disabled={searching}>Retry</Button>
                    </div>
                    : <Button ref={moreRef} icon={more.loading ? <Spinner size="tiny" /> : <ChevronDownRegular />}
                      disabledFocusable={more.loading || searching} onClick={loadMore} title={`Show the next ${PAGE_SIZE} older emails`}>
                      {more.loading ? 'Reading older email…' : 'See more'}
                    </Button>}
                </div>}
              </div>}
            </>}
            <p className="ca-muted dr-note">
              Lists and searches only email already pulled into SE Assist, not your live mailbox. Keywords match the subject, sender,
              recipients, customer account, and stored text. To pull newer email, use {PULL_PATH}.
            </p>
          </div>
        </section>

        <section className="ac-section dr-subjects-section">
          <div className="ac-section-head">
            <span className="ac-section-icon suggested"><BeakerRegular /></span>
            <h3 ref={subjectsHeadRef} tabIndex={-1}>Research subjects</h3>
            <span className="ca-muted sec-head-hint">Emails sent to Deep Research, most recent activity first.</span>
          </div>
          <div className="dr-subjects-body">
            {subjectsError && <div className="sec-flash sec-flash-error dr-flash-row" role="alert">
              <span>{subjectsError}</span>
              <Button size="small" onClick={loadSubjects} disabled={subjectsLoading}>Retry</Button>
            </div>}
            {!subjects && subjectsLoading && <Spinner size="small" label="Loading research subjects…" />}
            {subjects && (subjects.length
              ? <ul ref={subjectsListRef} className="dr-subjects" aria-label="Research subjects">{subjects.map(subjectRow)}</ul>
              : <p className="ca-muted dr-note">No research subjects yet. Search for an email above, open it, and choose Deep Research.</p>)}
            <div className="dr-subjects-foot ca-muted">
              {busy && <div role="status">Stop the active research area before switching subjects, removing one, or starting another.</div>}
              <div>Research runs while this page is open. Leaving Deep Research stops the active area; saved work is kept.</div>
            </div>
          </div>
          {selected && <div ref={panelRef} className="dr-panel">
            <WorkOutputsPanel key={selected.id} task={selected.task} userName={currentUserName}
              onBusyChange={setBusy} onClose={closePanel} />
          </div>}
        </section>
      </div>

      <Dialog open={detailOpen} onOpenChange={(_event, data) => { if (!data.open && !starting) closeDetail(); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          {detail && <DialogBody>
            <DialogTitle>{subjectText(email ? email.subject : detail.preview.subject)}</DialogTitle>
            <DialogContent>
              {detail.loading && <Spinner size="small" label="Opening the stored email…" />}
              {detail.error && <div className="sec-flash sec-flash-error dr-flash-row" role="alert">
                <span>{detail.error}</span>
                <Button size="small" onClick={() => openDetail(detail.preview)}>Try again</Button>
              </div>}
              {email && <>
                <dl className="dr-meta">
                  <dt>From</dt><dd>{personText(email.from) || 'Unknown sender'}</dd>
                  <dt>To</dt><dd>{email.to.length ? recipients(email.to) : 'No recipients stored'}</dd>
                  {email.cc.length > 0 && <><dt>Cc</dt><dd>{recipients(email.cc)}</dd></>}
                  <dt>Date</dt><dd>{dateText(email.date)}</dd>
                  <dt>{email.accounts.length > 1 ? 'Customer accounts' : 'Customer account'}</dt>
                  <dd>{email.accounts.length ? email.accounts.join(', ') : 'Not linked to a customer account'}</dd>
                </dl>
                <EmailTags email={email} bodySource={email.body.source} />
                {email.warnings.map((warning, index) => <div key={index} className="work-output-note" role="status">{warning}</div>)}
                {email.isProtected && <div className="work-output-note" role="status">
                  <LockClosedRegular /> This is a protected (Microsoft Purview) message. SE Assist cannot read its content, so Deep
                  Research is unavailable for it. Open it in Outlook to read it.
                </div>}
                {email.body.text
                  ? <>
                    <div className="dr-body-label">{BODY_LABEL[email.body.source] || `Stored text (unrecognised source: ${email.body.source})`}</div>
                    <pre className="dr-body">{email.body.text}</pre>
                  </>
                  : <p className="ca-muted dr-note">No body text is stored for this email.</p>}
                {email.body.truncated && <p className="ca-muted dr-note">Showing the first 60,000 characters. Open it in Outlook to read the rest.</p>}
                {!email.isProtected && <p className="ca-muted dr-note">
                  Deep Research reads this email again, live, through WorkIQ (User Home → Microsoft 365 Copilot sign-in), and runs
                  on GitHub Copilot (User Home → GitHub sign-in) with the model selected there.
                </p>}
                {busy && <div className="work-output-note" role="status">
                  Research is already running below. Stop the active area before starting Deep Research on another email.
                </div>}
                {actionError && <div className="sec-flash sec-flash-error" role="alert">{actionError}</div>}
              </>}
            </DialogContent>
            <DialogActions fluid>
              <Button icon={opening ? <Spinner size="tiny" /> : <OpenRegular />} disabled={!email || opening}
                onClick={() => openInOutlook(email)}>Open in Outlook</Button>
              <Button onClick={closeDetail} disabled={starting}>Close</Button>
              <Button appearance="primary" icon={starting ? <Spinner size="tiny" /> : <DocumentSearchRegular />}
                disabled={!email || email.isProtected || busy || starting} onClick={() => startResearch(email)}>
                {starting ? 'Starting…' : 'Deep Research'}
              </Button>
            </DialogActions>
          </DialogBody>}
        </DialogSurface>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={(_event, data) => { if (!data.open && !removing?.working) setRemoveOpen(false); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          {removing && <DialogBody>
            <DialogTitle>Remove this research subject?</DialogTitle>
            <DialogContent>
              <p className="dr-remove-title">{removing.subject.task?.title || 'Unreadable research subject'}</p>
              <p>Its saved research and outputs are deleted. Tasks and workloads you created from it stay in SE Assist.</p>
              {removing.error && <div className="sec-flash sec-flash-error" role="alert">{removing.error}</div>}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setRemoveOpen(false)} disabled={removing.working}>Cancel</Button>
              <Button appearance="primary" icon={removing.working ? <Spinner size="tiny" /> : <DeleteRegular />}
                disabled={removing.working || busy} onClick={confirmRemove}>Remove</Button>
            </DialogActions>
          </DialogBody>}
        </DialogSurface>
      </Dialog>
    </div>
  );
}
