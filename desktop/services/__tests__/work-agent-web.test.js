'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicWebClient } = require('../work-agent-web');

const START = 1700000000000;
const QUESTION = { query: 'Find the official Electron context isolation documentation.' };
const RESULT = { content: [{ type: 'text', text: 'Retrieved research response.' }] };
const TOOL = {
  name: 'web_search', annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

function response(status, text, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => text };
}

function rpc(init, result = RESULT) {
  return response(200, JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result }));
}

function harness(fetchTool = (_url, init) => rpc(init), options = {}) {
  let clock = START;
  const delays = [];
  const retries = [];
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, request: JSON.parse(init.body) });
    const { method } = JSON.parse(init.body);
    if (method === 'initialize') return rpc(init, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (method === 'notifications/initialized') return response(202, '');
    if (method === 'tools/list') return rpc(init, { tools: [TOOL] });
    return fetchTool(url, init);
  };
  const client = createPublicWebClient({
    getToken: () => 'test-github-token',
    fetchImpl, now: () => clock, requestIntervalMs: 0,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); delays.push(ms); clock += ms; },
    ...options,
  });
  return { client, requests, delays, retries, now: () => clock, onRetry: event => retries.push(event) };
}

function transient() {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
}

test('the client authenticates only to the documented read-only endpoint and discovers the exact capability', async () => {
  const client = harness();
  const result = await client.client('web_search', { ...QUESTION, task: 'must not leave the app' });
  assert.deepEqual(result, RESULT);
  assert.deepEqual(client.requests.map(item => item.request.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  for (const { url, init } of client.requests) {
    assert.equal(url, 'https://api.githubcopilot.com/mcp/readonly');
    assert.equal(init.headers.Authorization, 'Bearer test-github-token');
    assert.equal(init.headers['X-MCP-Tools'], 'web_search');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.doesNotMatch(init.body, /must not leave/);
  }
  assert.deepEqual(client.requests.at(-1).request.params, { name: 'web_search', arguments: QUESTION });
  assert.deepEqual(client.requests.filter(item => item.request.id).map(item => item.request.id), [1, 2, 3]);
});

test('connection discovery is reused until the app credential changes', async () => {
  let token = 'first-token';
  const client = harness(undefined, { getToken: () => token });
  await client.client('web_search', QUESTION);
  await client.client('web_search', QUESTION);
  token = 'second-token';
  await client.client('web_search', QUESTION);
  assert.equal(client.requests.filter(item => item.request.method === 'initialize').length, 2);
  assert.equal(client.requests.at(-1).init.headers.Authorization, 'Bearer second-token');
  token = null;
  const count = client.requests.length;
  await assert.rejects(client.client('web_search', QUESTION), /Connect GitHub Copilot/);
  assert.equal(client.requests.length, count);
});

test('missing GitHub sign-in fails before networking and does not try Exa or a CLI credential', async () => {
  const client = harness(undefined, { getToken: () => null });
  await assert.rejects(client.client('web_search', QUESTION), /requires sign-in/);
  assert.equal(client.requests.length, 0);
});

test('negotiated protocol and MCP session headers are retained, with matching JSON-RPC IDs', async () => {
  const requests = [];
  const client = harness(undefined, { fetchImpl: async (_url, init) => {
    const message = JSON.parse(init.body);
    requests.push({ message, init });
    if (message.method === 'initialize') {
      const result = rpc(init, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
      result.headers.set('mcp-session-id', 'mcp-session');
      return result;
    }
    assert.equal(init.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(init.headers['Mcp-Session-Id'], 'mcp-session');
    if (message.method === 'notifications/initialized') return response(202, '');
    if (message.method === 'tools/list') return rpc(init, { tools: [TOOL] });
    return response(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`
      + `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: RESULT })}\n\n`);
  } });
  assert.deepEqual(await client.client('web_search', QUESTION), RESULT);
  assert.equal(requests.length, 4);
});

test('unsupported negotiation, absent tools and incompatible schemas fail without a fallback', async () => {
  for (const [initialized, tools, expected] of [
    [{ protocolVersion: '2099-01-01', capabilities: { tools: {} } }, [TOOL], /supported MCP/],
    [{ protocolVersion: '2025-03-26', capabilities: {} }, [TOOL], /supported MCP/],
    [null, [], /not available/],
    [null, [{ ...TOOL, annotations: { readOnlyHint: false } }], /unsupported tool contract/],
    [null, [{ ...TOOL, inputSchema: { ...TOOL.inputSchema, required: ['query', 'secret'] } }], /unsupported tool contract/],
    [null, [{ ...TOOL, inputSchema: { ...TOOL.inputSchema, properties: { query: { type: 'number' } } } }], /unsupported tool contract/],
  ]) {
    let calls = 0;
    const client = harness(undefined, { fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'initialize') return rpc(init, initialized || { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
      if (request.method === 'notifications/initialized') return response(202, '');
      if (request.method === 'tools/list') return rpc(init, { tools });
      calls++;
      return rpc(init);
    } });
    await assert.rejects(client.client('web_search', QUESTION), expected);
    assert.equal(calls, 0);
  }
});

test('paginated capability discovery follows the advertised cursor', async () => {
  let pages = 0;
  const client = harness(undefined, { fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') return rpc(init, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (request.method === 'notifications/initialized') return response(202, '');
    if (request.method === 'tools/list') {
      pages++;
      if (pages === 1) return rpc(init, { tools: [], nextCursor: 'next-page' });
      assert.equal(request.params.cursor, 'next-page');
      return rpc(init, { tools: [TOOL] });
    }
    return rpc(init);
  } });
  await client.client('web_search', QUESTION);
  assert.equal(pages, 2);
});

test('transient connection failures retry the identical request and preserve the model continuation above this layer', async () => {
  const requests = [];
  const client = harness(async (url, init) => {
    requests.push({ url, body: init.body });
    if (requests.length < 3) throw transient();
    return rpc(init);
  });
  assert.deepEqual(await client.client('web_search', QUESTION, { onRetry: client.onRetry }), RESULT);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(item => item.body)).size, 1);
  assert.deepEqual(client.delays, [1000, 2000]);
  assert.deepEqual(client.retries.map(item => item.attempt), [2, 3]);
});

test('short Retry-After cooldowns are honored rather than retried early', async () => {
  let requests = 0;
  const client = harness(async (_url, init) => ++requests === 1
    ? response(429, 'quota exceeded', { 'Retry-After': '2' }) : rpc(init));
  await client.client('web_search', QUESTION, { onRetry: client.onRetry });
  assert.equal(requests, 2);
  assert.deepEqual(client.delays, [2000]);
});

test('long service cooldowns fail immediately and survive a later request', async () => {
  let calls = 0;
  const client = harness(async () => { calls++; return response(429, 'quota exceeded', { 'Retry-After': '3600' }); });
  await assert.rejects(client.client('web_search', QUESTION), error => {
    assert.equal(error.code, 'COPILOT_WEB_RATE_LIMIT');
    assert.equal(error.retryAt, START + 3600000);
    assert.equal(error.attempts, 1);
    return true;
  });
  const count = client.requests.length;
  await assert.rejects(client.client('web_search', QUESTION), /rate-limited/);
  assert.equal(client.requests.length, count);
  assert.equal(calls, 1);
  assert.deepEqual(client.delays, []);
});

test('HTTP-date and reset timestamp headers control the retry time', async () => {
  for (const headers of [
    { 'Retry-After': new Date(START + 3000).toUTCString() },
    { 'Retry-After': '1', 'X-RateLimit-Reset': String((START + 3000) / 1000) },
    { 'X-RateLimit-Reset': String(START + 3000) },
  ]) {
    let calls = 0;
    const client = harness(async (_url, init) => ++calls === 1 ? response(429, 'limited', headers) : rpc(init));
    await client.client('web_search', QUESTION);
    assert.deepEqual(client.delays, [3000]);
  }
});

test('invalid retry timestamps fail without an early retry', async () => {
  const client = harness(async () => response(429, 'limited', { 'Retry-After': '1e100' }));
  await assert.rejects(client.client('web_search', QUESTION), /invalid retry time/);
  assert.equal(client.requests.filter(item => item.request.method === 'tools/call').length, 1);
});

test('HTTP 503 retries, but authentication, permissions and other HTTP errors do not', async () => {
  let calls = 0;
  const client = harness(async (_url, init) => ++calls === 1 ? response(503, 'upstream unavailable') : rpc(init));
  await client.client('web_search', QUESTION);
  assert.equal(calls, 2);
  for (const status of [400, 401, 403, 404, 413]) {
    let failures = 0;
    const rejected = harness(async () => { failures++; return response(status, 'denied'); });
    await assert.rejects(rejected.client('web_search', QUESTION), error => {
      assert.equal(error.code, 'COPILOT_WEB_HTTP_ERROR');
      assert.equal(error.statusCode, status);
      assert.equal(error.retryable, false);
      if (status === 401) assert.match(error.message, /Reconnect GitHub Copilot/);
      return true;
    });
    assert.equal(failures, 1);
    assert.deepEqual(rejected.delays, []);
  }
});

test('persistent connectivity errors preserve nested causes and stop after three attempts', async () => {
  let calls = 0;
  const cause = transient();
  const client = harness(async () => { calls++; throw cause; });
  await assert.rejects(client.client('web_search', QUESTION), error => {
    assert.equal(error.code, 'COPILOT_WEB_CONNECTION_ERROR');
    assert.equal(error.cause, cause);
    assert.match(error.message, /ECONNRESET/);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(calls, 3);
});

test('nested aggregate connection errors are retried only when every underlying code is transient', async () => {
  for (const secondCode of ['ETIMEDOUT', 'CERT_HAS_EXPIRED']) {
    let calls = 0;
    const client = harness(async (_url, init) => {
      calls++;
      if (calls > 1) return rpc(init);
      throw new TypeError('fetch failed', { cause: new AggregateError([
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        Object.assign(new Error(secondCode), { code: secondCode }),
      ]) });
    });
    if (secondCode === 'ETIMEDOUT') {
      await client.client('web_search', QUESTION);
      assert.equal(calls, 2);
    } else {
      await assert.rejects(client.client('web_search', QUESTION), /CERT_HAS_EXPIRED/);
      assert.equal(calls, 1);
    }
  }
});

test('cancelling an active HTTP request does not retry or retain the failed connection', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = harness(async (_url, init) => {
    calls++;
    if (calls > 1) return rpc(init);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      controller.abort(new Error('User stopped the active search.'));
    });
  });
  await assert.rejects(client.client('web_search', QUESTION, { signal: controller.signal }), /User stopped/);
  await client.client('web_search', QUESTION);
  assert.equal(calls, 2);
  assert.equal(client.requests.filter(item => item.request.method === 'initialize').length, 2);
  assert.deepEqual(client.delays, []);
});

test('request timeouts are bounded and preserve their explicit timeout error', async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const client = harness(async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }, { requestTimeoutMs: 10 });
    await assert.rejects(client.client('web_search', QUESTION), error => {
      assert.equal(error.code, 'COPILOT_WEB_CONNECTION_ERROR');
      assert.equal(error.attempts, 3);
      assert.match(error.message, /timed out/);
      return true;
    });
    assert.equal(calls, 3);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('certificate failures are not retried', async () => {
  let calls = 0;
  const client = harness(async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }) });
  });
  await assert.rejects(client.client('web_search', QUESTION), /CERT_HAS_EXPIRED/);
  assert.equal(calls, 1);
  assert.deepEqual(client.delays, []);
});

test('MCP errors, malformed data and unmatched IDs fail without transport retries', async () => {
  for (const makeResponse of [
    init => response(200, JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { message: 'policy denied' } })),
    init => rpc(init, { isError: true, content: [{ type: 'text', text: 'tool failed' }] }),
    () => response(200, 'invalid payload'),
    () => response(200, JSON.stringify({ jsonrpc: '2.0', id: -1, result: RESULT })),
  ]) {
    let calls = 0;
    const client = harness(async (_url, init) => { calls++; return makeResponse(init); });
    await assert.rejects(client.client('web_search', QUESTION), /policy denied|tool failed|invalid MCP|no result/);
    assert.equal(calls, 1);
    assert.deepEqual(client.delays, []);
  }
});

test('pacing is shared across requests and discoveries', async () => {
  const client = harness(undefined, { requestIntervalMs: 600 });
  await Promise.all([client.client('web_search', QUESTION), client.client('web_search', QUESTION)]);
  assert.deepEqual(client.delays, [600, 600, 600, 600]);
  assert.equal(client.requests.filter(item => item.request.method === 'initialize').length, 1);
});

test('cancelling queued work returns immediately without invoking it after the earlier request', async () => {
  let release;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const client = harness(async (_url, init) => {
    calls++;
    started();
    return new Promise(resolve => { release = () => resolve(rpc(init)); });
  });
  const first = client.client('web_search', QUESTION);
  await firstStarted;
  const controller = new AbortController();
  const second = client.client('web_search', QUESTION, { signal: controller.signal });
  controller.abort(new Error('Cancelled queued research.'));
  await assert.rejects(second, /Cancelled queued/);
  release();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('cancelling backoff prevents the next request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = harness(async () => { calls++; throw transient(); }, {
    sleep: async (_ms, signal) => {
      controller.abort(new Error('Cancelled during backoff.'));
      signal.throwIfAborted();
    },
  });
  await assert.rejects(client.client('web_search', QUESTION, { signal: controller.signal }), /Cancelled during backoff/);
  assert.equal(calls, 1);
});

test('public page reads do not request GitHub credentials or use the MCP service', async () => {
  const pages = [];
  const client = harness(undefined, {
    getToken: () => { throw new Error('Must not read GitHub authentication for a page.'); },
    readPage: async (args, options) => { pages.push({ args, options }); return { structuredContent: { url: args.url, text: 'Page.' } }; },
  });
  const args = { url: 'https://example.com/source', max_length: 18000, start_index: 10 };
  await client.client('web_fetch', args);
  assert.equal(client.requests.length, 0);
  assert.deepEqual(pages[0].args, args);
  assert.deepEqual(Object.keys(pages[0].options), ['signal']);
});

test('a page-origin cooldown neither impersonates nor blocks GitHub search', async () => {
  let pageCalls = 0;
  const client = harness(undefined, { readPage: async () => {
    pageCalls++;
    throw Object.assign(new Error('page quota'), {
      code: 'PUBLIC_PAGE_HTTP_ERROR', statusCode: 429, headers: new Headers({ 'Retry-After': '3600' }),
    });
  } });
  const page = { url: 'https://example.com/source' };
  await assert.rejects(client.client('web_fetch', page), error => {
    assert.equal(error.code, 'PUBLIC_WEB_RATE_LIMIT');
    assert.doesNotMatch(error.message, /GitHub|sign-in/);
    return true;
  });
  await client.client('web_search', QUESTION);
  await assert.rejects(client.client('web_fetch', page), /rate-limited/);
  assert.equal(pageCalls, 1);
});

test('page connection retries preserve the exact requested URL and range', async () => {
  const pages = [];
  const client = harness(undefined, { readPage: async args => {
    pages.push(args);
    if (pages.length === 1) throw transient();
    return { structuredContent: { url: args.url, text: 'Read source.' } };
  } });
  const args = { url: 'https://example.com/source', start_index: 100 };
  await client.client('web_fetch', args);
  assert.deepEqual(pages, [args, args]);
  assert.deepEqual(client.delays, [1000]);
});

test('unknown tools and unsafe search queries never reach a public service', async () => {
  const client = harness();
  await assert.rejects(client.client('web_search_exa', QUESTION), /Unsupported public web tool/);
  await assert.rejects(client.client('web_search', { query: 'Email person@example.com' }), /Public web queries cannot/);
  await assert.rejects(client.client('web_search', {}), /requires a public question/);
  assert.equal(client.requests.length, 0);
});
