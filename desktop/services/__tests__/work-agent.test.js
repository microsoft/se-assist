'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRuntime } = require('../agents/runtime');
const { createWorkAgentTools, normalizeEvidence, normalizeCopilotSearch, normalizeBlockedSources } = require('../work-agent-tools');
const { createPublicWebClient } = require('../work-agent-web');

const source = { title: 'Official documentation', url: 'https://www.electronjs.org/docs/latest/tutorial/context-isolation' };
function copilotSearchResult({ sources = [source], text = 'Cited public research.', searches = [{ url: 'https://www.bing.com/search?q=official+documentation', text: 'official documentation' }] } = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({
    type: 'output_text',
    text: { value: text, annotations: sources.map(citation => ({ url_citation: citation })) },
    bing_searches: searches,
  }) }] };
}
const evidence = { text: 'Verified source content.', sources: [source] };
const toolCall = (id = 'call-1', name = 'search', args = '{"query":"documentation"}') => ({
  id, type: 'function', function: { name, arguments: args },
});
const toolReply = (calls = [toolCall()]) => ({ api: 'chat', content: '', toolCalls: calls, finishReason: 'tool_calls' });
const answer = { content: 'Grounded answer', finishReason: 'stop', model: 'selected-model' };
const transientError = () => Object.assign(new Error("WorkIQ retrieve failed: An error occurred invoking 'retrieve'. WorkIQ did not recover after 3 attempts."), {
  code: 'WORKIQ_TRANSIENT_TOOL_FAILURE', tool: 'retrieve', attempts: 3,
});

function investigation(responses, { execute = async () => evidence, maxRounds = 3, maxToolRecoveries = 1, allowPartialResults = false, extraTools = {} } = {}) {
  const calls = [];
  const systemMessages = [];
  const events = [];
  const toolInputs = [];
  const tools = {
    search: {
      label: 'Searching',
      isRecoverableError: (error) => error.code === 'WORKIQ_TRANSIENT_TOOL_FAILURE',
      getRecoveryKey: ({ scope }) => scope,
      recoveryInstructions: 'Refine the same search; do not substitute other sources.',
      definition: { type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
      execute: async (args) => { toolInputs.push(args); return execute(args); },
    },
    ...extraTools,
  };
  const runtime = createAgentRuntime({
    provider: { chat: async (system, _user, options) => {
      systemMessages.push(system);
      const { signal, ...recordable } = options;
      calls.push({ ...structuredClone(recordable), signal });
      const response = responses[calls.length - 1];
      return typeof response === 'function' ? response() : response;
    } },
    agents: [{
      id: 'investigator', name: 'Work Agent', tools: Object.keys(tools),
      model: { reasoningEffort: 'high', maxTokens: 6000 },
      toolLoop: { maxRounds, maxToolRecoveries, allowPartialResults },
      render: () => ({ systemMessage: 'Investigate', userMessage: 'Task' }),
    }],
  });
  return {
    calls, events, toolInputs, systemMessages,
    run: (deps = {}) => runtime.run('investigator', { deps: { tools, requireTools: true, onProgress: (event) => events.push(event), ...deps } }),
  };
}

test('tool runtime researches before answering, reports sources, and retains Chat tool context', async () => {
  const run = investigation([toolReply(), answer]);
  const result = await run.run();
  assert.equal(result.content, answer.content);
  assert.equal(result.model, 'selected-model');
  assert.deepEqual(run.toolInputs, [{ query: 'documentation' }]);
  assert.equal(run.calls[0].toolChoice, 'required');
  assert.equal(run.calls[1].toolChoice, 'auto');
  assert.equal(run.calls[1].reasoningEffort, 'high');
  assert.deepEqual(run.calls[1].toolMessages, [
    { role: 'assistant', content: null, tool_calls: [toolCall()] },
    { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(evidence) },
  ]);
  assert.deepEqual(run.events.map((event) => event.phase), ['reasoning', 'tool', 'evidence', 'reasoning', 'complete']);
  assert.deepEqual(run.events[2].sources, [source]);
});

test('tool runtime carries native Responses function outputs and reasoning forward', async () => {
  const responseInput = [{ role: 'user', content: 'Task' }];
  const responseOutput = [
    { type: 'reasoning', encrypted_content: 'opaque-test-value' },
    { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"documentation"}' },
  ];
  const run = investigation([{ ...toolReply(), api: 'responses', responseInput, responseOutput }, answer]);
  await run.run();
  assert.deepEqual(run.calls[1].responseInput, [
    ...responseInput, ...responseOutput,
    { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify(evidence) },
  ]);
  assert.deepEqual(run.calls[1].toolMessages, []);
});

test('first investigation cannot claim success without a source; follow-up editing can', async () => {
  await assert.rejects(investigation([answer]).run(), /without consulting a source/);
  const followup = await investigation([answer]).run({ requireTools: false });
  assert.equal(followup.content, answer.content);
});

for (const [label, response, expected] of [
  ['undeclared tool', toolReply([toolCall('call-1', 'send_mail')]), /unavailable tool/],
  ['missing ID', toolReply([toolCall('')]), /invalid or duplicate tool call/],
  ['invalid JSON', toolReply([toolCall('call-1', 'search', '{')]), /invalid arguments/],
  ['null arguments', toolReply([toolCall('call-1', 'search', 'null')]), /Invalid search arguments/],
  ['array arguments', toolReply([toolCall('call-1', 'search', '[]')]), /Invalid search arguments/],
  ['unexpected arguments', toolReply([toolCall('call-1', 'search', '{"query":"x","send":true}')]), /unexpected fields/],
  ['truncated reply', { ...answer, finishReason: 'length' }, /response budget/],
  ['content-filtered reply', { ...answer, finishReason: 'content_filter' }, /did not finish/],
  ['incomplete reply', { ...answer, finishReason: 'incomplete' }, /did not finish/],
  ['broken continuation', { ...toolReply(), api: 'responses' }, /invalid Responses continuation/],
]) {
  test(`tool runtime rejects ${label} before treating it as completed work`, async () => {
    const run = investigation([response]);
    await assert.rejects(run.run(), expected);
    assert.equal(run.toolInputs.length, 0);
    assert.ok(!run.events.some((event) => event.phase === 'complete'));
  });
}

test('tool failures and duplicate calls stop loudly rather than creating an unsupported answer', async () => {
  const failed = investigation([toolReply(), answer], { execute: async () => { throw new Error('Access denied'); } });
  await assert.rejects(failed.run(), /Searching failed: Access denied/);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.events.at(-1).phase, 'error');
  const duplicate = investigation([toolReply(), toolReply(), answer]);
  await assert.rejects(duplicate.run(), /duplicate tool call/);
  assert.equal(duplicate.toolInputs.length, 1);
});

for (const api of ['chat', 'responses']) {
  test(`${api} preserves accessible evidence through a denied source and returns explicit partial findings`, async () => {
    const resource = '/chats/19%3Adenied%40thread.v2/messages?$top=1';
    let requests = 0;
    const { tools } = toolHarness({ client: { readTool: async () => {
      requests++;
      throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden', resource });
    } } });
    const responsesReply = (calls, previousInput = []) => ({
      ...toolReply(calls), api,
      ...(api === 'responses' ? {
        responseInput: previousInput,
        responseOutput: [
          { type: 'reasoning', encrypted_content: 'preserved-private-reasoning' },
          ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
        ],
      } : {}),
    });
    const run = investigation([
      responsesReply([toolCall()]),
      () => responsesReply([toolCall('denied', 'workiq_read', JSON.stringify({ path: resource }))], run.calls[1].responseInput),
      answer,
    ], { maxRounds: 4, allowPartialResults: true, extraTools: tools });
    const result = await run.run();
    assert.equal(result.outcome, 'partial');
    assert.equal(result.blockedSources[0].resource, resource);
    assert.equal(result.blockedSources[0].status, 403);
    assert.equal(result.content, answer.content);
    assert.equal(requests, 1, 'a permission denial must not be retried');
    assert.equal(run.calls[2].toolChoice, 'auto');
    assert.ok(run.calls.every(call => call.reasoningEffort === 'high'));
    const context = api === 'responses' ? run.calls[2].responseInput : run.calls[2].toolMessages;
    assert.ok(JSON.stringify(context).includes(evidence.text), 'earlier research must not be discarded');
    const denied = JSON.parse(api === 'responses' ? context.at(-1).output : context.at(-1).content);
    assert.equal(denied.ok, false);
    assert.equal(denied.outcome, 'blocked');
    assert.equal(denied.error.status, 403);
    assert.match(denied.instruction, /not read.*Do not retry/);
    assert.match(run.systemMessages[2], /PARTIAL findings.*accessible evidence/);
    assert.match(run.systemMessages[2], /never invent an ETA/);
    if (api === 'responses') assert.ok(JSON.stringify(context).includes('preserved-private-reasoning'));
    assert.equal(run.events.filter(event => event.phase === 'evidence').length, 1, 'a denial is never evidence');
    assert.equal(run.events.filter(event => event.phase === 'blocked').length, 1);
    assert.equal(run.events.at(-1).phase, 'partial');
    assert.ok(!run.events.some(event => ['retry', 'complete'].includes(event.phase)));
  });
}

test('a denied source does not discard independent readable work in the same batch', async () => {
  const { tools } = toolHarness({ client: { readTool: async () => {
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  const run = investigation([
    toolReply([
      toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}'),
      toolCall('readable'),
    ]),
    answer,
  ], { allowPartialResults: true, extraTools: tools });
  assert.equal((await run.run()).outcome, 'partial');
  assert.equal(run.toolInputs.length, 1);
  assert.deepEqual(run.events.filter(event => ['blocked', 'evidence', 'partial'].includes(event.phase)).map(event => event.phase),
    ['blocked', 'evidence', 'partial']);
});

test('source denial alone cannot produce findings from model memory or the task excerpt', async () => {
  const { tools } = toolHarness({ client: { readTool: async () => {
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  const run = investigation([
    toolReply([toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}')]), answer,
  ], { allowPartialResults: true, extraTools: tools });
  await assert.rejects(run.run(), error => {
    assert.match(error.message, /no accessible source evidence/);
    assert.equal(error.cause.blockedSource.status, 403);
    return true;
  });
  assert.equal(run.calls[1].toolChoice, 'required');
  assert.ok(!run.events.some(event => ['complete', 'partial', 'evidence'].includes(event.phase)));
});

test('partial source results require agent opt-in and do not relax authentication or operational errors', async () => {
  for (const [allowPartialResults, statusCode, code] of [
    [false, 403, 'Forbidden'], [true, 401, 'InvalidAuthenticationToken'],
    [true, 429, 'TooManyRequests'], [true, 500, 'ServerError'],
  ]) {
    const { tools } = toolHarness({ client: { readTool: async () => {
      throw Object.assign(new Error('Original source failure'), { statusCode, code });
    } } });
    const run = investigation([
      toolReply(), toolReply([toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}')]), answer,
    ], { allowPartialResults, extraTools: tools, maxRounds: 4 });
    await assert.rejects(run.run(), /Original source failure/);
    assert.equal(run.calls.length, 2);
    assert.ok(!run.events.some(event => ['partial', 'complete'].includes(event.phase)));
  }
  const unclassified = investigation([toolReply(), answer], {
    allowPartialResults: true, execute: async () => { throw Object.assign(new Error('Global policy denial'), { statusCode: 403 }); },
  });
  await assert.rejects(unclassified.run(), /Global policy denial/);
  assert.equal(unclassified.calls.length, 1);
});

test('partial findings do not conceal a separate unresolved search failure', async () => {
  const { tools } = toolHarness({ client: { readTool: async () => {
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  let searches = 0;
  const run = investigation([
    toolReply(),
    toolReply([toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}')]),
    toolReply([toolCall('failed-search')]),
    answer,
  ], {
    maxRounds: 5, allowPartialResults: true, extraTools: tools,
    execute: async () => { if (++searches === 2) throw transientError(); return evidence; },
  });
  await assert.rejects(run.run(), /unresolved source failure/);
  assert.equal(run.calls.at(-1).toolChoice, 'required');
  assert.ok(!run.events.some(event => ['partial', 'complete'].includes(event.phase)));
});

test('follow-up editing retains blocked-source limitations without inventing an access recheck', async () => {
  const blockedSources = normalizeBlockedSources([{ status: 403, resource: '/chats/private/messages', code: 'Forbidden' }]);
  const run = investigation([answer], { allowPartialResults: true });
  const result = await run.run({ requireTools: false, blockedSources });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.blockedSources, blockedSources);
  assert.match(run.systemMessages[0], /Source access is incomplete/);
  assert.equal(run.toolInputs.length, 0);
  assert.equal(run.events.at(-1).phase, 'partial');
});

test('research-limit summaries preserve access blockers and prior evidence', async () => {
  const { tools } = toolHarness({ client: { readTool: async () => {
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  const run = investigation([
    toolReply(),
    toolReply([toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}')]),
    answer,
  ], { maxRounds: 3, allowPartialResults: true, extraTools: tools });
  const result = await run.run();
  assert.equal(result.outcome, 'partial');
  assert.equal(result.researchLimitReached, true);
  assert.equal(result.blockedSources.length, 1);
  assert.equal(run.calls[2].toolChoice, 'none');
  assert.equal(run.events.at(-1).phase, 'partial');
});

test('cancellation after a source denial cannot produce late partial findings', async () => {
  const controller = new AbortController();
  const { tools } = toolHarness({ client: { readTool: async () => {
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  const run = investigation([
    toolReply([toolCall('denied', 'workiq_read', '{"path":"/chats/private/messages?$top=1"}')]), answer,
  ], { allowPartialResults: true, extraTools: tools });
  await assert.rejects(run.run({
    signal: controller.signal,
    onProgress: event => { if (event.phase === 'blocked') controller.abort(new Error('Stopped')); },
  }), /^Error: Stopped$/);
  assert.equal(run.calls.length, 1);
});

test('a failed WorkIQ search is returned to the model for one same-source refinement without losing evidence', async () => {
  let attempts = 0;
  const run = investigation([
    toolReply(),
    toolReply([toolCall('call-2', 'search', '{"query":"focused topic"}')]),
    toolReply([toolCall('call-3', 'search', '{"query":"shorter topic"}')]),
    answer,
  ], { maxRounds: 4, execute: async () => {
    attempts += 1;
    if (attempts === 2) throw transientError();
    return evidence;
  } });
  const result = await run.run();
  assert.equal(result.content, answer.content);
  assert.equal(run.calls[2].reasoningEffort, 'high');
  assert.equal(run.calls[2].toolChoice, 'required', 'prior evidence must not let an unresolved failure be skipped');
  const messages = run.calls[2].toolMessages;
  assert.equal(messages[1].content, JSON.stringify(evidence), 'keep the successful research');
  const failure = JSON.parse(messages.at(-1).content);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'WORKIQ_TRANSIENT_TOOL_FAILURE');
  assert.match(failure.error.message, /after 3 attempts/);
  assert.match(failure.recovery, /same search/);
  assert.equal(run.events.filter((event) => event.phase === 'retry').length, 1);
  assert.equal(run.events.filter((event) => event.phase === 'evidence').length, 2);
  assert.ok(run.events.some((event) => event.recovered));
});

test('Responses recovery carries opaque reasoning and a real error output into the next model round', async () => {
  const responseInput = [{ role: 'user', content: 'Task' }];
  const responseOutput = [
    { type: 'reasoning', encrypted_content: 'preserved-reasoning' },
    { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"documentation"}' },
  ];
  let attempts = 0;
  const run = investigation([
    { ...toolReply(), api: 'responses', responseInput, responseOutput },
    () => ({
      ...toolReply([toolCall('call-2', 'search', '{"query":"focused documentation"}')]),
      api: 'responses', responseInput: run.calls[1].responseInput,
      responseOutput: [{ type: 'function_call', call_id: 'call-2', name: 'search', arguments: '{"query":"focused documentation"}' }],
    }),
    answer,
  ], { execute: async () => { if (++attempts === 1) throw transientError(); return evidence; } });
  await run.run();
  assert.deepEqual(run.calls[1].responseInput.slice(0, 3), [...responseInput, ...responseOutput]);
  assert.equal(run.calls[1].responseInput.at(-1).type, 'function_call_output');
  assert.equal(run.calls[1].responseInput.at(-1).call_id, 'call-1');
  assert.equal(JSON.parse(run.calls[1].responseInput.at(-1).output).ok, false);
  assert.deepEqual(run.calls[2].responseInput.at(-1), {
    type: 'function_call_output', call_id: 'call-2', output: JSON.stringify(evidence),
  });
  assert.deepEqual(run.calls[2].toolMessages, []);
});

test('a recoverable failure is not evidence and cannot be followed by an unsupported solution', async () => {
  const run = investigation([toolReply(), answer], { execute: async () => { throw transientError(); } });
  await assert.rejects(run.run(), /unresolved source failure.*An error occurred invoking/);
  assert.equal(run.calls[1].toolChoice, 'required');
  assert.ok(!run.events.some((event) => ['complete', 'evidence'].includes(event.phase)));
});

test('a success already queued in the failing batch does not hide the unresolved query', async () => {
  let calls = 0;
  const run = investigation([
    toolReply([toolCall(), toolCall('call-2', 'search', '{"query":"different topic"}')]), answer,
  ], { execute: async () => { if (++calls === 1) throw transientError(); return evidence; } });
  await assert.rejects(run.run(), /unresolved source failure/);
  assert.equal(run.calls[1].toolChoice, 'required');
  assert.ok(!run.events.some((event) => event.recovered || event.phase === 'complete'));
});

test('a different research tool cannot replace the failed source', async () => {
  const run = investigation([toolReply(), toolReply([toolCall('call-2', 'web_search')]), answer], {
    execute: async () => { throw transientError(); },
    extraTools: { web_search: {
      label: 'Public search',
      definition: { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
      execute: async () => evidence,
    } },
  });
  await assert.rejects(run.run(), /unresolved source failure/);
  assert.equal(run.calls[2].toolChoice, 'required');
  assert.ok(!run.events.some((event) => event.phase === 'complete'));
});

test('recovery cannot silently narrow or broaden the requested source scope', async () => {
  for (const [original, replacement] of [['enterprise', 'm365'], ['m365', 'enterprise']]) {
    const run = investigation([
      toolReply([toolCall('call-1', 'search', JSON.stringify({ query: 'original topic', scope: original }))]),
      toolReply([toolCall('call-2', 'search', JSON.stringify({ query: 'refined topic', scope: replacement }))]),
      answer,
    ], { execute: async () => { throw transientError(); } });
    await assert.rejects(run.run(), /cannot change the source scope/);
    assert.equal(run.toolInputs.length, 1, 'must reject the substituted scope before contacting a source');
    assert.ok(!run.events.some((event) => event.phase === 'complete'));
  }
});

test('same-scope refinement can recover and then complete the investigation', async () => {
  let attempts = 0;
  const run = investigation([
    toolReply([toolCall('call-1', 'search', '{"query":"original topic","scope":"enterprise"}')]),
    toolReply([toolCall('call-2', 'search', '{"query":"refined topic","scope":"enterprise"}')]),
    answer,
  ], { execute: async () => { if (++attempts === 1) throw transientError(); return evidence; } });
  assert.equal((await run.run()).content, answer.content);
  assert.deepEqual(run.toolInputs.map((args) => args.scope), ['enterprise', 'enterprise']);
});

test('query refinement is bounded and requires explicit agent opt-in', async () => {
  const run = investigation([toolReply(), toolReply([toolCall('call-2')]), answer], {
    execute: async () => { throw transientError(); },
  });
  await assert.rejects(run.run(), /Searching failed.*after 3 attempts/);
  assert.equal(run.calls.length, 2);
  assert.equal(run.events.filter((event) => event.phase === 'retry').length, 1);
  assert.equal(run.events.at(-1).phase, 'error');
  const disabled = investigation([toolReply(), answer], {
    maxToolRecoveries: 0, execute: async () => { throw transientError(); },
  });
  await assert.rejects(disabled.run(), /Searching failed/);
  assert.equal(disabled.calls.length, 1);
});

test('stopping during recovery prevents another tool or model call', async () => {
  const controller = new AbortController();
  const run = investigation([toolReply(), answer], { execute: async () => { throw transientError(); } });
  await assert.rejects(run.run({
    signal: controller.signal,
    onProgress: (event) => { if (event.phase === 'retry') controller.abort(new Error('Stopped')); },
  }), /^Error: Stopped$/);
  assert.equal(run.calls.length, 1);
  assert.equal(run.toolInputs.length, 1);
});

test('round limit never executes the last tool or presents unfinished research as a solution', async () => {
  const run = investigation([toolReply(), toolReply([toolCall('call-2')])], { maxRounds: 2 });
  await assert.rejects(run.run(), /investigation limit/);
  assert.equal(run.toolInputs.length, 1);
  assert.ok(!run.events.some((event) => event.phase === 'complete'));
});

for (const api of ['chat', 'responses']) {
  test(`${api} reserves the final round for a clearly limited evidence summary without dropping context`, async () => {
    const responseInput = [{ role: 'user', content: 'Task' }];
    const responseOutput = [
      { type: 'reasoning', encrypted_content: 'preserved-reasoning' },
      { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"query":"documentation"}' },
    ];
    const run = investigation([{
      ...toolReply(), api, ...(api === 'responses' ? { responseInput, responseOutput } : {}),
    }, answer], { maxRounds: 2 });
    const completion = await run.run();
    assert.equal(completion.researchLimitReached, true);
    assert.equal(completion.content, answer.content);
    assert.equal(run.calls[1].toolChoice, 'none');
    assert.equal(run.calls[1].reasoningEffort, 'high');
    assert.match(run.systemMessages[0], /turn 1 of 2.*1 tool rounds remain/);
    assert.match(run.systemMessages[1], /No research-tool rounds remain/);
    assert.match(run.systemMessages[1], /Do not claim the investigation is exhaustive/);
    assert.ok(JSON.stringify(run.calls[1]).includes(evidence.text));
    if (api === 'responses') assert.ok(JSON.stringify(run.calls[1].responseInput).includes('preserved-reasoning'));
    assert.equal(run.events.filter(event => event.phase === 'limit').length, 1);
    assert.match(run.events.at(-1).label, /research limit reached/);
    assert.equal(run.toolInputs.length, 1);
  });
}

test('the final summary phase cannot bypass an unresolved source failure', async () => {
  const run = investigation([toolReply(), answer], { maxRounds: 2, execute: async () => { throw transientError(); } });
  await assert.rejects(run.run(), /unresolved source failure/);
  assert.equal(run.calls[1].toolChoice, 'required');
  assert.ok(!run.events.some(event => event.phase === 'limit' || event.phase === 'complete'));
});

test('cancellation prevents another model round and ignores a late completion', async () => {
  const controller = new AbortController();
  const run = investigation([toolReply(), answer], { execute: async () => {
    controller.abort(new Error('Stopped'));
    return evidence;
  } });
  await assert.rejects(run.run({ signal: controller.signal }), /^Error: Stopped$/);
  assert.equal(run.calls.length, 1);
  assert.ok(!run.events.some((event) => event.phase === 'complete'));
  const lateController = new AbortController();
  const late = investigation([() => { lateController.abort(new Error('Stopped')); return answer; }]);
  await assert.rejects(late.run({ signal: lateController.signal, requireTools: false }), /^Error: Stopped$/);
});

test('missing required tools fail before contacting the model', async () => {
  const run = investigation([answer]);
  await assert.rejects(run.run({ tools: {} }), /required tool "search" is unavailable/);
  assert.equal(run.calls.length, 0);
});

function toolHarness(options = {}) {
  const calls = [];
  const connections = [];
  const webCalls = [];
  const tools = createWorkAgentTools({
    client: { readTool: async (...args) => {
      calls.push(args);
      const message = /\/messages\/([^/?]+)\?/.exec(args[1]?.entityUrls?.[0] || '');
      const id = message ? decodeURIComponent(message[1]) : 'record-1';
      return { structuredContent: { results: [{ statusCode: 200, data: { id, webLink: source.url, body: { contentType: 'text', content: 'Evidence' } } }] } };
    } },
    ensureConnected: async (args) => { connections.push(args); return { connected: true }; },
    webTool: async (...args) => {
      webCalls.push(args);
      return args[0] === 'web_search' ? copilotSearchResult()
        : { content: [{ type: 'text', text: `Title: ${source.title}\nURL: ${source.url}\nVerified source content.` }] };
    },
    ...options,
  });
  return { tools, calls, connections, webCalls };
}

test('WorkIQ tools share authenticated connection recovery and expose only investigation capabilities', async () => {
  const { tools, calls, connections } = toolHarness();
  assert.deepEqual(Object.keys(tools), ['workiq_search', 'workiq_read_email', 'workiq_read', 'workiq_document', 'web_search', 'web_read']);
  await tools.workiq_search.execute({ query: 'Related email decisions', scope: 'm365' });
  await tools.workiq_read.execute({ path: '/me/messages/record-1?$select=id,body,webLink' });
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0], { reason: 'work-agent' });
  assert.equal(calls[0][0], 'retrieve');
  assert.deepEqual(calls[0][1], { query: ['Related email decisions'], strategy: 'grounding' });
  assert.equal(calls[1][0], 'fetch');
  assert.deepEqual(calls[1][1], { entityUrls: ['/me/messages/record-1?$select=id,body,webLink'] });
});

test('only generic WorkIQ search faults allow model-guided query refinement', () => {
  const { tools } = toolHarness();
  assert.equal(tools.workiq_search.isRecoverableError(transientError()), true);
  assert.equal(tools.workiq_search.isRecoverableError(new Error('Access denied')), false);
  assert.equal(tools.workiq_search.isRecoverableError(Object.assign(transientError(), { tool: 'fetch' })), false);
  assert.match(tools.workiq_search.recoveryInstructions, /exact same scope, work sources and intent/);
  assert.match(tools.workiq_search.recoveryInstructions, /successful workiq_search is required/);
  for (const name of ['workiq_document', 'web_search']) {
    assert.equal(tools[name].isRecoverableError, undefined);
  }
  assert.equal(tools.workiq_read_email.isRecoverableError(transientError()), false);
  assert.equal(tools.workiq_read_email.isRecoverableError(Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' })), false);
  assert.equal(tools.workiq_read.isRecoverableError(transientError()), false);
  assert.equal(tools.web_read.isRecoverableError(transientError()), false);
});

test('calendar references preserve exact native IDs, calendars and queries without model transcription', async () => {
  const id = 'AAMk-native-Event_ID+with/slash=';
  const paths = [];
  const { tools } = toolHarness({ client: { readTool: async (_name, args) => {
    const path = args.entityUrls[0];
    paths.push(path);
    const record = { id, subject: 'Alignment', start: { dateTime: '2026-09-23T16:30:00' } };
    return { structuredContent: { results: [{ statusCode: 200, data: path.includes('calendarView') ? { value: [record] } : record }] } };
  } } });
  const collection = '/users/verified-user/calendars/calendar-1';
  const result = await tools.workiq_read.execute({ path: `${collection}/calendarView?startDateTime=2026-09-23&endDateTime=2026-09-24&$select=id,subject,start` });
  assert.deepEqual(result.eventReferences, [{
    reference: 'event-1', path: `${collection}/events/event-1`, subject: 'Alignment',
    start: { dateTime: '2026-09-23T16:30:00' }, end: undefined,
  }]);
  const query = '?$select=id,subject,body,attendees&$expand=attachments';
  const details = await tools.workiq_read.execute({ path: result.eventReferences[0].path + query });
  assert.equal(paths[1], `${collection}/events/${encodeURIComponent(id)}${query}`);
  assert.equal(details.eventReferences[0].reference, 'event-1', 'repeat reads retain their reference');
  await tools.workiq_read.execute({ path: `${collection}/events/${encodeURIComponent(id)}${query}` });
  assert.equal(paths[2], paths[1], 'exact native IDs already returned also remain supported');
  assert.equal(tools.workiq_read.getRecoveryKey({ path: result.eventReferences[0].path }),
    tools.workiq_read.getRecoveryKey({ path: `${collection}/events/${encodeURIComponent(id)}` }));
});

test('altered, unknown, cross-calendar and prior-investigation event IDs never reach WorkIQ', async () => {
  const { tools, calls } = toolHarness();
  const original = await tools.workiq_read.execute({ path: '/me/events?$select=id,subject&$top=10' });
  assert.equal(original.eventReferences[0].path, '/me/events/event-1');
  for (const path of [
    '/me/events/record%2F1', '/me/events/event-99',
    '/users/someone-else/events/event-1', '/me/calendars/other/events/event-1',
  ]) {
    await assert.rejects(tools.workiq_read.execute({ path }), error => {
      assert.equal(error.code, 'WORKIQ_EVENT_REFERENCE_UNKNOWN');
      assert.match(error.message, /No source was requested/);
      assert.equal(tools.workiq_read.isRecoverableError(error), true);
      return true;
    });
  }
  assert.equal(calls.length, 1);
  const fresh = toolHarness();
  await assert.rejects(fresh.tools.workiq_read.execute({ path: '/me/events/event-1' }), /not returned/);
  assert.equal(fresh.calls.length, 0);
  const code = 'WORKIQ_EVENT_REFERENCE_UNKNOWN';
  const key = tools.workiq_read.getRecoveryKey({ path: '/me/events/record%2F1' }, code);
  assert.equal(key, tools.workiq_read.getRecoveryKey({ path: '/me/events/event-1' }, code));
  for (const path of ['/me/events', '/me/calendarView', '/users/other/events/event-1', '/me/messages/record-1']) {
    assert.notEqual(key, tools.workiq_read.getRecoveryKey({ path }, code), 'a replacement search or mailbox cannot count as recovery');
  }
});

test('search-index meeting IDs are not registered as native Graph event IDs', async () => {
  const { tools, calls } = toolHarness();
  const result = await tools.workiq_search.execute({ query: 'Meeting details', scope: 'm365' });
  assert.equal(result.eventReferences, undefined);
  await assert.rejects(tools.workiq_read.execute({ path: '/me/events/record-1' }), /not returned/);
  assert.equal(calls.length, 1);
});

test('event-reference reads reject wrong identities, invalid records and late cancelled results', async () => {
  for (const data of [{ id: 'different-event' }, {}, { value: [{ id: 'record-1' }] }]) {
    let calls = 0;
    const { tools } = toolHarness({ client: { readTool: async () => ({ structuredContent: {
      results: [{ statusCode: 200, data: ++calls === 1 ? { value: [{ id: 'record-1' }] } : data }],
    } }) } });
    await tools.workiq_read.execute({ path: '/me/events?$select=id' });
    await assert.rejects(tools.workiq_read.execute({ path: '/me/events/event-1' }), /did not return the requested calendar event/);
  }
  const controller = new AbortController();
  const { tools } = toolHarness({ signal: controller.signal, client: { readTool: async () => {
    controller.abort(new Error('Stopped'));
    return { structuredContent: { results: [{ statusCode: 200, data: { value: [{ id: 'late' }] } }] } };
  } } });
  await assert.rejects(tools.workiq_read.execute({ path: '/me/events?$select=id' }), /Stopped/);
});

test('event query recovery cannot change the selected event after a real Graph error', async () => {
  const { tools } = toolHarness({ client: { readTool: async () => ({ structuredContent: {
    results: [{ statusCode: 200, data: { value: [{ id: 'first-event' }, { id: 'second-event' }] } }],
  } }) } });
  await tools.workiq_read.execute({ path: '/me/events?$select=id' });
  assert.notEqual(tools.workiq_read.getRecoveryKey({ path: '/me/events/event-1' }, 'RequestBroker--ParseUri'),
    tools.workiq_read.getRecoveryKey({ path: '/me/events/event-2' }, 'RequestBroker--ParseUri'));
  for (const statusCode of [401, 403, 429, 500]) {
    assert.equal(tools.workiq_read.isRecoverableError(Object.assign(new Error('Source error'), { statusCode })), false);
  }
});

const directoryUser = {
  id: '47a84b48-4a35-4a15-8ddb-c71eea076242',
  mail: 'first.last@contoso.com',
  userPrincipalName: 'flast@contoso.com',
};
const userNotFound = () => Object.assign(new Error('WorkIQ fetch failed (HTTP 404): Request_ResourceNotFound'), {
  statusCode: 404, code: 'Request_ResourceNotFound',
});
const workFetchResult = data => ({ structuredContent: { results: [{ statusCode: 200, data }] } });

test('not-found SMTP user paths resolve the same person and preserve subresource and query exactly', async () => {
  const paths = [];
  const progress = [];
  const suffix = "/directReports?$select=id,displayName&$filter=accountEnabled%20eq%20true&$top=10";
  const original = `/users/First.Last%40contoso.com${suffix}`;
  const { tools, connections, webCalls } = toolHarness({
    onProgress: event => progress.push(event),
    client: { readTool: async (name, args) => {
      assert.equal(name, 'fetch');
      const path = args.entityUrls[0];
      paths.push(path);
      if (path === original) throw userNotFound();
      if (path.startsWith('/users?')) return workFetchResult({ value: [directoryUser] });
      return workFetchResult({ value: [{ id: 'report-1', displayName: 'Returned report' }] });
    } },
  });
  const result = await tools.workiq_read.execute({ path: original });
  assert.equal(paths.length, 3);
  const lookup = new URL(paths[1], 'https://graph.microsoft.com');
  assert.equal(lookup.pathname, '/users');
  assert.equal(lookup.searchParams.get('$filter'), "mail eq 'First.Last@contoso.com' or userPrincipalName eq 'First.Last@contoso.com'");
  assert.equal(lookup.searchParams.get('$select'), 'id,mail,userPrincipalName');
  assert.equal(lookup.searchParams.get('$top'), '2');
  assert.equal(paths[2], `/users/${directoryUser.id}${suffix}`);
  assert.match(result.text, /Returned report/);
  assert.equal(connections.length, 1);
  assert.equal(webCalls.length, 0);
  assert.deepEqual(progress.map(event => event.phase), ['resolve', 'resolve']);
  assert.match(progress[0].label, /HTTP 404.*exact directory/);
  assert.match(progress[1].label, /same person.*verified directory ID/);

  await tools.workiq_read.execute({ path: '/users/first.last@contoso.com?$select=id' });
  assert.equal(paths.length, 4, 'reuse the verified identity instead of repeating the failing SMTP request');
  assert.equal(paths[3], `/users/${directoryUser.id}?$select=id`);
});

test('valid UPN requests are read directly without requiring directory-list permission', async () => {
  const { tools, calls } = toolHarness();
  await tools.workiq_read.execute({ path: '/users/flast@contoso.com?$select=id' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].entityUrls[0], '/users/flast@contoso.com?$select=id');
});

test('directory lookup escapes literal quotes and encodes email query characters without changing identity', async () => {
  const address = "o'brien+test&dept@contoso.com";
  const paths = [];
  const { tools } = toolHarness({ client: { readTool: async (_name, args) => {
    paths.push(args.entityUrls[0]);
    if (paths.length === 1) throw userNotFound();
    if (paths.length === 2) return workFetchResult({ value: [{ ...directoryUser, mail: address }] });
    return workFetchResult(directoryUser);
  } } });
  await tools.workiq_read.execute({ path: `/users/${encodeURIComponent(address)}?$select=id` });
  const lookup = new URL(paths[1], 'https://graph.microsoft.com');
  assert.equal(lookup.searchParams.size, 3);
  assert.equal(lookup.searchParams.get('$filter'), "mail eq 'o''brien+test&dept@contoso.com' or userPrincipalName eq 'o''brien+test&dept@contoso.com'");
  assert.equal(paths[2], `/users/${directoryUser.id}?$select=id`);
});

for (const [label, data, message] of [
  ['no matches', { value: [] }, /found no matching user/],
  ['ambiguous matches', { value: [directoryUser, { ...directoryUser, id: 'other-id' }] }, /did not identify a unique user/],
  ['incomplete page', { value: [directoryUser], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=more' }, /did not identify a unique user/],
  ['unrelated match', { value: [{ ...directoryUser, mail: 'someone.else@contoso.com' }] }, /unverified directory match/],
  ['missing ID', { value: [{ ...directoryUser, id: '' }] }, /unverified directory match/],
  ['malformed collection', { value: {} }, /invalid user directory lookup/],
]) {
  test(`user resolution rejects ${label} before reading another resource`, async () => {
    const paths = [];
    const { tools } = toolHarness({ client: { readTool: async (_name, args) => {
      paths.push(args.entityUrls[0]);
      if (paths.length === 1) throw userNotFound();
      return workFetchResult(data);
    } } });
    await assert.rejects(tools.workiq_read.execute({ path: '/users/first.last@contoso.com?$select=id' }), message);
    assert.equal(paths.length, 2, 'the directory lookup itself is not the requested source evidence');
  });
}

test('user resolution requires one successful directory result, not an empty or malformed envelope', async () => {
  for (const response of [
    { structuredContent: {} },
    { structuredContent: { results: [] } },
    { structuredContent: { results: [{ statusCode: 204, data: { value: [directoryUser] } }] } },
    { structuredContent: { results: [workFetchResult({ value: [directoryUser] }).structuredContent.results[0], {}] } },
  ]) {
    let requests = 0;
    const { tools } = toolHarness({ client: { readTool: async () => {
      if (++requests === 1) throw userNotFound();
      return response;
    } } });
    await assert.rejects(tools.workiq_read.execute({ path: '/users/first.last@contoso.com?$select=id' }), /invalid user directory lookup/);
    assert.equal(requests, 2);
  }
});

test('user identity resolution never retries permission, authentication, operational or unrelated not-found errors', async () => {
  for (const [path, statusCode, code] of [
    ...[[401, 'InvalidAuthenticationToken'], [403, 'Forbidden'], [429, 'TooManyRequests'], [500, 'ServerError'], [404, 'UnknownFailure']]
      .map(([status, code]) => ['/users/first.last@contoso.com?$select=id', status, code]),
    [`/users/${directoryUser.id}?$select=id`, 404, 'Request_ResourceNotFound'],
    ['/me/messages/missing', 404, 'ErrorItemNotFound'],
    ['/chats/missing/messages', 404, 'ResourceNotFound'],
  ]) {
    let requests = 0;
    const { tools } = toolHarness({ client: { readTool: async () => {
      requests++;
      throw Object.assign(new Error('Original service failure'), { statusCode, code });
    } } });
    await assert.rejects(tools.workiq_read.execute({ path }), error => error.statusCode === statusCode && error.code === code);
    assert.equal(requests, 1);
  }
});

test('a directory service failure is not a missing-user result or permission to try another identity', async () => {
  for (const statusCode of [401, 403, 404, 429, 500]) {
    let requests = 0;
    const { tools } = toolHarness({ client: { readTool: async () => {
      if (++requests === 1) throw userNotFound();
      throw Object.assign(new Error('Directory service failure'), { statusCode, code: 'DirectoryFailure' });
    } } });
    await assert.rejects(tools.workiq_read.execute({ path: '/users/first.last@contoso.com?$select=id' }), error => {
      assert.equal(error.statusCode, statusCode);
      assert.match(error.message, /Directory service failure/);
      return true;
    });
    assert.equal(requests, 2);
  }
});

test('resolving a person cannot hide a missing or denied child resource or initiate another identity lookup', async () => {
  for (const statusCode of [404, 403]) {
    const paths = [];
    const { tools } = toolHarness({ client: { readTool: async (_name, args) => {
      paths.push(args.entityUrls[0]);
      if (paths.length === 1) throw userNotFound();
      if (paths.length === 2) return workFetchResult({ value: [directoryUser] });
      throw Object.assign(new Error('Requested child still unavailable'), {
        statusCode, code: statusCode === 404 ? 'Request_ResourceNotFound' : 'Forbidden',
      });
    } } });
    const path = '/users/first.last@contoso.com/manager?$select=id';
    await assert.rejects(tools.workiq_read.execute({ path }), error => {
      assert.equal(error.statusCode, statusCode);
      assert.match(error.message, /Requested child still unavailable/);
      if (statusCode === 403) assert.equal(error.blockedSource.resource, `/users/${directoryUser.id}/manager?$select=id`);
      return true;
    });
    assert.equal(paths.length, 3);
    if (statusCode === 403) {
      await assert.rejects(tools.workiq_read.execute({ path }), /No permission retry was sent/);
      assert.equal(paths.length, 3, 'the verified ID must retain its permission exclusion');
    }
  }
});

test('cancellation during a directory lookup prevents the resolved source from being read', async () => {
  const controller = new AbortController();
  let requests = 0;
  const progress = [];
  const { tools } = toolHarness({
    signal: controller.signal,
    onProgress: event => progress.push(event),
    client: { readTool: async () => {
      if (++requests === 1) throw userNotFound();
      controller.abort(new Error('Stopped during directory lookup'));
      return workFetchResult({ value: [directoryUser] });
    } },
  });
  await assert.rejects(tools.workiq_read.execute({ path: '/users/first.last@contoso.com?$select=id' }), /Stopped during directory lookup/);
  assert.equal(requests, 2);
  assert.equal(progress.length, 1, 'stopping must not emit a late resolved-identity notice');
});

test('only explicit Graph query-syntax errors can be repaired, retaining the same resource', () => {
  const { tools } = toolHarness();
  const tool = tools.workiq_read;
  for (const code of ['BadRequest', 'RequestBroker--ParseUri', 'InefficientFilter']) {
    assert.equal(tool.isRecoverableError(Object.assign(new Error('Invalid filter clause'), { statusCode: 400, code })), true);
  }
  for (const [statusCode, code] of [[403, 'BadRequest'], [401, 'BadRequest'], [400, 'ErrorAccessDenied'], [429, 'TooManyRequests']]) {
    assert.equal(tool.isRecoverableError(Object.assign(new Error('Denied'), { statusCode, code })), false);
  }
  assert.equal(tool.isRecoverableError(Object.assign(new Error('Access denied by policy'), { statusCode: 400, code: 'BadRequest' })), false);
  assert.equal(tool.getRecoveryKey({ path: "/me/messages?$filter=conversationId%20eq%20'thread'%26$select=id" }),
    tool.getRecoveryKey({ path: "/me/messages?$filter=conversationId%20eq%20'thread'&$select=id" }));
  assert.notEqual(tool.getRecoveryKey({ path: '/me/messages/source-1' }), tool.getRecoveryKey({ path: '/me/messages/source-2' }));
  assert.match(tool.recoveryInstructions, /same relative resource path, record IDs and intended filters/);
  assert.match(tool.recoveryInstructions, /literal &, never %26 or &amp;/);
});

for (const [label, badPath, goodPath, code, message] of [
  ['encoded query separators', "/me/messages?$filter=conversationId%20eq%20'thread'%26$select=id%26$top=50", "/me/messages?$filter=conversationId%20eq%20'thread'&$select=id&$top=50", 'BadRequest', "Invalid filter clause: character '&' is not valid"],
  ['unsupported filter sorting', "/me/messages?$filter=conversationId eq 'thread'&$orderby=receivedDateTime desc&$top=20", "/me/messages?$filter=conversationId eq 'thread'&$top=20", 'InefficientFilter', 'The restriction or sort order is too complex for this operation.'],
]) {
  test(`Graph ${label} returns its error to the model and accepts a corrected same-resource read`, async () => {
    const paths = [];
    const { tools } = toolHarness({
      client: { readTool: async (_name, args) => {
        const path = args.entityUrls[0];
        paths.push(path);
        if (path === badPath) throw Object.assign(new Error(message), {
          statusCode: 400, code,
        });
        return { structuredContent: { results: [{ statusCode: 200, data: { value: [{ id: 'message-1', webLink: source.url }] } }] } };
      } },
    });
    const calls = [];
    const progress = [];
    const runtime = createAgentRuntime({
      provider: { chat: async (_system, _user, options) => {
        calls.push(structuredClone(options));
        return calls.length <= 2
          ? toolReply([toolCall(`call-${calls.length}`, 'workiq_read', JSON.stringify({ path: calls.length === 1 ? badPath : goodPath }))])
          : answer;
      } },
      agents: [{
        id: 'read-recovery', name: 'Work Agent', tools: ['workiq_read'], toolLoop: { maxRounds: 3, maxToolRecoveries: 1 },
        render: () => ({ systemMessage: 'Investigate', userMessage: 'Task' }),
      }],
    });
    assert.equal((await runtime.run('read-recovery', { deps: { tools, requireTools: true, onProgress: (event) => progress.push(event) } })).content, answer.content);
    assert.deepEqual(paths, [badPath, goodPath]);
    assert.equal(JSON.parse(calls[1].toolMessages.at(-1).content).error.code, code);
    assert.ok(progress.some((event) => event.phase === 'retry' && event.error.includes(message)));
    assert.ok(progress.some((event) => event.recovered));
  });
}

test('WorkIQ retry progress is forwarded without changing the search strategy or arguments', async () => {
  const progress = [];
  let actualArgs;
  const { tools } = toolHarness({
    onProgress: (event) => progress.push(event),
    client: { readTool: async (name, args, _timeout, _signal, onRetry) => {
      actualArgs = args;
      onRetry({ tool: name, attempt: 2, attempts: 3, error: 'Backend fault' });
      return { content: [{ type: 'text', text: 'Real evidence' }] };
    } },
  });
  await tools.workiq_search.execute({ query: 'Focused internal research', scope: 'enterprise' });
  assert.deepEqual(actualArgs, { query: ['Focused internal research'], strategy: 'copilot' });
  assert.equal(progress[0].phase, 'retry');
  assert.match(progress[0].label, /same request \(2\/3\)/);
  assert.equal(progress[0].error, 'Backend fault');
  assert.match(progress[0].label, /all connected sources/);
  assert.equal(progress[1].phase, 'recovered');
  assert.equal(progress[1].recovered, true);
  assert.match(progress[1].label, /all connected sources.*recovered on attempt 2\/3.*same search/);
});

test('search recovery is reported only after usable research, never a failed, empty or cancelled retry', async () => {
  for (const outcome of ['first-try', 'third-try', 'exhausted', 'empty', 'service-error', 'cancelled']) {
    const progress = [];
    const controller = new AbortController();
    const { tools } = toolHarness({
      signal: controller.signal,
      onProgress: event => progress.push(event),
      client: { readTool: async (_name, _args, _timeout, _signal, onRetry) => {
        if (outcome !== 'first-try') {
          onRetry({ attempt: 2, attempts: 3, error: 'Original backend failure' });
          onRetry({ attempt: 3, attempts: 3, error: 'Original backend failure' });
        }
        if (outcome === 'exhausted') throw transientError();
        if (outcome === 'empty') return { content: [] };
        if (outcome === 'service-error') return { isError: true, content: [{ type: 'text', text: 'Access denied' }] };
        if (outcome === 'cancelled') controller.abort(new Error('Stopped'));
        return { content: [{ type: 'text', text: 'Actual research' }] };
      } },
    });
    const operation = tools.workiq_search.execute({ query: 'Internal alignment decisions', scope: 'm365' });
    if (['first-try', 'third-try'].includes(outcome)) assert.equal((await operation).text, 'Actual research');
    else await assert.rejects(operation);
    const recovered = progress.filter(event => event.recovered);
    assert.equal(recovered.length, outcome === 'third-try' ? 1 : 0, outcome);
    if (recovered.length) assert.match(recovered[0].label, /Microsoft 365.*attempt 3\/3/);
  }
});

test('WorkIQ scopes map explicitly to their documented strategies and never default an invalid scope', async () => {
  const { tools, calls, connections } = toolHarness();
  const tool = tools.workiq_search;
  assert.deepEqual(tool.definition.function.parameters.required, ['query', 'scope']);
  assert.deepEqual(tool.definition.function.parameters.properties.scope.enum, ['m365', 'enterprise']);
  for (const scope of [undefined, null, '', 'grounding', 'copilot', 'unknown']) {
    await assert.rejects(tool.execute({ query: 'Task evidence', scope }), /explicit WorkIQ search scope/);
  }
  assert.equal(calls.length, 0);
  assert.equal(connections.length, 0);
  await tool.execute({ query: 'Email decisions', scope: 'm365' });
  await tool.execute({ query: 'Connected-system decisions', scope: 'enterprise' });
  assert.deepEqual(calls.map((call) => call[1]), [
    { query: ['Email decisions'], strategy: 'grounding' },
    { query: ['Connected-system decisions'], strategy: 'copilot' },
  ]);
  assert.match(tool.label({ scope: 'm365' }), /Microsoft 365/);
  assert.match(tool.label({ scope: 'enterprise' }), /all connected sources/);
});

test('WorkIQ research across connected objects remains usable without source links', async () => {
  const requests = [];
  const { tools } = toolHarness({
    sourceMessageId: 'source-email',
    client: { readTool: async (name, args) => {
      requests.push({ name, args });
      return name === 'fetch' ? { structuredContent: { results: [{
        statusCode: 200, data: { id: 'source-email', body: { contentType: 'text', content: 'Returned object details.' } },
      }] } } : { structuredContent: { markdown: 'Returned connected-source research without source links.' } };
    } },
  });
  for (const [name, args] of [
    ['workiq_search', { query: 'Related emails and meetings', scope: 'm365' }],
    ['workiq_search', { query: 'Related connected records', scope: 'enterprise' }],
    ['workiq_read_email', { messageId: null }],
    ['workiq_read', { path: '/me/events?$select=id,subject&$top=10' }],
    ['workiq_document', { url: 'https://tenant.sharepoint.com/docs/plan.docx', question: 'What are the decisions?' }],
  ]) {
    const result = await tools[name].execute(args);
    assert.ok(result.text.includes('Returned'));
    assert.deepEqual(result.sources, []);
  }
  const run = investigation([
    toolReply([toolCall('work-search', 'workiq_search', '{"query":"Connected records","scope":"enterprise"}')]), answer,
  ], { extraTools: tools });
  assert.equal((await run.run()).content, answer.content);
  assert.equal(run.events.at(-1).phase, 'complete');
  assert.deepEqual(requests.slice(0, 2).map(request => request.args.strategy), ['grounding', 'copilot']);
  assert.deepEqual(requests.map(request => request.name), ['retrieve', 'retrieve', 'fetch', 'fetch', 'ask', 'retrieve']);
});

test('the runtime shows the actual selected WorkIQ scope in progress and evidence events', async () => {
  const { tools } = toolHarness();
  let rounds = 0;
  const progress = [];
  const runtime = createAgentRuntime({
    provider: { chat: async () => ++rounds === 1
      ? toolReply([toolCall('call-1', 'workiq_search', '{"query":"Email decisions","scope":"m365"}')])
      : answer },
    agents: [{
      id: 'scoped', name: 'Work Agent', tools: ['workiq_search'], toolLoop: { maxRounds: 3 },
      render: () => ({ systemMessage: 'Investigate', userMessage: 'Task' }),
    }],
  });
  await runtime.run('scoped', { deps: { tools, requireTools: true, onProgress: (event) => progress.push(event) } });
  assert.match(progress.find((event) => event.phase === 'tool').label, /Microsoft 365/);
  assert.match(progress.find((event) => event.phase === 'evidence').label, /Microsoft 365/);
});

test('email reads bind the selected task ID and valid Graph fields without model-authored paths', async () => {
  const { tools, calls } = toolHarness({ sourceMessageId: 'AAMk+source/id==' });
  await tools.workiq_read_email.execute({ messageId: null });
  const parameters = tools.workiq_read_email.definition.function.parameters;
  assert.deepEqual(parameters.required, ['messageId']);
  assert.deepEqual(parameters.properties.messageId.type, ['string', 'null']);
  const url = new URL(`https://graph.microsoft.com/v1.0${calls[0][1].entityUrls[0]}`);
  assert.equal(url.pathname, '/v1.0/me/messages/AAMk%2Bsource%2Fid%3D%3D');
  const fields = url.searchParams.get('$select').split(',');
  for (const field of ['id', 'subject', 'body', 'from', 'toRecipients', 'ccRecipients', 'conversationId', 'webLink']) {
    assert.ok(fields.includes(field), `Missing ${field}`);
  }
  assert.ok(!fields.includes('recipients'));
  await tools.workiq_read_email.execute({ messageId: 'email-1' });
  assert.equal(calls[1][1].entityUrls[0], calls[0][1].entityUrls[0]);
});

test('email reads reject a different returned identity instead of substituting a source', async () => {
  const { tools } = toolHarness({
    sourceMessageId: 'selected-email',
    client: { readTool: async () => ({ structuredContent: { results: [{
      statusCode: 200, data: { id: 'different-email', body: { contentType: 'text', content: 'Wrong source' } },
    }] } }) },
  });
  await assert.rejects(tools.workiq_read_email.execute({ messageId: null }), /No other email was substituted/);
});

test('short email references bind exact indexed and mailbox IDs without reconstructing them', async () => {
  const indexedId = 'AAMk+indexed/email==';
  const mailboxId = 'AAMk+mailbox/email==';
  const calls = [];
  const { tools } = toolHarness({
    sourceMessageId: 'selected-email-id',
    client: { readTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'retrieve') return { structuredContent: { 'application/vnd.ms-workiq.retrieval': {
        markdown: 'x'.repeat(25000),
        retrievalHits: [{ entityType: 'Emails', resourceId: indexedId, resourceMetadata: { general: { title: 'Indexed email' } } }],
      } } };
      return { structuredContent: { results: [{ statusCode: 200, data: args.entityUrls[0].startsWith('/me/messages?')
        ? { value: [{ id: mailboxId, subject: 'Mailbox email', receivedDateTime: '2026-09-22T00:00:00Z' }] }
        : { id: decodeURIComponent(/\/messages\/([^?]+)\?/.exec(args.entityUrls[0])[1]), body: { contentType: 'text', content: 'Full content' } } }] } };
    } },
  });
  const search = await tools.workiq_search.execute({ query: 'Find the email', scope: 'm365' });
  assert.equal(search.truncated, true);
  assert.equal(search.emailReferences[0].reference, 'email-2', 'references must survive evidence truncation');
  await tools.workiq_read_email.execute({ messageId: search.emailReferences[0].reference });
  assert.match(calls[1].args.entityUrls[0], /^\/me\/messages\/AAMk%2Bindexed%2Femail%3D%3D\?/);
  const listing = await tools.workiq_read.execute({ path: '/me/messages?$select=id,subject&$top=2' });
  assert.equal(listing.emailReferences[0].subject, 'Mailbox email');
  await tools.workiq_read_email.execute({ messageId: listing.emailReferences[0].reference });
  assert.match(calls[3].args.entityUrls[0], /^\/me\/messages\/AAMk%2Bmailbox%2Femail%3D%3D\?/);
});

test('unknown or corrupted email IDs fail locally and cannot be inferred from quoted content', async () => {
  const calls = [];
  const { tools } = toolHarness({
    sourceMessageId: 'valid-source-id',
    client: { readTool: async (name, args) => {
      calls.push({ name, args });
      return { structuredContent: { markdown: 'Someone quoted {"entityType":"Emails","resourceId":"untrusted-id"}' } };
    } },
  });
  await tools.workiq_search.execute({ query: 'Related work', scope: 'm365' });
  for (const messageId of ['valid-id', 'email-999', 'untrusted-id']) {
    await assert.rejects(tools.workiq_read_email.execute({ messageId }), error => {
      assert.equal(error.code, 'WORKIQ_EMAIL_REFERENCE_UNKNOWN');
      assert.equal(tools.workiq_read_email.isRecoverableError(error), true);
      assert.match(error.message, /not returned in this investigation/);
      return true;
    });
  }
  assert.equal(calls.length, 1, 'no invalid email read should reach WorkIQ');
  const other = toolHarness();
  await assert.rejects(other.tools.workiq_read_email.execute({ messageId: 'email-1' }), /not returned in this investigation/);
});

test('a linked private Teams chat denial keeps the exact verified link and permission error', async () => {
  const url = 'https://teams.microsoft.com/l/chat/19:parent@thread.v2/conversations?context=original';
  const path = '/chats/19%3Aparent%40thread.v2/messages?$select=id,body&$top=50';
  const calls = [];
  const { tools, connections } = toolHarness({
    client: { readTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'retrieve') return { structuredContent: { markdown: `The case chat mentions [parent incident](${url}).` } };
      throw Object.assign(new Error('WorkIQ fetch failed (HTTP 403): Forbidden: InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden', resource: path });
    } },
  });
  await tools.workiq_search.execute({ query: 'Case updates', scope: 'm365' });
  await assert.rejects(tools.workiq_read.execute({ path }), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'Forbidden');
    assert.equal(error.blockedSource.resource, path);
    assert.equal(error.blockedSource.url, url);
    assert.equal(error.blockedSource.kind, 'Teams chat');
    assert.match(error.message, /InsufficientPrivileges.*does not grant access.*verify your membership/);
    assert.equal(tools.workiq_read.isRecoverableError(error), false);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(connections.length, 1, 'a denial must not reconnect');
});

test('denied chat reads are not retried through changed queries, member lookups or path aliases', async () => {
  const paths = [];
  const { tools, connections } = toolHarness({ client: { readTool: async (_name, args) => {
    paths.push(args.entityUrls[0]);
    throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' });
  } } });
  for (const path of [
    '/chats/19%3Aprivate%40thread.v2/messages?$top=50',
    '/chats/19:private@thread.v2/messages?$top=1',
    '/me/chats/19%3aprivate%40thread.v2/members',
    '/users/test-user/chats/19:private@thread.v2',
  ]) {
    await assert.rejects(tools.workiq_read.execute({ path }), error => {
      assert.equal(error.statusCode, 403);
      assert.equal(tools.workiq_read.getBlockedSource(error).resource, paths[0]);
      assert.equal(tools.workiq_read.isRecoverableError(error), false);
      return true;
    });
  }
  assert.equal(paths.length, 1);
  assert.equal(connections.length, 1);
});

test('follow-up exclusions block only the denied resource and a fresh investigation can recheck access', async () => {
  const blockedSources = normalizeBlockedSources([{ resource: '/chats/private/messages?$top=1', status: 403, code: 'Forbidden' }]);
  const followup = toolHarness({ blockedSources });
  await assert.rejects(followup.tools.workiq_read.execute({ path: '/chats/private/members' }), /No permission retry was sent/);
  assert.equal(followup.connections.length, 0);
  assert.equal(followup.calls.length, 0);
  await followup.tools.workiq_read.execute({ path: '/chats/readable/messages?$top=1' });
  assert.equal(followup.calls.length, 1);
  const fresh = toolHarness();
  await fresh.tools.workiq_read.execute({ path: '/chats/private/messages?$top=1' });
  assert.equal(fresh.calls.length, 1);
});

test('blocked-source context validates resource identities and exact matching Teams links', () => {
  const resource = '/chats/19%3Aprivate%40thread.v2/messages?$top=1';
  const url = 'https://teams.microsoft.com/l/chat/19:private@thread.v2/conversations';
  const sources = normalizeBlockedSources([
    { resource, status: 403, url, code: 'Forbidden' },
    { resource, status: 403, url, code: 'Forbidden' },
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, url);
  assert.equal(sources[0].kind, 'Teams chat');
  for (const invalid of [
    null, {}, Array(101).fill(sources[0]),
    [{ ...sources[0], status: 401 }],
    [{ ...sources[0], resource: 'https://graph.microsoft.com/chats/private/messages' }],
    [{ ...sources[0], url: 'https://example.com/private' }],
    [{ ...sources[0], url: 'https://teams.microsoft.com/l/chat/another-chat/conversations' }],
  ]) assert.throws(() => normalizeBlockedSources(invalid), /Invalid blocked-source|relative Microsoft 365|does not match/);
});

test('an access denial never invents a source link or hides the original error behind a malformed ID', async () => {
  for (const path of ['/chats/unseen/messages?$top=1', '/chats/%FF/messages?$top=1', '/sites/private/drive?$select=id']) {
    const { tools } = toolHarness({
      client: { readTool: async () => { throw Object.assign(new Error('InsufficientPrivileges'), { statusCode: 403, code: 'Forbidden' }); } },
    });
    await assert.rejects(tools.workiq_read.execute({ path }), error => {
      assert.equal(error.blockedSource.url, null);
      assert.equal(error.blockedSource.resource, path);
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /InsufficientPrivileges/);
      return true;
    });
  }
});

test('an email read with no source ID fails before calling WorkIQ', async () => {
  const { tools, calls } = toolHarness();
  await assert.rejects(tools.workiq_read_email.execute({}), /Email message ID is required/);
  await assert.rejects(tools.workiq_read_email.execute({ messageId: null }), /Email message ID is required/);
  await assert.rejects(tools.workiq_read_email.execute({ messageId: '' }), /Email message ID is required/);
  assert.equal(calls.length, 0);
});

test('source-email evidence preserves full text without wasting its budget on HTML styling', async () => {
  const html = `<html><head><style>${'.logo{color:red}'.repeat(12000)}</style></head><body><p>The decision is approved.</p><blockquote>Original request remains available.</blockquote><a href="https://example.com/decision">Decision record</a></body></html>`;
  const { tools } = toolHarness({
    sourceMessageId: 'source',
    client: { readTool: async () => ({ structuredContent: { results: [{
      statusCode: 200, data: { id: 'source', webLink: source.url, body: { contentType: 'html', content: html } },
    }] } }) },
  });
  const result = await tools.workiq_read_email.execute({ messageId: null });
  assert.equal(result.truncated, false);
  const body = JSON.parse(result.text).results[0].data.body;
  assert.equal(body.contentType, 'text');
  assert.match(body.content, /decision is approved/);
  assert.match(body.content, /Original request remains available/);
  assert.match(body.content, /https:\/\/example.com\/decision/);
  assert.doesNotMatch(body.content, /\.logo/);
});

test('disconnected WorkIQ reports its actual error without contacting tools', async () => {
  const { tools, calls } = toolHarness({ ensureConnected: async () => ({ connected: false, error: 'WorkIQ sign-in expired' }) });
  await assert.rejects(tools.workiq_search.execute({ query: 'Find owners', scope: 'm365' }), /WorkIQ sign-in expired/);
  assert.equal(calls.length, 0);
});

test('cancellation during shared auth recovery prevents the subsequent private-data request', async () => {
  const controller = new AbortController();
  const { tools, calls } = toolHarness({
    signal: controller.signal,
    ensureConnected: async () => { controller.abort(new Error('Stopped')); return { connected: true }; },
  });
  await assert.rejects(tools.workiq_search.execute({ query: 'Find owners', scope: 'm365' }), /Stopped/);
  assert.equal(calls.length, 0);
});

test('WorkIQ reads reject external and malformed paths; document reads stay on work-document hosts', async () => {
  const { tools, calls } = toolHarness();
  for (const path of ['https://example.com/me', '/me/../admin', '/me\\messages', '/me/messages#fragment', '/me/messages\nheader']) {
    await assert.rejects(tools.workiq_read.execute({ path }), /relative Microsoft 365 record path/);
  }
  for (const url of ['https://example.com/document', 'https://tenant.sharepoint.com.evil.example/doc', 'http://tenant.sharepoint.com/doc']) {
    await assert.rejects(tools.workiq_document.execute({ url, question: 'What was decided?' }), /OneDrive or SharePoint URL/);
  }
  assert.equal(calls.length, 0);
  await tools.workiq_document.execute({ url: 'https://tenant.sharepoint.com/docs/design.docx', question: 'What was decided?' });
  assert.equal(calls[0][0], 'ask');
  assert.deepEqual(calls[0][1].fileUrls, ['https://tenant.sharepoint.com/docs/design.docx']);
  assert.equal(calls[0][1].agentId, undefined);
  assert.match(calls[0][1].question, /Do not create, modify, send, or share/);
});

test('evidence normalization retains record IDs, source metadata and explicit truncation', () => {
  const result = normalizeEvidence({
    structuredContent: {
      markdown: 'Summary only.',
      hits: [{ id: 'record-1', title: 'Decision', webUrl: source.url, body: 'Full source detail' }],
    },
  });
  assert.equal(JSON.parse(result.text).hits[0].id, 'record-1');
  assert.match(result.text, /Full source detail/);
  assert.deepEqual(result.sources, [{ url: source.url, title: 'Decision' }]);
  const long = normalizeEvidence({ content: [{ type: 'text', text: 'x'.repeat(24001) }] });
  assert.equal(long.text.length, 24000);
  assert.equal(long.truncated, true);
  assert.match(long.notice, /narrower query/);
});

test('evidence normalization reports MCP and Graph errors, including a status with no error body', () => {
  for (const result of [
    { isError: true },
    { structuredContent: { error: 'Denied' } },
    { structuredContent: { results: [{ statusCode: 403, data: { error: 'Denied' } }] } },
    { structuredContent: { results: [{ statusCode: 404 }] } },
    { content: [] },
  ]) assert.throws(() => normalizeEvidence(result), /no usable|failed|empty/);
});

test('structured WorkIQ errors retain the status and nested service message with no text content', () => {
  assert.throws(() => normalizeEvidence({
    isError: true,
    content: [],
    structuredContent: { results: [{
      statusCode: 400, data: null,
      error: { error: { code: 'RequestBroker--ParseUri', message: "Could not find a property named 'recipients'." } },
    }] },
  }), /HTTP 400.*RequestBroker--ParseUri.*recipients/);
});

test('public search does not send private task data or require WorkIQ; public reads need a returned source', async () => {
  const { tools, webCalls, connections } = toolHarness({ privateTerms: ['Fabrikam', 'Jane Doe'] });
  await assert.rejects(tools.web_read.execute({ url: source.url }), /returned by web_search/);
  const result = await tools.web_search.execute({ query: 'Official Electron context isolation guidance' });
  assert.equal(connections.length, 0);
  assert.deepEqual(result.sources, [source]);
  assert.equal(webCalls[0][0], 'web_search');
  assert.deepEqual(Object.keys(webCalls[0][1]), ['query']);
  assert.doesNotMatch(JSON.stringify(webCalls[0]), /Fabrikam|Jane Doe/);
  await tools.web_read.execute({ url: source.url });
  assert.equal(webCalls[1][0], 'web_fetch');
  assert.equal(webCalls[1][1].url, source.url);
  await assert.rejects(tools.web_read.execute({ url: 'https://tenant.sharepoint.com/private' }), /returned by web_search/);
});

test('public reads can follow exact references from a previously read public page, never private or invented URLs', async () => {
  const reference = 'https://www.electronjs.org/docs/latest/tutorial/security';
  const calls = [];
  const { tools } = toolHarness({ webTool: async (name, args) => {
    calls.push({ name, args });
    return name === 'web_search' ? copilotSearchResult()
      : { content: [{ type: 'text', text: `Source: ${source.url}\nRelated reference: ${reference}\nPrivate: https://tenant.sharepoint.com/private` }] };
  } });
  await tools.web_search.execute({ query: 'Official Electron documentation' });
  await tools.web_read.execute({ url: source.url });
  await tools.web_read.execute({ url: reference });
  assert.equal(calls[2].args.url, reference);
  await assert.rejects(tools.web_read.execute({ url: 'https://tenant.sharepoint.com/private' }), error => {
    assert.equal(tools.web_read.isRecoverableError(error), false);
    return true;
  });
  await assert.rejects(tools.web_read.execute({ url: 'https://www.electronjs.org/guessed' }), error => {
    assert.equal(error.code, 'WEB_SOURCE_NOT_DISCOVERED');
    assert.equal(tools.web_read.isRecoverableError(error), true);
    return true;
  });
  assert.equal(calls.length, 3, 'Rejected URLs must never reach the public service.');
});

test('the agent can discover and correct a public URL without losing earlier evidence or fetching a guessed URL', async () => {
  const target = 'https://www.electronjs.org/docs/latest/tutorial/security';
  const requests = [];
  const { tools } = toolHarness({ webTool: async (name, args) => {
    requests.push({ name, args });
    return name === 'web_search'
      ? copilotSearchResult({ sources: args.query === 'Find the specific security reference' ? [{ title: 'Specific security reference', url: target }] : [source] })
      : { content: [{ type: 'text', text: `Verified source ${target}` }] };
  } });
  const run = investigation([
    toolReply([
      toolCall('search-first', 'web_search', '{"query":"Official Electron documentation"}'),
      toolCall('undiscovered', 'web_read', JSON.stringify({ url: target })),
    ]),
    toolReply([toolCall('discover', 'web_search', '{"query":"Find the specific security reference"}')]),
    toolReply([toolCall('read-discovered', 'web_read', JSON.stringify({ url: target }))]),
    answer,
  ], { extraTools: tools, maxRounds: 5 });
  const completion = await run.run();
  assert.equal(completion.content, answer.content);
  assert.equal(completion.researchLimitReached, undefined);
  assert.deepEqual(requests.map(request => request.name), ['web_search', 'web_search', 'web_fetch']);
  assert.equal(requests.at(-1).args.url, target);
  const failure = JSON.parse(run.calls[1].toolMessages.at(-1).content);
  assert.equal(failure.error.code, 'WEB_SOURCE_NOT_DISCOVERED');
  assert.match(failure.recovery, /No page was fetched/);
  assert.equal(run.events.filter(event => event.phase === 'retry').length, 1);
  assert.ok(run.events.some(event => event.recovered && event.tool === 'web_read'));
});

test('identical public research is reused only within its investigation and emits an explicit notice', async () => {
  const events = [];
  const { tools, webCalls } = toolHarness({ onProgress: event => events.push(event) });
  const first = await tools.web_search.execute({ query: 'Official product documentation' });
  assert.deepEqual(await tools.web_search.execute({ query: 'Official product documentation' }), first);
  const read = await tools.web_read.execute({ url: source.url });
  assert.deepEqual(await tools.web_read.execute({ url: source.url }), read);
  assert.equal(webCalls.length, 2);
  assert.equal(events.filter(event => event.phase === 'reuse').length, 2);
  await tools.web_search.execute({ query: 'Another unanswered technical question' });
  assert.equal(webCalls.length, 3, 'Different questions must still reach the service.');
  const next = toolHarness();
  await assert.rejects(next.tools.web_read.execute({ url: source.url }), /returned by web_search/);
  await next.tools.web_search.execute({ query: 'Official product documentation' });
  assert.equal(next.webCalls.length, 1, 'A fresh investigation must get fresh evidence.');
});

test('failed or malformed public requests are never cached as usable research', async () => {
  for (const invalid of [null, { content: [{ type: 'text', text: 'An unsupported response envelope.' }] }]) {
    let requests = 0;
    const { tools } = toolHarness({ webTool: async () => {
      requests += 1;
      if (requests === 1) return invalid;
      return copilotSearchResult();
    } });
    await assert.rejects(tools.web_search.execute({ query: 'Official docs' }), /no usable|invalid or empty search response/);
    assert.deepEqual((await tools.web_search.execute({ query: 'Official docs' })).sources, [source]);
    assert.equal(requests, 2);
  }
});

test('public research accepts optional citations and Bing metadata without inventing source links', async () => {
  for (const response of [
    copilotSearchResult({ searches: [] }),
    copilotSearchResult({ sources: [] }),
    copilotSearchResult({ sources: [], searches: [], text: `A research summary mentioning ${source.url}` }),
    copilotSearchResult({ sources: [{ title: 'Private', url: 'https://tenant.sharepoint.com/private' }] }),
    copilotSearchResult({ sources: [{ title: 'Query URL is not a cited page', url: 'https://www.bing.com/search?q=claim' }] }),
    copilotSearchResult({ searches: [{ url: 'https://unverified.example.com/search?q=claim' }] }),
    { structuredContent: { type: 'output_text', text: { value: 'Useful search research with no citation metadata.' } } },
  ]) {
    let requests = 0;
    const events = [];
    const { tools } = toolHarness({
      onProgress: event => events.push(event),
      webTool: async () => { requests++; return response; },
    });
    const result = await tools.web_search.execute({ query: 'A specific public question' });
    assert.ok(result.text.length > 0);
    assert.match(result.notice, /Citations are optional/);
    assert.equal(result.outcome, undefined, 'Missing citations must not be mislabeled as no results.');
    assert.deepEqual(await tools.web_search.execute({ query: 'A specific public question' }), result);
    assert.equal(requests, 1, 'Missing citations must not cause retries or prevent normal result reuse.');
    assert.ok(events.some(event => event.phase === 'reuse'));
    if (!result.sources.length) {
      assert.match(result.warning, /no source citations.*uncited research/);
      await assert.rejects(tools.web_read.execute({ url: source.url }), /returned by web_search/);
    } else {
      assert.deepEqual(result.sources, [source]);
      assert.equal(result.warning, undefined);
    }
  }
});

test('optional citations do not turn actual service errors or empty responses into research', () => {
  for (const invalid of [
    null,
    { isError: true, content: [{ type: 'text', text: 'Permission denied.' }] },
    { structuredContent: { error: { code: 'Forbidden', message: 'Policy denied access.' } } },
    { structuredContent: { type: 'output_text', text: { value: '' } } },
    { structuredContent: { type: 'output_text', text: { value: ' \n ' } } },
    { structuredContent: { type: 'output_text', text: { annotations: [{ url_citation: source }] } } },
    { structuredContent: { type: 'unknown', text: { value: 'Unexpected envelope.' } } },
  ]) assert.throws(() => normalizeCopilotSearch(invalid), /no usable|failed|invalid or empty/);
});

test('uncited summaries retain the truncation limit and both supported citation locations remain usable', () => {
  const long = normalizeCopilotSearch(copilotSearchResult({ text: 'x'.repeat(24001), sources: [], searches: [] }));
  assert.equal(long.text.length, 24000);
  assert.equal(long.truncated, true);
  assert.match(long.warning, /uncited research/);
  for (const location of ['text', 'top']) {
    const payload = { type: 'output_text', text: { value: 'Research summary.' } };
    const annotations = [null, { url_citation: { url: 'https://tenant.sharepoint.com/private' } }, { url_citation: source }, { url_citation: source }];
    if (location === 'text') payload.text.annotations = annotations;
    else payload.annotations = annotations;
    const result = normalizeCopilotSearch({ structuredContent: payload });
    assert.deepEqual(result.sources, [source]);
    assert.equal(result.warning, undefined);
  }
});

test('only citation annotations authorize public sources, not Bing query URLs or generated prose URLs', async () => {
  const invented = 'https://www.electronjs.org/guessed';
  const result = copilotSearchResult({
    text: `A summary mentioning ${invented}.`,
    sources: [source, { title: 'Bing query', url: 'https://www.bing.com/search?q=official+documentation' }],
  });
  const normalized = normalizeCopilotSearch(result);
  assert.deepEqual(normalized.sources, [source]);
  assert.match(normalized.notice, /AI-generated search summary, not a page read/);
  const { tools } = toolHarness({ webTool: async () => result });
  await tools.web_search.execute({ query: 'Official documentation' });
  for (const url of [invented, 'https://www.bing.com/search?q=official+documentation']) {
    await assert.rejects(tools.web_read.execute({ url }), error => error.code === 'WEB_SOURCE_NOT_DISCOVERED');
  }
});

test('HTML references retain their exact URLs and are not reinvented by scanning the page text', () => {
  const reference = 'https://www.electronjs.org/page_(reference)';
  const invented = 'https://www.electronjs.org/not-a-hyperlink';
  const text = `Official text with a real link [${reference}] and a plain example ${invented}.`;
  const result = normalizeEvidence({ structuredContent: {
    url: source.url, text, references: [{ url: reference }], truncated: false,
    startIndex: 0, totalCharacters: text.length,
    redirectNotice: `The source redirected to ${source.url}.`,
  } }, { publicOnly: true });
  assert.equal(result.text, text);
  assert.deepEqual(result.sources.map(item => item.url), [source.url, reference]);
  assert.equal(result.startIndex, 0);
  assert.equal(result.totalCharacters, text.length);
  assert.match(result.redirectNotice, /redirected/);
});

test('page truncation and continuation offsets survive the evidence layer and cache by range', async () => {
  const calls = [];
  const { tools } = toolHarness({ webTool: async (name, args) => {
    calls.push({ name, args });
    return name === 'web_search' ? copilotSearchResult() : { structuredContent: {
      url: source.url, text: args.start_index ? 'Following part.' : 'First part.',
      truncated: args.start_index === 0,
      ...(args.start_index === 0 ? { nextStartIndex: 18000, notice: 'Read the next page window.' } : {}),
    } };
  } });
  await tools.web_search.execute({ query: 'Official documentation' });
  const first = await tools.web_read.execute({ url: source.url });
  assert.equal(first.truncated, true);
  assert.equal(first.nextStartIndex, 18000);
  assert.equal(first.notice, 'Read the next page window.');
  const next = await tools.web_read.execute({ url: source.url, startIndex: first.nextStartIndex });
  assert.equal(next.truncated, false);
  assert.equal(calls.at(-1).args.start_index, 18000);
  await tools.web_read.execute({ url: source.url, startIndex: first.nextStartIndex });
  assert.equal(calls.length, 3, 'Repeated reads can reuse the same range but not a different range.');
});

for (const api of ['chat', 'responses']) {
  test(`${api} can combine uncited web summaries with continuing WorkIQ research and finish normally`, async () => {
    const summary = 'Useful public technical research without source citations.';
    let webRequests = 0;
    const { tools, calls: privateCalls } = toolHarness({
      webTool: async () => {
        webRequests++;
        return copilotSearchResult({ sources: [], searches: [], text: summary });
      },
    });
    const calls = [
      toolCall('private-search', 'workiq_search', '{"query":"Related decision","scope":"m365"}'),
      toolCall('uncited-public-search', 'web_search', '{"query":"Specific public technical documentation"}'),
    ];
    const responseInput = [{ role: 'user', content: 'Investigate' }];
    const responseOutput = [
      { type: 'reasoning', encrypted_content: 'keep-reasoning' },
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
    ];
    const run = investigation([{
      ...toolReply(calls), api, ...(api === 'responses' ? { responseInput, responseOutput } : {}),
    }, () => {
      const next = toolCall('connected-work', 'workiq_search', '{"query":"Related connected records","scope":"enterprise"}');
      return {
        ...toolReply([next]), api,
        ...(api === 'responses' ? {
          responseInput: run.calls[1].responseInput,
          responseOutput: [{ type: 'function_call', call_id: next.id, name: next.function.name, arguments: next.function.arguments }],
        } : {}),
      };
    }, { ...answer, content: 'The work sources and uncited public research suggest the following next steps.' }], { extraTools: tools, maxRounds: 4 });
    const result = await run.run();
    assert.match(result.content, /work sources and uncited public research/);
    assert.equal(result.outcome, undefined, 'Missing citations alone must not force a partial/failure outcome.');
    assert.equal(run.calls.length, 3);
    assert.equal(run.calls[1].toolChoice, 'auto');
    assert.ok(run.calls.every(call => call.reasoningEffort === 'high'));
    assert.equal(privateCalls.length, 2);
    assert.deepEqual(privateCalls.map(call => call[1].strategy), ['grounding', 'copilot']);
    assert.equal(webRequests, 1);
    const context = api === 'responses' ? run.calls[1].responseInput : run.calls[1].toolMessages;
    const publicResearch = JSON.parse(api === 'responses' ? context.at(-1).output : context.at(-1).content);
    assert.equal(publicResearch.text, summary);
    assert.deepEqual(publicResearch.sources, []);
    assert.match(publicResearch.warning, /no source citations/);
    if (api === 'responses') assert.ok(JSON.stringify(context).includes('keep-reasoning'));
    assert.equal(run.events.filter(event => event.phase === 'evidence').length, 3);
    assert.equal(run.events.filter(event => event.warning).length, 1);
    assert.equal(run.events.filter(event => event.phase === 'empty').length, 0);
    assert.ok(!run.events.some(event => ['error', 'retry'].includes(event.phase)));
    assert.equal(run.events.at(-1).phase, 'complete');
  });
}

for (const api of ['chat', 'responses']) {
  test(`${api} investigation preserves its email evidence and reasoning through a Copilot search disconnect and throttle`, async () => {
    let clock = Date.now();
    const requests = [];
    const retries = [];
    const webTool = createPublicWebClient({
      getToken: () => 'test-github-token',
      now: () => clock, sleep: async ms => { clock += ms; },
      fetchImpl: async (url, init) => {
        const request = JSON.parse(init.body);
        const ok = result => ({ ok: true, text: async () => JSON.stringify({ id: request.id, result }) });
        if (request.method === 'initialize') return ok({ protocolVersion: '2025-03-26', capabilities: { tools: {} } });
        if (request.method === 'notifications/initialized') return { ok: true, text: async () => '' };
        if (request.method === 'tools/list') return ok({ tools: [{
          name: 'web_search', annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }] });
        requests.push({ url, body: init.body });
        if (requests.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
        if (requests.length === 2) return {
          ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }),
          text: async () => JSON.stringify({ id: null, error: { message: 'GitHub search rate limit' } }),
        };
        return ok(copilotSearchResult());
      },
    });
    const { tools, calls: privateCalls } = toolHarness({
      sourceMessageId: 'private-email-id', privateTerms: ['Fabrikam'], webTool,
      onProgress: event => retries.push(event),
    });
    const calls = [
      toolCall('email-read', 'workiq_read_email', '{"messageId":null}'),
      toolCall('public-search', 'web_search', '{"query":"Official Electron context isolation guidance"}'),
    ];
    const responseInput = [{ role: 'user', content: 'Investigate the private task' }];
    const responseOutput = [
      { type: 'reasoning', encrypted_content: 'opaque-reasoning-preserved' },
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
    ];
    const run = investigation([{
      ...toolReply(calls), api,
      ...(api === 'responses' ? { responseInput, responseOutput } : {}),
    }, answer], { extraTools: tools });
    const completion = await run.run();
    assert.equal(completion.content, answer.content);
    assert.equal(privateCalls.length, 1, 'A web retry must not rerun the private investigation.');
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.url === requests[0].url && request.body === requests[0].body));
    assert.doesNotMatch(requests[0].body, /private-email-id|Fabrikam/);
    assert.equal(retries.length, 2);
    assert.ok(retries.every(event => event.phase === 'retry'));
    assert.equal(run.calls[1].reasoningEffort, 'high');
    if (api === 'responses') {
      assert.deepEqual(run.calls[1].responseInput.slice(0, 4), [...responseInput, ...responseOutput]);
      assert.deepEqual(run.calls[1].responseInput.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['email-read', 'public-search']);
    } else {
      assert.deepEqual(run.calls[1].toolMessages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['email-read', 'public-search']);
    }
    assert.equal(run.events.at(-1).phase, 'complete');
  });
}

test('an exhausted Copilot search allowance preserves its retry time through the runtime and blocks completion', async () => {
  const retryAt = Date.now() + 7200000;
  const failure = Object.assign(new Error('GitHub search allowance unavailable until reset'), { code: 'COPILOT_WEB_RATE_LIMIT', retryAt });
  const { tools } = toolHarness({ webTool: async () => { throw failure; } });
  const run = investigation([toolReply([toolCall('web', 'web_search', '{"query":"Official docs"}')]), answer], { extraTools: tools });
  await assert.rejects(run.run(), error => {
    assert.equal(error.cause, failure);
    assert.equal(error.cause.retryAt, retryAt);
    return true;
  });
  assert.equal(run.calls.length, 1);
  assert.ok(!run.events.some(event => event.phase === 'complete'));
});

test('private public-search arguments are rejected before the external service is called', async () => {
  const { tools, webCalls } = toolHarness({ privateTerms: ['Fabrikam', 'Jane Doe'] });
  for (const query of [
    'Fabrikam migration plans', 'Find Jane Doe', 'jane@example.com',
    'https://tenant.sharepoint.com/private', 'token=private-test-value',
    '12345678-abcd-abcd-abcd-123456789abc',
  ]) await assert.rejects(tools.web_search.execute({ query }), /Public web queries cannot|task-specific/);
  assert.equal(webCalls.length, 0);
});

test('unsupported public-search envelopes still fail even if their text mentions a source', async () => {
  for (const text of ['An answer without sources.', 'https://127.0.0.1/private', 'https://tenant.sharepoint.com/private']) {
    const { tools } = toolHarness({ webTool: async () => ({ content: [{ type: 'text', text }] }) });
    await assert.rejects(tools.web_search.execute({ query: 'Official product documentation' }), /invalid or empty search response/);
  }
});
