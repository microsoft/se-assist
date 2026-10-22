const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  inlineMd,
  markdownToHtml,
  renderHtmlDocument,
  extractHtmlDocument,
} = require('../html-render');

test('escapeHtml escapes the dangerous trio', () => {
  assert.equal(escapeHtml('<a> & "b"'), '&lt;a&gt; &amp; "b"');
  assert.equal(escapeHtml(5), '5');
});

test('inlineMd renders bold, italic, and code', () => {
  assert.equal(inlineMd('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(inlineMd('a *b* c'), 'a <em>b</em> c');
  assert.equal(inlineMd('use `x` here'), 'use <code>x</code> here');
});

test('markdownToHtml handles headings, lists, and paragraphs', () => {
  const html = markdownToHtml('# Title\n\n- one\n- two\n\nbody text');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<p>body text<\/p>/);
});

test('markdownToHtml escapes content inside blocks', () => {
  const html = markdownToHtml('- <script>');
  assert.match(html, /<li>&lt;script&gt;<\/li>/);
});

test('renderHtmlDocument embeds title, subtitle, body, and count chips', () => {
  const doc = renderHtmlDocument({
    title: 'My <Title>',
    subtitle: 'sub',
    bodyMarkdown: '## Section\n\ntext',
    meta: { counts: { emails: 3 }, source: 'unit' },
  });
  assert.match(doc, /<!doctype html>/);
  assert.match(doc, /<h1>My &lt;Title&gt;<\/h1>/);
  assert.match(doc, /<div class="subtitle">sub<\/div>/);
  assert.match(doc, /<span class="chip">emails: 3<\/span>/);
  assert.match(doc, /· unit/);
});

test('extractHtmlDocument strips fences and slices the document', () => {
  const raw = '```html\n<!doctype html><html><body>hi</body></html>\n```';
  assert.equal(extractHtmlDocument(raw), '<!doctype html><html><body>hi</body></html>');
  assert.equal(extractHtmlDocument('no html here'), null);
});
