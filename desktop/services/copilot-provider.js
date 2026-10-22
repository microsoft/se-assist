/**
 * copilot-provider.js — calls GitHub Copilot's chat models (the same backend the
 * Copilot CLI/editors use) instead of an Azure Foundry endpoint.
 *
 * Two-step auth, mirroring the Copilot editors:
 *   1. Exchange the user's GitHub OAuth token (from github-auth) for a short-lived
 *      Copilot bearer token at api.github.com/copilot_internal/v2/token (cached).
 *   2. POST OpenAI-compatible chat/completions to api.githubcopilot.com with that
 *      bearer plus the Editor-Version / Copilot-Integration-Id headers Copilot expects.
 *
 * Requires an active GitHub Copilot subscription on the signed-in account.
 */
const githubAuth = require('./github-auth');
const appPrefs = require('./app-prefs');
const crypto = require('crypto');
const { modelRequestScheduler, rateLimitRetryAt } = require('./model-request-scheduler');

const UA = 'SE-Assist/1.0';
const EDITOR_VERSION = 'SE-Assist/1.0';
const INTEGRATION_ID = process.env.COPILOT_INTEGRATION_ID || 'vscode-chat';
const DEFAULT_API_BASE = 'https://api.githubcopilot.com';

// Bounded deadline for a single chat-completions request so a hung upstream call can't wedge
// an AI feature indefinitely. Generous enough for large reasoning completions.
const CHAT_TIMEOUT_MS = Number(process.env.COPILOT_CHAT_TIMEOUT_MS) || 120000;

// When a model returns an empty/absent message this call (e.g. a reasoning model on the Responses
// API that produced no visible text), we surface THIS notice and stop. No model substitution, no
// token-budget or parameter fiddling, no silent retry — the user simply tries again.
const MODEL_BUSY_MESSAGE = 'The AI model is busy right now — please wait a minute and try again.';

// Reasoning-token headroom for the Responses API. There, `max_output_tokens` is a COMBINED ceiling
// over the model's internal reasoning tokens AND its visible answer. An agent's `maxTokens` sizes
// the ANSWER (e.g. 700 for a HoK activity JSON); passing that raw as `max_output_tokens` lets
// high reasoning consume the whole budget before writing a single visible token, yielding an empty
// completion (status=incomplete, reason=max_output_tokens) that looks like — but is NOT — a
// transient "busy". So we add this headroom on top of the agent's answer budget so the reasoning
// process has room and the intended answer can still be emitted. It's a ceiling (only real tokens
// are billed), and reasoning models support large output windows, so a generous value is safe.
const RESPONSES_REASONING_HEADROOM = Number(process.env.COPILOT_RESPONSES_REASONING_HEADROOM) || 25000;

// Supported reasoning-effort ladder, highest first. The app defaults to high rather than xhigh
// to reduce latency while retaining strong reasoning. If the default is rejected, step DOWN one
// rung and cache the accepted value so later requests do not repeat a known-invalid attempt.
// COPILOT_REASONING_EFFORT can still explicitly request another supported level.
const REASONING_EFFORTS = ['xhigh', 'high', 'medium', 'low'];
const DEFAULT_REASONING_EFFORT = 'high';
let acceptedReasoningEffort = (process.env.COPILOT_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).trim();

// Ultra-safe default model present on every Copilot plan, used only when the user hasn't chosen
// a model (see getModelName). It is NOT used to silently substitute for a model the user did
// pick — an unsupported explicit selection fails loudly instead.
const FALLBACK_MODEL = 'gpt-4o';
const USE_PRIMARY_MODEL = '__primary__';

// Preference order used to auto-pick the "latest" model when the user hasn't chosen
// one yet. First match against the account's available picker models wins.
const RECOMMENDED_PRIORITY = [
  'claude-opus-4.8',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'claude-sonnet-4.6', 'claude-opus-4.7', 'claude-opus-4.6',
  'claude-sonnet-4.5', 'gemini-3.1-pro-preview', 'gemini-2.5-pro',
  'gpt-5-mini', 'gpt-4.1',
];

let copilotToken = null;
let copilotTokenExpiry = 0;
let apiBase = DEFAULT_API_BASE;
let selectedModel; // undefined = not yet loaded from prefs
let selectedUtilityModel; // undefined = not yet loaded from prefs; null means use primary

function getPersistedModel() {
  if (selectedModel === undefined) {
    selectedModel = appPrefs.get('copilotModel', null);
  }
  return selectedModel;
}

function getModelName() {
  return getPersistedModel() || (process.env.COPILOT_MODEL || '').trim() || FALLBACK_MODEL;
}

function getPersistedUtilityModel() {
  if (selectedUtilityModel === undefined) {
    selectedUtilityModel = appPrefs.get('copilotUtilityModel', null);
  }
  return selectedUtilityModel;
}

function getModelNameForRole(role = 'primary') {
  if (role !== 'utility') return getModelName();
  const persisted = getPersistedUtilityModel();
  if (persisted === USE_PRIMARY_MODEL) return getModelName();
  return persisted
    || (process.env.COPILOT_UTILITY_MODEL || process.env.SEASSIST_FAST_MODEL || '').trim()
    || getModelName();
}

function utilityUsesPrimaryModel() {
  const persisted = getPersistedUtilityModel();
  const configured = (process.env.COPILOT_UTILITY_MODEL || process.env.SEASSIST_FAST_MODEL || '').trim();
  return persisted === USE_PRIMARY_MODEL || (!persisted && !configured);
}

// Persist the user's model choice (or clear it with null/empty to revert to default).
function setModel(modelId) {
  const id = (modelId || '').trim() || null;
  selectedModel = id;
  appPrefs.set('copilotModel', id);
  return getModelName();
}

// The utility model is an explicit second role for bounded extraction/classification.
// Empty means "use the primary model" — never an implicit substitution after failure.
function setUtilityModel(modelId) {
  const requested = (modelId || '').trim();
  const id = requested === USE_PRIMARY_MODEL ? USE_PRIMARY_MODEL : (requested || null);
  selectedUtilityModel = id;
  appPrefs.set('copilotUtilityModel', id);
  return getModelNameForRole('utility');
}

// Exchange the GitHub OAuth token for a Copilot bearer token (cached until ~1 min
// before expiry). Throws a helpful error when not signed in or no Copilot seat.
async function getCopilotToken() {
  if (copilotToken && copilotTokenExpiry > Date.now() + 60_000) return copilotToken;

  const gho = githubAuth.getToken();
  if (!gho) {
    const err = new Error('Not connected to GitHub Copilot. Use "Connect GitHub Copilot" in Settings.');
    err.code = 'NO_GITHUB_TOKEN';
    throw err;
  }

  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${gho}`,
      'User-Agent': UA,
      'Editor-Version': EDITOR_VERSION,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text).message || detail; } catch { /* keep raw */ }
    const err = new Error(
      resp.status === 403
        ? `GitHub Copilot is not available for this account (no active Copilot subscription?): ${detail}`
        : `Copilot token exchange failed: ${resp.status} ${detail}`,
    );
    err.code = 'COPILOT_TOKEN_FAILED';
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.token) {
    const err = new Error('Copilot token exchange returned no token.');
    err.code = 'COPILOT_TOKEN_FAILED';
    throw err;
  }
  copilotToken = data.token;
  copilotTokenExpiry = (Number(data.expires_at) || Math.floor(Date.now() / 1000) + 1500) * 1000;
  apiBase = data.endpoints?.api || DEFAULT_API_BASE;
  return copilotToken;
}

// Verify connectivity + entitlement without sending a prompt. Returns {ok, error}.
async function probe() {
  try {
    await getCopilotToken();
    return { ok: true, model: getModelName(), apiBase };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: err.code };
  }
}

// List chat models available to the signed-in account from the Copilot /models
// endpoint. Returns { models: [{id,name,vendor,picker,maxOutput,context}], recommended,
// selected, effective }. Sorted with picker-enabled (curated) models first.
async function listModels() {
  const token = await getCopilotToken();
  const url = `${apiBase.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
      'Editor-Version': EDITOR_VERSION,
      'Copilot-Integration-Id': INTEGRATION_ID,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub Copilot model list failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text);
  const raw = parsed.data || parsed.models || [];
  const seen = new Set();
  const models = [];
  for (const m of raw) {
    const id = m.id || m.model;
    if (!id || seen.has(id)) continue;
    const cap = m.capabilities || {};
    const type = cap.type || (m.model_picker_enabled ? 'chat' : '');
    if (type !== 'chat') continue; // drop embeddings / non-chat
    if ((m.vendor || '') === 'Experimental') continue;
    seen.add(id);
    const limits = cap.limits || {};
    models.push({
      id,
      name: m.name || id,
      vendor: m.vendor || '',
      picker: Boolean(m.model_picker_enabled),
      maxOutput: limits.max_output_tokens || null,
      context: limits.max_context_window_tokens || limits.max_prompt_tokens || null,
    });
  }
  // Curated (picker) models first, then alphabetical by display name.
  models.sort((a, b) => (Number(b.picker) - Number(a.picker)) || a.name.localeCompare(b.name));

  const available = new Set(models.filter((m) => m.picker).map((m) => m.id));
  const recommended = RECOMMENDED_PRIORITY.find((id) => available.has(id))
    || (models.find((m) => m.picker) || models[0] || {}).id
    || FALLBACK_MODEL;

  return {
    models,
    recommended,
    selected: getPersistedModel(),
    effective: getModelName(),
    utilitySelected: getPersistedUtilityModel(),
    utilityEffective: getModelNameForRole('utility'),
  };
}


// Pull assistant text out of an OpenAI Responses API payload. Prefers the SDK-style
// `output_text` convenience field when present; otherwise walks output[].content[] for
// output_text / text items and concatenates them.
function extractResponsesText(parsed) {
  if (typeof parsed?.output_text === 'string' && parsed.output_text.trim()) return parsed.output_text;
  const out = Array.isArray(parsed?.output) ? parsed.output : [];
  const parts = [];
  for (const item of out) {
    if (item?.type && item.type !== 'message') continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

// Call the OpenAI **Responses** API for models that are served ONLY there (some flagship models
// reject /chat/completions with `unsupported_api_for_model`). This runs the SAME model the user
// selected — it is an endpoint change, NEVER a model substitution. Returns the same
// { content, usage, finishReason, model } contract as chat(). `headers` is reused from chat()
// (carries the bearer + Copilot integration headers).
function modelHttpError(response, text, label) {
  const error = Object.assign(new Error(`${label}: HTTP ${response.status} ${text.slice(0, 200)}`), {
    code: 'COPILOT_HTTP_ERROR', statusCode: response.status,
  });
  if ([429, 503].includes(response.status)) error.retryAt = rateLimitRetryAt(response.headers);
  return error;
}

// An explicitly requested reasoning level is never lowered. A pinned request (the feature declares
// its own model) also never points the user at Settings: changing the Settings model does not
// change which model that feature runs.
function reasoningUnsupportedError(model, effort, detail, { modelPinned, requestLabel } = {}) {
  const label = requestLabel || 'This AI feature';
  const message = modelPinned
    ? `${label} runs only on GitHub Copilot model "${model}" with ${effort} reasoning, but the model rejected ${effort} reasoning. ${label} will not lower reasoning or switch models automatically. ${detail.slice(0, 200)}`
    : `The selected model "${model}" rejected ${effort} reasoning. Choose a model that supports it in Settings > AI Model; Work Agent will not lower reasoning automatically. ${detail.slice(0, 200)}`;
  return Object.assign(new Error(message), { code: 'REASONING_UNSUPPORTED' });
}

async function chatViaResponses(systemMessage, userMessage, {
  model, maxTokens, headers, timeoutMs = CHAT_TIMEOUT_MS,
  tools, toolChoice, responseInput, reasoningEffort, signal, modelPinned, requestLabel,
}) {
  const url = `${apiBase.replace(/\/+$/, '')}/responses`;
  // Responses request: `instructions` carries the system prompt, `input` the user turn.
  // `max_output_tokens` replaces max_tokens — but on the Responses API it caps reasoning tokens
  // PLUS the visible answer, so we add RESPONSES_REASONING_HEADROOM on top of the agent's answer
  // budget (otherwise high reasoning can starve the answer and return empty — see the constant).
  // Request the configured reasoning effort (high by default), stepping DOWN only if the model
  // rejects that value. Reasoning models may also reject
  // a custom temperature (adapted away below).
  const body = {
    model,
    instructions: systemMessage,
    input: responseInput || userMessage,
    max_output_tokens: maxTokens + RESPONSES_REASONING_HEADROOM,
    reasoning: { effort: reasoningEffort || acceptedReasoningEffort },
    temperature: 0.2,
    stream: false,
  };
  if (reasoningEffort) delete body.temperature;
  if (tools?.length) {
    body.tools = tools.map(({ function: fn }) => ({ type: 'function', ...fn }));
    body.tool_choice = toolChoice || 'auto';
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      text = await response.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err && err.name === 'AbortError') {
        // A timeout is NOT "model unavailable" — tag it so chat() surfaces it honestly instead of
        // telling the user to switch models. Heavy prompts (e.g. many accounts) are the usual cause.
        const e = new Error(`GitHub Copilot Responses API timed out after ${Math.round(timeoutMs / 1000)}s (model "${model}"). The request may be too large — narrow the scope (e.g. fewer accounts) and try again.`);
        e.code = 'RESPONSES_TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const parsed = JSON.parse(text);
      const content = extractResponsesText(parsed);
      const toolCalls = (tools?.length ? parsed.output || [] : []).filter((item) => item.type === 'function_call').map((item) => ({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      }));
      if ((!content || !content.trim()) && !toolCalls.length) {
        // No visible message this call. Distinguish the two very different causes so the user gets
        // honest, actionable guidance — not a misleading "busy, try again":
        //   (a) TRUNCATED: status=incomplete, reason=max_output_tokens → reasoning consumed the
        //       entire (already-generous) budget before writing an answer. Deterministic; retrying
        //       as-is won't help. This is what a too-large prompt looks like.
        //   (b) genuinely empty (status=completed, no text) → a real transient hiccup; try again.
        const truncatedNoOutput = parsed?.status === 'incomplete'
          && parsed?.incomplete_details?.reason === 'max_output_tokens';
        if (truncatedNoOutput) {
          const e = new Error('The AI model spent its entire response budget on reasoning before writing an answer — the request is unusually large. Narrow the scope (e.g. fewer linked signals) and try again.');
          e.code = 'RESPONSES_BUDGET_EXHAUSTED';
          throw e;
        }
        const e = new Error(MODEL_BUSY_MESSAGE);
        e.code = 'MODEL_BUSY';
        throw e;
      }
      // Normalize usage to the chat shape and map a truncated response → 'length' so callers'
      // existing finishReason checks (e.g. HTML-fallback on truncation) keep working.
      const u = parsed?.usage || null;
      const usage = u
        ? { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null, total_tokens: u.total_tokens ?? null }
        : null;
      const truncated = parsed?.status === 'incomplete' && parsed?.incomplete_details?.reason === 'max_output_tokens';
      return {
        content: content.trim(),
        usage,
        finishReason: truncated ? 'length' : (parsed?.status || null),
        model: parsed?.model || model,
        ...(tools?.length ? {
          toolCalls,
          api: 'responses',
          responseInput: Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input }],
          responseOutput: parsed.output || [],
        } : {}),
      };
    }

    const detail = text.toLowerCase();
    let adapted = false;
    if (response.status === 400 && detail.includes('temperature') && 'temperature' in body) {
      delete body.temperature;
      adapted = true;
    }
    if (response.status === 400 && !adapted && body.reasoning
        && (detail.includes('reasoning') || detail.includes('effort') || detail.includes(String(body.reasoning.effort)))) {
      if (reasoningEffort) {
        throw reasoningUnsupportedError(model, reasoningEffort, text, { modelPinned, requestLabel });
      }
      // Endpoint/model rejected this reasoning-effort value — step DOWN to the next rung rather than
      // dropping reasoning entirely, and remember it so later calls start at the accepted level.
      const idx = REASONING_EFFORTS.indexOf(body.reasoning.effort);
      if (idx >= 0 && idx < REASONING_EFFORTS.length - 1) {
        body.reasoning = { effort: REASONING_EFFORTS[idx + 1] };
        acceptedReasoningEffort = body.reasoning.effort;
      } else {
        delete body.reasoning; // ladder exhausted (or unknown value) — model doesn't take the hint
      }
      adapted = true;
    }
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      copilotToken = null; copilotTokenExpiry = 0;
      headers.Authorization = `****** getCopilotToken()}`;
      adapted = true;
    }
    if (!adapted) {
      // Endpoint unavailable (e.g. 404 — this account/endpoint doesn't serve /responses) or a
      // hard error. Fail loudly; still no model substitution.
      throw modelHttpError(response, text, `GitHub Copilot Responses API failed for model "${model}"`);
    }
  }
  throw new Error(`GitHub Copilot Responses API failed for model "${model}": could not satisfy parameter requirements`);
}

// OpenAI-compatible chat completion. Returns { content, usage, finishReason, model }.
async function executeChat(systemMessage, userMessage, options = {}) {
  options.signal?.throwIfAborted();
  const token = await getCopilotToken();
  options.signal?.throwIfAborted();
  const url = `${apiBase.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'Editor-Version': EDITOR_VERSION,
    'Editor-Plugin-Version': EDITOR_VERSION,
    'Copilot-Integration-Id': INTEGRATION_ID,
    Accept: 'application/json',
  };
  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
    ...(options.toolMessages || []),
  ];
  const maxTokens = Number(options.maxTokens) || 1200;
  // Per-call timeout override (agents can set model.timeoutMs for heavy jobs, e.g. the workload
  // suggester); falls back to the global default.
  const timeoutMs = Number(options.timeoutMs) || CHAT_TIMEOUT_MS;
  const model = options.model || getModelName();
  const responseOptions = {
    model, maxTokens, headers, timeoutMs,
    tools: options.tools, toolChoice: options.toolChoice,
    responseInput: options.responseInput, reasoningEffort: options.reasoningEffort,
    signal: options.signal, modelPinned: options.modelPinned, requestLabel: options.requestLabel,
  };
  if (options.responseInput) return chatViaResponses(systemMessage, userMessage, responseOptions);
  const body = {
    model, messages,
    max_tokens: maxTokens + (options.reasoningEffort ? RESPONSES_REASONING_HEADROOM : 0),
    temperature: 0.2, stream: false,
  };
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
    delete body.temperature;
  }

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice || 'auto';
  }

  // Adapt to model-specific parameter constraints (reasoning models reject temperature
  // and require max_completion_tokens), retrying once per discovered constraint. NOTE: we
  // never silently swap to a different model — an unsupported model selection fails loudly.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      text = await response.text();
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (err && err.name === 'AbortError') {
        const e = new Error(`GitHub Copilot chat-completions timed out after ${Math.round(timeoutMs / 1000)}s (model "${body.model}").`);
        e.code = 'RESPONSES_TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const parsed = JSON.parse(text);
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      const toolCalls = options.tools?.length && Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
      if ((!content || typeof content !== 'string' || !content.trim()) && !toolCalls.length) {
        if (options.tools?.length && choice?.finish_reason === 'length') {
          const err = new Error('Work Agent exhausted its response budget before answering. Narrow the question and try again.');
          err.code = 'RESPONSES_BUDGET_EXHAUSTED';
          throw err;
        }
        // No visible message this call — surface a clear "try again" notice and stop. No retry, no
        // budget/parameter fiddling, no model substitution.
        const e = new Error(MODEL_BUSY_MESSAGE);
        e.code = 'MODEL_BUSY';
        throw e;
      }
      // Report the model that actually ran (parsed.model when present) so callers never
      // misattribute output to a different model than executed.
      return {
        content: typeof content === 'string' ? content.trim() : '',
        usage: parsed?.usage || null,
        finishReason: choice?.finish_reason || null,
        model: parsed?.model || body.model,
        ...(options.tools?.length ? { toolCalls, api: 'chat' } : {}),
      };
    }

    const detail = text.toLowerCase();
    let adapted = false;
    if (response.status === 400) {
      // Some flagship models (e.g. gpt-5.5, gpt-5.6-sol) are served ONLY on the Responses API and
      // reject /chat/completions. Route the SAME model to /responses (endpoint change, NOT a model
      // substitution) so the user gets the model they chose. If /responses is also unavailable on
      // this endpoint, fall back to actionable guidance — still without swapping models.
      if (detail.includes('unsupported_api_for_model') || detail.includes('not accessible via the /chat/completions')) {
        try {
          return await chatViaResponses(systemMessage, userMessage, responseOptions);
        } catch (respErr) {
          // A timeout, "model busy", or a deterministic budget-exhaustion is transient/actionable,
          // NOT an availability problem — surface it as-is rather than telling the user to switch
          // models. Only genuine endpoint-unavailability (e.g. /responses 404) gets the "choose a
          // Chat-compatible model" guidance.
          if (options.signal?.aborted) throw options.signal.reason;
          if (respErr && (respErr.code === 'COPILOT_HTTP_ERROR' && ![404, 405].includes(respErr.statusCode)
            || ['RESPONSES_TIMEOUT', 'MODEL_BUSY', 'RESPONSES_BUDGET_EXHAUSTED', 'REASONING_UNSUPPORTED'].includes(respErr.code))) throw respErr;
          if (options.modelPinned) {
            const label = options.requestLabel || 'This AI feature';
            throw new Error(`${label} runs only on GitHub Copilot model "${body.model}", which isn't available over the APIs this app can use (${respErr.message}). ${label} will not switch models automatically.`);
          }
          throw new Error(`The selected model "${body.model}" isn't available over the APIs this app can use (${respErr.message}). Choose a Chat-compatible model in Settings → AI model.`);
        }
      }
      if (detail.includes("'max_tokens'") && detail.includes('max_completion_tokens') && 'max_tokens' in body) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
        adapted = true;
      } else if (detail.includes("'max_completion_tokens'") && detail.includes('max_tokens') && 'max_completion_tokens' in body) {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
        adapted = true;
      }
      if (detail.includes('temperature') && 'temperature' in body) {
        delete body.temperature;
        adapted = true;
      }
      if (!adapted && options.reasoningEffort && (detail.includes('reasoning') || detail.includes('effort'))) {
        throw reasoningUnsupportedError(body.model, options.reasoningEffort, text, options);
      }
    }
    if (response.status === 401 || response.status === 403) {
      // Token may have expired mid-flight — force a refresh once.
      if (attempt === 0) { copilotToken = null; copilotTokenExpiry = 0; headers.Authorization = `Bearer ${await getCopilotToken()}`; adapted = true; }
    }
    if (!adapted) {
      throw modelHttpError(response, text, `GitHub Copilot chat-completions failed for model "${body.model}"`);
    }
  }
  throw new Error(`GitHub Copilot chat-completions failed for model "${body.model}": could not satisfy model parameter requirements`);
}

function dedupeKey(systemMessage, userMessage, options, model) {
  // Tool continuations and cancellable work are intentionally never shared: they carry
  // request-local state and cancellation ownership. Plain, identical read-only prompts
  // can safely share one in-flight response.
  if (options.signal || options.tools?.length || options.toolMessages?.length || options.responseInput || options.dedupe === false) {
    return null;
  }
  const identity = JSON.stringify({
    systemMessage,
    userMessage,
    model,
    maxTokens: Number(options.maxTokens) || 1200,
    reasoningEffort: options.reasoningEffort || null,
    timeoutMs: Number(options.timeoutMs) || CHAT_TIMEOUT_MS,
  });
  return crypto.createHash('sha256').update(identity).digest('hex');
}

// Every Copilot model request enters the same process-wide scheduler. This is the one
// admission path for agent calls: it serializes bursts, paces starts, shares provider
// cooldowns, and coalesces only exact, side-effect-free in-flight prompts.
function chat(systemMessage, userMessage, options = {}) {
  options.signal?.throwIfAborted();
  const modelRole = options.modelRole === 'utility' ? 'utility' : 'primary';
  const model = options.model || getModelNameForRole(modelRole);
  const requestOptions = { ...options, model };
  return modelRequestScheduler.schedule(
    () => executeChat(systemMessage, userMessage, requestOptions),
    {
      priority: options.queuePriority || 'foreground',
      label: options.requestLabel || 'AI request',
      model,
      modelRole,
      signal: options.signal,
      dedupeKey: dedupeKey(systemMessage, userMessage, options, model),
      onStatus: options.onQueueStatus,
    },
  ).then(completion => ({ ...completion, modelRole }));
}

function scheduleExternalModelWork(run, {
  label = 'Background AI enrichment',
  priority = 'background',
  signal,
} = {}) {
  return modelRequestScheduler.schedule(run, {
    label,
    priority,
    signal,
    model: getModelNameForRole('utility'),
    modelRole: 'utility',
  });
}

function getStatus() {
  return {
    signedIn: githubAuth.isSignedIn(),
    model: getModelName(),
    utilityModel: getModelNameForRole('utility'),
    utilityUsesPrimary: utilityUsesPrimaryModel(),
    activity: modelRequestScheduler.snapshot(),
  };
}

// The resolved Copilot API base (set during token exchange). Callers should invoke
// getCopilotToken() first so this reflects the account's real endpoint.
function getApiBase() {
  return apiBase;
}

module.exports = {
  chat,
  probe,
  listModels,
  getStatus,
  getModelName,
  getModelNameForRole,
  utilityUsesPrimaryModel,
  getPersistedModel,
  getPersistedUtilityModel,
  setModel,
  setUtilityModel,
  scheduleExternalModelWork,
  getActivity: () => modelRequestScheduler.snapshot(),
  onActivity: listener => modelRequestScheduler.subscribe(listener),
  getCopilotToken,
  getApiBase,
  _resetSchedulerForTests: options => modelRequestScheduler.resetForTests(options),
};
