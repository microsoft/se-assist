'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { gzipSync, brotliCompressSync, deflateSync } = require('node:zlib');
const { createPublicPageReader, publicSourceUrl } = require('../public-web-page');

const URL = 'https://www.electronjs.org/docs/latest/tutorial/context-isolation';

function harness(pages = [{ text: 'Official source text.' }], addresses = [{ address: '93.184.216.34', family: 4 }]) {
  const requests = [];
  const connections = [];
  const dnsRequests = [];
  const read = createPublicPageReader({
    lookup(hostname, options, callback) {
      dnsRequests.push({ hostname, options });
      callback(null, typeof addresses === 'function' ? addresses(hostname) : addresses);
    },
    get(url, options, callback) {
      const target = new globalThis.URL(url);
      const request = new EventEmitter();
      const page = pages[requests.length] || pages.at(-1);
      requests.push({ url: target.href, options });
      let response;
      const onAbort = () => {
        request.emit('error', options.signal.reason);
        response?.destroy(options.signal.reason);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => options.lookup(target.hostname, { all: true }, (error, resolved) => {
        if (error) {
          options.signal?.removeEventListener('abort', onAbort);
          request.emit('error', error);
          return;
        }
        connections.push({ hostname: target.hostname, resolved });
        response = page.stream || Readable.from(page.chunks || [Buffer.from(page.text ?? '')], { objectMode: false });
        response.statusCode = page.status ?? 200;
        response.headers = { 'content-type': page.type || 'text/plain; charset=utf-8', ...page.headers };
        response.on('close', () => options.signal?.removeEventListener('abort', onAbort));
        callback(response);
      }));
      return request;
    },
  });
  return { read, requests, connections, dnsRequests };
}

test('public page URLs reject private hosts, credentials, IPs and non-HTTPS schemes', () => {
  for (const url of [
    'http://example.com/page', 'https://example.com:444/page', 'https://user:password@example.com/page',
    'https://localhost/page', 'https://intranet/page', 'https://host.local/page', 'https://host.internal./page',
    'https://127.0.0.1/page', 'https://2130706433/page', 'https://[::1]/page',
    'https://tenant.sharepoint.com/file', 'https://tenant.sharepoint.com./file', 'https://outlook.office.com/mail/item/id',
    'https://teams.microsoft.com/l/message/id', 'file:///C:/private', 'not a URL',
  ]) assert.equal(publicSourceUrl(url), null, url);
  assert.equal(publicSourceUrl(URL), URL);
});

test('the actual socket lookup pins only vetted public addresses and requests never carry credentials', async () => {
  const client = harness(undefined, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  const result = await client.read({ url: URL });
  assert.equal(result.structuredContent.text, 'Official source text.');
  assert.equal(result.structuredContent.url, URL);
  assert.equal(client.dnsRequests.length, 1);
  assert.deepEqual(client.dnsRequests[0].options, { all: true });
  assert.equal(client.connections[0].resolved.length, 2);
  const options = client.requests[0].options;
  assert.equal(options.agent, false);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers.Referer, undefined);
  assert.equal(options.rejectUnauthorized, undefined);
  assert.equal(options.headers['Accept-Encoding'], 'identity');
});

test('a private or reserved DNS address rejects the entire resolution before connecting', async () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1',
  ]) {
    const client = harness(undefined, [
      { address: '93.184.216.34', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    await assert.rejects(client.read({ url: URL }), /private|reserved|public/i, address);
    assert.equal(client.connections.length, 0, address);
  }
});

test('an invalid address or address family is not accepted as a public connection', async () => {
  for (const addresses of [[], [{ address: 'not-an-address', family: 4 }], [{ address: '93.184.216.34', family: 6 }]]) {
    const client = harness(undefined, addresses);
    await assert.rejects(client.read({ url: URL }), /address|public/i);
    assert.equal(client.connections.length, 0);
  }
});

test('HTTP redirects are explicit and every new connection is checked', async () => {
  const client = harness([
    { status: 302, headers: { location: '/docs/latest/tutorial/sandbox' } },
    { text: 'Sandbox details.' },
  ]);
  const result = (await client.read({ url: URL })).structuredContent;
  assert.equal(client.dnsRequests.length, 2);
  assert.equal(result.requestedUrl, URL);
  assert.equal(result.url, 'https://www.electronjs.org/docs/latest/tutorial/sandbox');
  assert.match(result.redirectNotice, /redirect/i);
  assert.equal(result.text, 'Sandbox details.');
});

test('redirects cannot escape into private URLs or private DNS resolutions', async () => {
  for (const location of ['https://127.0.0.1/data', 'https://tenant.sharepoint.com/data', 'http://example.com/data']) {
    const client = harness([{ status: 302, headers: { location } }]);
    await assert.rejects(client.read({ url: URL }), /private or unsupported URL/i);
    assert.equal(client.requests.length, 1);
  }
  const client = harness([
    { status: 302, headers: { location: 'https://private.example.com/data' } },
    { text: 'Must not connect.' },
  ], hostname => [{ address: hostname === 'private.example.com' ? '10.0.0.1' : '93.184.216.34', family: 4 }]);
  await assert.rejects(client.read({ url: URL }), /private|reserved|public/i);
  assert.equal(client.connections.length, 1);
});

test('redirect loops and missing redirect targets fail explicitly', async () => {
  const loop = harness([{ status: 302, headers: { location: URL } }]);
  await assert.rejects(loop.read({ url: URL }), /redirect/i);
  assert.equal(loop.requests.length, 6);
  await assert.rejects(harness([{ status: 302 }]).read({ url: URL }), /invalid.*redirect/i);
});

test('HTML conversion preserves public relative links but removes scripts and private links', async () => {
  const client = harness([{
    type: 'text/html',
    text: '<html><head><title>Title</title></head><body><nav>Navigation</nav><h1>Guide</h1>'
      + '<p>Verified details. <a href="../api/context-bridge">API</a><a href="/page_(reference)">Exact reference</a>'
      + '<a href="https://tenant.sharepoint.com/file">Private reference</a></p>'
      + '<script>window.secret = "hidden";</script><style>.hide { display:none }</style></body></html>',
  }]);
  const result = (await client.read({ url: URL })).structuredContent;
  assert.match(result.text, /Verified details/);
  assert.match(result.text, /https:\/\/www\.electronjs\.org\/docs\/latest\/api\/context-bridge/);
  assert.ok(result.references.some(reference => reference.url === 'https://www.electronjs.org/page_(reference)'));
  assert.doesNotMatch(result.text, /sharepoint|window\.secret|display:none|Navigation/);
});

test('declared text encodings are honored and malformed bytes do not silently become replacement characters', async () => {
  const encoded = harness([{ type: 'text/plain; charset=windows-1252', chunks: [Buffer.from([0x63, 0x61, 0x66, 0xe9])] }]);
  assert.equal((await encoded.read({ url: URL })).structuredContent.text, 'caf\u00e9');
  await assert.rejects(harness([{ chunks: [Buffer.from([0xff])] }]).read({ url: URL }), /encoded data.*valid/i);
  await assert.rejects(harness([{ type: 'text/plain; charset=not-an-encoding', text: 'data' }]).read({ url: URL }), /encoding.*not supported/i);
});

test('compressed text responses are decoded before applying the size limit', async () => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
    const client = harness([{ chunks: [compress('Original source text.')], headers: { 'content-encoding': encoding } }]);
    assert.equal((await client.read({ url: URL })).structuredContent.text, 'Original source text.', encoding);
    const large = harness([{ chunks: [compress('x'.repeat(2_000_001))], headers: { 'content-encoding': encoding } }]);
    await assert.rejects(large.read({ url: URL }), /2 MB|too large|limit/i, encoding);
  }
});

test('binary, missing-type, unknown-encoding, empty and oversized pages are explicit failures', async () => {
  for (const page of [
    { type: 'application/pdf', text: 'binary' },
    { headers: { 'content-type': '' }, text: 'unknown' },
    { headers: { 'content-encoding': 'custom' }, text: 'encoded' },
    { text: '   ' },
    { text: 'x'.repeat(2_000_001) },
  ]) await assert.rejects(harness([page]).read({ url: URL }), /type|encoding|empty|readable|2 MB|limit/i);
});

test('page windows expose exact continuation offsets rather than silently omitting text', async () => {
  const client = harness([{ text: '0123456789abcdef' }]);
  const first = (await client.read({ url: URL, max_length: 5 })).structuredContent;
  assert.equal(first.text, '01234');
  assert.equal(first.truncated, true);
  assert.equal(first.nextStartIndex, 5);
  assert.equal(first.totalCharacters, 16);
  assert.match(first.notice, /continu|start/i);
  const next = (await client.read({ url: URL, max_length: 20, start_index: first.nextStartIndex })).structuredContent;
  assert.equal(next.text, '56789abcdef');
  assert.equal(next.truncated, false);
  assert.equal(next.nextStartIndex, undefined);
  await assert.rejects(client.read({ url: URL, start_index: 16 }), /outside this page/i);
});

test('invalid page ranges do not initiate a request', async () => {
  const client = harness();
  for (const args of [{ start_index: -1 }, { start_index: 0.5 }, { start_index: '1' }, { max_length: 0 }, { max_length: 20001 }]) {
    await assert.rejects(client.read({ url: URL, ...args }), /range|offset|length|integer/i);
  }
  assert.equal(client.requests.length, 0);
});

test('HTTP errors preserve status and retry headers without substituting another page', async () => {
  const client = harness([{ status: 429, headers: { 'retry-after': '3600' } }]);
  await assert.rejects(client.read({ url: URL }), error => {
    assert.equal(error.code, 'PUBLIC_PAGE_HTTP_ERROR');
    assert.equal(error.statusCode, 429);
    assert.equal(error.headers.get('Retry-After'), '3600');
    return true;
  });
  assert.equal(client.requests.length, 1);
});

test('cancelling an in-progress page read aborts its stream', async () => {
  const stream = new Readable({ read() {} });
  const client = harness([{ stream }]);
  const controller = new AbortController();
  const pending = client.read({ url: URL }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('Cancelled by the user.'));
  await assert.rejects(pending, /Cancelled/);
  assert.equal(stream.destroyed, true);
});
