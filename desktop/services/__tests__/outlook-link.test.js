'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { toOutlookWebReaderLink } = require('../outlook-link');

test('replaces the legacy OWA reader route with an exact-message modern deep link', () => {
  const graph = 'https://outlook.office365.com/owa/?ItemID=AAMkAGE0%2BZ%2FzZ%3D&exvsurl=1&viewmodel=ReadMessageItem';
  assert.strictEqual(
    toOutlookWebReaderLink(graph),
    'https://outlook.office.com/mail/deeplink/read/AAMkAGE0%2BZ%2FzZ%3D?ItemID=AAMkAGE0%2BZ%2FzZ%3D&exvsurl=1',
  );
});

test('a failed native-session OWA link is rebuilt without legacy or session parameters', () => {
  const mangled = 'https://outlook.office.com/owa/?ItemID=AAMkAGE0abc%3D&exvsurl=1&viewmodel=ReadMessageItem&nativeVersion=1.2026.915.300&sessionId=5a00983b-1111-2222-3333-444455556666';
  assert.strictEqual(
    toOutlookWebReaderLink(mangled),
    'https://outlook.office.com/mail/deeplink/read/AAMkAGE0abc%3D?ItemID=AAMkAGE0abc%3D&exvsurl=1',
  );
});

test('preserves the exact item identity in both path and query without double encoding', () => {
  const id = 'AAMkAGE0ZGE2Njg5%2FLTdmZjQ%2BNDJlMS05%3D';
  const out = toOutlookWebReaderLink(`https://outlook.office365.com/owa/?ItemID=${id}&exvsurl=1&viewmodel=ReadMessageItem`);
  assert.ok(out.includes(`ItemID=${id}`), `ItemID must be untouched, got: ${out}`);
  assert.ok(out.includes(`/mail/deeplink/read/${id}?`));
  assert.ok(!out.includes('%253D'));
});

test('preserves literal plus and slash characters in IDs instead of decoding plus as space', () => {
  const out = new URL(toOutlookWebReaderLink('https://outlook.office.com/owa/?ItemID=AAMk+test/id=&viewmodel=ReadMessageItem'));
  assert.strictEqual(decodeURIComponent(out.pathname.split('/').at(-1)), 'AAMk+test/id=');
  assert.strictEqual(out.searchParams.get('ItemID'), 'AAMk+test/id=');
});

test('leaves unspecified and compose views alone rather than inventing a reader surface', () => {
  assert.strictEqual(
    toOutlookWebReaderLink('https://outlook.office365.com/owa/?ItemID=X%3D&exvsurl=1'),
    'https://outlook.office365.com/owa/?ItemID=X%3D&exvsurl=1',
  );
  const compose = 'https://outlook.office.com/owa/?ItemID=X%3D&viewmodel=ComposeMessageItem&exvsurl=1';
  assert.strictEqual(toOutlookWebReaderLink(compose), compose);
  const modernDraft = 'https://outlook.office.com/mail/deeplink/compose/X%3D';
  assert.strictEqual(toOutlookWebReaderLink(modernDraft), modernDraft);
});

test('leaves an already-modern reader link unchanged (idempotent)', () => {
  const clean = 'https://outlook.office.com/mail/deeplink/read/X%3D?ItemID=X%3D&exvsurl=1';
  assert.strictEqual(toOutlookWebReaderLink(clean), clean);
  assert.strictEqual(toOutlookWebReaderLink(toOutlookWebReaderLink(
    'https://outlook.office365.com/owa/?ItemID=X%3D&viewmodel=ReadMessageItem',
  )), clean);
});

test('keeps mailbox sign-in and display hints while removing native session context', () => {
  const url = 'https://outlook.office365.com/owa/?ItemID=X%3D&viewmodel=ReadMessageItem&ispopout=0&login_hint=test%40example.com&sessionId=old';
  const out = new URL(toOutlookWebReaderLink(url));
  assert.strictEqual(out.searchParams.get('ispopout'), '0');
  assert.strictEqual(out.searchParams.get('login_hint'), 'test@example.com');
  assert.strictEqual(out.searchParams.has('sessionId'), false);
});

test('recognizes case-insensitive OWA reader parameter names', () => {
  assert.strictEqual(
    toOutlookWebReaderLink('https://outlook.office.com/OWA?itemid=X%3D&ViewModel=ReadMessageItem&NativeVersion=old'),
    'https://outlook.office.com/mail/deeplink/read/X%3D?ItemID=X%3D&exvsurl=1',
  );
});

test('invalid or ambiguous reader IDs fail loudly instead of opening the inbox or another message', () => {
  for (const query of ['', 'ItemID=', 'ItemID=%GG', 'ItemID=X%20Y', 'ItemID=X&ItemID=Y']) {
    assert.throws(
      () => toOutlookWebReaderLink(`https://outlook.office.com/owa/?viewmodel=ReadMessageItem&${query}`),
      /Outlook email link.*message/,
    );
  }
});

test('does not rewrite non-item OWA links or unrelated URLs', () => {
  const calendar = 'https://outlook.office365.com/owa/?path=/calendar/view/Month';
  assert.strictEqual(toOutlookWebReaderLink(calendar), calendar);
  const web = 'https://learn.microsoft.com/azure/openai/quotas-limits';
  assert.strictEqual(toOutlookWebReaderLink(web), web);
  for (const url of [
    'https://outlook.office.com/owa/other@example.com/?ItemID=X&viewmodel=ReadMessageItem',
    'https://outlook.office.com/mail/inbox/id/X',
    'https://teams.microsoft.com/l/message/X',
    'https://example.com/owa/?ItemID=X&viewmodel=ReadMessageItem',
    'http://outlook.office.com/owa/?ItemID=X&viewmodel=ReadMessageItem',
    'https://outlook.office.com:8443/owa/?ItemID=X&viewmodel=ReadMessageItem',
    'https://user@outlook.office.com/owa/?ItemID=X&viewmodel=ReadMessageItem',
  ]) assert.strictEqual(toOutlookWebReaderLink(url), url);
});

test('returns non-string / unparseable input unchanged, without throwing', () => {
  assert.strictEqual(toOutlookWebReaderLink(null), null);
  assert.strictEqual(toOutlookWebReaderLink(''), '');
  assert.strictEqual(toOutlookWebReaderLink('not a url'), 'not a url');
});
