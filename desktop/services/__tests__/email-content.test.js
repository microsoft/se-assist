'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emailBodyText, compactEmailLinks, isProtectedMessageNotice, isProtectedMessageText } = require('../email-content');

const safeLink = (target) => `https://nam06.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=05%7C02%7Cuser%40contoso.com%7Cabc&sdata=xyz%3D&reserved=0`;

test('email HTML becomes complete text with decoded entities, links and quoted replies', () => {
  const body = emailBodyText({ contentType: 'html', content: [
    '<html><head><style>.hidden{color:red}</style><script>untrusted()</script></head><body>',
    '<p>Please review A &amp; B &#x2192; C.</p>',
    '<p><a href="https://example.com/spec">Read the spec</a></p>',
    '<blockquote><p>From: Sender</p><p>Original request: send the report.</p></blockquote>',
    '<img alt="Status chart" src="data:image/png;base64,NOT-TEXT"><img src="cid:attachment">',
    '</body></html>',
  ].join('') });
  assert.match(body, /A & B \u2192 C/);
  assert.match(body, /https:\/\/example.com\/spec/);
  assert.match(body, /Original request: send the report/);
  assert.match(body, /Status chart/);
  assert.match(body, /Inline image without a text alternative/);
  assert.doesNotMatch(body, /\.hidden|untrusted\(\)|base64|NOT-TEXT/);
});

test('long styling and large element counts never silently remove the final action item', () => {
  const content = `<html><head><style>${'.x{color:red}'.repeat(16000)}</style></head><body>${'<span>context </span>'.repeat(2500)}<p>FINAL ACTION: deliver the report.</p></body></html>`;
  const body = emailBodyText({ contentType: 'html', content });
  assert.match(body, /FINAL ACTION: deliver the report\.$/);
  assert.equal((body.match(/context/g) || []).length, 2500);
});

test('plain text is preserved including angle brackets and reply history', () => {
  const content = 'if (a < b) { finish(); }\n\nFrom: Sender\nOriginal task';
  assert.equal(emailBodyText({ contentType: 'text', content }), content);
});

test('missing, unsupported and oversized bodies are errors rather than shortened content', () => {
  assert.throws(() => emailBodyText(null), /full email body/);
  assert.throws(() => emailBodyText({ contentType: 'xml', content: '<body>Task</body>' }), /unsupported/);
  assert.throws(() => emailBodyText({ contentType: 'html', content: 'x'.repeat(2_000_001) }), /No body text was silently truncated/);
});

test('link compaction keeps link text, site and path, unwraps SafeLinks and marks what it removed', () => {
  const body = emailBodyText({ contentType: 'html', content: [
    `<p>Please complete <a href="${safeLink('https://forms.office.com/r/AbC?source=email')}">the intake form</a> by Friday.</p>`,
    `<p><a href="${safeLink('https://aka.ms/Foo')}">https://aka.ms/Foo</a></p>`,
  ].join('') });
  assert.equal(compactEmailLinks(body), 'Please complete the intake form [forms.office.com/r/AbC…] by Friday.\n\naka.ms/Foo');
  assert.equal(compactEmailLinks(`https://aka.ms/Foo<${safeLink('https://aka.ms/Foo')}>`), 'aka.ms/Foo');
  assert.equal(compactEmailLinks('https://aka.ms/Foo [https://click.example.com/t?x=1]'), 'aka.ms/Foo [click.example.com/t…]');
  assert.equal(compactEmailLinks(`Nested ${safeLink(safeLink('https://example.com/x#top'))}`), 'Nested example.com/x…');
  assert.equal(compactEmailLinks(`Script [${safeLink('javascript:alert(1)')}]`), 'Script [nam06.safelinks.protection.outlook.com…]');
  assert.equal(compactEmailLinks('https://user:secret@Example.COM/Path'), 'example.com/Path');
});

test('link compaction leaves sentence punctuation, long paths and non-web text readable', () => {
  assert.equal(
    compactEmailLinks('See https://x.com/a?b=1. Then (https://en.wikipedia.org/wiki/Foo_(bar)) and \u201chttps://y.com/\u201d.'),
    'See x.com/a\u2026. Then (en.wikipedia.org/wiki/Foo_(bar)) and \u201cy.com\u201d.',
  );
  const path = '/sites/Team/Shared%20Documents/General/Very/Deep/Folder/Structure/Report.docx';
  assert.equal(compactEmailLinks(`https://contoso.sharepoint.com${path}`), `contoso.sharepoint.com${path.slice(0, 60)}…`);
  for (const text of ['Ann [ann@contoso.com] mailto:ann@contoso.com', 'Go to https://%zz now', 'if (a < b) { finish(); }', '']) {
    assert.equal(compactEmailLinks(text), text);
  }
});

test('protected-message detection requires the actual notice, not quoted text inside a readable reply', () => {
  const notice = 'Sender (sender@example.com) has sent you a protected message.\nRead the message\nLearn about messages protected by Microsoft Purview Message Encryption.';
  assert.equal(isProtectedMessageNotice(notice), true);
  assert.equal(isProtectedMessageNotice(`\n\n${notice}`), true);
  assert.equal(isProtectedMessageNotice(`Here is the requested update.\n\nFrom: Sender\n${notice}`), false);
  assert.equal(isProtectedMessageNotice('A protected message may arrive later. Please send the agenda.'), false);
  assert.equal(isProtectedMessageNotice(''), false);
});

test('protected-notice detection on stored single-line text still rejects quoted notices and ordinary mail', () => {
  const stored = 'Karen Del Vescovo (karendve@contoso.com) has sent you a protected message. Read the message Learn about messages protected by Microsoft Purview Message Encryption. This is a secure message.';
  assert.equal(isProtectedMessageText(stored), true);
  assert.equal(isProtectedMessageText(`  ${stored.replace(/ /g, '\n')}`), true);
  assert.equal(isProtectedMessageText(`Here is the requested update. From: Karen ${stored}`), false);
  assert.equal(isProtectedMessageText(`From: Karen ${stored}`), false);
  assert.equal(isProtectedMessageText('has sent you a protected message. Read the message Microsoft Purview Message Encryption'), false);
  assert.equal(isProtectedMessageText('Karen has sent you a protected message. Read the message later.'), false);
  assert.equal(isProtectedMessageText('A protected message may arrive later. Please send the agenda.'), false);
  assert.equal(isProtectedMessageText(`${'x'.repeat(301)} has sent you a protected message. Read the message Microsoft Purview Message Encryption`), false);
  assert.equal(isProtectedMessageText(''), false);
  assert.equal(isProtectedMessageText(null), false);
});
