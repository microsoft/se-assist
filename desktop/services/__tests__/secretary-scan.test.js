'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { scanSecretaryInbox, emailBatches, readEmailPullState } = require('../secretary-scan');
const {
  secretaryDb, message, storeEmail, addLink, addCustomer, markPulled, setUser, markDone,
} = require('./secretary-fixture');

const NOW = new Date('2026-09-21T12:00:00.000Z');
const SINCE = '2026-09-20T12:00:00.000Z';
const PULLED_AT = '2026-09-21T11:30:00.000Z';
const PROTECTED_REASON = 'Protected message: SE Assist stored an encryption notice, not the message content. Review it in Outlook; its actions were not assessed.';
const NO_BODY_REASON = 'SE Assist stored no readable text for this email (its body and preview are empty or image-only). Open it in Outlook; its actions were not assessed.';
const NOTICE = 'Sender (sender@example.com) has sent you a protected message.\n\nRead the message [https://outlook.office.com/]\nLearn about messages protected by Microsoft Purview Message Encryption.';
const todo = (source) => ({
  title: `Complete ${source.message_id}`, summary: 'Complete the requested task.',
  priority: 'medium', sourceMessageId: source.message_id, ownership: 'direct', owner: 'Test User',
});
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

const databases = [];
after(() => { for (const db of databases) db.close(); });

// Emails are stored the way the pull stores them; a `[message, options]` entry overrides stored columns.
function harness({ emails = [], pulled = '2026-09-21 11:30:00', scope, extract, model } = {}) {
  const db = secretaryDb();
  databases.push(db);
  addCustomer(db, 'T-1', 'Contoso');
  for (const entry of emails) {
    const [m, options] = Array.isArray(entry) ? entry : [entry];
    storeEmail(db, m, options);
  }
  if (pulled !== null) markPulled(db, pulled);
  const modelCalls = [];
  const ran = model ? { model } : {};
  const runtime = { run: async (agent, { input }) => {
    modelCalls.push({ agent, context: input.context });
    if (agent === 'secretary-scope') return { content: JSON.stringify(scope), finishReason: 'stop', ...ran };
    const items = extract
      ? await extract(input.context.emails, modelCalls, input.context)
      : [...input.context.previousItems, ...input.context.emails.map(todo)];
    return items?.content !== undefined ? items : { content: JSON.stringify(items), finishReason: 'stop', ...ran };
  } };
  return {
    db, modelCalls,
    scan: (options = {}) => scanSecretaryInbox({ db, runtime, now: NOW, userName: 'Test User', parseJson, ...options }),
  };
}

test('default scan reads pulled customer email in the exact rolling 24-hour window', async () => {
  const h = harness({ emails: [
    message('lower-boundary', SINCE),
    message('inside'),
    [message('sqlite-time'), { received_at: '2026-09-21 10:00:00' }],
    message('now', NOW.toISOString()),
    message('old', '2026-09-20T11:59:59.999Z'),
    message('future', '2026-09-21T12:00:00.001Z'),
    [message('unlinked'), { tpids: [] }],
    [message('ai-rejected'), { method: 'ai-rejected' }],
  ] });
  const result = await h.scan();
  assert.deepEqual(result.items.map((item) => item.sourceMessageId), ['lower-boundary', 'inside', 'sqlite-time', 'now']);
  assert.equal(result.source, 'local-customer-emails');
  assert.deepEqual(result.scope, { since: SINCE, until: NOW.toISOString(), label: 'the last 24 hours' });
  assert.equal(result.scanned, 4);
  assert.equal(result.pulledAt, PULLED_AT);
  assert.deepEqual(result.pullWarnings, []);
  assert.deepEqual(result.bodySources, { full: 4, condensed: 0, preview: 0 });
  assert.equal(result.sentByYou, null);
  assert.equal(result.userAddressKnown, false);
  assert.equal(result.duplicatesMerged, 0);
  assert.deepEqual(h.modelCalls.map((call) => call.agent), ['secretary']);
  assert.ok(h.modelCalls[0].context.emails.every((email) => email.account_name === 'Contoso'));
  assert.ok(result.items.every((item) => item.account === 'Contoso'));
});

test('scan processes more than 40 pulled emails without clipping their bodies', async () => {
  const start = Date.parse('2026-09-21T00:00:00.000Z');
  const h = harness({ emails: Array.from({ length: 75 }, (_, i) => message(`email-${i}`, new Date(start + i * 60000).toISOString(), {
    body: { contentType: 'text', content: `${'Full context. '.repeat(100)}Task at the end ${i}` },
  })) });
  const result = await h.scan({ days: 1 });
  assert.equal(result.items.length, 75);
  assert.equal(result.scanned, 75);
  assert.equal(result.analyzed, 75);
  assert.equal(h.modelCalls.length, 4);
  const passed = h.modelCalls.flatMap((call) => call.context.emails);
  assert.equal(passed.length, 75);
  assert.match(passed.at(-1).body_content, /Task at the end 74$/);
});

test('HTML-heavy stored emails are scanned completely without exceeding the body-text batch limit', async () => {
  const h = harness({ emails: [message('html', undefined, {
    body: { contentType: 'html', content: `<html><head><style>${'.x{color:red}'.repeat(20000)}</style></head><body><p>Final action: send the report.</p><blockquote>Keep the prior request.</blockquote></body></html>` },
  })] });
  const result = await h.scan();
  assert.equal(result.items.length, 1);
  assert.match(h.modelCalls[0].context.emails[0].body_content, /Final action: send the report/);
  assert.match(h.modelCalls[0].context.emails[0].body_content, /Keep the prior request/);
  assert.doesNotMatch(h.modelCalls[0].context.emails[0].body_content, /\.x/);
});

test('the model reads link text with shortened web addresses, and batching measures the shortened body', async () => {
  const link = (i) => `<a href="https://nam06.safelinks.protection.outlook.com/?url=${encodeURIComponent(`https://contoso.sharepoint.com/sites/Deal/Doc${i}.docx?web=1`)}&data=${'05%7C02%7Cuser%40contoso.com%7C'.repeat(8)}&reserved=0">Doc ${i}</a>`;
  const content = `<p>Review ${Array.from({ length: 600 }, (_, i) => link(i)).join(' ')} and send the summary.</p>`;
  assert.ok(content.length > 160000);
  const h = harness({ emails: [message('links', undefined, { body: { contentType: 'html', content } })] });
  const result = await h.scan();
  assert.equal(result.items.length, 1);
  const body = h.modelCalls[0].context.emails[0].body_content;
  assert.match(body, /^Review Doc 0 \[contoso\.sharepoint\.com\/sites\/Deal\/Doc0\.docx…\] Doc 1 \[/);
  assert.match(body, /Doc 599 \[contoso\.sharepoint\.com\/sites\/Deal\/Doc599\.docx…\] and send the summary\.$/);
  assert.doesNotMatch(body, /safelinks|reserved=0/);
});

test('todos remain priority ordered independently of email order', async () => {
  const h = harness({
    emails: [message('low'), message('high'), message('medium')],
    extract: (batch) => batch.map((source) => ({ ...todo(source), priority: source.message_id })),
  });
  assert.deepEqual((await h.scan()).items.map((item) => item.priority), ['high', 'medium', 'low']);
});

test('common rolling periods are resolved deterministically without a separate model call', async () => {
  const scope = { since: '2026-08-22T12:00:00.000Z', until: NOW.toISOString(), label: 'the last 30 days' };
  const h = harness({ emails: [message('old', '2026-08-25T12:00:00.000Z')] });
  const result = await h.scan({ guidance: 'Find Contoso todos over the last 30 days' });
  assert.deepEqual(result.scope, scope);
  assert.equal(result.items.length, 1);
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.modelCalls[0].agent, 'secretary');
  assert.match(h.modelCalls[0].context.guidance, /Contoso/);
});

test('explicit all-time guidance reads all pulled customer email with no invented lower date cutoff', async () => {
  for (const guidance of [
    'Search all pulled customer email', 'Review all customer emails', 'Search all available inbox history', 'Find todos from all time',
  ]) {
    const h = harness({ emails: [message('ancient', '2020-01-15T09:00:00.000Z')] });
    const result = await h.scan({ guidance });
    assert.deepEqual(result.scope, { since: null, until: NOW.toISOString(), label: 'all pulled customer email' }, guidance);
    assert.deepEqual(h.modelCalls.map((call) => call.agent), ['secretary'], guidance);
    assert.equal(result.items.length, 1, guidance);
  }
});

test('calendar periods use local calendar boundaries without a model call', async () => {
  const h = harness({ emails: [message('august', '2026-08-01T09:00:00.000Z')] });
  const result = await h.scan({ guidance: 'Find Fabrikam follow-ups from last week' });
  const thisWeek = new Date(NOW);
  thisWeek.setHours(0, 0, 0, 0);
  thisWeek.setDate(thisWeek.getDate() - (thisWeek.getDay() + 6) % 7);
  const previousWeek = new Date(thisWeek);
  previousWeek.setDate(previousWeek.getDate() - 7);
  assert.deepEqual(result.scope, {
    since: previousWeek.toISOString(),
    until: new Date(thisWeek.getTime() - 1).toISOString(),
    label: 'last week',
  });
  assert.equal(h.modelCalls.length, 0);
  assert.equal(result.scanned, 0);
});

test('conflicting time phrases still require explicit model validation', async () => {
  const h = harness({ emails: [message('a')], scope: { error: 'Choose one time period.' } });
  await assert.rejects(h.scan({ guidance: 'Search today and last week' }), /Secretary needs a time range/);
  assert.deepEqual(h.modelCalls.map((call) => call.agent), ['secretary-scope']);
});

test('completed threads remain excluded and source identities come from the stored email', async () => {
  const h = harness({
    emails: [message('done'), message('active')],
    extract: (batch) => [{ ...todo(batch[0]), account: 'Invented account', from: 'Invented sender', subject: 'Invented subject' }],
  });
  markDone(h.db, 'thread-done');
  const result = await h.scan();
  assert.equal(result.scanned, 2);
  assert.equal(result.analyzed, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.items[0].account, 'Contoso');
  assert.equal(result.items[0].from, 'Sender');
  assert.equal(result.items[0].subject, 'Subject active');
  assert.equal(result.items[0].webLink, 'https://outlook.office.com/mail/item/active');
});

test('threads stay together across batches and exact repeated tasks are returned once', async () => {
  const rows = Array.from({ length: 22 }, (_, i) => ({ message_id: `e-${i}`, conversation_id: `thread-${i}`, body_content: 'Complete the request.' }));
  rows[21].conversation_id = rows[0].conversation_id;
  const batches = emailBatches(rows);
  assert.ok(batches[0].includes(rows[0]) && batches[0].includes(rows[21]));
  assert.equal(batches.flat().length, 22);
  const h = harness({
    emails: [message('a'), message('b', undefined, { conversationId: 'thread-a' })],
    extract: (batch) => batch.map((source) => ({ ...todo(source), title: 'Send the requested deck' })),
  });
  assert.equal((await h.scan()).items.length, 1);
});

test('Secretary returns a modern reader link to the exact source email, not the legacy OWA route', async () => {
  const id = 'AAMk+source/email=';
  const h = harness({
    emails: [message(id, undefined, {
      webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem&nativeVersion=old&sessionId=old`,
    })],
    extract: (batch) => [{ ...todo(batch[0]), webLink: 'https://example.com/invented' }],
  });
  const { items } = await h.scan();
  const link = new URL(items[0].webLink);
  assert.equal(items[0].sourceMessageId, id);
  assert.equal(link.origin, 'https://outlook.office.com');
  assert.equal(decodeURIComponent(link.pathname), `/mail/deeplink/read/${id}`);
  assert.equal(link.searchParams.get('ItemID'), id);
  assert.equal(link.searchParams.has('nativeVersion'), false);
  assert.equal(link.searchParams.has('sessionId'), false);
});

test('a large conversation spans bounded batches without dropping messages', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    message_id: `large-${i}`, conversation_id: 'large-thread', body_content: 'x'.repeat(35000),
  }));
  rows.push({ message_id: 'other', conversation_id: 'other-thread', body_content: 'y'.repeat(40000) });
  const batches = emailBatches(rows);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 4);
  assert.equal(batches[1].length, 3);
  assert.equal(batches.flat().length, rows.length);
});

test('long conversations retain earlier open todos and later replies can resolve them', async () => {
  const h = harness({
    emails: [
      message('latest', '2026-09-21T11:00:00.000Z', {
        conversationId: 'long-thread', body: { contentType: 'text', content: `The first task is completed. ${'x'.repeat(85000)}` },
      }),
      message('middle', '2026-09-21T10:00:00.000Z', {
        conversationId: 'long-thread', body: { contentType: 'text', content: `Please complete another task. ${'x'.repeat(85000)}` },
      }),
      message('first', '2026-09-21T09:00:00.000Z', {
        conversationId: 'long-thread', body: { contentType: 'text', content: `Please complete the first task. ${'x'.repeat(85000)}` },
      }),
    ],
    extract: (batch, _calls, context) => {
      if (batch[0].message_id === 'latest') return context.previousItems.filter((item) => item.sourceMessageId !== 'first');
      return [...context.previousItems, ...batch.map(todo)];
    },
  });
  const result = await h.scan();
  assert.deepEqual(h.modelCalls.map((call) => call.context.emails[0].message_id), ['first', 'middle', 'latest']);
  assert.deepEqual(h.modelCalls.map((call) => call.context.previousItems.length), [0, 1, 2]);
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.items.map((item) => item.sourceMessageId), ['middle']);
});

test('a later conversation chunk cannot cite an unread future email', async () => {
  const h = harness({
    emails: [
      message('first', '2026-09-21T09:00:00.000Z', { conversationId: 'long-thread', body: { contentType: 'text', content: 'x'.repeat(100000) } }),
      message('future-chunk', '2026-09-21T10:00:00.000Z', { conversationId: 'long-thread', body: { contentType: 'text', content: 'x'.repeat(100000) } }),
    ],
    extract: () => [{
      title: 'Invented early task', summary: 'Not read yet', priority: 'high', sourceMessageId: 'future-chunk',
      ownership: 'direct', owner: 'Test User',
    }],
  });
  await assert.rejects(h.scan(), /ungrounded todo/);
});

test('an empty time window is explicit and does not call the extraction model', async () => {
  const h = harness({ emails: [message('earlier', '2026-09-01T09:00:00.000Z')] });
  const result = await h.scan();
  assert.deepEqual(result.items, []);
  assert.equal(result.scanned, 0);
  assert.equal(result.analyzed, 0);
  assert.equal(h.modelCalls.length, 0);
  assert.equal(result.excluded, 0);
  assert.deepEqual(result.unreadable, []);
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.bodySources, { full: 0, condensed: 0, preview: 0 });
});

test('scan reports the model that actually ran for its scope and extraction calls', async () => {
  const scope = { since: SINCE, until: NOW.toISOString(), label: 'since the offsite' };
  const h = harness({ scope, model: 'gpt-5.6-luna', emails: [message('one')] });
  const result = await h.scan({ guidance: 'Find todos since the offsite' });
  assert.deepEqual(h.modelCalls.map((call) => call.agent), ['secretary-scope', 'secretary']);
  assert.deepEqual(result.models, ['gpt-5.6-luna']);
  assert.equal(result.items.length, 1);
});

test('direct assignments and shared follow-ups retain distinct ownership and the stored recipients', async () => {
  const h = harness({
    emails: [
      message('direct', '2026-09-21T09:00:00.000Z', { body: { contentType: 'text', content: 'Test User, please send the review notes.' } }),
      message('shared', '2026-09-21T09:30:00.000Z', {
        toRecipients: [{ emailAddress: { name: 'Account owner' } }],
        ccRecipients: [{ emailAddress: { name: 'Test User' } }],
        body: { contentType: 'text', content: 'Account owner, please coordinate the urgent pricing call. Customer confirmation is pending.' },
      }),
    ],
    extract: batch => batch.map(source => ({
      ...todo(source),
      ownership: source.message_id === 'shared' ? 'shared' : 'direct',
      owner: source.message_id === 'shared' ? 'Account owner' : 'Test User',
    })),
  });
  const result = await h.scan();
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].ownership, 'direct');
  assert.equal(result.items[0].owner, 'Test User');
  assert.equal(result.items[1].ownership, 'shared');
  assert.equal(result.items[1].owner, 'Account owner');
  assert.equal(result.scope.since, SINCE);
  const shared = h.modelCalls[0].context.emails[1];
  assert.deepEqual(shared.to_recipients, [{ emailAddress: { name: 'Account owner', address: null } }]);
  assert.deepEqual(shared.cc_recipients, [{ emailAddress: { name: 'Test User', address: null } }]);
});

test('protected-message notices are disclosed, not passed to the model as readable content', async () => {
  const h = harness({ emails: [
    message('protected', undefined, { body: { contentType: 'text', content: NOTICE } }),
    message('readable'),
    message('done'),
  ] });
  markDone(h.db, 'thread-done');
  const result = await h.scan();
  assert.equal(result.scanned, 3);
  assert.equal(result.analyzed, 1);
  assert.equal(result.excluded, 1);
  assert.deepEqual(result.unreadable, [{
    sourceMessageId: 'protected', subject: 'Subject protected',
    webLink: 'https://outlook.office.com/mail/item/protected', reason: PROTECTED_REASON,
  }]);
  assert.deepEqual(h.modelCalls[0].context.emails.map(email => email.message_id), ['readable']);
});

test('a window containing only protected notices is not reported as fully analyzed', async () => {
  const h = harness({ emails: [message('protected', undefined, {
    body: { contentType: 'html', content: '<p>Sender has sent you a protected message.</p><p>Read the message</p><p>Learn about messages protected by Microsoft Purview Message Encryption.</p>' },
    webLink: null,
  })] });
  const result = await h.scan();
  assert.equal(result.items.length, 0);
  assert.equal(result.scanned, 1);
  assert.equal(result.analyzed, 0);
  assert.equal(result.unreadable.length, 1);
  assert.equal(result.unreadable[0].webLink, null);
  assert.equal(result.unreadable[0].reason, PROTECTED_REASON);
  assert.equal(h.modelCalls.length, 0);
});

test('missing or invented ownership is rejected rather than claiming a shared task belongs to the user', async () => {
  for (const ownership of [undefined, 'personal', null]) {
    const h = harness({ emails: [message('a')], extract: batch => [{ ...todo(batch[0]), ownership }] });
    await assert.rejects(h.scan(), /invalid or ungrounded todo/);
  }
});

test('oversized evidence and incomplete model output are errors, not silently shortened scans', async () => {
  assert.throws(() => emailBatches([{ message_id: 'large', body_content: 'x'.repeat(160001) }]), /silently truncated/);
  const h = harness({
    emails: [message('a')],
    extract: () => ({ content: '[]', finishReason: 'length' }),
  });
  await assert.rejects(h.scan(), /No partial results/);
});

for (const badItem of [
  { title: '', summary: 'Task', priority: 'high', sourceMessageId: 'a', ownership: 'direct', owner: null },
  { title: 'Task', summary: '', priority: 'high', sourceMessageId: 'a', ownership: 'direct', owner: null },
  { title: 'Task', summary: 'Task', priority: 'urgent', sourceMessageId: 'a', ownership: 'direct', owner: null },
  { title: 'Task', summary: 'Task', priority: 'high', sourceMessageId: 'invented-id', ownership: 'direct', owner: null },
]) {
  test(`invalid or ungrounded item is rejected: ${JSON.stringify(badItem)}`, async () => {
    const h = harness({ emails: [message('a')], extract: () => [badItem] });
    await assert.rejects(h.scan(), /invalid or ungrounded todo/);
  });
}

test('invalid model shape or JSON is not turned into an empty task list', async () => {
  for (const output of [{ items: [] }, { content: 'not JSON', finishReason: 'stop' }]) {
    const h = harness({ emails: [message('a')], extract: () => output });
    await assert.rejects(h.scan(), /unexpected action-item format|invalid JSON/);
  }
});

test('ambiguous, impossible, reversed and future time scopes fail before any email is read', async () => {
  for (const scope of [
    { error: 'Specify the last 7 days or all history.' },
    { since: '2026-02-30T00:00:00.000Z', until: NOW.toISOString(), label: 'Invalid date' },
    { since: NOW.toISOString(), until: SINCE, label: 'Reversed' },
    { since: SINCE, until: '2026-09-22T12:00:00.000Z', label: 'Future' },
    { since: 'not-a-date', until: NOW.toISOString(), label: 'Bad' },
  ]) {
    const h = harness({ emails: [message('a')], scope });
    await assert.rejects(h.scan({ guidance: 'Search further back' }), /time range/);
    assert.deepEqual(h.modelCalls.map((call) => call.agent), ['secretary-scope']);
  }
});

test('invalid requested durations and guidance are not silently changed to the default', async () => {
  for (const days of [0, -1, '7', Infinity, 1e300]) {
    const h = harness({ emails: [message('a')] });
    await assert.rejects(h.scan({ days }), /positive number of days/);
    assert.equal(h.modelCalls.length, 0);
  }
  const h = harness({ emails: [message('a')] });
  await assert.rejects(h.scan({ guidance: 'x'.repeat(2001) }), /2,000 characters/);
  assert.equal(h.modelCalls.length, 0);
});

test('Secretary fails loudly before any model call when no customer-linked email has been pulled', async () => {
  for (const h of [
    harness({ pulled: null }),
    harness(),
    harness({ emails: [[message('unlinked'), { tpids: [] }], [message('ai-rejected'), { method: 'ai-rejected' }]] }),
  ]) {
    await assert.rejects(h.scan({ guidance: 'Find todos since the offsite' }), (error) => {
      assert.match(error.message, /No customer-linked email has been pulled into SE Assist yet/);
      assert.match(error.message, /Pull new items/);
      return true;
    });
    assert.equal(h.modelCalls.length, 0);
  }
});

test('stored customer email without a completed pull record is not presented as current', async () => {
  const h = harness({ emails: [message('a')], pulled: null });
  await assert.rejects(h.scan(), /no record of a completed email pull.*Pull new items/);
  assert.equal(h.modelCalls.length, 0);
});

test('an unreadable pull time stops the scan instead of guessing freshness', async () => {
  const h = harness({ emails: [message('a')] });
  addCustomer(h.db, 'T-2', 'Fabrikam');
  markPulled(h.db, 'yesterday-ish', 'T-2');
  await assert.rejects(h.scan(), /unreadable email pull time \("yesterday-ish"\)/);
  assert.equal(h.modelCalls.length, 0);
});

test('the pull time is the latest recorded email refresh across accounts and time formats', () => {
  const db = secretaryDb();
  databases.push(db);
  addCustomer(db, 'T-1', 'Contoso');
  addCustomer(db, 'T-2', 'Fabrikam');
  addCustomer(db, 'T-3', 'Tailspin');
  storeEmail(db, message('linked'));
  storeEmail(db, message('unlinked'), { tpids: [] });
  markPulled(db, '2026-09-21 08:00:00', 'T-1');
  markPulled(db, '2026-09-21T13:15:00+02:00', 'T-2');
  markPulled(db, '2026-09-21T10:00:00Z', 'T-3');
  assert.deepEqual(readEmailPullState(db), { pulledAt: '2026-09-21T11:15:00.000Z', linkedCount: 1 });
});

test('each email reports whether the model read the full stored body, condensed text, or only the preview', async () => {
  const h = harness({ emails: [
    message('full', '2026-09-21T08:00:00.000Z'),
    [message('condensed', '2026-09-21T08:10:00.000Z', { body: { contentType: 'text', content: 'Condensed body text.' } }), { raw_json: null }],
    [message('invalid-raw', '2026-09-21T08:20:00.000Z'), { raw_json: '{not json' }],
    message('empty-raw-body', '2026-09-21T08:30:00.000Z', { body: { contentType: 'text', content: '   ' } }),
    message('no-body', '2026-09-21T08:40:00.000Z', { body: undefined }),
  ] });
  const result = await h.scan();
  assert.deepEqual(result.bodySources, { full: 1, condensed: 2, preview: 2 });
  assert.deepEqual(h.modelCalls[0].context.emails.map((email) => [email.message_id, email.body_content, email.body_source, email.excerpt]), [
    ['full', 'Please complete task full.', 'full', 'Preview full'],
    ['condensed', 'Condensed body text.', 'condensed', 'Condensed body text.'],
    ['invalid-raw', 'Please complete task invalid-raw.', 'condensed', 'Please complete task invalid-raw.'],
    ['empty-raw-body', 'Preview empty-raw-body', 'preview', 'Preview empty-raw-body'],
    ['no-body', 'Preview no-body', 'preview', 'Preview no-body'],
  ]);
});

test('a protected notice stored only as condensed text is still disclosed as unreadable', async () => {
  const h = harness({ emails: [[message('protected-copy'), {
    raw_json: null,
    body_text: 'Sender (sender@example.com) has sent you a protected message. Read the message Learn about messages protected by Microsoft Purview Message Encryption.',
  }]] });
  const result = await h.scan();
  assert.deepEqual(result.unreadable, [{
    sourceMessageId: 'protected-copy', subject: 'Subject protected-copy',
    webLink: 'https://outlook.office.com/mail/item/protected-copy', reason: PROTECTED_REASON,
  }]);
  assert.equal(h.modelCalls.length, 0);
});

test('an email with no readable stored text is disclosed instead of analyzed as empty', async () => {
  const h = harness({ emails: [message('blank', undefined, { body: { contentType: 'html', content: '<p> </p>' }, bodyPreview: '' })] });
  const result = await h.scan();
  assert.equal(result.scanned, 1);
  assert.equal(result.analyzed, 0);
  assert.deepEqual(result.unreadable, [{
    sourceMessageId: 'blank', subject: 'Subject blank',
    webLink: 'https://outlook.office.com/mail/item/blank', reason: NO_BODY_REASON,
  }]);
  assert.equal(h.modelCalls.length, 0);
});

test('sent-by-you is matched on the signed-in address and is unknown when that address is not stored', async () => {
  const emails = [
    message('mine', '2026-09-21T08:00:00.000Z', { from: { emailAddress: { name: 'Test User', address: 'Test.User@Contoso.com' } } }),
    message('theirs', '2026-09-21T08:30:00.000Z'),
    message('unknown-sender', '2026-09-21T09:00:00.000Z', { from: undefined }),
  ];
  const known = harness({ emails });
  setUser(known.db, ' test.user@contoso.com ');
  const knownResult = await known.scan();
  assert.deepEqual(known.modelCalls[0].context.emails.map((email) => email.from_you), [true, false, null]);
  assert.equal(knownResult.sentByYou, 1);
  assert.equal(knownResult.userAddressKnown, true);

  const unknown = harness({ emails });
  const unknownResult = await unknown.scan();
  assert.deepEqual(unknown.modelCalls[0].context.emails.map((email) => email.from_you), [null, null, null]);
  assert.equal(unknownResult.sentByYou, null);
  assert.equal(unknownResult.userAddressKnown, false);

  const missing = harness({ emails });
  missing.db.exec('DROP TABLE app_settings');
  await assert.rejects(missing.scan(), /no such table: app_settings/);
  assert.equal(missing.modelCalls.length, 0);
});

test('stored copies of one message are merged, keep every linked account, and a done copy excludes the message', async () => {
  const shared = { internetMessageId: '<shared@example.com>', conversationId: 'thread-shared' };
  const doneGroup = { internetMessageId: '<done@example.com>', conversationId: 'thread-done' };
  const h = harness({ emails: [
    [message('copy-a', '2026-09-21T09:00:00.000Z', shared), { raw_json: null, body_text: 'Short preview', body_source: 'preview' }],
    [message('copy-b', '2026-09-21T09:00:00.000Z', shared), { tpids: ['T-2'] }],
    [message('copy-c', '2026-09-21T09:00:00.000Z', { ...shared, body: { contentType: 'text', content: NOTICE } }), { internet_message_id: null }],
    message('done-sent', '2026-09-21T08:00:00.000Z', doneGroup),
    message('done-received', '2026-09-21T08:00:05.000Z', doneGroup),
  ] });
  addCustomer(h.db, 'T-2', 'Fabrikam');
  markDone(h.db, 'thread-done');
  const result = await h.scan();
  assert.equal(result.scanned, 2);
  assert.equal(result.analyzed, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.duplicatesMerged, 3);
  assert.deepEqual(result.unreadable, []);
  assert.deepEqual(result.bodySources, { full: 1, condensed: 0, preview: 0 });
  assert.deepEqual(h.modelCalls[0].context.emails.map((email) => [email.message_id, email.account_name]), [['copy-b', 'Contoso, Fabrikam']]);
});

test('account labels prefer top-level customers, skip rejected links, and summarize long lists', async () => {
  const h = harness({ emails: [[message('many'), { tpids: ['T-1', 'T-2', 'T-3', 'T-4', 'T-6'] }]] });
  addCustomer(h.db, 'T-1', 'Aaa Contoso Unit', 'crm-parent-1');
  addCustomer(h.db, 'T-2', 'Fabrikam');
  addCustomer(h.db, 'T-3', 'Northwind');
  addCustomer(h.db, 'T-4', 'Adatum');
  addCustomer(h.db, 'T-5', 'Zeta Rejected');
  addLink(h.db, 'many', 'T-5', 'ai-rejected');
  const result = await h.scan();
  assert.equal(h.modelCalls[0].context.emails[0].account_name, 'Adatum, Contoso, Fabrikam +1 more');
  assert.equal(result.items[0].account, 'Adatum, Contoso, Fabrikam +1 more');
});

test('recipients stored without the Graph message are read from the pulled columns', async () => {
  const h = harness({ emails: [
    [message('flat', '2026-09-21T08:00:00.000Z', {
      toRecipients: [{ emailAddress: { name: 'Buyer', address: 'buyer@contoso.com' } }],
      ccRecipients: [{ emailAddress: { address: 'cc@contoso.com' } }],
    }), { raw_json: null }],
    [message('empty', '2026-09-21T08:10:00.000Z'), { raw_json: null, to_json: null, cc_json: '' }],
    [message('json-null', '2026-09-21T08:20:00.000Z'), { raw_json: null, to_json: 'null', cc_json: null }],
  ] });
  await h.scan();
  const recipients = Object.fromEntries(h.modelCalls[0].context.emails.map((email) => [email.message_id, [email.to_recipients, email.cc_recipients]]));
  assert.deepEqual(recipients.flat, [
    [{ emailAddress: { name: 'Buyer', address: 'buyer@contoso.com' } }],
    [{ emailAddress: { name: null, address: 'cc@contoso.com' } }],
  ]);
  assert.deepEqual(recipients.empty, [[], []]);
  assert.deepEqual(recipients['json-null'], [[], []]);
});

test('unreadable stored recipients stop the scan instead of dropping them', async () => {
  for (const toJson of ['{bad', '{}', '[1]']) {
    const h = harness({ emails: [[message('bad-recipients'), { raw_json: null, to_json: toJson }]] });
    await assert.rejects(h.scan(), /unreadable recipients for the email "Subject bad-recipients"/, toJson);
    assert.equal(h.modelCalls.length, 0, toJson);
  }
});

test('an invalid stored Outlook link stops the scan instead of linking to the wrong email', async () => {
  const h = harness({ emails: [message('bad-link', undefined, {
    webLink: 'https://outlook.office365.com/owa/?ItemID=a&ItemID=b&viewmodel=ReadMessageItem',
  })] });
  await assert.rejects(h.scan(), /stored Outlook link for the email "Subject bad-link" is invalid/);
  assert.equal(h.modelCalls.length, 0);
});

test('a stored body too large to convert safely is an error, not a truncated read', async () => {
  const h = harness({ emails: [message('huge', undefined, { body: { contentType: 'html', content: `<p>${'x'.repeat(2000001)}</p>` } })] });
  await assert.rejects(h.scan(), /could not be read: The email HTML exceeds the safe processing limit/);
  assert.equal(h.modelCalls.length, 0);
});

test('every pull problem that limits the stored email is reported in plain language', async () => {
  const h = harness({
    pulled: '2026-09-21 09:00:00',
    emails: [message('a'), [message('undated'), { received_at: 'not-a-date', sent_at: null }]],
  });
  const result = await h.scan({ lastPull: {
    result: {
      ranAt: '2026-09-21T09:00:00.000Z',
      errors: [{ medium: 'teams', error: 'Teams failed.' }, { medium: 'email', error: 'Graph throttled the request.' }],
      results: [{ medium: 'email', failedAccounts: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((account) => ({ account, error: 'Search failed.' })) }],
      degraded: true,
      degradedReason: 'Customer aliases were unavailable.',
    },
    lastError: 'MSX sign-in expired.',
    lastErrorAt: '2026-09-21T11:00:00.000Z',
    running: true,
    autoEnabled: false,
    autoIntervalMin: 60,
  } });
  assert.deepEqual(result.pullWarnings, [
    'The latest pull could not refresh email: Graph throttled the request. Secretary is reading the email stored before it.',
    'The latest pull could not search 7 accounts (A, B, C, D, E, and 2 more); their newest email may be missing.',
    'The latest pull ran degraded (Customer aliases were unavailable), so customer email matching may be incomplete.',
    'The most recent pull attempt failed: MSX sign-in expired. Secretary is reading the email stored by the previous pull.',
    'A pull is running now; scan again after it finishes to include the newest email.',
    'Automatic background pulls are off, so stored email updates only when you choose Pull new items.',
    'The last email pull finished 3 hours ago, so newer email is not included.',
    '1 stored customer email has no readable date, so it could not be placed in the time window and was not read.',
  ]);
});

test('pull problems are reported only when they can affect the stored email, and unknown times are not hidden', async () => {
  const auto = { autoEnabled: true, autoIntervalMin: 60 };
  const everyProblem = {
    errors: [{ medium: 'email', error: 'Graph throttled the request.' }],
    results: [{ medium: 'email', failedAccounts: [{ account: 'A', error: 'Search failed.' }] }],
    degraded: true,
    degradedReason: 'Customer aliases were unavailable.',
  };
  for (const [lastPull, expected] of [
    [{ ...auto, result: { ...everyProblem, ranAt: '2026-09-21T11:00:00.000Z' }, lastError: 'Pull failed.', lastErrorAt: '2026-09-21 11:00:00' }, []],
    [{ ...auto, result: { ranAt: '2026-09-21T11:45:00.000Z', degraded: true, results: [{ medium: 'teams' }] } }, []],
    [{ ...auto, result: { ranAt: 'unknown', errors: [{ medium: 'email', error: '  ' }], results: [{ medium: 'email', failedAccounts: [{}] }] } }, [
      'The latest pull could not refresh email: no error detail was recorded. Secretary is reading the email stored before it.',
      'The latest pull could not search 1 account; their newest email may be missing.',
    ]],
    [{ ...auto, lastError: 'Pull failed.', lastErrorAt: null }, [
      'The most recent pull attempt failed: Pull failed. Secretary is reading the email stored by the previous pull.',
    ]],
  ]) {
    const h = harness({ emails: [message('a')] });
    assert.deepEqual((await h.scan({ lastPull })).pullWarnings, expected, JSON.stringify(lastPull));
  }
});

test('stale stored email is flagged against the pull schedule, only when the window reaches past the last pull', async () => {
  const scope = { since: '2026-09-14T00:00:00.000Z', until: '2026-09-16T00:00:00.000Z', label: 'the offsite week' };
  const stale = (age) => [`The last email pull finished ${age} ago, so newer email is not included.`];
  for (const [pulled, lastPull, expected, guidance] of [
    ['2026-09-21 09:00:00', null, stale('3 hours')],
    ['2026-09-21 09:00:00', { autoEnabled: true, autoIntervalMin: 240 }, []],
    ['2026-09-21 09:00:00', { autoEnabled: true, autoIntervalMin: 60 }, stale('3 hours')],
    ['2026-09-19 11:00:00', null, stale('2 days')],
    ['2026-09-19 13:00:00', null, stale('47 hours')],
    ['2026-09-18 12:00:00', null, [], 'Find todos from the week of the offsite'],
  ]) {
    const h = harness({ pulled, scope, emails: [message('earlier', '2026-09-18T09:00:00.000Z')] });
    const result = await h.scan({ lastPull, guidance });
    assert.deepEqual(result.pullWarnings, expected, `${pulled} ${JSON.stringify(lastPull)}`);
  }
});

test('several undated stored emails are counted in one warning', async () => {
  const h = harness({ emails: [
    message('a'),
    [message('bad-date'), { received_at: 'not-a-date' }],
    [message('no-date'), { received_at: null, sent_at: null }],
  ] });
  assert.deepEqual((await h.scan()).pullWarnings, [
    '2 stored customer emails have no readable date, so they could not be placed in the time window and were not read.',
  ]);
});
