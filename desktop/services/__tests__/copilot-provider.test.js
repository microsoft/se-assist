'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const githubAuth = require('../github-auth');
const provider = require('../copilot-provider');

// Stub the GitHub OAuth token so getCopilotToken() proceeds to the (mocked) token exchange.
const origGetToken = githubAuth.getToken;
githubAuth.getToken = () => 'gho_test';

const origFetch = global.fetch;
function mkResp(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}
const TOKEN_OK = mkResp(200, {
  token: 'copilot_tok',
  expires_at: Math.floor(Date.now() / 1000) + 100000,
  endpoints: { api: 'https://mock.local' },
});

// Captured request bodies, in order, for assertions.
let bodies;
beforeEach(() => {
  bodies = [];
  provider._resetSchedulerForTests({
    maxConcurrent: 1,
    minIntervalMs: 0,
    maxAutoCooldownMs: 30_000,
    maxCooldownRetries: 1,
  });
});

function installFetch(route) {
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('copilot_internal/v2/token')) return TOKEN_OK;
    bodies.push({ url: u, body });
    return route(u, body, bodies.length);
  };
}

test('routes a Responses-only model through /responses with high reasoning effort and reasoning headroom on the output budget', async () => {
  installFetch((u) => {
    if (u.endsWith('/chat/completions')) {
      return mkResp(400, { error: { code: 'unsupported_api_for_model', message: 'unsupported_api_for_model: use /responses' } });
    }
    return mkResp(200, { status: 'completed', output_text: 'HELLO', model: 'gpt-5.6-sol', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } });
  });

  const res = await provider.chat('sys', 'user', { model: 'gpt-5.6-sol', maxTokens: 700 });
  assert.equal(res.content, 'HELLO');
  assert.equal(res.model, 'gpt-5.6-sol');

  const responsesCalls = bodies.filter((b) => b.url.endsWith('/responses'));
  assert.equal(responsesCalls.length, 1, 'no retry/padding — a single call');
  // High reasoning effort. On the Responses API max_output_tokens caps
  // reasoning + answer, so the caller's answer budget (700) carries reasoning headroom on top —
  // otherwise reasoning can starve the answer to empty (the HoK "model busy" bug).
  assert.deepEqual(responsesCalls[0].body.reasoning, { effort: 'high' });
  assert.ok(responsesCalls[0].body.max_output_tokens > 700, 'answer budget carries reasoning headroom');
  assert.equal(responsesCalls[0].body.max_output_tokens, 700 + 25000);
});

test('Responses genuinely-empty content surfaces a "try again" notice — no retry, no fallback, no substitution', async () => {
  installFetch((u) => {
    if (u.endsWith('/chat/completions')) {
      return mkResp(400, { error: { code: 'unsupported_api_for_model', message: 'unsupported_api_for_model' } });
    }
    // Model completed but produced no visible message this call — a real transient hiccup.
    return mkResp(200, { status: 'completed', output: [] });
  });

  await assert.rejects(
    provider.chat('sys', 'user', { model: 'gpt-5.6-sol', maxTokens: 700 }),
    /busy right now|try again/i,
  );
  // Exactly one /responses attempt — the notice is surfaced immediately, nothing is grown or swapped.
  const responsesCalls = bodies.filter((b) => b.url.endsWith('/responses'));
  assert.equal(responsesCalls.length, 1);
});

test('Responses truncated-with-no-output is reported honestly as budget exhaustion, not "busy"', async () => {
  installFetch((u) => {
    if (u.endsWith('/chat/completions')) {
      return mkResp(400, { error: { code: 'unsupported_api_for_model', message: 'unsupported_api_for_model' } });
    }
    // Reasoning ate the whole budget before writing an answer — deterministic, not transient.
    return mkResp(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  });

  await assert.rejects(
    provider.chat('sys', 'user', { model: 'gpt-5.6-sol', maxTokens: 700 }),
    (err) => /budget on reasoning|unusually large|narrow the scope/i.test(err.message)
      && !/busy right now/i.test(err.message)
      && !/isn't available/i.test(err.message),
  );
  const responsesCalls = bodies.filter((b) => b.url.endsWith('/responses'));
  assert.equal(responsesCalls.length, 1, 'no retry — reported immediately and honestly');
});

test('chat-completions empty content surfaces the same "try again" notice without retrying', async () => {
  installFetch(() => mkResp(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }], model: 'reason-x' }));

  await assert.rejects(
    provider.chat('sys', 'user', { model: 'reason-x', maxTokens: 700 }),
    /busy right now|try again/i,
  );
  const chatCalls = bodies.filter((b) => b.url.endsWith('/chat/completions'));
  assert.equal(chatCalls.length, 1, 'no retry on empty content');
});

test('identical side-effect-free prompts share one in-flight provider request', async () => {
  let release;
  installFetch(() => new Promise(resolve => { release = () => resolve(mkResp(200, {
    choices: [{ message: { content: 'shared answer' }, finish_reason: 'stop' }],
    model: 'selected-model',
  })); }));

  const first = provider.chat('same system', 'same user', { model: 'selected-model' });
  const second = provider.chat('same system', 'same user', { model: 'selected-model' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies.length, 1, 'only one model request starts');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.content), ['shared answer', 'shared answer']);
  assert.equal(bodies.filter(({ url }) => url.endsWith('/chat/completions')).length, 1);
});

test('a Responses timeout is surfaced honestly (as a timeout), not as "model unavailable"', async () => {
  // Honor the abort signal so the per-call timeoutMs actually fires.
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('copilot_internal/v2/token')) return TOKEN_OK;
    if (u.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model', message: 'unsupported_api_for_model' } });
    // /responses: never resolve — reject when the AbortController fires.
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
  };
  await assert.rejects(
    provider.chat('sys', 'user', { model: 'gpt-5.6-sol', maxTokens: 700, timeoutMs: 60 }),
    (err) => /timed out/i.test(err.message) && !/isn't available/i.test(err.message),
  );
});

test('default reasoning effort steps down (high → medium) when the endpoint rejects high, instead of dropping it', async () => {
  installFetch((u, body) => {
    if (u.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model', message: 'unsupported_api_for_model' } });
    if (u.endsWith('/responses') && body && body.reasoning && body.reasoning.effort === 'high') {
      return mkResp(400, { error: { message: "Invalid value for 'reasoning.effort': 'high'." } });
    }
    return mkResp(200, { status: 'completed', output_text: 'OK', model: 'gpt-5.6-sol' });
  });
  const res = await provider.chat('sys', 'user', { model: 'gpt-5.6-sol', maxTokens: 700 });
  assert.equal(res.content, 'OK');
  const responsesCalls = bodies.filter((b) => b.url.endsWith('/responses'));
  assert.equal(responsesCalls[0].body.reasoning.effort, 'high', 'tries the configured default first');
  assert.equal(responsesCalls[1].body.reasoning.effort, 'medium', 'steps down one rung, not dropped');
});

const researchTools = [{
  type: 'function',
  function: { name: 'search', description: 'Read a source', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
}];
const researchCall = { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"query":"documentation"}' } };

test('native Chat tools accept tool-only replies and carry results into the next turn', async () => {
  installFetch((_url, _body, count) => mkResp(200, {
    choices: [{ message: count === 1 ? { content: null, tool_calls: [researchCall] } : { content: 'Grounded answer' }, finish_reason: count === 1 ? 'tool_calls' : 'stop' }],
    model: 'selected-model',
  }));
  const options = { model: 'selected-model', tools: researchTools, reasoningEffort: 'xhigh', maxTokens: 6000, toolChoice: 'required' };
  const first = await provider.chat('sys', 'user', options);
  assert.equal(first.content, '');
  assert.equal(first.api, 'chat');
  assert.deepEqual(first.toolCalls, [researchCall]);
  assert.equal(bodies[0].body.reasoning_effort, 'xhigh');
  assert.equal(bodies[0].body.max_tokens, 31000);
  assert.equal(bodies[0].body.tool_choice, 'required');
  assert.equal(bodies[0].body.temperature, undefined);
  assert.deepEqual(bodies[0].body.tools, researchTools);
  const toolMessages = [
    { role: 'assistant', content: null, tool_calls: first.toolCalls },
    { role: 'tool', tool_call_id: 'call-1', content: '{"text":"Evidence"}' },
  ];
  const second = await provider.chat('sys', 'user', { ...options, toolChoice: 'auto', toolMessages });
  assert.equal(second.content, 'Grounded answer');
  assert.deepEqual(bodies[1].body.messages.slice(2), toolMessages);
  assert.equal(bodies[1].body.model, 'selected-model');
});

test('native Responses tools retain encrypted reasoning and continue without going back to Chat', async () => {
  const output = [
    { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'opaque-test-reasoning' },
    { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'search', arguments: '{"query":"documentation"}' },
  ];
  installFetch((url, body) => {
    if (url.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model' } });
    return mkResp(200, body.input === 'user'
      ? { status: 'completed', output, model: 'selected-model' }
      : { status: 'completed', output_text: 'Grounded answer', model: 'selected-model' });
  });
  const options = { model: 'selected-model', tools: researchTools, reasoningEffort: 'xhigh', toolChoice: 'required' };
  const first = await provider.chat('sys', 'user', options);
  assert.equal(first.api, 'responses');
  assert.deepEqual(first.toolCalls, [researchCall]);
  assert.deepEqual(first.responseOutput, output);
  assert.equal(bodies[1].body.store, false);
  assert.deepEqual(bodies[1].body.include, ['reasoning.encrypted_content']);
  assert.equal(bodies[1].body.reasoning.effort, 'xhigh', 'a cached lower default must not lower explicit reasoning');
  assert.equal(bodies[1].body.tools[0].name, 'search');
  assert.equal(bodies[1].body.tools[0].function, undefined);
  const responseInput = [...first.responseInput, ...first.responseOutput, { type: 'function_call_output', call_id: 'call-1', output: 'Evidence' }];
  const second = await provider.chat('sys', 'user', { ...options, toolChoice: 'auto', responseInput });
  assert.equal(second.content, 'Grounded answer');
  assert.equal(bodies.length, 3);
  assert.ok(bodies[2].url.endsWith('/responses'));
  assert.deepEqual(bodies[2].body.input, responseInput);
});

for (const api of ['chat', 'responses']) {
  test(`explicit xhigh rejection on ${api} fails without a reasoning or model downgrade`, async () => {
    installFetch((url) => {
      if (api === 'responses' && url.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model' } });
      return mkResp(400, { error: { message: 'Unsupported reasoning effort xhigh.' } });
    });
    await assert.rejects(provider.chat('sys', 'user', {
      model: 'selected-model', tools: researchTools, reasoningEffort: 'xhigh',
    }), (err) => err.code === 'REASONING_UNSUPPORTED' && /will not lower reasoning/.test(err.message));
    assert.equal(bodies.length, api === 'responses' ? 2 : 1);
    assert.ok(bodies.every(({ body }) => body.model === 'selected-model'));
  });
}

test('tool-enabled empty Chat truncation is budget exhaustion, not a busy-model notice', async () => {
  installFetch(() => mkResp(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
  await assert.rejects(provider.chat('sys', 'user', { tools: researchTools, reasoningEffort: 'xhigh' }),
    (err) => err.code === 'RESPONSES_BUDGET_EXHAUSTED' && /budget/.test(err.message));
  assert.equal(bodies.length, 1);
});

for (const api of ['chat', 'responses']) {
  test(`cancelling ${api} stops the request without an availability error or retry`, async () => {
    const controller = new AbortController();
    let requests = 0;
    global.fetch = async (url, init) => {
      if (String(url).includes('copilot_internal/v2/token')) return TOKEN_OK;
      requests += 1;
      if (api === 'responses' && String(url).endsWith('/chat/completions')) {
        return mkResp(400, { error: { code: 'unsupported_api_for_model' } });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        setImmediate(() => controller.abort(new Error('Stopped for test')));
      });
    };
    await assert.rejects(provider.chat('sys', 'user', {
      tools: researchTools, reasoningEffort: 'xhigh', signal: controller.signal,
    }), /^Error: Stopped for test$/);
    assert.equal(requests, api === 'responses' ? 2 : 1);
  });
}

for (const status of [429, 503]) {
  test(`Responses HTTP ${status} retains service metadata instead of recommending another model`, async () => {
    installFetch(url => {
      if (url.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model' } });
      return { ...mkResp(status, { error: { message: 'Temporary service failure' } }), headers: { get: name => name === 'Retry-After' ? '60' : null } };
    });
    await assert.rejects(provider.chat('sys', 'user', { model: 'selected-model', reasoningEffort: 'xhigh' }), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.code, 'COPILOT_HTTP_ERROR');
      assert.ok(error.retryAt > Date.now());
      assert.doesNotMatch(error.message, /Choose a Chat-compatible model/);
      return true;
    });
  });
}

test('HTTP 429 without retry metadata still creates a short shared cooldown', async () => {
  provider._resetSchedulerForTests({
    maxConcurrent: 1,
    minIntervalMs: 0,
    maxAutoCooldownMs: 30_000,
    maxCooldownRetries: 0,
  });
  installFetch(url => {
    if (url.endsWith('/chat/completions')) return mkResp(429, { error: { message: 'quota exceeded' } });
    throw new Error(`Unexpected URL: ${url}`);
  });
  await assert.rejects(provider.chat('sys', 'user', { model: 'selected-model' }), error => {
    assert.equal(error.statusCode, 429);
    assert.ok(error.retryAt >= Date.now());
    return true;
  });
  assert.equal(provider.getActivity().phase, 'cooldown');
});

// ── Pinned models (Secretary top-level chat) ─────────────────────────────────
const appPrefs = require('../app-prefs');
const pinned = { model: 'gpt-5.6-luna', reasoningEffort: 'high', modelPinned: true, requestLabel: 'Secretary' };

function withSettingsModels(run) {
  const originalSet = appPrefs.set;
  appPrefs.set = () => true; // never write the developer's real prefs file
  provider.setModel('settings-primary');
  provider.setUtilityModel('settings-utility');
  return Promise.resolve().then(run).finally(() => {
    provider.setModel(null);
    provider.setUtilityModel(null);
    appPrefs.set = originalSet;
  });
}

for (const modelRole of ['primary', 'utility']) {
  test(`a pinned ${modelRole} request runs its own model with high reasoning, not the Settings model`, () => withSettingsModels(async () => {
    assert.equal(provider.getModelNameForRole(modelRole), `settings-${modelRole}`, 'Settings selects a different model');
    installFetch(() => mkResp(200, { choices: [{ message: { content: 'Todos' }, finish_reason: 'stop' }], model: 'gpt-5.6-luna-2026-01-01' }));
    const res = await provider.chat('sys', 'user', { ...pinned, modelRole, maxTokens: 700 });
    assert.equal(res.content, 'Todos');
    assert.equal(res.model, 'gpt-5.6-luna-2026-01-01', 'reports the model that actually ran');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].body.model, 'gpt-5.6-luna');
    assert.equal(bodies[0].body.reasoning_effort, 'high');
    assert.equal(bodies[0].body.temperature, undefined);
    assert.equal(bodies[0].body.max_tokens, 700 + 25000);
  }));
}

for (const api of ['chat', 'responses']) {
  test(`a pinned request rejected for high reasoning on ${api} fails without pointing to Settings`, async () => {
    installFetch((url) => {
      if (api === 'responses' && url.endsWith('/chat/completions')) return mkResp(400, { error: { code: 'unsupported_api_for_model' } });
      return mkResp(400, { error: { message: 'Unsupported reasoning effort high.' } });
    });
    await assert.rejects(provider.chat('sys', 'user', pinned), (err) => {
      assert.equal(err.code, 'REASONING_UNSUPPORTED');
      assert.match(err.message, /Secretary runs only on GitHub Copilot model "gpt-5\.6-luna" with high reasoning/);
      assert.match(err.message, /will not lower reasoning or switch models/);
      assert.doesNotMatch(err.message, /Settings/);
      return true;
    });
    assert.ok(bodies.every(({ body }) => body.model === 'gpt-5.6-luna'));
    assert.ok(bodies.every(({ body }) => (body.reasoning_effort || body.reasoning?.effort) === 'high'));
  });
}

test('a pinned model unavailable on every API fails loudly without suggesting another model', async () => {
  installFetch((url) => url.endsWith('/chat/completions')
    ? mkResp(400, { error: { code: 'unsupported_api_for_model' } })
    : mkResp(404, { error: { message: 'Not found' } }));
  await assert.rejects(provider.chat('sys', 'user', pinned), (err) => {
    assert.match(err.message, /Secretary runs only on GitHub Copilot model "gpt-5\.6-luna"/);
    assert.match(err.message, /will not switch models automatically/);
    assert.doesNotMatch(err.message, /Choose a Chat-compatible model/);
    return true;
  });
  assert.ok(bodies.every(({ body }) => body.model === 'gpt-5.6-luna'));
});

test('a pinned model the account cannot use fails with an error naming that model', async () => {
  installFetch(() => mkResp(400, { error: { message: 'The requested model is not supported.' } }));
  await assert.rejects(provider.chat('sys', 'user', pinned), (err) => {
    assert.equal(err.code, 'COPILOT_HTTP_ERROR');
    assert.match(err.message, /failed for model "gpt-5\.6-luna": HTTP 400/);
    return true;
  });
  assert.equal(bodies.length, 1);
});

test.after(() => { global.fetch = origFetch; githubAuth.getToken = origGetToken; });
