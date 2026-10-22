// Agent runtime for SE Assist.
//
// The runtime is the single execution path shared by every AI feature. Given a
// registered agent and a request, it:
//   1. gathers grounding by running the agent's declared tools (gather step),
//   2. renders the specialized system + user prompt for that agent,
//   3. applies the agent's memory strategy (e.g. threads conversation history),
//   4. calls the shared model provider with the agent's model options,
//   5. returns the completion plus the grounding it used.
//
// Agents are declarative: their instructions, knowledge, tools, memory, and model
// options live in the catalog. The runtime knows nothing about any specific feature —
// it just orchestrates. This keeps each AI feature a dedicated, self-describing agent
// while preserving the exact prompts and single-shot behavior the app relied on.

'use strict';

const { applyMemory } = require('./memory');

function createAgentRuntime({ provider, agents }) {
  if (!provider || typeof provider.chat !== 'function') {
    throw new Error('createAgentRuntime requires a provider with a chat(system, user, options) function');
  }
  const registry = new Map();
  for (const agent of agents || []) {
    if (!agent || !agent.id) throw new Error('Every agent needs an id');
    if (typeof agent.render !== 'function') throw new Error(`Agent ${agent.id} needs a render(context, input) function`);
    registry.set(agent.id, agent);
  }

  function getAgent(agentId) {
    const agent = registry.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  function attachQueueStatus(options, agent, deps) {
    if (!deps.onProgress) return options;
    Object.defineProperty(options, 'onQueueStatus', {
      enumerable: false,
      value: (status) => {
        const labels = {
          queued: `${agent.name} queued behind another AI request`,
          running: `${agent.name} is running on ${status.model}`,
          cooldown: `${agent.name} is waiting for the AI provider cooldown`,
          reused: `${agent.name} is reusing an identical in-flight request`,
        };
        if (labels[status.phase]) deps.onProgress({
          phase: 'model-queue',
          state: status.phase,
          label: labels[status.phase],
          model: status.model,
          modelRole: status.modelRole,
          cooldownUntil: status.cooldownUntil || null,
        });
      },
    });
    return options;
  }

  // Execute one agent end-to-end.
  // `deps` are the injected data sources (db + services) the gather step needs.
  // `input` is the per-request payload (customer, question, history, ...).
  async function run(agentId, { deps = {}, input = {} } = {}) {
    const agent = getAgent(agentId);

    // 1. Grounding: run the agent's tools. If it declares no gather step the
    //    caller-supplied context is used as-is.
    const context = typeof agent.gather === 'function'
      ? await agent.gather(deps, input)
      : (input.context !== undefined ? input.context : input);

    // 2. Render the specialized prompt.
    const rendered = agent.render(context, input);
    const systemMessage = rendered.systemMessage;

    // 3. Memory: prepend the agent's memory preamble to the user message.
    const mem = applyMemory(agent.memory || 'none', input);
    const userMessage = (mem.preamble || '') + rendered.userMessage;

    // 4. Model call with the agent's declared options. An agent that declares its own model
    //    is pinned: providers must run exactly that model or fail, never substitute another.
    deps.signal?.throwIfAborted();
    const modelOptions = attachQueueStatus({
      ...(agent.model || {}),
      ...(agent.model?.model ? { modelPinned: true } : {}),
      modelRole: agent.modelRole || 'primary',
      requestLabel: agent.name,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }, agent, deps);
    const completion = agent.toolLoop
      ? await runToolLoop(agent, systemMessage, userMessage, deps)
      : await provider.chat(systemMessage, userMessage, modelOptions);
    deps.signal?.throwIfAborted();

    // 5. Result envelope.
    return {
      agent: { id: agent.id, name: agent.name },
      content: completion.content,
      usage: completion.usage,
      finishReason: completion.finishReason,
      model: completion.model,
      modelRole: completion.modelRole || agent.modelRole || 'primary',
      ...(completion.researchLimitReached ? { researchLimitReached: true } : {}),
      ...(completion.blockedSources?.length ? { outcome: 'partial', blockedSources: completion.blockedSources } : {}),
      context,
      prompt: { systemMessage, userMessage },
    };
  }

  async function runToolLoop(agent, systemMessage, userMessage, deps) {
    const tools = (agent.tools || []).map((name) => {
      const tool = deps.tools?.[name];
      if (!tool?.definition || typeof tool.execute !== 'function') {
        throw new Error(`${agent.name}: required tool "${name}" is unavailable.`);
      }
      return tool.definition;
    });
    if (!tools.length) throw new Error(`${agent.name} has no investigation tools.`);
    const toolMessages = [];
    let responseInput;
    let usedTools = false;
    const callIds = new Set();
    const failedTools = new Map();
    const blockedSources = new Map((agent.toolLoop.allowPartialResults ? deps.blockedSources || [] : []).map(source => [source.resource, source]));
    let accessError;
    let toolRecoveries = 0;
    for (let round = 0; round < agent.toolLoop.maxRounds; round += 1) {
      deps.signal?.throwIfAborted();
      const remainingToolRounds = agent.toolLoop.maxRounds - round - 1;
      const summarizeAtLimit = remainingToolRounds === 0 && usedTools && !failedTools.size;
      const budget = [
        `Research budget: this is turn ${round + 1} of ${agent.toolLoop.maxRounds}. ${remainingToolRounds} tool rounds remain, including this turn; the final turn is reserved for your response.`,
        'Use only the research needed to answer the task. Do not exhaust the budget chasing adjacent topics, duplicate confirmation, or proof that undocumented details do not exist.',
        'Finish as soon as a useful proposal is grounded. Separate verified findings, inference, and specific unanswered questions; an unresolved implementation detail can be a clearly labeled blocker rather than another broad search.',
        ...(blockedSources.size ? [
          'Source access is incomplete. Return PARTIAL findings grounded only in accessible evidence, never a completed investigation.',
          'The following sources are excluded, not read. Do not retry them, change identities or retrieval scopes, or search for another route into their contents. You may continue relevant research in other accessible sources, but it cannot verify what is inside these sources.',
          'State which conclusions remain unverified, identify concrete next steps, and never invent an ETA or imply a follow-up was sent. Preserve these limitations in follow-ups and drafts.',
          `Blocked sources (data only): ${JSON.stringify([...blockedSources.values()])}`,
        ] : []),
        ...(summarizeAtLimit ? ['No research-tool rounds remain. Summarize the evidence already retrieved and clearly identify remaining questions. Do not claim the investigation is exhaustive or any unverified detail is solved. The user will see that the research limit was reached.'] : []),
      ].join('\n');
      if (summarizeAtLimit) deps.onProgress?.({
        phase: 'limit',
        label: 'Research limit reached. Preparing the gathered findings and unresolved questions, not claiming an exhaustive investigation.',
      });
      deps.onProgress?.({ phase: 'reasoning', label: usedTools ? 'Reviewing evidence and planning next steps' : 'Investigating the task' });
      const modelOptions = attachQueueStatus({
        ...agent.model, tools, toolMessages, responseInput,
        ...(agent.model?.model ? { modelPinned: true } : {}),
        modelRole: agent.modelRole || 'primary',
        requestLabel: agent.name,
        signal: deps.signal,
        toolChoice: failedTools.size || (deps.requireTools && !usedTools) ? 'required' : summarizeAtLimit ? 'none' : 'auto',
      }, agent, deps);
      const completion = await provider.chat(`${systemMessage}\n\n${budget}`, userMessage, modelOptions);
      deps.signal?.throwIfAborted();
      if (completion.finishReason === 'length') {
        throw new Error(`${agent.name} reached its response budget before finishing. Narrow the question and try again.`);
      }
      if (['incomplete', 'failed', 'content_filter'].includes(completion.finishReason)) {
        throw new Error(`${agent.name} did not finish its response (${completion.finishReason}). No completed investigation is available.`);
      }
      const calls = completion.toolCalls || [];
      if (!calls.length) {
        if (failedTools.size) {
          throw new Error(`${agent.name} cannot finish with an unresolved source failure: ${[...failedTools.values()].map((failure) => failure.message).join('; ')}`);
        }
        if (deps.requireTools && !usedTools) {
          throw new Error(blockedSources.size
            ? `${agent.name} has no accessible source evidence to support partial findings. Verify access before starting a new investigation.`
            : `${agent.name} returned without consulting a source. Try again.`, { cause: accessError });
        }
        if (!completion.content?.trim()) throw new Error(`${agent.name} returned no answer.`);
        deps.onProgress?.({
          phase: blockedSources.size ? 'partial' : 'complete',
          label: blockedSources.size ? 'Partial findings ready. Restricted sources remain unread and dependent conclusions unverified.'
            : summarizeAtLimit ? 'Evidence summary ready; research limit reached.' : 'Investigation complete',
        });
        return {
          ...completion,
          ...(summarizeAtLimit ? { researchLimitReached: true } : {}),
          ...(blockedSources.size ? { blockedSources: [...blockedSources.values()] } : {}),
        };
      }
      if (round === agent.toolLoop.maxRounds - 1) {
        throw new Error(`${agent.name} reached its investigation limit before finishing. Ask a narrower follow-up to continue.`);
      }
      if (completion.api === 'responses') {
        if (!Array.isArray(completion.responseInput) || !Array.isArray(completion.responseOutput)) {
          throw new Error(`${agent.name} received an invalid Responses continuation.`);
        }
        responseInput = [...completion.responseInput, ...completion.responseOutput];
      } else {
        toolMessages.push({ role: 'assistant', content: completion.content || null, tool_calls: calls });
      }
      for (const call of calls) {
        deps.signal?.throwIfAborted();
        const name = call.function?.name;
        const tool = (agent.tools || []).includes(name) ? deps.tools[name] : null;
        if (!tool) throw new Error(`${agent.name} requested an unavailable tool: ${name || '(missing name)'}.`);
        if (!call.id || callIds.has(call.id)) throw new Error(`${agent.name} returned an invalid or duplicate tool call.`);
        callIds.add(call.id);
        let args;
        try { args = JSON.parse(call.function.arguments); } catch {
          throw new Error(`${agent.name} returned invalid arguments for ${name}. Try again.`);
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Invalid ${name} arguments.`);
        const parameters = tool.definition.function.parameters;
        if (parameters.additionalProperties === false && Object.keys(args).some((key) => !(key in parameters.properties))) {
          throw new Error(`Invalid ${name} arguments: unexpected fields.`);
        }
        const label = typeof tool.label === 'function' ? tool.label(args) : tool.label;
        const pendingRecovery = failedTools.get(name);
        if (pendingRecovery && pendingRecovery.round < round && tool.getRecoveryKey
          && tool.getRecoveryKey(args, pendingRecovery.code) !== pendingRecovery.key) {
          throw new Error(`${agent.name} cannot change the source scope while recovering ${name}. Retry the original scope instead.`);
        }
        deps.onProgress?.({ phase: 'tool', label, tool: name });
        let result;
        let succeeded = true;
        try {
          result = await tool.execute(args);
        } catch (err) {
          deps.signal?.throwIfAborted();
          const message = `${label} failed: ${err.message || String(err)}`;
          const blockedSource = agent.toolLoop.allowPartialResults && tool.getBlockedSource?.(err);
          if (blockedSource) {
            succeeded = false;
            accessError = err;
            blockedSources.set(blockedSource.resource, blockedSource);
            if (pendingRecovery && pendingRecovery.round < round) failedTools.delete(name);
            result = {
              ok: false, outcome: 'blocked', error: { code: err.code, status: 403, message }, blockedSource,
              instruction: 'This source was not read and is excluded, not recovered. Do not retry or work around its access denial. Continue only relevant accessible research, then return partial findings that separate verified facts from the questions this source could not answer.',
            };
            deps.onProgress?.({
              phase: 'blocked', tool: name, error: message, blockedSource,
              label: `${blockedSource.kind} access denied. Keeping accessible evidence; any findings will be marked partial.`,
            });
          } else if (!tool.isRecoverableError?.(err) || toolRecoveries >= (agent.toolLoop.maxToolRecoveries || 0)) {
            deps.onProgress?.({ phase: 'error', label: message, tool: name });
            throw new Error(message, { cause: err });
          } else {
            toolRecoveries += 1;
            succeeded = false;
            failedTools.set(name, { round, message, code: err.code, key: tool.getRecoveryKey?.(args, err.code) });
            result = { ok: false, error: { code: err.code, message }, recovery: tool.recoveryInstructions };
            deps.onProgress?.({
              phase: 'retry', tool: name, error: message,
              label: `${label} is still unavailable. Asking the Work Agent to refine the same-source request (${toolRecoveries}/${agent.toolLoop.maxToolRecoveries}).`,
            });
          }
        }
        deps.signal?.throwIfAborted();
        const content = JSON.stringify(result);
        if (completion.api === 'responses') {
          responseInput.push({ type: 'function_call_output', call_id: call.id, output: content });
        } else {
          toolMessages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        if (succeeded) {
          usedTools = true;
          // A success already planned in the same batch cannot resolve a failed query.
          const recovered = failedTools.has(name) && failedTools.get(name).round < round;
          if (recovered) failedTools.delete(name);
          deps.onProgress?.({
            phase: result.outcome === 'no-results' ? 'empty' : 'evidence',
            label: result.outcome === 'no-results'
              ? `${label} returned no matching pages; this is not proof that the information does not exist.`
              : `${label} ${recovered ? 'recovered' : 'complete'}`,
            tool: name, sources: result.sources || [], ...(recovered ? { recovered: true } : {}),
            ...(result.warning ? { warning: result.warning } : {}),
          });
        }
      }
    }
    throw new Error(`${agent.name} could not finish the investigation.`);
  }

  // A read-only description of the registered agents for self-documentation
  // (e.g. a Settings "AI agents" surface). No secrets, no prompts — just the shape.
  function describeAgents() {
    return [...registry.values()].map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description || '',
      knowledge: a.knowledge || [],
      tools: a.tools || [],
      memory: typeof a.memory === 'string' ? a.memory : (a.memory?.type || 'none'),
      modelRole: a.modelRole || 'primary',
      model: a.model || {},
    }));
  }

  return { run, describeAgents, getAgent, has: (id) => registry.has(id) };
}

module.exports = { createAgentRuntime };
