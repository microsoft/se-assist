'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { copyMilestoneTeamsMessage } = require('../teams-chat-message');

const milestoneUrl = 'https://microsoftsales.crm.dynamics.com/main.aspx?etn=msp_engagementmilestone&id=11111111-2222-3333-4444-555555555555&pagetype=entityrecord';
const payload = { ownerName: '  Avery   Quinn  ', milestoneName: 'Azure & AI', milestoneUrl };

function fakeClipboard() {
  let data;
  const writes = [];
  return {
    writes,
    write(value) { data = value; writes.push(value); },
    readText: () => data?.text || '',
    readHTML: () => data ? `<meta charset='utf-8'>${data.html}` : '',
  };
}

test('copies one rich-text message whose milestone name links to the exact MSX record', () => {
  const clipboard = fakeClipboard();
  assert.deepEqual(copyMilestoneTeamsMessage(payload, clipboard), { ok: true });
  assert.deepEqual(clipboard.writes, [{
    text: `Hi Avery, can we talk about this milestone Azure & AI. ${milestoneUrl}`,
    html: `<p>Hi Avery, can we talk about this milestone <a href="${milestoneUrl.replace(/&/g, '&amp;')}">Azure &amp; AI</a>.</p>`,
  }]);
});

test('escapes names as text and quotes in the hyperlink attribute rather than allowing markup', () => {
  const clipboard = fakeClipboard();
  copyMilestoneTeamsMessage({
    ownerName: '<svg/onload=bad> Owner',
    milestoneName: 'Scope <b>AI</b> & "data"',
    milestoneUrl: `${milestoneUrl}&view="quoted"`,
  }, clipboard);
  const { html } = clipboard.writes[0];
  assert.ok(html.includes('Hi &lt;svg/onload=bad&gt;,'));
  assert.ok(html.includes('>Scope &lt;b&gt;AI&lt;/b&gt; &amp; "data"</a>'));
  assert.ok(html.includes('&amp;view=&quot;quoted&quot;"'));
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.equal(html.includes('<svg'), false);
  assert.equal(html.includes('<b>'), false);
});

test('preserves Unicode names and trims surrounding whitespace without substituting a greeting', () => {
  const clipboard = fakeClipboard();
  copyMilestoneTeamsMessage({
    ...payload, ownerName: '  Ren\u00e9   P\u00e9rez ', milestoneName: ' \u6771\u4eac & AI ',
  }, clipboard);
  assert.ok(clipboard.writes[0].html.includes('Hi Ren\u00e9,'));
  assert.ok(clipboard.writes[0].html.includes('>\u6771\u4eac &amp; AI</a>'));
});

test('missing or invalid names and links fail before touching the clipboard', () => {
  for (const invalid of [null, {}, { ...payload, ownerName: ' ' },
    { ...payload, milestoneName: 7 }, { ...payload, milestoneName: '' },
    { ...payload, milestoneUrl: null }]) {
    const clipboard = fakeClipboard();
    assert.throws(() => copyMilestoneTeamsMessage(invalid, clipboard), /owner name, milestone name and MSX link are required/);
    assert.equal(clipboard.writes.length, 0);
  }
});

test('unsafe URLs, other record types, and incomplete MSX links cannot be copied', () => {
  for (const invalid of ['not a url', 'javascript:alert(1)', 'data:text/html,test',
    milestoneUrl.replace('https:', 'http:'),
    milestoneUrl.replace('msp_engagementmilestone', 'opportunity'),
    milestoneUrl.replace('/main.aspx', '/other.aspx'),
    milestoneUrl.replace(/&id=[^&]+/, ''),
    milestoneUrl.replace('&pagetype=entityrecord', '')]) {
    const clipboard = fakeClipboard();
    assert.throws(() => copyMilestoneTeamsMessage({ ...payload, milestoneUrl: invalid }, clipboard), /valid HTTPS milestone MSX link/);
    assert.equal(clipboard.writes.length, 0);
  }
});

test('missing HTML clipboard support fails explicitly instead of copying plain text', () => {
  let written = false;
  assert.throws(() => copyMilestoneTeamsMessage(payload, {
    write() { written = true; }, readText() { return ''; },
  }), /desktop clipboard support/);
  assert.equal(written, false);
});

test('lost HTML or a changed clipboard is reported instead of claiming a formatted copy succeeded', () => {
  for (const method of ['readHTML', 'readText']) {
    const clipboard = fakeClipboard();
    clipboard[method] = () => '';
    assert.throws(() => copyMilestoneTeamsMessage(payload, clipboard), /clipboard did not retain/);
    assert.equal(clipboard.writes.length, 1);
  }
});

test('clipboard errors propagate without retrying as plain text', () => {
  const clipboard = fakeClipboard();
  const error = new Error('Clipboard is locked');
  clipboard.write = () => { throw error; };
  assert.throws(() => copyMilestoneTeamsMessage(payload, clipboard), value => value === error);
  assert.equal(clipboard.writes.length, 0);
});
