'use strict';

const { readPublicWebPage, publicSourceUrl } = require('./public-web-page');

const WEB_ENDPOINT = 'https://api.githubcopilot.com/mcp/readonly';
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
const CONNECTION_ERRORS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withCancellation(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function retryDelay(response, now, backoff) {
  const header = response.headers?.get('Retry-After');
  let delay = backoff;
  if (header != null && header.trim()) {
    const seconds = Number(header);
    const date = Date.parse(header);
    if (Number.isFinite(seconds) && seconds >= 0) delay = seconds * 1000;
    else if (!Number.isFinite(seconds) && Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  const reset = Number(response.headers?.get('X-RateLimit-Reset'));
  const resetAt = reset > 1e12 ? reset : reset * 1000;
  return Math.max(delay, Number.isFinite(resetAt) ? resetAt - now : 0, 0);
}

function httpError(response, text, now, backoff, label, prefix) {
  let detail = text;
  try { detail = String(JSON.parse(text)?.error?.message || text); } catch { /* HTTP errors can be plain text. */ }
  const delayMs = retryDelay(response, now, backoff);
  const retryAt = now + delayMs;
  const limited = response.status === 429;
  const retryable = limited || [408, 500, 502, 503, 504].includes(response.status);
  if (!Number.isFinite(new Date(retryAt).getTime())) {
    throw new Error(`${label} failed (HTTP ${response.status}) with an invalid retry time. No early retry was attempted.`);
  }
  const retryMessage = retryable ? ` Retry after ${new Date(retryAt).toISOString()}.` : '';
  const error = new Error(limited
    ? `${label} is rate-limited (HTTP 429).${retryMessage} ${detail.slice(0, 300)}`
    : `${label} failed (HTTP ${response.status}).${retryMessage} ${detail.slice(0, 300)}${prefix === 'COPILOT_WEB' && response.status === 401 ? ' Reconnect GitHub Copilot in Settings.' : ''}`);
  return Object.assign(error, {
    code: `${prefix}_${limited ? 'RATE_LIMIT' : 'HTTP_ERROR'}`,
    statusCode: response.status,
    retryable,
    delayMs,
    ...(retryable ? { retryAt } : {}),
  });
}

function connectionError(cause, timedOut, label, prefix) {
  const codes = new Set();
  const collect = (error, depth = 0) => {
    if (!error || depth > 4) return;
    if (error.code) codes.add(error.code);
    collect(error.cause, depth + 1);
    if (Array.isArray(error.errors)) for (const nested of error.errors) collect(nested, depth + 1);
  };
  collect(cause);
  const error = new Error(timedOut
    ? `${label} timed out.`
    : `${label} failed: ${cause.message}${codes.size ? ` (${[...codes].join(', ')})` : ''}`, { cause });
  return Object.assign(error, {
    code: `${prefix}_CONNECTION_ERROR`,
    retryable: timedOut || (codes.size > 0 && [...codes].every(code => CONNECTION_ERRORS.has(code))),
  });
}

function parseResult(text, id) {
  let message;
  try {
    const frames = text.trimStart().startsWith('{')
      ? [JSON.parse(text)]
      : text.split(/\r?\n\r?\n/).map((frame) => frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
        .filter(Boolean).map((data) => JSON.parse(data));
    message = frames.find((frame) => frame.id === id && (frame.result || frame.error));
  } catch {
    throw new Error('GitHub Copilot web search returned an invalid MCP response.');
  }
  if (message?.error) throw new Error(`GitHub Copilot web search failed: ${message.error.message || 'MCP request rejected.'}`);
  if (!message?.result) throw new Error('GitHub Copilot web search returned no result.');
  if (message.result.isError) {
    const detail = (message.result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    throw new Error(`GitHub Copilot web search failed: ${detail || 'The search tool returned an error.'}`);
  }
  return message.result;
}

function createPublicWebClient({
  fetchImpl = global.fetch, now = Date.now, sleep = abortableDelay,
  getToken = () => require('./github-auth').getToken(),
  readPage = readPublicWebPage,
  requestIntervalMs = 600, requestTimeoutMs = 90000, maxAttempts = 3, maxRetryDelayMs = 60000,
} = {}) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let nextId = 0;
  let connection = null;
  const cooldowns = new Map();

  async function withRetry(operation, { signal, onRetry }, scope, label, prefix) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const cooldown = cooldowns.get(scope);
      if (cooldown?.retryAt > now()) {
        const waitMs = cooldown.retryAt - now();
        if (waitMs > maxRetryDelayMs) throw cooldown;
        onRetry?.({ attempt, attempts: maxAttempts, delayMs: waitMs, error: cooldown.message });
        await sleep(waitMs, signal);
      }
      const pacingDelay = nextRequestAt - now();
      if (pacingDelay > 0) await sleep(pacingDelay, signal);
      signal?.throwIfAborted();
      nextRequestAt = now() + requestIntervalMs;
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      let error;
      try {
        const result = await operation(signal ? AbortSignal.any([signal, timeout]) : timeout);
        signal?.throwIfAborted();
        return result;
      } catch (cause) {
        signal?.throwIfAborted();
        error = ['COPILOT_MCP_HTTP_ERROR', 'PUBLIC_PAGE_HTTP_ERROR'].includes(cause.code)
          ? httpError({ status: cause.statusCode, headers: cause.headers }, cause.message, now(), 1000 * (2 ** (attempt - 1)), label, prefix)
          : connectionError(cause, timeout.aborted, label, prefix);
      }
      const backoff = 1000 * (2 ** (attempt - 1));
      if (error.retryAt) cooldowns.set(scope, error);
      error.attempts = attempt;
      const delayMs = error.delayMs ?? backoff;
      if (!error.retryable || attempt >= maxAttempts || delayMs > maxRetryDelayMs) throw error;
      onRetry?.({ attempt: attempt + 1, attempts: maxAttempts, delayMs, error: error.message });
      await sleep(delayMs, signal);
    }
    throw new Error(`${label} exhausted its request attempts.`);
  }

  async function mcp(state, method, params, options, notification = false) {
    const id = notification ? undefined : ++nextId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const text = await withRetry(async (signal) => {
      const response = await fetchImpl(WEB_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${state.token}`,
          'User-Agent': 'SE-Assist/2.1.0',
          'X-MCP-Tools': 'web_search',
          ...(state.protocolVersion ? { 'MCP-Protocol-Version': state.protocolVersion } : {}),
          ...(state.sessionId ? { 'Mcp-Session-Id': state.sessionId } : {}),
        },
        credentials: 'omit', redirect: 'error', body, signal,
      });
      const content = await response.text();
      if (!response.ok) throw Object.assign(new Error(content), {
        code: 'COPILOT_MCP_HTTP_ERROR', statusCode: response.status, headers: response.headers,
      });
      const sessionId = response.headers?.get('mcp-session-id');
      if (sessionId) state.sessionId = sessionId;
      return content;
    }, options, WEB_ENDPOINT, 'GitHub Copilot web search', 'COPILOT_WEB');
    return notification ? undefined : parseResult(text, id);
  }

  async function connect(token, options) {
    const state = { token };
    const initialized = await mcp(state, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'se-assist', version: '2.1.0' },
    }, options);
    if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(initialized.protocolVersion) || !initialized.capabilities?.tools) {
      throw new Error('GitHub Copilot web search did not negotiate a supported MCP tools connection.');
    }
    state.protocolVersion = initialized.protocolVersion;
    await mcp(state, 'notifications/initialized', {}, options, true);
    let cursor;
    const seen = new Set();
    do {
      const listing = await mcp(state, 'tools/list', cursor ? { cursor } : {}, options);
      if (!Array.isArray(listing.tools)) throw new Error('GitHub Copilot returned an invalid web-search tool catalog.');
      const tool = listing.tools.find(item => item.name === 'web_search');
      if (tool) {
        if (tool.annotations?.readOnlyHint !== true || tool.inputSchema?.type !== 'object'
          || tool.inputSchema.properties?.query?.type !== 'string'
          || !Array.isArray(tool.inputSchema.required) || !tool.inputSchema.required.includes('query')
          || tool.inputSchema.required.some(field => field !== 'query')) {
          throw new Error('GitHub Copilot web search has an unsupported tool contract. No alternative service was used.');
        }
        return state;
      }
      cursor = listing.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || seen.has(cursor) || seen.size >= 20)) {
        throw new Error('GitHub Copilot returned invalid web-search catalog pagination.');
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error('GitHub Copilot web search is not available for this account or policy. The service did not advertise web_search; no alternative provider was used.');
  }

  async function execute(name, args, options) {
    options.signal?.throwIfAborted();
    if (name === 'web_fetch') {
      const url = publicSourceUrl(args?.url);
      if (!url) throw new Error('Read only a public HTTPS source URL.');
      return withRetry(signal => readPage(args, { signal }), options, new URL(url).origin, 'Public page read', 'PUBLIC_WEB');
    }
    if (typeof args?.query !== 'string' || !args.query.trim() || args.query.length > 1000) {
      throw new Error('GitHub Copilot web search requires a public question of 1-1000 characters.');
    }
    assertPublicQuery(args.query);
    const token = await getToken();
    if (!token) throw new Error('GitHub Copilot web search requires sign-in. Use "Connect GitHub Copilot" in Settings.');
    try {
      if (connection?.token !== token) connection = await connect(token, options);
      return await mcp(connection, 'tools/call', { name: 'web_search', arguments: { query: args.query } }, options);
    } catch (error) {
      connection = null;
      throw error;
    }
  }

  return function callPublicWebTool(name, args, options = {}) {
    if (!WEB_TOOL_NAMES.has(name)) return Promise.reject(new Error(`Unsupported public web tool: ${name}.`));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const request = queue.then(() => execute(name, args, options));
    // Release the shared gate after a failure; the caller still receives that failure.
    queue = request.catch(() => {});
    return withCancellation(request, options.signal);
  };
}

// Share connection discovery, pacing and service cooldowns across investigations.
const callPublicWebTool = createPublicWebClient();

function assertPublicQuery(query, privateTerms = []) {
  if (/https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(query)
    || /\b(?:bearer\s+\S+|gh[pousr]_[\w]+|sk-[\w-]{8,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(query)) {
    throw new Error('Public web queries cannot include email addresses, record IDs, links or credentials. Use generic product or technical terms.');
  }
  const normalized = query.toLowerCase().replace(/\s+/g, ' ');
  for (const term of privateTerms) {
    const value = String(term || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (value.length >= 4 && normalized.includes(value)) {
      throw new Error('The public web query contains task-specific account, sender or email details. Use generic product or technical terms instead.');
    }
  }
}

module.exports = { callPublicWebTool, createPublicWebClient, assertPublicQuery };
