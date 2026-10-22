'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const { EventEmitter } = require('node:events');
const agents = require('../agents');
const prompts = require('../agents/prompts');
const { createWorkAgentTools, normalizeBlockedSources } = require('../work-agent-tools');

const appIpcPath = path.join(__dirname, '..', '..', 'app-ipc.js');
const sourceUrl = 'https://www.electronjs.org/docs/latest/tutorial/context-isolation';
const searchResult = { structuredContent: {
  type: 'output_text',
  text: { value: 'Official research.', annotations: [{ url_citation: { title: 'Official documentation', url: sourceUrl } }] },
  bing_searches: [{ url: 'https://www.bing.com/search?q=official+documentation' }],
} };
const unusedDependencies = new Set([
  './msx-ipc', './acr-ipc', './capacity-ipc', './services/owned-accounts',
  './services/m365-ingest', './services/outlook-link', './services/meeting-transcript', './services/teams-chat-message',
  './services/customer-tasks', './services/meeting-tasks', './services/work-outputs',
  './services/secretary-scan', './services/email-search', './services/research-dossier', './services/signal-links',
  './services/workload-suggestion-dedup', './services/workload-concept-key',
  './services/customer-insights', './services/customer-relationship-graph',
  './services/html-render', './services/row-mappers', './services/safe-json', './services/intelligence',
  './services/stakeholder-influence', './services/stakeholder-influence-store',
]);

function harness({ signedIn = true, probeError, readPage = false, webTool, workiq, modelReplies } = {}) {
  const handlers = new Map();
  const progress = [];
  const modelCalls = [];
  const modelPrompts = [];
  const webCalls = [];
  const sender = Object.assign(new EventEmitter(), {
    id: 42, isDestroyed: () => false,
    send: (channel, event) => progress.push({ channel, ...event }),
  });
  const event = { sender, senderFrame: { url: 'http://localhost:5173' } };
  const stubs = {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { isPackaged: false } },
    './sqlite-ipc': { openDb: () => ({ prepare: sql => {
      if (/^SELECT 1 FROM (?:emails|meetings|teams_chats)\b/.test(sql)
        || /^SELECT 1 FROM active_(?:email|meeting|teams_chat)_customer_links\b/.test(sql)) return { get: () => undefined };
      if (sql.startsWith('SELECT tpid FROM tpid_config') || sql.includes('SELECT tpid, name AS term FROM customers')) return { all: () => [] };
      throw new Error('This test must not access other customer data.');
    } }) },
    './account-roster': { ...require('../../account-roster'), getEffectiveTpids: () => [] },
    './services/github-auth': { isSignedIn: () => signedIn },
    './services/copilot-provider': {
      probe: async () => probeError ? { ok: false, error: probeError } : { ok: true },
      getModelName: () => 'chosen-copilot-model',
      chat: async (_system, _user, options) => {
        modelCalls.push(options);
        modelPrompts.push({ system: _system, user: _user });
        if (modelReplies) {
          assert.ok(modelReplies[modelCalls.length - 1], 'The investigation must not continue after a fatal source failure.');
          return modelReplies[modelCalls.length - 1];
        }
        const tool = modelCalls.length === 1 ? 'web_search' : readPage && modelCalls.length === 2 ? 'web_read' : null;
        return tool ? {
          api: 'chat', content: '', finishReason: 'tool_calls',
          toolCalls: [{
            id: `call-${modelCalls.length}`, type: 'function',
            function: { name: tool, arguments: JSON.stringify(tool === 'web_search' ? { query: 'Official Electron documentation' } : { url: sourceUrl }) },
          }],
        } : { content: 'Verified recommendation.', model: 'chosen-copilot-model', finishReason: 'stop' };
      },
    },
    './services/model-request-scheduler': require('../model-request-scheduler'),
    './services/app-prefs': {},
    './services/identity-store': { getSavedName: () => '' },
    './services/workiq-client': { getWorkIqClient: () => workiq || {} },
    './services/workiq-auth': { ensureConnected: async () => {
      if (workiq) return { connected: true };
      throw new Error('This public test must not contact WorkIQ.');
    } },
    './services/work-agent-tools': { normalizeBlockedSources, createWorkAgentTools: options => createWorkAgentTools({
      ...options,
      webTool: async (...args) => {
        webCalls.push(args);
        return webTool ? webTool(...args) : searchResult;
      },
    }) },
    './services/agents': agents,
    './services/agents/prompts': prompts,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(appIpcPath, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(appIpcPath),
    require: name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (unusedDependencies.has(name)) return Object.freeze({});
      if (isBuiltin(name)) return require(name);
      throw new Error(`Unexpected IPC test dependency: ${name}`);
    },
    process: { env: {}, platform: process.platform, resourcesPath: path.dirname(appIpcPath) },
    URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    console: { ...console, log: () => {} },
  }, { filename: appIpcPath });
  module.exports.registerAppIpc();
  const payload = {
    requestId: 'ipc-search-verification', userName: 'Test user',
    task: { title: 'Prepare a preload bridge recommendation' },
    question: 'Use public official documentation.', history: [],
  };
  return {
    handlers, event, sender, progress, modelCalls, modelPrompts, webCalls,
    run: (overrides = {}) => handlers.get('se-work-agent-chat')(event, { ...payload, ...overrides }),
    cancel: () => handlers.get('se-work-agent-cancel')(event, { requestId: payload.requestId }),
  };
}

test('actual Work Agent IPC returns cited sources and the unchanged selected model and reasoning', async () => {
  const client = harness();
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.provider, 'github-copilot');
  assert.equal(result.meta.model, 'chosen-copilot-model');
  assert.equal(result.meta.reasoningEffort, 'high');
  assert.equal(result.meta.sources[0].url, sourceUrl);
  assert.ok(client.modelCalls.every(call => call.reasoningEffort === 'high'));
  assert.ok(client.progress.every(item => item.requestId === 'ipc-search-verification'));
  assert.ok(client.progress.some(item => item.phase === 'evidence' && item.sources[0].url === sourceUrl));
  assert.equal(client.sender.listenerCount('destroyed'), 0);
  assert.equal(client.cancel().cancelled, false);
});

test('actual IPC recovers an altered calendar ID through its exact returned reference, without reading the wrong ID', async () => {
  const id = 'AAMk-native-Event_ID=';
  const paths = [];
  const call = (n, path) => ({
    api: 'chat', content: '', finishReason: 'tool_calls',
    toolCalls: [{ id: `event-${n}`, type: 'function', function: { name: 'workiq_read', arguments: JSON.stringify({ path }) } }],
  });
  const client = harness({
    modelReplies: [
      call(1, '/me/calendarView?startDateTime=2026-09-23&endDateTime=2026-09-24&$select=id,subject,start,end'),
      call(2, '/me/events/AAMk-native%2FEvent_ID=?$select=id,subject,attendees'),
      call(3, '/me/events/event-1?$select=id,subject,attendees'),
      { content: 'Findings from the exact calendar event.', finishReason: 'stop' },
    ],
    workiq: { readTool: async (_name, args) => {
      const path = args.entityUrls[0];
      paths.push(path);
      const record = { id, subject: 'Alignment' };
      return { structuredContent: { results: [{ statusCode: 200, data: paths.length === 1 ? { value: [record] } : record }] } };
    } },
  });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.equal(paths.length, 2);
  assert.equal(paths[1], `/me/events/${encodeURIComponent(id)}?$select=id,subject,attendees`);
  assert.ok(client.modelCalls.every(call => call.reasoningEffort === 'high'));
  assert.ok(JSON.stringify(client.modelCalls[1].toolMessages).includes('eventReferences'));
  assert.match(JSON.stringify(client.modelCalls[2].toolMessages), /WORKIQ_EVENT_REFERENCE_UNKNOWN/);
  assert.equal(client.progress.filter(event => event.phase === 'retry').length, 1);
  assert.equal(client.progress.filter(event => event.recovered).length, 1);
  assert.equal(client.webCalls.length, 0);
});

for (const replacement of ['/me/calendarView?$select=id', '/me/events?$select=id', '/users/other/events/event-1']) {
  test(`event-reference recovery rejects a different source through IPC: ${replacement}`, async () => {
    let reads = 0;
    const client = harness({
      modelReplies: ['/me/events/altered-id', replacement].map((path, index) => ({
        api: 'chat', content: '', finishReason: 'tool_calls',
        toolCalls: [{ id: `invalid-${index}`, type: 'function', function: { name: 'workiq_read', arguments: JSON.stringify({ path }) } }],
      })),
      workiq: { readTool: async () => { reads++; throw new Error('No unverified event read may be sent.'); } },
    });
    await assert.rejects(client.run(), /cannot change the source scope/);
    assert.equal(reads, 0);
    assert.equal(client.progress.filter(event => event.phase === 'retry').length, 1);
    assert.ok(!client.progress.some(event => event.recovered || event.phase === 'complete'));
  });
}

test('event-reference IPC preserves a real source access denial and its exclusion', async () => {
  const paths = [];
  const client = harness({
    modelReplies: ['/me/events?$select=id', '/me/events/event-1?$select=id,body', '/me/events/event-1?$select=id,subject'].map((path, index) => ({
      api: 'chat', content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: `denied-${index}`, type: 'function', function: { name: 'workiq_read', arguments: JSON.stringify({ path }) } }],
    })).concat({ content: 'Partial findings: calendar metadata is available, but event details remain unread.', finishReason: 'stop' }),
    workiq: { readTool: async (_name, args) => {
      paths.push(args.entityUrls[0]);
      if (paths.length === 1) return { structuredContent: { results: [{ statusCode: 200, data: { value: [{ id: 'native-event-id' }] } }] } };
      throw Object.assign(new Error('Access denied'), { statusCode: 403, code: 'Forbidden' });
    } },
  });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'partial');
  assert.equal(paths.length, 2, 'later aliases and changed queries do not retry a denied event');
  assert.equal(paths[1], '/me/events/native-event-id?$select=id,body');
  assert.equal(result.meta.blockedSources.length, 1);
  assert.match(result.meta.blockedSources[0].resource, /^\/me\/events\/native-event-id/);
  assert.ok(!client.progress.some(event => event.recovered || event.phase === 'retry' || event.phase === 'complete'));
});

for (const code of ['COPILOT_WEB_RATE_LIMIT', 'COPILOT_WEB_HTTP_ERROR', 'PUBLIC_WEB_RATE_LIMIT', 'PUBLIC_WEB_HTTP_ERROR']) {
  test(`actual Work Agent IPC preserves ${code} cooldowns for the renderer`, async () => {
    const retryAt = Date.now() + 300000;
    const client = harness({
      readPage: code.startsWith('PUBLIC_WEB'),
      webTool: async name => {
        if (code.startsWith('PUBLIC_WEB') && name === 'web_search') return searchResult;
        throw Object.assign(new Error('Upstream cooldown; wait before retrying.'), { code, retryAt });
      },
    });
    const result = await client.run();
    assert.equal(result.ok, false);
    assert.equal(result.retryAt, retryAt);
    assert.match(result.error, /Upstream cooldown/);
    assert.ok(!client.progress.some(item => item.phase === 'complete'));
    assert.equal(client.sender.listenerCount('destroyed'), 0);
  });
}

test('actual Work Agent IPC fails clearly when Copilot is absent or rejected, without another provider', async () => {
  for (const options of [{ signedIn: false }, { probeError: 'Account policy denied access.' }]) {
    const client = harness(options);
    await assert.rejects(client.run(), /requires GitHub Copilot|Account policy denied/);
    assert.equal(client.modelCalls.length, 0);
    assert.equal(client.webCalls.length, 0);
    assert.equal(client.sender.listenerCount('destroyed'), 0);
  }
});

test('actual Work Agent IPC returns uncited research with a visible note instead of failing', async () => {
  const client = harness({ webTool: async () => ({ structuredContent: {
    type: 'output_text', text: { value: `A generated claim mentioning ${sourceUrl}.`, annotations: [] }, bing_searches: [],
  } }) });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.reply, 'Verified recommendation.');
  assert.equal(result.meta.sources.length, 0, 'An uncited prose URL is not a returned citation.');
  assert.equal(result.meta.researchWarnings.length, 1);
  assert.match(result.meta.researchWarnings[0], /no source citations.*uncited research/);
  assert.equal(result.meta.reasoningEffort, 'high');
  assert.equal(client.modelCalls.length, 2);
  assert.equal(client.webCalls.length, 1);
  assert.ok(client.progress.some(item => item.phase === 'evidence' && item.warning === result.meta.researchWarnings[0]));
  assert.ok(client.progress.some(item => item.phase === 'complete'));
  assert.ok(!client.progress.some(item => ['retry', 'error', 'empty'].includes(item.phase)));
  assert.equal(client.sender.listenerCount('destroyed'), 0);
});

test('actual IPC retains supplied citations without Bing metadata and does not add an uncited warning', async () => {
  const client = harness({ webTool: async () => ({ structuredContent: {
    type: 'output_text', text: { value: 'Research with a source.', annotations: [{ url_citation: { title: 'Source', url: sourceUrl } }] },
  } }) });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.meta.sources[0].url, sourceUrl);
  assert.equal(result.meta.researchWarnings.length, 0);
});

test('actual IPC deduplicates uncited research notes without blocking multiple public searches', async () => {
  const client = harness({
    modelReplies: [...[1, 2].map(index => ({
      api: 'chat', content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: `search-${index}`, type: 'function', function: {
        name: 'web_search', arguments: JSON.stringify({ query: `Public technical question ${index}` }),
      } }],
    })), { content: 'Recommendation using the returned uncited summaries.', finishReason: 'stop' }],
    webTool: async () => ({ structuredContent: { type: 'output_text', text: { value: 'Useful uncited research.' } } }),
  });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.meta.researchWarnings.length, 1);
  assert.equal(client.progress.filter(item => item.warning).length, 2);
  assert.equal(client.webCalls.length, 2);
});

test('optional citations do not swallow real public-search service errors through IPC', async () => {
  for (const response of [
    { isError: true, content: [{ type: 'text', text: 'Permission denied by search policy.' }] },
    { structuredContent: { type: 'output_text', text: { value: '' } } },
    { structuredContent: { unexpected: 'Unsupported response' } },
  ]) {
    const client = harness({ webTool: async () => response });
    await assert.rejects(client.run(), /Work Agent failed.*(?:Permission denied|invalid or empty)/);
    assert.equal(client.modelCalls.length, 1);
    assert.ok(!client.progress.some(item => item.phase === 'complete'));
  }
});

test('actual IPC returns grounded partial findings through a linked-chat denial without a permission retry', async () => {
  const sourceUrl = 'https://teams.microsoft.com/l/chat/19:blocked@thread.v2/conversations';
  const resource = '/chats/19%3Ablocked%40thread.v2/messages?$select=id,body&$top=50';
  const reads = [];
  const client = harness({
    modelReplies: [...[
      ['workiq_read_email', { messageId: null }],
      ['workiq_search', { query: 'The private incident update', scope: 'm365' }],
      ['workiq_read', { path: resource }],
    ].map(([name, args], index) => ({
      api: 'chat', content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    })), { content: 'The accessible email confirms an update is needed. The ETA remains unverified.\n\nDraft:\nCould you confirm the next update time?', model: 'chosen-copilot-model', finishReason: 'stop' }],
    workiq: { readTool: async (name, args) => {
      reads.push({ name, args });
      if (name === 'fetch' && args.entityUrls[0].startsWith('/me/messages/source-email')) return { structuredContent: { results: [{
        statusCode: 200, data: {
          id: 'source-email', subject: 'Investigation update', webLink: 'https://outlook.office.com/mail/item/source-email',
          body: { contentType: 'text', content: 'Please get a timeframe for the next update.' },
        },
      }] } };
      if (name === 'retrieve') return { structuredContent: { markdown: `Linked chat: ${sourceUrl}` } };
      throw Object.assign(new Error('WorkIQ fetch failed (HTTP 403): Forbidden: InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden', resource });
    } },
  });
  const result = await client.run({ task: { title: 'Obtain investigation update ETA', sourceMessageId: 'source-email' }, question: '' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'partial');
  assert.match(result.reply, /ETA remains unverified/);
  assert.match(result.reply, /Draft:/);
  assert.equal(result.meta.blockedSources[0].url, sourceUrl);
  assert.equal(result.meta.blockedSources[0].resource, resource);
  assert.equal(result.meta.blockedSources[0].status, 403);
  assert.equal(result.meta.blockedSources[0].code, 'Forbidden');
  assert.deepEqual(Array.from(result.meta.sources, source => source.url), ['https://outlook.office.com/mail/item/source-email']);
  assert.equal(reads.length, 3);
  assert.equal(client.modelCalls.length, 4);
  assert.ok(client.modelCalls.every(options => options.reasoningEffort === 'high'));
  assert.match(client.modelPrompts.at(-1).system, /Source access is incomplete/);
  assert.equal(client.webCalls.length, 0, 'public research must not substitute for the blocked chat');
  assert.equal(client.progress.at(-1).phase, 'partial');
  assert.ok(!client.progress.some(item => ['complete', 'retry'].includes(item.phase)));
  assert.equal(client.sender.listenerCount('destroyed'), 0);
});

test('actual IPC resolves a not-found SMTP user without dropping research or consuming model recovery', async () => {
  const id = '47a84b48-4a35-4a15-8ddb-c71eea076242';
  const original = '/users/first.last@contoso.com?$select=id,displayName,jobTitle';
  const reads = [];
  const client = harness({
    modelReplies: [
      { api: 'chat', content: '', finishReason: 'tool_calls', toolCalls: [{
        id: 'original-evidence', type: 'function',
        function: { name: 'workiq_search', arguments: '{"query":"Internal alignment decision","scope":"m365"}' },
      }] },
      { api: 'chat', content: '', finishReason: 'tool_calls', toolCalls: [{
        id: 'read-person', type: 'function',
        function: { name: 'workiq_read', arguments: JSON.stringify({ path: original }) },
      }] },
      { content: 'The retrieved decision and directory record support this alignment proposal.', finishReason: 'stop' },
    ],
    workiq: { readTool: async (name, args) => {
      reads.push({ name, args });
      if (name === 'retrieve') return { structuredContent: { markdown: 'The earlier alignment decision.' } };
      const path = args.entityUrls[0];
      if (path === original) throw Object.assign(new Error('Resource not found'), { statusCode: 404, code: 'Request_ResourceNotFound', resource: path });
      return { structuredContent: { results: [{ statusCode: 200, data: path.startsWith('/users?')
        ? { value: [{ id, mail: 'first.last@contoso.com', userPrincipalName: 'flast@contoso.com' }] }
        : { id, displayName: 'Verified person', jobTitle: 'Architect' },
      }] } };
    } },
  });
  const result = await client.run({ question: 'Investigate the alignment decision using work sources.' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.equal(reads.length, 4);
  assert.equal(reads[3].args.entityUrls[0], `/users/${id}?$select=id,displayName,jobTitle`);
  assert.equal(client.modelCalls.length, 3);
  assert.ok(client.modelCalls.every(options => options.reasoningEffort === 'high'));
  const messages = JSON.stringify(client.modelCalls.at(-1).toolMessages);
  assert.match(messages, /earlier alignment decision/);
  assert.match(messages, /Verified person/);
  assert.equal(client.progress.filter(event => event.phase === 'resolve').length, 2);
  assert.equal(client.progress.at(-1).phase, 'complete');
  assert.ok(!client.progress.some(event => ['retry', 'error'].includes(event.phase)));
  assert.equal(client.webCalls.length, 0);
  assert.equal(client.sender.listenerCount('destroyed'), 0);
});

test('actual IPC reports a recovered WorkIQ retry before continuing to a grounded solution', async () => {
  const client = harness({
    modelReplies: [{
      api: 'chat', content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'search', type: 'function', function: {
        name: 'workiq_search', arguments: '{"query":"Internal alignment decisions","scope":"m365"}',
      } }],
    }, { content: 'Proposal based on the returned alignment discussion.', finishReason: 'stop' }],
    workiq: { readTool: async (name, args, _timeout, _signal, onRetry) => {
      assert.equal(name, 'retrieve');
      assert.equal(args.strategy, 'grounding');
      onRetry({ attempt: 2, attempts: 3, error: "WorkIQ retrieve failed: An error occurred invoking 'retrieve'." });
      onRetry({ attempt: 3, attempts: 3, error: "WorkIQ retrieve failed: An error occurred invoking 'retrieve'." });
      return { structuredContent: { markdown: 'Dated alignment discussion from work sources.' } };
    } },
  });
  const result = await client.run();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(client.progress.map(event => event.phase),
    ['reasoning', 'tool', 'retry', 'retry', 'recovered', 'evidence', 'reasoning', 'complete']);
  const recovered = client.progress.find(event => event.recovered);
  assert.match(recovered.label, /Microsoft 365.*recovered on attempt 3\/3/);
  assert.equal(recovered.requestId, 'ipc-search-verification');
  assert.equal(client.modelCalls.length, 2, 'transport recovery must not consume a model refinement turn');
  assert.ok(client.modelCalls.every(call => call.reasoningEffort === 'high'));
  assert.equal(client.webCalls.length, 0);
});

test('actual IPC cannot present a directory lookup as successful evidence when identity is unresolved', async () => {
  for (const matches of [[], [{ id: 'one', mail: 'first.last@contoso.com' }, { id: 'two', mail: 'first.last@contoso.com' }]]) {
    let reads = 0;
    const client = harness({
      modelReplies: [{
        api: 'chat', content: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'read-person', type: 'function', function: {
          name: 'workiq_read', arguments: '{"path":"/users/first.last@contoso.com?$select=id"}',
        } }],
      }],
      workiq: { readTool: async () => {
        if (++reads === 1) throw Object.assign(new Error('Resource not found'), { statusCode: 404, code: 'Request_ResourceNotFound' });
        return { structuredContent: { results: [{ statusCode: 200, data: { value: matches } }] } };
      } },
    });
    await assert.rejects(client.run(), /no matching user|did not identify a unique user/);
    assert.equal(reads, 2);
    assert.equal(client.modelCalls.length, 1);
    assert.ok(!client.progress.some(event => ['evidence', 'complete', 'partial'].includes(event.phase)));
    assert.equal(client.sender.listenerCount('destroyed'), 0);
  }
});

test('actual IPC retains access exclusions in follow-up edits and returns no invented source reads', async () => {
  const blockedSources = normalizeBlockedSources([{ status: 403, resource: '/chats/private/messages', code: 'Forbidden' }]);
  const client = harness({ modelReplies: [{ content: 'Draft:\nCould you confirm the next investigation update?', finishReason: 'stop' }] });
  const result = await client.run({
    question: 'Make the draft shorter.', blockedSources,
    history: [{ role: 'assistant', content: 'Partial findings: no ETA was confirmed.' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.meta.blockedSources, blockedSources);
  assert.match(client.modelPrompts[0].system, /Source access is incomplete/);
  assert.equal(client.webCalls.length, 0);
  assert.equal(client.progress.at(-1).phase, 'partial');
});

test('actual IPC fails explicitly when only denied sources were consulted', async () => {
  const client = harness({
    modelReplies: [{
      api: 'chat', content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'denied', type: 'function', function: { name: 'workiq_read', arguments: '{"path":"/chats/private/messages"}' } }],
    }, { content: 'An unsupported answer.', finishReason: 'stop' }],
    workiq: { readTool: async () => { throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' }); } },
  });
  const result = await client.run();
  assert.equal(result.ok, false);
  assert.equal(result.reply, undefined);
  assert.equal(result.blockedSource.status, 403);
  assert.match(result.error, /no accessible source evidence/);
  assert.ok(!client.progress.some(item => ['complete', 'partial'].includes(item.phase)));
  assert.equal(client.sender.listenerCount('destroyed'), 0);
});

test('actual Work Agent IPC cancellation aborts research and removes the active request', async () => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const client = harness({ webTool: async (_name, _args, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const running = client.run();
  await startedPromise;
  assert.equal(client.cancel().cancelled, true);
  await assert.rejects(running, /Investigation stopped by the user/);
  assert.equal(client.modelCalls.length, 1);
  assert.equal(client.cancel().cancelled, false);
  assert.equal(client.sender.listenerCount('destroyed'), 0);
});
