'use strict';

// Deep Research finds its subject among the email SE Assist has already pulled into the local
// `emails` table: newest first, optionally narrowed to one customer account and to search words.
// Search never reads the mailbox live; the research itself reads the chosen email live through
// WorkIQ when it runs.

const { emailBodyText, isProtectedMessageNotice, isProtectedMessageText } = require('./email-content');
const { toOutlookWebReaderLink } = require('./outlook-link');
const { storedTimeMs, parseRaw, accountLabel, ACCOUNT_NAME } = require('./secretary-scan');
const { assertActiveTpid, assertActiveSource } = require('../account-roster');

const MAX_QUERY_CHARS = 200;
const MAX_TERMS = 8;
const PAGE_SIZE = 20;
const MAX_LIMIT = 100;
const MAX_ACCOUNT_CHARS = 200;
const MAX_CURSOR_CHARS = 16384;
const SNIPPET_CHARS = 220;
const SNIPPET_LEAD = 60;
const MAX_BODY_CHARS = 60000;
const BODY_RANK = { body: 0, preview: 1 };
const SEARCH_FIELDS = ['e.subject', 'e.from_name', 'e.from_address', 'e.to_json', 'e.cc_json', 'e.body_text'];
const TERM_MATCH = `(${SEARCH_FIELDS.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')}
  OR EXISTS (SELECT 1 FROM active_email_customer_links l JOIN active_customers c ON c.tpid = l.tpid
    WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected' AND c.name LIKE ? ESCAPE '\\'))`;
const TERM_PARAMS = SEARCH_FIELDS.length + 1;
// raw_json is read only when the column is empty, to find the Graph internetMessageId of older rows.
const COPY_COLUMNS = `e.message_id, e.internet_message_id, e.received_at, e.sent_at, e.body_source,
  LENGTH(COALESCE(e.body_text, '')) AS body_length,
  CASE WHEN e.internet_message_id IS NULL OR TRIM(e.internet_message_id) = '' THEN e.raw_json END AS raw_json`;
// Customer account links of stored email. Links the AI rejected are not account links.
const LINKED = `FROM active_email_customer_links k JOIN active_emails s ON s.message_id = k.message_id
  WHERE k.match_method <> 'ai-rejected'`;
const CURSOR_ERROR = 'The “See more” position could not be read. Refresh the email list.';

const likePattern = (term) => `%${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const clause = (value) => String(value).trim().replace(/[.\s]+$/, '');
const byText = (a, b) => a.localeCompare(b);

function searchTerms(query) {
  if (query != null && typeof query !== 'string') throw new Error('Enter search words as text.');
  const text = (query || '').trim();
  if (text.length > MAX_QUERY_CHARS) throw new Error(`Search words must be at most ${MAX_QUERY_CHARS} characters.`);
  const terms = [...new Set(text.split(/\s+/).filter(Boolean))];
  if (terms.length > MAX_TERMS) throw new Error(`Use at most ${MAX_TERMS} search words.`);
  return { text, terms };
}

function accountFilter(account) {
  if (account == null || account === '') return null;
  if (typeof account !== 'string' || !account.trim() || account.length > MAX_ACCOUNT_CHARS) {
    throw new Error('Choose a customer account from the list.');
  }
  return account;
}

function resultLimit(limit) {
  if (limit == null) return PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`The result limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

// Newest first, email with no readable date last. The key breaks ties so every page is stable.
function order(a, b) {
  if (a.time !== b.time) {
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return b.time - a.time;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// “See more” continues after the last email shown, not at an offset, so email pulled between pages
// cannot repeat an email that is already listed.
const cursorAfter = (group) => Buffer.from(JSON.stringify([group.time, group.key]), 'utf8').toString('base64url');

function readCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error(CURSOR_ERROR);
  }
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error(CURSOR_ERROR); }
  if (!Array.isArray(value) || value.length !== 2) throw new Error(CURSOR_ERROR);
  const [time, key] = value;
  if (!(time === null || Number.isFinite(time)) || typeof key !== 'string' || !key) throw new Error(CURSOR_ERROR);
  return { time, key };
}

// Copies of one message (for example a sent and a received copy) share a key: the internet message
// id when SE Assist knows it, otherwise the stored message id.
function copyKey(row) {
  const stored = clean(row.internet_message_id) || clean(parseRaw(row.raw_json)?.internetMessageId);
  return stored ? `internet:${stored}` : `id:${row.message_id}`;
}

// One message can be stored more than once. Each group lists its copies fullest body first.
function groupCopies(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = copyKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, copies]) => {
    copies.sort((a, b) => (BODY_RANK[a.body_source] ?? 2) - (BODY_RANK[b.body_source] ?? 2)
      || Number(b.body_length) - Number(a.body_length)
      || (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0));
    const times = copies.map((copy) => storedTimeMs(copy.received_at || copy.sent_at)).filter((time) => time !== null);
    return { key, messageIds: copies.map((copy) => copy.message_id), time: times.length ? Math.max(...times) : null };
  });
}

// Every customer account linked to stored email, labelled so each one can be told apart: two
// accounts with the same name show their TPIDs, and an account with no stored name shows its TPID.
function accountDirectory(db) {
  const rows = db.prepare(`SELECT l.tpid, ${ACCOUNT_NAME} AS name FROM (SELECT DISTINCT k.tpid ${LINKED}) l`).all()
    .map((row) => ({ tpid: row.tpid, name: clean(row.name) }));
  const uses = new Map();
  for (const { name } of rows) if (name) uses.set(name, (uses.get(name) || 0) + 1);
  return new Map(rows.map(({ tpid, name }) => [tpid, {
    tpid,
    named: Boolean(name),
    label: !name ? `Unnamed account (TPID ${tpid})` : uses.get(name) > 1 ? `${name} (TPID ${tpid})` : name,
  }]));
}

function linkedAccounts(db) {
  const links = new Map();
  for (const { message_id: id, tpid } of db.prepare(`SELECT DISTINCT k.message_id, k.tpid ${LINKED}`).all()) {
    if (!links.has(id)) links.set(id, new Set());
    links.get(id).add(tpid);
  }
  return links;
}

const labelsOf = (directory, tpids) => [...tpids].map((tpid) => directory.get(tpid).label).sort(byText);

function matchingIds(db, terms) {
  const where = terms.map(() => TERM_MATCH).join(' AND ');
  const params = terms.flatMap((term) => Array(TERM_PARAMS).fill(likePattern(term)));
  return new Set(db.prepare(`SELECT e.message_id FROM active_emails e WHERE ${where}`).all(...params).map((row) => row.message_id));
}

function snippet(text, terms) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  const start = at > SNIPPET_LEAD ? at - SNIPPET_LEAD : 0;
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function pullState(db) {
  let latest = null;
  let unreadable = 0;
  for (const { last_run_at: value } of db.prepare('SELECT last_run_at FROM email_sync WHERE scope_key IN (SELECT tpid FROM tpid_config)').all()) {
    const time = storedTimeMs(value);
    if (time === null) unreadable++;
    else if (latest === null || time > latest) latest = time;
  }
  return {
    storedCount: Number(db.prepare('SELECT COUNT(*) AS n FROM active_emails').get().n),
    pulledAt: latest === null ? null : new Date(latest).toISOString(),
    unreadablePullTimes: unreadable,
  };
}

function person(name, address) {
  return { name: clean(name), address: clean(address) };
}

// Lists stored email newest first, one page at a time. An account and search words narrow the list;
// with both, an email must be linked to the account and contain every search word.
function searchEmails(db, { query, account, cursor, limit } = {}) {
  const { text, terms } = searchTerms(query);
  const tpid = accountFilter(account);
  if (tpid !== null) assertActiveTpid(db, tpid);
  const after = readCursor(cursor);
  const max = resultLimit(limit);
  const directory = accountDirectory(db);
  const links = linkedAccounts(db);
  const matched = terms.length ? matchingIds(db, terms) : null;
  const counts = new Map();
  const groups = [];
  for (const group of groupCopies(db.prepare(`SELECT ${COPY_COLUMNS} FROM active_emails e`).all())) {
    group.tpids = new Set(group.messageIds.flatMap((id) => [...(links.get(id) || [])]));
    for (const id of group.tpids) counts.set(id, (counts.get(id) || 0) + 1);
    if (matched && !group.messageIds.some((id) => matched.has(id))) continue;
    if (tpid !== null && !group.tpids.has(tpid)) continue;
    groups.push(group);
  }
  groups.sort(order);
  const start = after ? groups.findIndex((group) => order(group, after) > 0) : 0;
  const page = start < 0 ? [] : groups.slice(start, start + max);
  const readRow = db.prepare(`SELECT message_id, subject, from_name, from_address, sent_at, received_at,
      body_text, body_source, has_attachments, importance FROM active_emails WHERE message_id = ?`);
  const results = page.map((group) => {
    // A search shows the stored copy that matched; otherwise the copy with the fullest body.
    const row = readRow.get(matched ? group.messageIds.find((id) => matched.has(id)) : group.messageIds[0]);
    const accounts = labelsOf(directory, group.tpids);
    return {
      messageId: row.message_id,
      subject: typeof row.subject === 'string' ? row.subject : '',
      from: person(row.from_name, row.from_address),
      date: row.received_at || row.sent_at || null,
      snippet: snippet(row.body_text, terms),
      bodySource: row.body_source === 'preview' ? 'preview' : row.body_text ? 'condensed' : null,
      isProtected: isProtectedMessageText(row.body_text),
      accounts,
      accountLabel: accountLabel(accounts),
      hasAttachments: Boolean(row.has_attachments),
      importance: clean(row.importance) || 'normal',
      copies: group.messageIds.length,
    };
  });
  return {
    mode: terms.length ? 'search' : 'recent',
    query: text,
    account: tpid === null ? null : { tpid, label: directory.get(tpid)?.label ?? null },
    total: groups.length,
    results,
    nextCursor: page.length && start + page.length < groups.length ? cursorAfter(page.at(-1)) : null,
    accounts: [...directory.values()]
      .sort((a, b) => Number(b.named) - Number(a.named) || byText(a.label, b.label) || (a.tpid < b.tpid ? -1 : 1))
      .map((entry) => ({ tpid: entry.tpid, label: entry.label, emailCount: counts.get(entry.tpid) || 0 })),
    ...pullState(db),
  };
}

function storedRecipients(rawList, storedJson, label, warnings) {
  const unreadable = () => {
    warnings.push(`SE Assist stored unreadable ${label} recipients for this email. Open it in Outlook to see them.`);
    return [];
  };
  let list = rawList;
  const nested = Array.isArray(rawList);
  if (!nested) {
    if (storedJson == null || storedJson === '') return [];
    try { list = JSON.parse(storedJson); } catch { return unreadable(); }
    if (list == null) return [];
    if (!Array.isArray(list)) return unreadable();
  }
  const people = [];
  for (const entry of list) {
    const value = nested ? entry?.emailAddress : entry;
    if (!value || typeof value !== 'object') return unreadable();
    people.push(person(value.name, value.address));
  }
  return people;
}

// Prefer the complete stored Graph body; otherwise show the pull's condensed text or preview, labelled.
function storedBody(row, raw, warnings) {
  const body = raw?.body;
  const format = String(body?.contentType || '').toLowerCase();
  if (typeof body?.content === 'string' && (format === 'html' || format === 'text')) {
    try {
      const text = emailBodyText(body).trim();
      if (text) return { text, source: 'full' };
    } catch (error) {
      warnings.push(`The full stored body could not be read (${clause(error.message)}). The condensed text SE Assist stored is shown instead.`);
    }
  }
  const stored = typeof row.body_text === 'string' ? row.body_text.trim() : '';
  if (stored) return { text: stored, source: row.body_source === 'preview' ? 'preview' : 'condensed' };
  return { text: '', source: null };
}

function outlookLink(row, warnings) {
  const byId = `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(row.message_id)}?ItemID=${encodeURIComponent(row.message_id)}&exvsurl=1`;
  if (!row.web_link) return byId;
  try {
    const link = toOutlookWebReaderLink(row.web_link);
    if (URL.canParse(link) && new URL(link).protocol === 'https:') return link;
  } catch { /* reported below */ }
  warnings.push('The stored Outlook link for this email is invalid, so Open in Outlook uses its message ID instead.');
  return byId;
}

function readEmail(db, messageId) {
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 2000) {
    throw new Error('Choose an email from the search results.');
  }
  assertActiveSource(db, 'email', messageId);
  const row = db.prepare(`SELECT message_id, internet_message_id, subject, from_name, from_address, to_json, cc_json,
      sent_at, received_at, body_text, body_source, has_attachments, importance, web_link, raw_json
    FROM active_emails WHERE message_id = ?`).get(messageId);
  if (!row) throw new Error('This email is no longer stored in SE Assist. Search again.');
  const raw = parseRaw(row.raw_json);
  const key = copyKey(row);
  const copies = new Set([row.message_id]);
  if (key.startsWith('internet:')) {
    const others = db.prepare(`SELECT ${COPY_COLUMNS} FROM active_emails e
      WHERE TRIM(e.internet_message_id) = ? OR e.internet_message_id IS NULL OR TRIM(e.internet_message_id) = ''`)
      .all(key.slice('internet:'.length));
    for (const other of others) if (copyKey(other) === key) copies.add(other.message_id);
  }
  const warnings = [];
  const body = storedBody(row, raw, warnings);
  const preview = raw?.bodyPreview;
  const isProtected = (Boolean(body.text) && (isProtectedMessageNotice(body.text) || isProtectedMessageText(body.text)))
    || (typeof preview === 'string' && preview !== '' && isProtectedMessageNotice(preview))
    || isProtectedMessageText(row.body_text);
  const sender = raw?.from?.emailAddress;
  const readLinks = db.prepare(`SELECT DISTINCT tpid FROM active_email_customer_links WHERE message_id = ? AND match_method <> 'ai-rejected'`);
  const accounts = labelsOf(accountDirectory(db), new Set([...copies].flatMap((id) => readLinks.all(id).map((link) => link.tpid))));
  return {
    messageId: row.message_id,
    subject: typeof row.subject === 'string' ? row.subject : '',
    from: person(row.from_name || sender?.name, row.from_address || sender?.address),
    to: storedRecipients(raw?.toRecipients, row.to_json, 'To', warnings),
    cc: storedRecipients(raw?.ccRecipients, row.cc_json, 'Cc', warnings),
    date: row.received_at || row.sent_at || null,
    accounts,
    accountLabel: accountLabel(accounts),
    importance: clean(row.importance) || clean(raw?.importance) || 'normal',
    hasAttachments: Boolean(row.has_attachments),
    body: { text: body.text.slice(0, MAX_BODY_CHARS), source: body.source, truncated: body.text.length > MAX_BODY_CHARS },
    isProtected,
    webLink: outlookLink(row, warnings),
    copies: copies.size,
    warnings,
  };
}

module.exports = { searchEmails, readEmail, PAGE_SIZE };
