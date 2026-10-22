// Memory strategies for SE Assist AI agents.
//
// Most agents are stateless single-shot analysts (memory: 'none'). The assistant
// bubble is conversational: it threads the recent turns back into the prompt so the
// model can follow a multi-message exchange. This module centralizes those strategies
// so an agent's memory behavior is a declared configuration rather than ad-hoc prompt
// glue inside a handler.
//
// A memory strategy turns the caller-supplied memory input (e.g. prior turns) into a
// `preamble` string that the runtime prepends to the agent's user message. Keeping it
// a pure string transform makes it trivial to unit-test and keeps the model contract
// identical to the historical inline behavior.

'use strict';

const STRATEGIES = {
  // Stateless: the agent sees only the current request.
  none() {
    return { preamble: '' };
  },

  // Conversational: fold the recent turns into a "Recent conversation:" block, exactly
  // as the assistant bubble did inline. `history` is an array of { role, content }.
  conversation({ history } = {}) {
    if (!history || !history.length) return { preamble: '' };
    const lines = history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`);
    return { preamble: `Recent conversation:\n${lines.join('\n')}\n\n` };
  },
};

// Resolve a memory config to a preamble string.
// `config` is either a strategy id string ('none' | 'conversation') or
// { type, maxTurns } — maxTurns trims the history to the most recent N turns.
function applyMemory(config, input = {}) {
  const type = typeof config === 'string' ? config : config?.type || 'none';
  const strategy = STRATEGIES[type];
  if (!strategy) throw new Error(`Unknown memory strategy: ${type}`);

  let memInput = input;
  const maxTurns = typeof config === 'object' ? config?.maxTurns : undefined;
  if (type === 'conversation' && maxTurns && Array.isArray(input.history)) {
    memInput = { ...input, history: input.history.slice(-maxTurns) };
  }
  return strategy(memInput);
}

module.exports = { STRATEGIES, applyMemory };
