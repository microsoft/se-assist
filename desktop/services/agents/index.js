// SE Assist agent framework — public surface.
//
// Usage (see desktop/app-ipc.js):
//   const { createAgentRuntime, AGENTS, resolveAgents } = require('./services/agents');
//   const runtime = createAgentRuntime({ provider, agents: resolveAgents(impls) });
//   const result = await runtime.run('sales-advisor', { deps, input });

'use strict';

const { KNOWLEDGE, composeKnowledge, knowledgeTitle } = require('./knowledge');
const { STRATEGIES, applyMemory } = require('./memory');
const { AGENTS, AGENTS_BY_ID, getAgentSpec, SECRETARY_CHAT_MODEL } = require('./catalog');
const { createAgentRuntime } = require('./runtime');

// Merge the declarative catalog specs with the concrete implementations supplied by
// the app (a map of agentId -> { render, gather }). Every catalog agent must have a
// render implementation; a missing one throws loudly rather than silently skipping.
function resolveAgents(impls = {}) {
  return AGENTS.map((spec) => {
    const impl = impls[spec.id];
    if (!impl || typeof impl.render !== 'function') {
      throw new Error(`Missing render implementation for agent: ${spec.id}`);
    }
    return { ...spec, render: impl.render, gather: impl.gather };
  });
}

// A provider-free, read-only description of the catalog for self-documentation
// surfaces (e.g. the Settings "AI agents" list). Resolves each knowledge id to its
// human title so the UI can show what each agent grounds itself in.
function describeCatalog() {
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description || '',
    knowledge: (a.knowledge || []).map((id) => knowledgeTitle(id)),
    tools: a.tools || [],
    memory: typeof a.memory === 'string' ? a.memory : (a.memory?.type || 'none'),
    modelRole: a.modelRole || 'primary',
    model: a.model || {},
  }));
}

module.exports = {
  KNOWLEDGE,
  composeKnowledge,
  knowledgeTitle,
  STRATEGIES,
  applyMemory,
  AGENTS,
  AGENTS_BY_ID,
  getAgentSpec,
  SECRETARY_CHAT_MODEL,
  createAgentRuntime,
  resolveAgents,
  describeCatalog,
};
