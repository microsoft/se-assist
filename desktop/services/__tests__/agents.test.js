'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWLEDGE,
  composeKnowledge,
  knowledgeTitle,
} = require('../agents/knowledge');
const { applyMemory } = require('../agents/memory');
const { AGENTS, SECRETARY_CHAT_MODEL } = require('../agents/catalog');
const { createAgentRuntime } = require('../agents/runtime');
const agentsIndex = require('../agents');
const { resolveAgents } = agentsIndex;

// ── knowledge ────────────────────────────────────────────────────────────────
test('knowledge: persona block is the exact historical string', () => {
  assert.equal(
    KNOWLEDGE['se-assist-persona'].text,
    'You are SE Assist, an internal Microsoft assistant for a financial-services solution engineer.',
  );
});

test('knowledge: presentation rules carry every hard requirement and the theme colors', () => {
  const t = KNOWLEDGE['presentation-html-rules'].text;
  assert.match(t, /Output ONLY the HTML document\. Start with <!doctype html>/);
  assert.match(t, /Fully self-contained: ALL CSS inline in one <style> tag/);
  assert.match(t, /Avoid JavaScript\./);
  assert.match(t, /background #ffffff, text #1f2333, accent blue #4c63d2/);
  assert.match(t, /Add a clean @media print rule\./);
});

test('knowledge: composeKnowledge joins in order and rejects unknown ids', () => {
  const composed = composeKnowledge(['se-assist-persona', 'grounding-contract']);
  assert.equal(
    composed,
    `${KNOWLEDGE['se-assist-persona'].text} ${KNOWLEDGE['grounding-contract'].text}`,
  );
  assert.throws(() => composeKnowledge(['nope']), /Unknown knowledge block: nope/);
  assert.equal(knowledgeTitle('se-assist-persona'), 'SE Assist persona');
});

// ── memory ─────────────────────────────────────────────────────────────────
test('memory: none and empty conversation produce no preamble', () => {
  assert.equal(applyMemory('none', {}).preamble, '');
  assert.equal(applyMemory('conversation', { history: [] }).preamble, '');
  assert.equal(applyMemory({ type: 'conversation' }, {}).preamble, '');
});

test('memory: conversation preamble matches the legacy assistant prompt format exactly', () => {
  const history = [
    { role: 'user', content: 'Who is pressing?' },
    { role: 'assistant', content: 'Contoso milestone is overdue.' },
  ];
  // Legacy inline formatting from buildAssistantPrompt.
  const legacy = `Recent conversation:\n${history
    .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n')}\n\n`;
  assert.equal(applyMemory('conversation', { history }).preamble, legacy);
});

test('memory: preamble + no-history user message reproduces the legacy user message', () => {
  // The runtime prepends the memory preamble to a render that omits history. With a
  // leading empty line (priorTurns collapsed to ''), this must equal the legacy
  // `${priorTurns}\nQuestion: ...` concatenation for both empty and non-empty history.
  const question = 'What is top of mind for Contoso?';
  const body = ['', `Question: ${question}`, '', 'Context (JSON):', '{}'].join('\n');

  for (const history of [[], [{ role: 'user', content: 'hi' }]]) {
    const priorTurns = history.length
      ? `Recent conversation:\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}\n\n`
      : '';
    const legacyUser = [priorTurns, `Question: ${question}`, '', 'Context (JSON):', '{}'].join('\n');
    const runtimeUser = applyMemory('conversation', { history }).preamble + body;
    assert.equal(runtimeUser, legacyUser);
  }
});

test('memory: maxTurns keeps only the most recent turns', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = applyMemory({ type: 'conversation', maxTurns: 3 }, { history }).preamble;
  assert.match(out, /User: m17\nUser: m18\nUser: m19/);
  assert.doesNotMatch(out, /m16/);
});

// ── catalog ────────────────────────────────────────────────────────────────
test('catalog: every agent is well-formed and ids are unique', () => {
  const ids = new Set();
  for (const a of AGENTS) {
    assert.ok(a.id, 'agent has id');
    assert.ok(a.name, `${a.id} has name`);
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    for (const k of a.knowledge || []) {
      assert.ok(KNOWLEDGE[k], `${a.id} references known knowledge block ${k}`);
    }
  }
  // Core synthesis and assistant features remain registered. HTML presentation is
  // rendered deterministically and no longer consumes a second model request.
  assert.ok(ids.has('sales-advisor'));
  assert.ok(ids.has('assistant'));
});

test('catalog: only the Secretary top-level chat pins gpt-5.6-luna with high reasoning', () => {
  assert.deepEqual({ ...SECRETARY_CHAT_MODEL }, { model: 'gpt-5.6-luna', reasoningEffort: 'high' });
  assert.ok(Object.isFrozen(SECRETARY_CHAT_MODEL));
  assert.equal(agentsIndex.SECRETARY_CHAT_MODEL, SECRETARY_CHAT_MODEL);
  const pinned = AGENTS.filter((a) => a.model?.model);
  assert.deepEqual(pinned.map((a) => a.id).sort(), ['secretary', 'secretary-scope']);
  for (const agent of pinned) {
    assert.equal(agent.model.model, 'gpt-5.6-luna');
    assert.equal(agent.model.reasoningEffort, 'high');
  }
  // Solve (Work Agent and Work Outputs) keeps the model selected in Settings.
  for (const id of ['work-agent', 'work-output', 'work-output-public-query', 'work-output-gap-triage', 'work-output-gap-answer']) {
    assert.equal(AGENTS.find((a) => a.id === id).model.model, undefined, id);
  }
});

// ── runtime ──────────────────────────────────────────────────────────────────
function fakeProvider() {
  const calls = [];
  return {
    calls,
    chat(systemMessage, userMessage, options) {
      calls.push({ systemMessage, userMessage, options });
      return { content: 'MODEL_OUTPUT', usage: { total: 1 }, finishReason: 'stop' };
    },
  };
}

test('runtime: runs render, applies model options, returns an envelope', async () => {
  const provider = fakeProvider();
  const runtime = createAgentRuntime({
    provider,
    agents: [{
      id: 'demo',
      name: 'Demo',
      model: { maxTokens: 2400 },
      render: (context) => ({ systemMessage: 'SYS', userMessage: `U:${context.q}` }),
    }],
  });
  const res = await runtime.run('demo', { input: { context: { q: 'hello' } } });
  assert.equal(res.content, 'MODEL_OUTPUT');
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.agent.id, 'demo');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].systemMessage, 'SYS');
  assert.equal(provider.calls[0].userMessage, 'U:hello');
  assert.deepEqual(provider.calls[0].options, {
    maxTokens: 2400,
    modelRole: 'primary',
    requestLabel: 'Demo',
  });
});

test('runtime: a pinned agent sends its own model and reasoning, marked modelPinned', async () => {
  const provider = fakeProvider();
  const runtime = createAgentRuntime({
    provider,
    agents: [{
      id: 'pinned',
      name: 'Pinned',
      modelRole: 'utility',
      model: { maxTokens: 700, ...SECRETARY_CHAT_MODEL },
      render: () => ({ systemMessage: 'SYS', userMessage: 'U' }),
    }],
  });
  await runtime.run('pinned');
  assert.deepEqual(provider.calls[0].options, {
    maxTokens: 700,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    modelPinned: true,
    modelRole: 'utility',
    requestLabel: 'Pinned',
  });
});

test('runtime: a pinned tool-loop agent keeps its model pinned on every round', async () => {
  const provider = fakeProvider();
  const runtime = createAgentRuntime({
    provider,
    agents: [{
      id: 'pinned-loop',
      name: 'Pinned Loop',
      tools: ['lookup'],
      toolLoop: { maxRounds: 2 },
      model: { maxTokens: 800, ...SECRETARY_CHAT_MODEL },
      render: () => ({ systemMessage: 'SYS', userMessage: 'U' }),
    }],
  });
  const tools = { lookup: { definition: { type: 'function', function: { name: 'lookup' } }, execute: async () => ({}) } };
  const res = await runtime.run('pinned-loop', { deps: { tools } });
  assert.equal(res.content, 'MODEL_OUTPUT');
  assert.equal(provider.calls[0].options.model, 'gpt-5.6-luna');
  assert.equal(provider.calls[0].options.reasoningEffort, 'high');
  assert.equal(provider.calls[0].options.modelPinned, true);
});

test('runtime: conversation memory is prepended to the user message', async () => {
  const provider = fakeProvider();
  const runtime = createAgentRuntime({
    provider,
    agents: [{
      id: 'chatty',
      name: 'Chatty',
      memory: 'conversation',
      render: () => ({ systemMessage: 'SYS', userMessage: '\nQuestion: hi' }),
    }],
  });
  await runtime.run('chatty', { input: { history: [{ role: 'user', content: 'prev' }] } });
  assert.equal(provider.calls[0].userMessage, 'Recent conversation:\nUser: prev\n\n\nQuestion: hi');
});

test('runtime: gather step assembles grounding from deps before rendering', async () => {
  const provider = fakeProvider();
  const runtime = createAgentRuntime({
    provider,
    agents: [{
      id: 'grounded',
      name: 'Grounded',
      gather: async (deps) => ({ n: deps.db.count() }),
      render: (context) => ({ systemMessage: 'SYS', userMessage: `count=${context.n}` }),
    }],
  });
  const res = await runtime.run('grounded', { deps: { db: { count: () => 7 } } });
  assert.equal(provider.calls[0].userMessage, 'count=7');
  assert.equal(res.context.n, 7);
});

test('runtime: unknown agent throws; describeAgents exposes the registry', () => {
  const runtime = createAgentRuntime({
    provider: fakeProvider(),
    agents: [{ id: 'a', name: 'A', knowledge: ['se-assist-persona'], tools: ['x'], memory: 'none', model: {}, render: () => ({ systemMessage: '', userMessage: '' }) }],
  });
  assert.throws(() => runtime.getAgent('missing'), /Unknown agent: missing/);
  const described = runtime.describeAgents();
  assert.equal(described.length, 1);
  assert.equal(described[0].memory, 'none');
  assert.deepEqual(described[0].tools, ['x']);
});

test('runtime: createAgentRuntime rejects a bad provider', () => {
  assert.throws(() => createAgentRuntime({ provider: {}, agents: [] }), /requires a provider/);
});

// ── index / resolveAgents ────────────────────────────────────────────────────
test('resolveAgents: throws loudly when a catalog agent has no render impl', () => {
  assert.throws(() => resolveAgents({}), /Missing render implementation/);
});

test('resolveAgents: merges catalog metadata with supplied impls', () => {
  const impls = {};
  for (const a of AGENTS) impls[a.id] = { render: () => ({ systemMessage: '', userMessage: '' }) };
  const resolved = resolveAgents(impls);
  assert.equal(resolved.length, AGENTS.length);
  const sales = resolved.find((a) => a.id === 'sales-advisor');
  assert.equal(typeof sales.render, 'function');
  assert.deepEqual(sales.model, { maxTokens: 2400 });
  assert.ok(sales.knowledge.includes('grounding-contract'));
});
