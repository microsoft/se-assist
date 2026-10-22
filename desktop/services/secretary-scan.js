'use strict';

// Secretary reads only customer-linked email that SE Assist has already pulled into the local
// `emails` table (the manual or scheduled WorkIQ pull). It never reads the mailbox live, so every
// scan reports when that email was last pulled and anything that limits its coverage.

const { randomUUID } = require('node:crypto');
const { emailBodyText, compactEmailLinks, isProtectedMessageNotice, isProtectedMessageText } = require('./email-content');
const { toOutlookWebReaderLink } = require('./outlook-link');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_BATCH_EMAILS = 20;
const MAX_BATCH_CHARS = 160000;
const MAX_EXCERPT_CHARS = 1200;
const MAX_ACCOUNT_CHARS = 300;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const BODY_RANK = { full: 0, condensed: 1, preview: 2 };
const NO_TEXT_RANK = 3;
const PULL_HINT = 'Run User Home → WorkIQ Outlook and Teams Sync → Pull new items (or turn on auto-ingest), then try again.';
const PROTECTED_REASON = 'Protected message: SE Assist stored an encryption notice, not the message content. Review it in Outlook; its actions were not assessed.';
const NO_BODY_REASON = 'SE Assist stored no readable text for this email (its body and preview are empty or image-only). Open it in Outlook; its actions were not assessed.';
// Customer-linked follows the app-wide rule: at least one link that the AI linker did not reject.
const LINKED_EMAIL = "EXISTS (SELECT 1 FROM active_email_customer_links l WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')";
const ACCOUNT_NAME = `(SELECT c.name FROM active_customers c WHERE c.tpid = l.tpid AND c.name IS NOT NULL AND c.name != ''
  ORDER BY (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '') DESC, c.name LIMIT 1)`;
const STORED_TIME = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/;

function readCompletion(completion, parseJson) {
  if (['length', 'incomplete', 'failed', 'content_filter'].includes(completion?.finishReason)) {
    throw new Error('Secretary could not finish the scan. No partial results were returned; try a narrower search.');
  }
  const parsed = parseJson(completion?.content);
  if (parsed == null) throw new Error('Secretary returned invalid JSON. Please try the scan again.');
  return parsed;
}

// Stored times are Graph ISO strings or SQLite CURRENT_TIMESTAMP values (UTC without a zone).
function storedTimeMs(value) {
  if (typeof value !== 'string') return null;
  const match = STORED_TIME.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00', fraction = '', zone = 'Z'] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return null;
  }
  const millis = fraction.slice(1, 4).padEnd(3, '0');
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offset}`);
  return Number.isFinite(time) ? time : null;
}

const emailTime = (email) => storedTimeMs(email.received_at || email.sent_at) ?? 0;
const clause = (text) => String(text).trim().replace(/[.\s]+$/, '');

function scanDayCount(days, now) {
  const dayCount = days === undefined ? 1 : days;
  if (typeof dayCount !== 'number' || !Number.isFinite(dayCount) || dayCount <= 0
    || !Number.isFinite(new Date(now.getTime() - dayCount * DAY_MS).getTime())) {
    throw new Error('The Secretary scan needs a positive number of days.');
  }
  return dayCount;
}

function deterministicScanScope(guidance, dayCount, now) {
  const until = now.toISOString();
  if (!guidance) {
    return {
      since: new Date(now.getTime() - dayCount * DAY_MS).toISOString(),
      until,
      label: dayCount === 1 ? 'the last 24 hours' : `the last ${dayCount} days`,
    };
  }

  const text = guidance.toLowerCase();
  const candidates = [];
  const add = (since, label, end = now) => {
    if (since === null || (Number.isFinite(since.getTime()) && since < end)) {
      candidates.push({ since: since === null ? null : since.toISOString(), until: end.toISOString(), label });
    }
  };

  const durationPattern = /\b(?:last|past)\s+(\d{1,5})\s+(hours?|days?|weeks?)\b/g;
  for (const match of text.matchAll(durationPattern)) {
    const amount = Number(match[1]);
    const unit = match[2].startsWith('hour') ? HOUR_MS
      : match[2].startsWith('week') ? 7 * DAY_MS : DAY_MS;
    if (amount > 0 && Number.isFinite(now.getTime() - amount * unit)) {
      add(new Date(now.getTime() - amount * unit), `the last ${amount} ${match[2]}`);
    }
  }

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const thisWeek = new Date(today);
  thisWeek.setDate(thisWeek.getDate() - (thisWeek.getDay() + 6) % 7);
  const thisMonth = new Date(today);
  thisMonth.setDate(1);

  if (/\btoday\b/.test(text)) add(today, 'today');
  if (/\bthis week\b/.test(text)) add(thisWeek, 'this week');
  if (/\blast week\b/.test(text)) {
    const previousWeek = new Date(thisWeek);
    previousWeek.setDate(previousWeek.getDate() - 7);
    add(previousWeek, 'last week', new Date(thisWeek.getTime() - 1));
  }
  if (/\bthis month\b/.test(text)) add(thisMonth, 'this month');
  if (/\blast month\b/.test(text)) {
    const previousMonth = new Date(thisMonth);
    previousMonth.setMonth(previousMonth.getMonth() - 1);
    add(previousMonth, 'last month', new Date(thisMonth.getTime() - 1));
  }
  if (/\ball (?:(?:pulled|stored)(?: customer)?|customer) e-?mails?\b|\ball (?:available )?(?:inbox )?history\b|\ball time\b/.test(text)) {
    add(null, 'all pulled customer email');
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveScanScope({ runtime, guidance, days, now, parseJson }) {
  const end = now.toISOString();
  const dayCount = scanDayCount(days, now);
  const deterministic = deterministicScanScope(guidance, dayCount, now);
  if (deterministic) return deterministic;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const month = new Date(today);
  month.setDate(1);
  const previousMonth = new Date(month);
  previousMonth.setMonth(previousMonth.getMonth() - 1);
  const completion = await runtime.run('secretary-scope', { input: { context: {
    guidance,
    now: end,
    defaultSince: new Date(now.getTime() - DAY_MS).toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    todayStart: today.toISOString(),
    weekStart: week.toISOString(),
    monthStart: month.toISOString(),
    previousMonthStart: previousMonth.toISOString(),
  } } });
  const scope = readCompletion(completion, parseJson);
  if (typeof scope.error === 'string' && scope.error.trim()) throw new Error(`Secretary needs a time range: ${scope.error}`);
  const validDate = (value) => typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
  if (!validDate(scope.until) || (scope.since !== null && !validDate(scope.since))
    || Date.parse(scope.until) > now.getTime()
    || (scope.since !== null && Date.parse(scope.since) >= Date.parse(scope.until))
    || typeof scope.label !== 'string' || !scope.label.trim() || scope.label.length > 120) {
    throw new Error('Secretary could not resolve that time range. Specify a period such as "the last 7 days".');
  }
  return { since: scope.since, until: scope.until, label: scope.label.trim() };
}

// The pull records a sync time per account only after a successful email refresh.
function readEmailPullState(db) {
  let latest = null;
  for (const { last_run_at: value } of db.prepare('SELECT last_run_at FROM email_sync WHERE scope_key IN (SELECT tpid FROM tpid_config)').all()) {
    const time = storedTimeMs(value);
    if (time === null) {
      throw new Error(`SE Assist stored an unreadable email pull time (${JSON.stringify(String(value).slice(0, 40))}), so Secretary cannot tell how current its email is.`);
    }
    if (latest === null || time > latest) latest = time;
  }
  const linkedCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM active_emails e WHERE ${LINKED_EMAIL}`).get().n);
  if (!linkedCount) {
    throw new Error(`No customer-linked email has been pulled into SE Assist yet. Secretary reads only email already pulled and matched to your customer accounts. ${PULL_HINT}`);
  }
  if (latest === null) {
    throw new Error(`SE Assist has no record of a completed email pull, so Secretary cannot tell how current its stored customer email is. ${PULL_HINT}`);
  }
  return { pulledAt: new Date(latest).toISOString(), linkedCount };
}

function readUserAddress(db) {
  const value = db.prepare("SELECT value FROM app_settings WHERE key = 'signed_in_user_upn'").get()?.value;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function parseRaw(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const raw = JSON.parse(value);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Prefer the complete stored Graph body; otherwise use the pull's condensed text or preview.
function copyBody(row, raw) {
  const body = raw?.body;
  const format = String(body?.contentType || '').toLowerCase();
  if (typeof body?.content === 'string' && (format === 'html' || format === 'text')) {
    let text;
    try {
      text = emailBodyText(body).trim();
    } catch (error) {
      throw new Error(`The stored body of the email "${row.subject || '(no subject)'}" could not be read: ${error.message}`);
    }
    if (text) return { text, bodySource: 'full', rank: BODY_RANK.full };
  }
  const stored = typeof row.body_text === 'string' ? row.body_text.trim() : '';
  if (stored) {
    const bodySource = row.body_source === 'preview' ? 'preview' : 'condensed';
    return { text: stored, bodySource, rank: BODY_RANK[bodySource] };
  }
  return { text: '', bodySource: null, rank: NO_TEXT_RANK };
}

function isProtectedCopy({ row, raw, text }) {
  const preview = raw?.bodyPreview;
  return (Boolean(text) && (isProtectedMessageNotice(text) || isProtectedMessageText(text)))
    || (typeof preview === 'string' && preview !== '' && isProtectedMessageNotice(preview))
    || isProtectedMessageText(row.body_text);
}

function readerLink(value, subject) {
  if (!value) return null;
  try {
    return toOutlookWebReaderLink(value);
  } catch {
    throw new Error(`The stored Outlook link for the email "${subject}" is invalid, so Secretary stopped without partial results. Narrow the time range to skip it, and open that email in Outlook directly.`);
  }
}

function recipientList(rawList, storedJson, subject) {
  const unreadable = () => new Error(`SE Assist stored unreadable recipients for the email "${subject}", so Secretary stopped without partial results. Narrow the time range to skip it, and open that email in Outlook directly.`);
  const nested = Array.isArray(rawList);
  let list = rawList;
  if (!nested) {
    if (storedJson == null || storedJson === '') return [];
    try {
      list = JSON.parse(storedJson);
    } catch {
      throw unreadable();
    }
    if (list == null) return [];
    if (!Array.isArray(list)) throw unreadable();
  }
  return list.map((entry) => {
    const person = nested ? entry?.emailAddress : entry;
    if (!person || typeof person !== 'object') throw unreadable();
    return { emailAddress: {
      name: typeof person.name === 'string' && person.name ? person.name : null,
      address: typeof person.address === 'string' && person.address ? person.address : null,
    } };
  });
}

function accountLabel(names) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (!sorted.length) return null;
  const shown = sorted.slice(0, 3).join(', ');
  return (sorted.length > 3 ? `${shown} +${sorted.length - 3} more` : shown).slice(0, MAX_ACCOUNT_CHARS);
}

function readCustomerEmails({ db, scope, userAddress = null }) {
  const since = scope.since === null ? null : Date.parse(scope.since);
  const until = Date.parse(scope.until);
  let undated = 0;
  const inWindow = [];
  for (const row of db.prepare(`SELECT e.message_id, e.received_at, e.sent_at FROM active_emails e WHERE ${LINKED_EMAIL}`).all()) {
    const time = storedTimeMs(row.received_at || row.sent_at);
    if (time === null) undated++;
    else if ((since === null || time >= since) && time <= until) inWindow.push(row.message_id);
  }

  const readRow = db.prepare(`SELECT message_id, conversation_id, internet_message_id, subject, from_name, from_address,
      to_json, cc_json, sent_at, received_at, body_text, body_source, importance, web_link, raw_json
    FROM active_emails WHERE message_id = ?`);
  const done = db.prepare("SELECT 1 FROM email_triage WHERE conversation_id = ? AND status = 'done'");
  const accountNames = db.prepare(`SELECT DISTINCT ${ACCOUNT_NAME} AS name FROM active_email_customer_links l
    WHERE l.message_id = ? AND l.match_method <> 'ai-rejected'`);

  // One message can be stored more than once, for example as a sent and a received copy.
  const groups = new Map();
  for (const id of inWindow) {
    const row = readRow.get(id);
    const raw = parseRaw(row.raw_json);
    const internetId = (typeof row.internet_message_id === 'string' && row.internet_message_id.trim())
      || (typeof raw?.internetMessageId === 'string' && raw.internetMessageId.trim()) || null;
    const key = internetId ? `internet:${internetId}` : `id:${row.message_id}`;
    const copy = { row, raw, ...copyBody(row, raw) };
    copy.isProtected = isProtectedCopy(copy);
    copy.readable = Boolean(copy.text) && !copy.isProtected;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(copy);
  }

  const emails = [];
  const unreadable = [];
  let excluded = 0;
  let duplicatesMerged = 0;
  for (const copies of groups.values()) {
    duplicatesMerged += copies.length - 1;
    if (copies.some(({ row }) => done.get(row.conversation_id || row.message_id))) {
      excluded++;
      continue;
    }
    copies.sort((a, b) => Number(b.readable) - Number(a.readable) || a.rank - b.rank || b.text.length - a.text.length
      || (a.row.message_id < b.row.message_id ? -1 : a.row.message_id > b.row.message_id ? 1 : 0));
    const { row, raw, text, bodySource, readable } = copies[0];
    const subject = typeof row.subject === 'string' ? row.subject : '';
    const label = subject || '(no subject)';
    const webLink = readerLink(row.web_link, label);
    if (!readable) {
      const reason = copies.some((copy) => copy.isProtected) ? PROTECTED_REASON : NO_BODY_REASON;
      unreadable.push({ sourceMessageId: row.message_id, subject: label, webLink, reason });
      continue;
    }
    const preview = typeof raw?.bodyPreview === 'string' ? raw.bodyPreview : '';

    const names = new Set();
    for (const copy of copies) {
      for (const { name } of accountNames.all(copy.row.message_id)) if (name) names.add(name);
    }
    const sender = raw?.from?.emailAddress;
    const fromName = row.from_name || (typeof sender?.name === 'string' && sender.name) || null;
    const fromAddress = row.from_address || (typeof sender?.address === 'string' && sender.address) || null;
    emails.push({
      message_id: row.message_id,
      conversation_id: row.conversation_id || row.message_id,
      subject,
      from_name: fromName,
      from_address: fromAddress,
      to_recipients: recipientList(raw?.toRecipients, row.to_json, label),
      cc_recipients: recipientList(raw?.ccRecipients, row.cc_json, label),
      // Batching measures this model input, so links are shortened before it; the excerpt keeps the stored text.
      body_content: compactEmailLinks(text),
      body_format: 'text',
      body_source: bodySource,
      from_you: userAddress && fromAddress ? fromAddress.trim().toLowerCase() === userAddress : null,
      excerpt: (preview || text).replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT_CHARS),
      received_at: row.received_at || null,
      sent_at: row.sent_at || null,
      importance: row.importance || (typeof raw?.importance === 'string' && raw.importance) || 'normal',
      web_link: webLink,
      account_name: accountLabel(names),
      is_customer_related: true,
    });
  }
  emails.sort((a, b) => emailTime(a) - emailTime(b));
  return { emails, scanned: groups.size, excluded, unreadable, duplicatesMerged, undated };
}

// Everything that limits how current or complete the stored email is, stated plainly.
function pullWarnings({ pulledAt, lastPull, now, undated, scope }) {
  const warnings = [];
  const pulledMs = Date.parse(pulledAt);
  const result = lastPull?.result;
  if (result && typeof result === 'object') {
    const ranAt = storedTimeMs(result.ranAt);
    if (ranAt === null || ranAt >= pulledMs) {
      const emailError = (Array.isArray(result.errors) ? result.errors : []).find((entry) => entry?.medium === 'email');
      if (emailError) {
        const detail = typeof emailError.error === 'string' && emailError.error.trim() ? clause(emailError.error) : 'no error detail was recorded';
        warnings.push(`The latest pull could not refresh email: ${detail}. Secretary is reading the email stored before it.`);
      }
      const emailResult = (Array.isArray(result.results) ? result.results : []).find((entry) => entry?.medium === 'email');
      const failed = Array.isArray(emailResult?.failedAccounts) ? emailResult.failedAccounts : [];
      if (failed.length) {
        const names = failed.map((entry) => entry?.account).filter((name) => typeof name === 'string' && name.trim());
        const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '');
        warnings.push(`The latest pull could not search ${failed.length} account${failed.length === 1 ? '' : 's'}${shown ? ` (${shown})` : ''}; their newest email may be missing.`);
      }
      if (result.degraded && emailResult) {
        const reason = typeof result.degradedReason === 'string' && result.degradedReason.trim() ? ` (${clause(result.degradedReason)})` : '';
        warnings.push(`The latest pull ran degraded${reason}, so customer email matching may be incomplete.`);
      }
    }
  }
  if (typeof lastPull?.lastError === 'string' && lastPull.lastError.trim()) {
    const failedAt = storedTimeMs(lastPull.lastErrorAt);
    if (failedAt === null || failedAt > pulledMs) {
      warnings.push(`The most recent pull attempt failed: ${clause(lastPull.lastError)}. Secretary is reading the email stored by the previous pull.`);
    }
  }
  if (lastPull?.running) warnings.push('A pull is running now; scan again after it finishes to include the newest email.');
  if (lastPull?.autoEnabled === false) {
    warnings.push('Automatic background pulls are off, so stored email updates only when you choose Pull new items.');
  }
  if (Date.parse(scope.until) > pulledMs) {
    const intervalMin = Number(lastPull?.autoIntervalMin);
    const interval = lastPull?.autoEnabled && Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin * 60 * 1000 : 0;
    const age = now.getTime() - pulledMs;
    if (age > Math.max(2 * HOUR_MS, 2 * interval)) {
      const hours = Math.floor(age / HOUR_MS);
      warnings.push(`The last email pull finished ${hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`} ago, so newer email is not included.`);
    }
  }
  if (undated > 0) {
    warnings.push(undated === 1
      ? '1 stored customer email has no readable date, so it could not be placed in the time window and was not read.'
      : `${undated} stored customer emails have no readable date, so they could not be placed in the time window and were not read.`);
  }
  return warnings;
}

function emailBatches(emails) {
  // Keep threads together when possible; larger ones carry their todo state across batches.
  const threads = new Map();
  for (const email of emails) {
    const key = email.conversation_id || email.message_id;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(email);
  }
  const batches = [];
  let batch = [];
  let chars = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    chars = 0;
  };
  for (const thread of threads.values()) {
    thread.sort((a, b) => emailTime(a) - emailTime(b));
    const size = JSON.stringify(thread).length;
    if (batch.length && (batch.length + thread.length > MAX_BATCH_EMAILS || chars + size > MAX_BATCH_CHARS)) {
      flush();
    }
    for (const email of thread) {
      const emailSize = JSON.stringify(email).length + 2;
      if (emailSize > MAX_BATCH_CHARS) {
        throw new Error('An individual email is too large for a complete Secretary scan. Review that email in Outlook; no email text was silently truncated.');
      }
      if (batch.length && (batch.length >= MAX_BATCH_EMAILS || chars + emailSize > MAX_BATCH_CHARS)) flush();
      batch.push(email);
      chars += emailSize;
    }
  }
  flush();
  return batches;
}

async function scanSecretaryInbox({ db, runtime: agentRuntime, parseJson, userName, guidance = '', days, now = new Date(), lastPull = null }) {
  if (typeof guidance !== 'string' || guidance.length > 2000) throw new Error('Keep your Secretary search under 2,000 characters.');
  scanDayCount(days, now);
  // Fail before any model call when there is nothing pulled to read.
  const { pulledAt } = readEmailPullState(db);
  // Record the model each call actually ran so the scan can report it honestly.
  const models = new Set();
  const runtime = {
    ...agentRuntime,
    run: async (...args) => {
      const completion = await agentRuntime.run(...args);
      if (completion?.model) models.add(completion.model);
      return completion;
    },
  };
  const scope = await resolveScanScope({ runtime, guidance: guidance.trim(), days, now, parseJson });
  const userAddress = readUserAddress(db);
  const { emails, scanned, excluded, unreadable, duplicatesMerged, undated } = readCustomerEmails({ db, scope, userAddress });
  const warnings = pullWarnings({ pulledAt, lastPull, now, undated, scope });
  const sourceById = new Map(emails.map((email) => [email.message_id, email]));
  const threadItems = new Map();
  for (const batch of emailBatches(emails)) {
    const threadIds = new Set(batch.map((email) => email.conversation_id));
    const previousItems = [...threadIds].flatMap((id) => threadItems.get(id) || []);
    const completion = await runtime.run('secretary', { input: { context: {
      userName, emails: batch, previousItems, guidance, scope, now: now.toISOString(),
    } } });
    const list = readCompletion(completion, parseJson);
    if (!Array.isArray(list)) throw new Error('Secretary returned an unexpected action-item format (expected a JSON array).');
    const allowedIds = new Set([...batch.map((email) => email.message_id), ...previousItems.map((item) => item.sourceMessageId)]);
    const nextItems = new Map([...threadIds].map((id) => [id, []]));
    const seen = new Set();
    for (const item of list) {
      const src = sourceById.get(item?.sourceMessageId);
      if (!src || !allowedIds.has(item.sourceMessageId) || !threadIds.has(src.conversation_id)
        || typeof item.title !== 'string' || !item.title.trim()
        || typeof item.summary !== 'string' || !item.summary.trim()
        || !Object.hasOwn(PRIORITY_RANK, item.priority)
        || !['direct', 'shared'].includes(item.ownership)
        || (item.owner !== null && (typeof item.owner !== 'string' || !item.owner.trim() || item.owner.length > 300))) {
        throw new Error('Secretary returned an invalid or ungrounded todo. No partial results were returned; try the scan again.');
      }
      const title = item.title.trim().slice(0, 200);
      const key = `${src.conversation_id}\0${title.toLowerCase().replace(/\s+/g, ' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nextItems.get(src.conversation_id).push({
        id: `sec-${randomUUID()}`,
        title,
        summary: item.summary.trim().slice(0, 800),
        priority: item.priority,
        ownership: item.ownership,
        owner: item.owner?.trim() || null,
        account: src.account_name
          || (typeof item.account === 'string' ? item.account.trim().slice(0, MAX_ACCOUNT_CHARS) || null : null),
        from: src.from_name || src.from_address,
        subject: src.subject,
        sourceMessageId: src.message_id,
        webLink: src.web_link,
        excerpt: src.excerpt,
        date: src.received_at || src.sent_at,
      });
    }
    for (const [id, items] of nextItems) threadItems.set(id, items);
  }
  const items = [...threadItems.values()].flat();
  items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const bodySources = { full: 0, condensed: 0, preview: 0 };
  for (const email of emails) bodySources[email.body_source]++;
  return {
    ok: true,
    items,
    scanned,
    analyzed: emails.length,
    excluded,
    unreadable,
    scope,
    models: [...models],
    source: 'local-customer-emails',
    pulledAt,
    bodySources,
    sentByYou: userAddress ? emails.filter((email) => email.from_you === true).length : null,
    userAddressKnown: Boolean(userAddress),
    duplicatesMerged,
    pullWarnings: warnings,
  };
}

module.exports = {
  scanSecretaryInbox, resolveScanScope, deterministicScanScope, readCustomerEmails, readEmailPullState, emailBatches,
  storedTimeMs, parseRaw, accountLabel, ACCOUNT_NAME,
};
