const { ipcMain, app, BrowserWindow, webContents, clipboard } = require('electron');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { openDb } = require('./sqlite-ipc');
let msxIpc;
try {
  msxIpc = require('./msx-ipc');
} catch {
  msxIpc = null;
}
const { getEffectiveTpids, saveRoster, assertActiveTpid, assertActiveRecord, assertActiveAccountTask, createAccountScope, beginRosterWork, withRosterWork } = require('./account-roster');
const githubAuth = require('./services/github-auth');
const copilotProvider = require('./services/copilot-provider');
const { modelRequestScheduler, rateLimitRetryAt } = require('./services/model-request-scheduler');
const appPrefs = require('./services/app-prefs');
const { deriveOwnedAccounts } = require('./services/owned-accounts');
const m365Ingest = require('./services/m365-ingest');
const { getWorkIqClient } = require('./services/workiq-client');
const { toOutlookWebReaderLink } = require('./services/outlook-link');
const { copyMilestoneTeamsMessage } = require('./services/teams-chat-message');
const meetingTranscript = require('./services/meeting-transcript');
const customerTasks = require('./services/customer-tasks');
const meetingTasks = require('./services/meeting-tasks');
const workiqAuth = require('./services/workiq-auth');
const { createWorkAgentTools, normalizeBlockedSources } = require('./services/work-agent-tools');
const { createWorkOutputs } = require('./services/work-outputs');
const { scanSecretaryInbox } = require('./services/secretary-scan');
const { searchEmails, readEmail } = require('./services/email-search');
const researchDossier = require('./services/research-dossier');
const signalLinks = require('./services/signal-links');
const { dedupeSuggestions } = require('./services/workload-suggestion-dedup');
const { normalizeConceptKey, deriveConceptKey, dropDismissedByKey } = require('./services/workload-concept-key');
const customerInsights = require('./services/customer-insights');
const stakeholderInfluence = require('./services/stakeholder-influence');
const influenceStore = require('./services/stakeholder-influence-store');
const {
  buildCustomerRelationshipGraph,
  participantFrom,
  participantList,
  collectTeamsMembers,
  isInternalEmail,
} = require('./services/customer-relationship-graph');
const { KNOWLEDGE, createAgentRuntime, resolveAgents, describeCatalog, SECRETARY_CHAT_MODEL } = require('./services/agents');
const {
  generatedDir,
  escapeHtml,
  inlineMd,
  markdownToHtml,
  renderHtmlDocument,
  writeHtmlArtifact,
  writeRawHtmlArtifact,
} = require('./services/html-render');
const {
  rowToProfile,
  rowToAsset,
  rowToTimelineEvent,
  rowToEmailRef,
  rowToMeetingRef,
  rowToTeamsRef,
  rowToTranscript,
} = require('./services/row-mappers');
const {
  buildComprehensivePrompt,
  buildTechStackPrompt,
  buildAcrAnalysisPrompt,
  buildSalesAdvisorPrompt,
  buildCustomerAnalysisPrompt,
  buildAssistantPrompt,
  buildAssistantAgentPrompt,
  buildOrgKeywordPrompt,
  buildOrgMatchPrompt,
  buildMeetingPrepPrompt,
  buildTranscriptSummaryPrompt,
  buildMilestoneSignalPrompt,
  buildMilestoneCommentPrompt,
  buildMilestoneHokPrompt,
  buildWorkloadSuggesterPrompt,
  buildWorkloadDiscoverPrompt,
  buildSecretaryScopePrompt,
  buildSecretaryPrompt,
  buildWorkAgentPrompt,
  buildWorkOutputPrompt,
  buildWorkOutputQueryPrompt,
  buildWorkOutputGapTriagePrompt,
  buildWorkOutputGapAnswerPrompt,
  buildStakeholderInfluencePrompt,
} = require('./services/agents/prompts');
const { safeParseJson } = require('./services/safe-json');
const {
  emptyTeamsIntel,
  resolveTeamsSourceMode,
  cliTeamsHasData,
  graphTeamsHasData,
  loadTeamsIntelligence,
  loadTeamsIntelligenceFromGraph,
  loadTeamsIntelligenceFromCli,
  emptyEmailIntel,
  resolveEmailSourceMode,
  loadEmailIntelligence,
  emptyMeetingIntel,
  loadMeetingIntelligence,
  loadAccountTeam,
} = require('./services/intelligence');
let acrIpc;
try {
  acrIpc = require('./acr-ipc');
} catch {
  acrIpc = null;
}
let capacityIpc;
try {
  capacityIpc = require('./capacity-ipc');
} catch {
  capacityIpc = null;
}

function nowIso() {
  return new Date().toISOString();
}

function isTrustedRendererSender(event) {
  const rawUrl = event?.senderFrame?.url || '';
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'http:') {
    if (app.isPackaged) return false;
    return parsed.origin === 'http://localhost:5173'
      || parsed.origin === 'http://127.0.0.1:5173';
  }
  if (parsed.protocol !== 'file:' || parsed.hostname) return false;
  let senderPath;
  try {
    senderPath = path.resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const expectedPaths = [
    path.resolve(__dirname, '..', 'src', 'frontend', 'dist', 'index.html'),
    path.resolve(process.resourcesPath, 'src', 'frontend', 'dist', 'index.html'),
  ];
  return expectedPaths.some((expected) => (
    process.platform === 'win32'
      ? expected.toLowerCase() === senderPath.toLowerCase()
      : expected === senderPath
  ));
}

// ── Trusted-sender IPC wrapper ───────────────────────────────────────
// Every renderer request is verified to originate from the SE Assist app frame (the
// dist/index.html webview) before its handler runs — defense-in-depth behind
// contextIsolation + the fixed preload surface. Even if another frame (an injected
// sub-frame or a stray webview) learned a channel name, it cannot drive these handlers,
// which read and write the local customer database. The shell window's own frame never
// calls these channels (shell-preload exposes no IPC), so no legitimate caller is
// affected. An untrusted sender fails loudly with an explicit Unauthorized result.
function registerHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRendererSender(event)) {
      return { ok: false, error: 'Unauthorized IPC sender.' };
    }
    const payload = args[0];
    if (channel.startsWith('influence-')) return withRosterWork(channel, () => handler(event, ...args));
    const accountWork = /^(se-(workspace|acr|sales|customer|suggest|workload|meeting|milestone|work-output|secretary|assistant|work-agent|signal|email)|org-customer|customer-search)/.test(channel);
    if (!accountWork) return handler(event, ...args);
    return withRosterWork(channel, () => {
      const database = openDb();
      if (payload && typeof payload === 'object') {
        const tpid = payload.tpid || payload.customer?.tpid;
        if (tpid) assertActiveTpid(database, tpid);
        if (payload.profileId) assertActiveRecord(database, 'profiles', 'id', payload.profileId);
        if (payload.workloadId) assertActiveRecord(database, 'workloads', 'id', payload.workloadId);
        if (payload.opportunityId) assertActiveRecord(database, 'opportunities', 'opportunity_id', payload.opportunityId);
        if (payload.milestoneId) assertActiveRecord(database, 'milestones', 'milestone_id', payload.milestoneId);
        assertActiveAccountTask(database, payload.task);
        const eventId = payload.eventId || payload.meetingEventId;
        if (eventId) assertActiveRecord(database, 'meetings', 'event_id', eventId);
      }
      return handler(event, ...args);
    });
  });
}

// ── Generated HTML artifacts live in ./services/html-render.js ───────
// ── DB row → API mappers live in ./services/row-mappers.js ───────────

// Mail / calendar / chat are read through WorkIQ, not a direct delegated Graph token.
// This tenant enforces a token-protection CA policy that rejects the app's public-client
// Graph token (AADSTS530084); WorkIQ carries its own admin-consented M365 OAuth and
// proxies Microsoft Graph, so it returns the same shape ({ value: [...] }).
async function callGraph(path) {
  const wiq = getWorkIqClient({ log: () => {} });
  const res = await wiq.fetchOne(path);
  if (res.status && res.status >= 400) {
    throw new Error(
      `WorkIQ Graph fetch failed (HTTP ${res.status}) for ${path}. ` +
      `Ensure the Copilot CLI WorkIQ sign-in is valid.`,
    );
  }
  return { value: res.value, '@odata.nextLink': res.nextLink };
}

// POST-style Graph actions (search, getSchedule, findMeetingTimes) through WorkIQ's
// do_action tool. Returns the action's `data` payload; throws on HTTP >= 400, on an
// error payload, or when the tool returned nothing (so callers never mistake a silent
// failure — e.g. WorkIQ not signed in — for a genuinely empty result).
async function callGraphAction(actionUrl, body) {
  const wiq = getWorkIqClient({ log: () => {} });
  const res = await wiq.doAction(actionUrl, body);
  if ((res.status && res.status >= 400) || res.error || (res.status == null && res.data == null)) {
    const detail = res.error?.error?.message || res.error?.message
      || (typeof res.error === 'string' ? res.error : '')
      || (res.status == null ? 'no response from WorkIQ' : '');
    throw new Error(
      `WorkIQ action failed${res.status ? ` (HTTP ${res.status})` : ''} for ${actionUrl}${detail ? `: ${detail}` : ''}. ` +
      'Ensure the Copilot CLI WorkIQ sign-in is valid.',
    );
  }
  return res.data;
}

function seedCachedProfiles(database) {
  const rosterTpids = getEffectiveTpids(database);
  // With an empty roster there is nothing to seed (and `IN ()` is invalid SQL). Leave
  // any existing cached profiles untouched.
  if (!rosterTpids.length) return;

  const stmt = database.prepare(
    `INSERT OR IGNORE INTO cached_customer_profiles
       (id, tpid, display_name, summary, relationship_health, version, updated_at)
     SELECT ?, ?, ?, '', 'unknown', 1, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM active_cached_customer_profiles WHERE tpid = ? AND deleted_at IS NULL
     )`,
  );
  const insert = database.transaction(() => {
    for (const tpid of rosterTpids) {
      stmt.run(crypto.randomUUID(), tpid, `TPID ${tpid}`, nowIso(), tpid);
    }
  });
  insert();
}

function loadProfileWorkspace(database, profileId) {
  if (!profileId) throw new Error('profileId is required');
  const profileRow = database.prepare('SELECT * FROM active_cached_customer_profiles WHERE id = ? AND deleted_at IS NULL').get(profileId);
  if (!profileRow) throw new Error('Profile not found');
  return {
    ok: true,
    profile: rowToProfile(profileRow),
    todos: customerTasks.listTasks(database, { profileId }),
    assets: database.prepare(
      'SELECT * FROM active_cached_customer_assets WHERE profile_id = ? AND deleted_at IS NULL ORDER BY title',
    ).all(profileId).map(rowToAsset),
    transcripts: database.prepare(
      'SELECT * FROM active_cached_customer_transcripts WHERE profile_id = ? AND deleted_at IS NULL ORDER BY recorded_at DESC',
    ).all(profileId).map(rowToTranscript),
    emailRefs: database.prepare(
      'SELECT * FROM active_cached_customer_email_refs WHERE profile_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC',
    ).all(profileId).map(rowToEmailRef),
    meetingRefs: database.prepare(
      'SELECT * FROM active_cached_customer_meeting_refs WHERE profile_id = ? AND deleted_at IS NULL ORDER BY starts_at DESC',
    ).all(profileId).map(rowToMeetingRef),
    teamsRefs: database.prepare(
      'SELECT * FROM active_cached_customer_teams_refs WHERE profile_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    ).all(profileId).map(rowToTeamsRef),
    aiBriefs: database.prepare(
      `SELECT * FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'ai_brief' AND deleted_at IS NULL
       ORDER BY occurred_at DESC`,
    ).all(profileId).map(rowToTimelineEvent),
    techStacks: database.prepare(
      `SELECT * FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'tech_stack' AND deleted_at IS NULL
       ORDER BY occurred_at DESC`,
    ).all(profileId).map(rowToTimelineEvent),
    acrAnalyses: database.prepare(
      `SELECT * FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'acr_analysis' AND deleted_at IS NULL
       ORDER BY occurred_at DESC`,
    ).all(profileId).map(rowToTimelineEvent),
    salesAdvisories: database.prepare(
      `SELECT * FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'sales_advisor' AND deleted_at IS NULL
       ORDER BY occurred_at DESC`,
    ).all(profileId).map(rowToTimelineEvent),
    customerAnalyses: database.prepare(
      `SELECT * FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'customer_analysis' AND deleted_at IS NULL
       ORDER BY occurred_at DESC`,
    ).all(profileId).map(rowToTimelineEvent),
  };
}


// ── Teams intelligence provider ──────────────────────────────────────
// Two interchangeable sources feed the same normalized shape:
//   • cli   — personal: tools/teams Python CLI -> teams_* tables (keyed by tpid).
//   • graph — org: the Scan Graph button -> cached_customer_teams_refs (by profile_id).
// Selection is config-driven (SE_ASSIST_TEAMS_SOURCE = auto|cli|graph|none, default
// auto). This keeps the customer profile, comprehensive summary, and assistant features
// working for org users on Graph data, with the CLI path as a personal-only enrichment.

// ── Customer intelligence loaders live in ./services/intelligence.js ─

// Assemble the inputs for the customer analysis engine (customer-insights.js):
// research-dossier topics (local), Azure consumption momentum (best-effort —
// needs Microsoft sign-in + VPN; cached a day), and recent Teams/email open
// threads. Opportunities + milestones are passed in from the renderer (already
// queried there). Every source is optional; the engine handles absence honestly.
async function gatherCustomerInsightInputs(database, {
  profileId = null, customer = {}, opportunities = [], milestones = [], includeAcr = true,
} = {}) {
  const name = String(customer.name || '').trim();
  const tpid = String(customer.tpid || '').trim();

  let dossierTopics = [];
  let dossierAvailable = false;
  try {
    const doc = researchDossier.getDossier({ name, tpid });
    if (doc.found) { dossierTopics = doc.topics || []; dossierAvailable = true; }
  } catch { /* dossier optional */ }

  // Azure consumption at this account's per-service grain. The identity-scoped raw
  // ACR cache returns live/fresh/stale data immediately and discloses its timestamp.
  // A cold cache stays unavailable while it warms in the background.
  let acr = null;
  let acrMeta = null;
  if (includeAcr && tpid) {
    if (acrIpc?.getAcrService) {
      try {
        const live = await acrIpc.getAcrService().getAccountMonthlyServiceAcr({
          tpids: [tpid],
          level: 2,
        });
        if (live && Array.isArray(live.services) && live.services.length) {
          acr = live;
          const trulyLive = live.cache?.status === 'live';
          acrMeta = {
            source: trulyLive ? 'live' : 'local-cache',
            asOf: live.cache?.dataAsOf || null,
          };
        }
      } catch { /* consumption is optional */ }
    }
  }

  let engagement = null;
  try {
    const teams = loadTeamsIntelligence(database, tpid, profileId);
    const email = loadEmailIntelligence(database, tpid);
    engagement = {
      openQuestions: [...(teams.openQuestions || []), ...(email.openQuestions || [])].slice(0, 12),
      actionItems: [...(teams.actionItems || []), ...(email.actionItems || [])].slice(0, 12),
    };
  } catch { /* engagement optional */ }

  return { customer: { ...customer, tpid: tpid || customer.tpid }, dossierTopics, dossierAvailable, opportunities, milestones, acr, acrMeta, engagement };
}

function readDesktopFoundryConfig(env = process.env) {
  const endpoint = (env.FOUNDRY_ENDPOINT || env.AI_FOUNDRY_ENDPOINT || '').trim();
  const deployment = (env.FOUNDRY_DEPLOYMENT || env.AI_FOUNDRY_DEPLOYMENT || '').trim();
  const apiKey = (env.FOUNDRY_API_KEY || env.AI_FOUNDRY_API_KEY || '').trim();
  const apiVersion = (env.FOUNDRY_API_VERSION || env.AI_FOUNDRY_API_VERSION || '2024-10-21').trim();
  const tenantId = (env.AZURE_TENANT_ID || env.FOUNDRY_TENANT_ID || env.ENTRA_TENANT_ID || '').trim();
  const clientId = (env.AZURE_CLIENT_ID || env.FOUNDRY_CLIENT_ID || '').trim();
  const clientSecret = (env.AZURE_CLIENT_SECRET || env.FOUNDRY_CLIENT_SECRET || '').trim();
  const hasServicePrincipal = Boolean(tenantId && clientId && clientSecret);
  const authMode = apiKey ? 'apiKey' : (hasServicePrincipal ? 'servicePrincipal' : 'none');
  const enabled = Boolean(endpoint && deployment && authMode !== 'none');
  return { enabled, endpoint, deployment, apiKey, apiVersion, authMode, tenantId, clientId, clientSecret };
}

const foundryTokenCache = new Map();

// Acquire an Entra ID token via client-credentials for the Cognitive Services scope.
async function getFoundryBearerToken(config) {
  const cacheKey = `${config.tenantId}:${config.clientId}`;
  const cached = foundryTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://cognitiveservices.azure.com/.default',
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Entra token request failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed.access_token) {
    throw new Error('Entra token response contained no access_token');
  }
  foundryTokenCache.set(cacheKey, {
    token: parsed.access_token,
    expiresAt: Date.now() + (Number(parsed.expires_in) || 3600) * 1000,
  });
  return parsed.access_token;
}

// ── AI prompt builders live in ./services/agents/prompts.js ─────────

// Pulls a complete HTML document out of a model response (tolerates stray markdown
// code fences or leading prose). Returns null if no full, non-truncated doc is found.
async function callFoundrySummary(config, systemMessage, userMessage, options = {}) {
  options.signal?.throwIfAborted();
  const base = config.endpoint.endsWith('/') ? config.endpoint.slice(0, -1) : config.endpoint;
  const url = `${base}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
  const headers = { 'content-type': 'application/json' };
  if (config.authMode === 'servicePrincipal') {
    const token = await getFoundryBearerToken(config);
    headers.authorization = `Bearer ${token}`;
  } else if (config.authMode === 'apiKey') {
    headers['api-key'] = config.apiKey;
  } else {
    throw new Error('No Foundry auth method configured');
  }

  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ];
  // Newer/reasoning models (gpt-5, o-series) require 'max_completion_tokens' and
  // reject a non-default 'temperature'; older deployments use 'max_tokens'. Start
  // with the modern shape and adapt based on the 400 error the model returns.
  const maxTokens = Number(options.maxTokens) || 1200;
  const body = { messages, max_completion_tokens: maxTokens, temperature: 0.2 };
  const timeoutMs = Number(options.timeoutMs) || 120000;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error?.name === 'AbortError') {
        const timeout = new Error(`Foundry chat-completions timed out after ${Math.round(timeoutMs / 1000)}s (deployment "${config.deployment}").`);
        timeout.code = 'MODEL_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const parsed = JSON.parse(text);
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('Foundry returned no message content');
      }
      return { content: content.trim(), usage: parsed?.usage || null, finishReason: choice?.finish_reason || null };
    }

    // Adapt to model-specific parameter constraints and retry once per issue.
    const detail = text.toLowerCase();
    let adapted = false;
    if (response.status === 400) {
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
    }
    if (!adapted) {
      const error = Object.assign(
        new Error(`Foundry chat-completions failed: ${response.status} ${text.slice(0, 200)}`),
        { code: 'FOUNDRY_HTTP_ERROR', statusCode: response.status },
      );
      if ([429, 503].includes(response.status)) error.retryAt = rateLimitRetryAt(response.headers);
      throw error;
    }
  }
  throw new Error('Foundry chat-completions failed: could not satisfy model parameter requirements');
}

function foundryDedupeKey(config, systemMessage, userMessage, options) {
  if (options.signal || options.tools?.length || options.toolMessages?.length
    || options.responseInput || options.dedupe === false) return null;
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: 'foundry',
    endpoint: config.endpoint,
    deployment: config.deployment,
    systemMessage,
    userMessage,
    maxTokens: Number(options.maxTokens) || 1200,
    timeoutMs: Number(options.timeoutMs) || 120000,
  })).digest('hex');
}

function callScheduledFoundry(config, systemMessage, userMessage, options = {}) {
  // A feature that declares its own Copilot model must never run on the Foundry deployment instead.
  if (options.modelPinned) {
    const label = options.requestLabel || 'This AI feature';
    return Promise.reject(new Error(`${label} runs only on GitHub Copilot model "${options.model}"; the Azure AI Foundry deployment "${config.deployment}" cannot run it. Connect GitHub Copilot in User Home → GitHub sign-in.`));
  }
  const modelRole = options.modelRole === 'utility' ? 'utility' : 'primary';
  return modelRequestScheduler.schedule(
    () => callFoundrySummary(config, systemMessage, userMessage, options),
    {
      priority: options.queuePriority || 'foreground',
      label: options.requestLabel || 'AI request',
      model: config.deployment,
      modelRole,
      signal: options.signal,
      dedupeKey: foundryDedupeKey(config, systemMessage, userMessage, options),
      onStatus: options.onQueueStatus,
    },
  ).then(completion => ({
    ...completion,
    model: completion.model || config.deployment,
    modelRole,
  }));
}

// Message shown when neither model provider is available.
const NO_MODEL_PROVIDER_MESSAGE =
  'No AI model provider is configured. Either connect GitHub Copilot (Settings → AI Model → Connect GitHub Copilot) ' +
  'to use your Copilot subscription models, or configure Azure AI Foundry by setting AI_FOUNDRY_ENDPOINT (or ' +
  'FOUNDRY_ENDPOINT) and AI_FOUNDRY_DEPLOYMENT (or FOUNDRY_DEPLOYMENT), plus EITHER FOUNDRY_API_KEY OR a service ' +
  'principal (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET), in desktop/.env or the repo-root .env.';

// Pick the chat-model backend. A connected GitHub Copilot account is an explicit
// provider choice, so an unavailable Copilot session fails instead of silently switching
// to Foundry. Foundry is used only when Copilot is not connected.
// Returns a uniform provider { kind, source, provider, authMode, deployment, chat }
// whose chat(system, user, options) yields { content, usage, finishReason }, or null.
async function resolveChatProvider({
  copilotOnly = false,
  copilotOnlyMessage = 'Work Agent requires GitHub Copilot. Connect it in Settings > AI Model and select a model that supports high reasoning.',
} = {}) {
  if (githubAuth.isSignedIn()) {
    const ready = await copilotProvider.probe();
    if (ready.ok) {
      return {
        kind: 'github-copilot',
        source: 'github-copilot',
        provider: 'github-copilot',
        authMode: 'github-copilot',
        deployment: copilotProvider.getModelName(),
        chat: (system, user, options) => copilotProvider.chat(system, user, options),
      };
    }
    throw new Error(`GitHub Copilot is unavailable: ${ready.error || 'Reconnect in Settings > AI Model.'}`);
  }
  if (copilotOnly) throw new Error(copilotOnlyMessage);
  const foundry = readDesktopFoundryConfig();
  if (foundry.enabled) {
    return {
      kind: 'foundry',
      source: 'microsoft-foundry',
      provider: 'azure-openai',
      authMode: foundry.authMode,
      deployment: foundry.deployment,
      chat: (system, user, options) => callScheduledFoundry(foundry, system, user, options),
    };
  }
  return null;
}

function resolveAssistantUserName(payloadUserName) {
  // Priority: explicit override from the renderer → the display name from the in-app
  // Microsoft sign-in (your 365 login) → the name persisted in local SQLite from a
  // prior sign-in (offline fallback) → optional SE_ASSIST_USER_NAME env fallback.
  // This resolves "you" from your 365 login with no hardcoded name; the persisted name
  // keeps it working offline after the first sign-in, and the env var remains an
  // optional fallback for the rare case where your M365 display name differs from the
  // name used on MSX deal teams / milestone owners.
  const signedInName = (() => {
    try { return msxIpc?.getSignedInName?.() || ''; } catch { return ''; }
  })();
  const savedName = (() => {
    try { return require('./services/identity-store').getSavedName() || ''; } catch { return ''; }
  })();
  return String(payloadUserName || signedInName || savedName || process.env.SE_ASSIST_USER_NAME || '').trim();
}

// Gather the user's milestones (where they're on the deal team or are owner), rank them
// by how "pressing" they are, and attach each customer's top-of-mind Teams signals.
function gatherAssistantContext(database, userName) {
  const like = `%${userName}%`;
  let rows = [];
  try {
    rows = database.prepare(
      `SELECT m.milestone_id, m.name AS milestone_name, m.milestone_date,
              COALESCE(NULLIF(m.status_label, ''), m.milestone_status) AS status,
              m.workload, m.monthly_use, m.owner_name, m.forecast_comments,
              o.name AS opportunity_name, o.sales_play, o.parent_account_id,
              cu.tpid, cu.name AS customer_name
       FROM active_milestones m
       JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
       LEFT JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
       WHERE m.deal_team_json LIKE ? OR m.owner_name = ?
       ORDER BY (m.milestone_date IS NULL), m.milestone_date ASC`,
    ).all(like, userName);
  } catch (err) {
    // Fail loud: a broken query here (e.g. a schema drift) must surface, not silently pretend the
    // user has zero milestones — that would give a confidently wrong "nothing pressing" answer.
    throw new Error(`Assistant could not read your milestones: ${err.message || String(err)}`);
  }

  const now = Date.now();
  // Only active/open milestones are "pressing"; closed states are excluded.
  const closed = new Set(['completed', 'cancelled', 'hygiene/duplicate', 'duplicate']);
  const pressing = [];
  for (const r of rows) {
    const statusLc = String(r.status || '').toLowerCase();
    if (closed.has(statusLc)) continue;
    const ts = r.milestone_date ? Date.parse(r.milestone_date) : NaN;
    const days = Number.isNaN(ts) ? null : Math.floor((ts - now) / 86_400_000);
    let score = 0;
    if (days != null) {
      if (days < 0) score += 100;
      else if (days <= 30) score += 60;
      else if (days <= 60) score += 40;
      else if (days <= 90) score += 20;
      else score += 5;
    }
    if (statusLc === 'blocked') score += 50;
    if (statusLc === 'at risk' || statusLc === 'off track') score += 40;
    const acr = Number(r.monthly_use) || 0;
    if (acr >= 50_000) score += 30;
    else if (acr >= 10_000) score += 15;
    else if (acr > 0) score += 5;
    pressing.push({ ...r, daysToDate: days, acr, score });
  }
  pressing.sort((a, b) => b.score - a.score);

  const tpids = [...new Set(pressing.map((p) => p.tpid).filter(Boolean))];
  // Customer display name straight from the MSX milestone rows (source-agnostic).
  const nameByTpid = {};
  for (const r of rows) {
    if (r.tpid && !nameByTpid[r.tpid]) nameByTpid[r.tpid] = r.customer_name || null;
  }
  const topOfMind = {};
  for (const tpid of tpids) {
    let profileId = null;
    try {
      const prof = database
        .prepare('SELECT id FROM active_cached_customer_profiles WHERE tpid = ? AND deleted_at IS NULL LIMIT 1')
        .get(tpid);
      profileId = prof?.id || null;
    } catch {
      profileId = null;
    }
    // Source-aware: CLI (personal) or Graph (org) Teams intelligence, or empty.
    const intel = loadTeamsIntelligence(database, tpid, profileId);
    const mail = loadEmailIntelligence(database, tpid);
    const meet = loadMeetingIntelligence(database, tpid);
    // Merge Teams + email signal into one top-of-mind view per customer.
    const mergedQuestions = [
      ...(intel.openQuestions || []).map((q) => ({ ...q, via: 'teams' })),
      ...(mail.openQuestions || []).map((q) => ({ ...q, via: 'email' })),
    ].slice(0, 6);
    const mergedActions = [
      ...(intel.actionItems || []).map((a) => ({ ...a, via: 'teams' })),
      ...(mail.actionItems || []).map((a) => ({ ...a, via: 'email' })),
      ...(meet.actionItems || []).map((a) => ({ ...a, via: 'meeting' })),
    ].slice(0, 6);
    const lastActivity = [intel.lastActivity, mail.lastActivity, meet.lastActivity]
      .filter(Boolean)
      .sort()
      .pop() || null;
    const team = loadAccountTeam(database, tpid);
    topOfMind[tpid] = {
      displayName: nameByTpid[tpid] || null,
      lastActivity,
      openQuestions: mergedQuestions,
      actionItems: mergedActions,
      participants: (intel.participants || []).slice(0, 6),
      teamsSource: intel.source,
      emailCount: mail.emailCount || 0,
      teamsMessages: intel.messageCount || 0,
      meetingCount: meet.meetingCount || 0,
      recentMeetings: (meet.recentMeetings || []).slice(0, 5).map((m) => ({
        subject: m.subject, startsAt: m.start_at, organizer: m.organizer_name,
      })),
      microsoftTeam: (team.microsoft || []).slice(0, 8).map((p) => p.name),
    };
  }

  return { userName, pressingCount: pressing.length, pressing: pressing.slice(0, 20), topOfMind };
}


// ── Customer-data ingestion (WorkIQ) ────────────────────────────────────────────────
const ingestState = { running: false, lastRunAt: null, lastResult: null, lastError: null, lastErrorAt: null };

function ingestCounts(db) {
  const q = (sql) => db.prepare(sql).get().n;
  return {
    emails: q('SELECT COUNT(*) n FROM active_emails'),
    emailsCustomer: q('SELECT COUNT(*) n FROM active_emails WHERE is_customer_related=1'),
    meetings: q('SELECT COUNT(*) n FROM active_meetings'),
    meetingsCustomer: q('SELECT COUNT(*) n FROM active_meetings WHERE is_customer_related=1'),
    chats: q('SELECT COUNT(*) n FROM active_teams_chats'),
    chatsCustomer: q('SELECT COUNT(*) n FROM active_teams_chats WHERE is_customer_related=1'),
  };
}

// A single ingestion pass intentionally defers some AI convergence work: alias
// generation is capped per run (tools/teams/ai_aliases DEFAULT_MAX_NEW) and weak-link
// AI verification is capped per medium (tools/common/ai_classify DEFAULT_CAP). Both are
// cached and resume on the next run, so a fresh user with thousands of accounts fully
// resolves over a few passes rather than one long one. This inspects the residual state
// so the UI can honestly tell the user "run once more to continue" instead of implying a
// partial pass was complete. Another pass only helps when a model is actually available —
// without one, the deferred work cannot resolve, so we don't nag.
function computeIngestConvergence(db, result) {
  const q = (sql) => db.prepare(sql).get().n;
  const aliasRes = (result?.results || []).find((r) => r.medium === 'aliases') || {};
  const modelAvailable = Boolean(aliasRes.model_available);
  const aliasesRemaining = Number(aliasRes.remaining || 0);
  const weakClause = "tier='weak' AND match_method NOT IN ('ai-verified','ai-rejected')";
  const weakUnverified =
    q(`SELECT COUNT(*) n FROM active_email_customer_links WHERE ${weakClause}`) +
    q(`SELECT COUNT(*) n FROM active_meeting_customer_links WHERE ${weakClause}`) +
    q(`SELECT COUNT(*) n FROM active_teams_chat_customer_links WHERE ${weakClause}`);
  const needsAnotherPass = modelAvailable && (aliasesRemaining > 0 || weakUnverified > 0);
  return { modelAvailable, aliasesRemaining, weakUnverified, needsAnotherPass };
}

function broadcastIngest(payload, webContents) {
  try {
    if (webContents && !webContents.isDestroyed()) { webContents.send('m365-ingest-progress', payload); return; }
  } catch { /* fall through to broadcast */ }
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('m365-ingest-progress', payload); } catch { /* ignore */ }
  }
}

function workiqConnectionError(connection) {
  if (connection.reason === 'no-account') {
    return 'Microsoft 365 Copilot (WorkIQ) is not connected. Open Settings and click Connect WorkIQ once — after that the app can reconnect on its own.';
  }
  const detail = String(connection.error || 'no error detail was returned').trim().replace(/\.+$/, '');
  if (connection.reason === 'access-denied') {
    // Signing in again does not grant access, so do not send the user to Connect WorkIQ.
    return `Microsoft 365 Copilot (WorkIQ) is signed in but denied access: ${detail}.`;
  }
  if (connection.reason === 'manual-sign-in-failed') {
    return `Microsoft 365 Copilot (WorkIQ) is not connected: ${detail}. Open Settings and click Connect WorkIQ to try again.`;
  }
  return `Microsoft 365 Copilot (WorkIQ) is disconnected and could not reconnect automatically: ${detail}. Open Settings and click Connect WorkIQ.`;
}

// Research tools show `error` as-is, so give it the same guidance as the other WorkIQ callers.
async function ensureWorkIqWithGuidance(options) {
  const connection = await workiqAuth.ensureConnected(options);
  return connection.connected ? connection : { ...connection, error: workiqConnectionError(connection) };
}

// Pull only saved active accounts. Discovery is a separate, preview-only action.
async function runIngestionJob({ mode = 'incremental', mediums, webContents } = {}) {
  if (ingestState.running) return { ok: false, error: 'Ingestion is already running.' };
  ingestState.running = true;
  ingestState.lastError = null;
  ingestState.lastErrorAt = null;
  const releaseRoster = beginRosterWork('Microsoft 365 ingestion');
  const send = (payload) => broadcastIngest(payload, webContents);
  try {
    const db = openDb();
    // Linking depends on the customers table (auto-aliases + customer domains are
    // derived from it). Without it, meetings/emails/chats are pulled but match nothing,
    // leaving profiles empty. Fail loudly and point the user at the Customers sync
    // rather than silently producing an empty result.
    const rosterTpids = getEffectiveTpids(db);
    if (!rosterTpids.length) throw new Error('No active accounts. Save your TPIDs in User Home before pulling customer information.');
    const customerCount = db.prepare("SELECT COUNT(*) n FROM active_customers").get().n;
    if (!customerCount) {
      throw new Error('No customer accounts synced yet. Run Settings → Sync (Customers) first so your meetings, emails, and chats can be matched to your accounts — otherwise nothing links and profiles stay empty.');
    }
    const accounts = db.prepare(
      `SELECT tpid, name, crm_account_id AS accountId FROM active_customers
       ORDER BY (parenting_level = 861980000) DESC, name`,
    ).all();
    const syncedTpids = new Set(accounts.map((account) => String(account.tpid)));
    if (rosterTpids.some((tpid) => !syncedTpids.has(tpid))) {
      throw new Error('Some active accounts have no synced customer details. Run User Home → Sync from CRM before pulling Microsoft 365 information.');
    }
    send({ phase: 'accounts', detail: `Using ${rosterTpids.length} saved active accounts…` });

    // WorkIQ's token expires on its own, which would otherwise make this run pull
    // nothing. Heal it in place first when the account is still cached; if it can't be
    // healed, fail loudly here rather than reporting a "successful" empty sync.
    send({ phase: 'auth', detail: 'Checking the Microsoft 365 Copilot connection…' });
    const connection = await workiqAuth.ensureConnected({ reason: `ingest:${mode}` });
    if (!connection.connected) throw new Error(workiqConnectionError(connection));
    if (connection.reconnected) {
      send({ phase: 'auth', detail: 'Reconnected to Microsoft 365 Copilot automatically.' });
    }

    const result = await m365Ingest.runIngestion({
      mode,
      mediums: mediums && mediums.length ? mediums : ['email', 'meetings', 'teams'],
      accounts,
      onProgress: send,
    });
    ingestState.lastResult = result;
    ingestState.lastRunAt = result.ranAt;
    result.convergence = computeIngestConvergence(db, result);
    appPrefs.set('lastIngestAt', result.ranAt);
    appPrefs.set('lastIngestResult', { mode: result.mode, ranAt: result.ranAt, results: result.results, errors: result.errors, convergence: result.convergence, degraded: result.degraded, degradedReason: result.degradedReason });
    return { ok: true, result, accounts: rosterTpids.length, counts: ingestCounts(db) };
  } catch (err) {
    ingestState.lastError = err.message;
    ingestState.lastErrorAt = new Date().toISOString();
    send({ phase: 'error', detail: err.message });
    return { ok: false, error: err.message };
  } finally {
    releaseRoster();
    ingestState.running = false;
    send({ phase: 'done' });
  }
}

// Roll-up of "items pulled" across mediums for one ingestion result — the raw count of
// emails + calendar events + Teams messages staged this pass. Alias work stages nothing
// and contributes 0. Used for the auto-ingest activity log line.
function sumIngestItems(result) {
  let n = 0;
  for (const r of (result?.results || [])) {
    n += Number(r.stagedMessages || 0) + Number(r.stagedEvents || 0);
  }
  return n;
}

// Persist a one-line record of the most recent background (auto) ingestion so the user
// can actually see that auto-ingest is doing something: when it last ran, how long it
// took, and how many items it pulled. Keeps a small rolling history (latest first) and
// always exposes the newest entry via autoIngestLastLog.
function recordAutoIngestLog(entry = {}) {
  const record = {
    at: new Date().toISOString(),
    trigger: 'auto',
    ok: Boolean(entry.ok),
    durationMs: Math.max(0, Number(entry.durationMs) || 0),
    items: Math.max(0, Number(entry.items) || 0),
    accounts: entry.accounts != null ? Number(entry.accounts) : null,
    error: entry.ok ? null : (entry.error || 'Unknown error'),
  };
  const secs = (record.durationMs / 1000).toFixed(1);
  console.log(record.ok
    ? `[auto-ingest] ${record.at} — pulled ${record.items} item(s) in ${secs}s`
    : `[auto-ingest] ${record.at} — failed after ${secs}s: ${record.error}`);
  try {
    appPrefs.set('autoIngestLastLog', record);
    const prev = appPrefs.get('autoIngestLog', []);
    const hist = Array.isArray(prev) ? prev : [];
    hist.unshift(record);
    appPrefs.set('autoIngestLog', hist.slice(0, 20));
  } catch { /* best-effort persistence */ }
  return record;
}

// Called on a fixed cadence by the main-process scheduler; runs only when auto-ingest is
// enabled and the configured interval has elapsed since the last run.
async function maybeRunScheduledIngestion() {
  if (!appPrefs.get('autoIngestEnabled', false)) return;
  if (ingestState.running) return;
  const intervalMin = Math.max(15, Number(appPrefs.get('autoIngestIntervalMin', 60)) || 60);
  const last = appPrefs.get('lastIngestAt', null);
  if (last && (Date.now() - new Date(last).getTime()) < intervalMin * 60_000) return;
  const startedAt = Date.now();
  try {
    const res = await runIngestionJob({ mode: 'incremental' });
    const durationMs = Date.now() - startedAt;
    // runIngestionJob already stamps ingestState.lastError on thrown failures, but a
    // clean { ok: false } return (e.g. MSX unavailable) would otherwise vanish silently.
    if (res && res.ok === false) {
      ingestState.lastError = res.error || 'Scheduled ingestion failed.';
      ingestState.lastErrorAt = new Date().toISOString();
      console.warn('[app-ipc] scheduled ingestion did not run:', res.error);
      recordAutoIngestLog({ ok: false, durationMs, error: res.error });
    } else {
      recordAutoIngestLog({ ok: true, durationMs, items: sumIngestItems(res?.result), accounts: res?.accounts });
    }
  } catch (err) {
    // Background timer — never throw, but leave a trace so a silently-stalled scheduler
    // is diagnosable from logs and the Settings ingest section.
    const durationMs = Date.now() - startedAt;
    ingestState.lastError = err?.message || String(err);
    ingestState.lastErrorAt = new Date().toISOString();
    console.warn('[app-ipc] scheduled ingestion error:', err?.message || err);
    recordAutoIngestLog({ ok: false, durationMs, error: err?.message || String(err) });
  }
}

// Keep the WorkIQ connection alive in the background. Its token expires on its own and
// nothing notices until a sync quietly returns nothing, so probe on a slow cadence and
// silently re-acquire when the account is still cached. Cheap: a probe is one small
// read, and the reconnect itself is rate-limited inside workiqAuth.
async function maybeReconnectWorkIq() {
  // Ingestion does its own ensureConnected; don't compete with a run in progress.
  if (ingestState.running) return;
  try {
    const result = await workiqAuth.ensureConnected({ reason: 'watchdog' });
    if (result.reconnected) {
      broadcastIngest({ phase: 'workiq-reconnected', detail: 'Reconnected to Microsoft 365 Copilot.' });
    }
  } catch (err) {
    // Background timer — never throw; the state is readable via workiq-status.
    console.warn('[workiq] watchdog error:', err?.message || err);
  }
}

// ── My Org (org-chart) helpers ───────────────────────────────────────────────
// The Microsoft org chart is read from the Entra directory through WorkIQ (callGraph),
// the only auth path in this tenant with Directory.Read. Everything here is deterministic
// Graph reads; the product-search mode additionally uses the chat provider to map a
// described capability area onto real directory people.
const ORG_PERSON_SELECT =
  'id,displayName,jobTitle,department,mail,userPrincipalName,officeLocation,city,country';

function projectOrgPerson(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id || '',
    displayName: user.displayName || user.userPrincipalName || '(unknown)',
    jobTitle: user.jobTitle || '',
    department: user.department || '',
    mail: (user.mail || user.userPrincipalName || '').toLowerCase(),
    userPrincipalName: user.userPrincipalName || '',
    officeLocation: user.officeLocation || '',
    city: user.city || '',
    country: user.country || '',
  };
}

function escapeODataLiteral(value) {
  return String(value || '').replace(/'/g, "''");
}

// Best-effort JSON extraction from a model reply (handles ```json fences and prose).
function extractJsonBlock(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let from = objStart;
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) from = arrStart;
  if (from < 0) return null;
  const close = s[from] === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end <= from) return null;
  try { return JSON.parse(s.slice(from, end + 1)); } catch { return null; }
}

function orgUserBase(userId) {
  return userId === 'me' ? '/me' : `/users/${encodeURIComponent(userId)}`;
}

async function fetchOrgPerson(userId) {
  const res = await callGraph(`${orgUserBase(userId)}?$select=${ORG_PERSON_SELECT}`);
  const v = Array.isArray(res.value) ? res.value[0] : res.value;
  return projectOrgPerson(v);
}

// Live manager lookup. Returns { manager, definitiveNone }: definitiveNone is true ONLY when
// Graph confirms the person has no manager (HTTP 404 on /manager) — i.e. a real top-of-chain.
// A transient / permission error yields { manager: null, definitiveNone: false } so the cache
// never records a false "top" that would truncate the chain for 30 days.
async function liveManager(userId) {
  try {
    const res = await callGraph(`${orgUserBase(userId)}/manager?$select=${ORG_PERSON_SELECT}`);
    const v = Array.isArray(res.value) ? res.value[0] : res.value;
    const mgr = projectOrgPerson(v);
    return { manager: mgr && mgr.id ? mgr : null, definitiveNone: !(mgr && mgr.id) };
  } catch (err) {
    // Graph returns 404 when the user has no manager — that's a definitive top-of-chain.
    if (/HTTP 404/.test(String((err && err.message) || ''))) {
      return { manager: null, definitiveNone: true };
    }
    return { manager: null, definitiveNone: false };
  }
}

async function fetchOrgReports(userId) {
  const res = await callGraph(`${orgUserBase(userId)}/directReports?$select=${ORG_PERSON_SELECT}&$top=100`);
  return (res.value || [])
    .map(projectOrgPerson)
    .filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}


// ── My Org read-through cache ────────────────────────────────────────────────
// A local, on-read cache of org people + reporting edges (migration 012). Hierarchy
// traversal is served from here for speed and refreshed live on miss / staleness /
// explicit Refresh. SEARCH is never served from cache alone — the live directory is
// always queried and cached matches are only *merged in* (see the handlers), so the
// cache can only ever surface MORE people, never hide newly-relevant ones.
const ORG_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // org chart changes rarely → 30 days

function orgNow() { return new Date().toISOString(); }

function orgIsFresh(ts) {
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && (Date.now() - t) < ORG_CACHE_TTL_MS;
}

function rowToOrgPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name || row.user_principal_name || '(unknown)',
    jobTitle: row.job_title || '',
    department: row.department || '',
    mail: row.mail || '',
    userPrincipalName: row.user_principal_name || '',
    officeLocation: row.office_location || '',
    city: row.city || '',
    country: row.country || '',
  };
}

// Upsert a person's identity fields. Reporting-edge columns are only overwritten when the
// caller passes them (extra.managerId / managerFetchedAt / reportsFetchedAt); otherwise the
// COALESCE keeps any edge we already know — so a plain search read never wipes hierarchy data.
function cacheUpsertPerson(person, extra = {}) {
  if (!person || !person.id) return;
  openDb().prepare(`
    INSERT INTO org_people
      (id, display_name, job_title, department, mail, user_principal_name,
       office_location, city, country, manager_id, manager_fetched_at, reports_fetched_at, updated_at)
    VALUES
      (@id, @display_name, @job_title, @department, @mail, @user_principal_name,
       @office_location, @city, @country, @manager_id, @manager_fetched_at, @reports_fetched_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      display_name        = excluded.display_name,
      job_title           = excluded.job_title,
      department          = excluded.department,
      mail                = excluded.mail,
      user_principal_name = excluded.user_principal_name,
      office_location     = excluded.office_location,
      city                = excluded.city,
      country             = excluded.country,
      manager_id          = COALESCE(excluded.manager_id, org_people.manager_id),
      manager_fetched_at  = COALESCE(excluded.manager_fetched_at, org_people.manager_fetched_at),
      reports_fetched_at  = COALESCE(excluded.reports_fetched_at, org_people.reports_fetched_at),
      updated_at          = excluded.updated_at
  `).run({
    id: person.id,
    display_name: person.displayName === '(unknown)' ? '' : (person.displayName || ''),
    job_title: person.jobTitle || '',
    department: person.department || '',
    mail: person.mail || '',
    user_principal_name: person.userPrincipalName || '',
    office_location: person.officeLocation || '',
    city: person.city || '',
    country: person.country || '',
    manager_id: extra.managerId !== undefined ? extra.managerId : null,
    manager_fetched_at: extra.managerFetchedAt || null,
    reports_fetched_at: extra.reportsFetchedAt || null,
    updated_at: orgNow(),
  });
}

function cacheUpsertPeople(people) {
  const list = (people || []).filter((p) => p && p.id);
  if (!list.length) return;
  const tx = openDb().transaction((rows) => { for (const p of rows) cacheUpsertPerson(p); });
  tx(list);
}

// Record an upward edge on a child node. managerId '' means "confirmed no manager (top)".
function cacheSetManagerEdge(childId, managerId, ts) {
  if (!childId) return;
  const db = openDb();
  const res = db.prepare(
    'UPDATE org_people SET manager_id = ?, manager_fetched_at = ?, updated_at = ? WHERE id = ?',
  ).run(managerId, ts, orgNow(), childId);
  if (res.changes === 0) {
    db.prepare(
      'INSERT OR IGNORE INTO org_people (id, manager_id, manager_fetched_at, updated_at) VALUES (?,?,?,?)',
    ).run(childId, managerId, ts, orgNow());
  }
}

function cacheSetReportsFetched(parentId, ts) {
  if (!parentId) return;
  const db = openDb();
  const res = db.prepare(
    'UPDATE org_people SET reports_fetched_at = ?, updated_at = ? WHERE id = ?',
  ).run(ts, orgNow(), parentId);
  if (res.changes === 0) {
    db.prepare(
      'INSERT OR IGNORE INTO org_people (id, reports_fetched_at, updated_at) VALUES (?,?,?)',
    ).run(parentId, ts, orgNow());
  }
}

function cacheGetPersonRow(id) {
  if (!id) return null;
  return openDb().prepare('SELECT * FROM org_people WHERE id = ?').get(id) || null;
}

function cacheGetPerson(id) {
  const row = cacheGetPersonRow(id);
  return row ? { person: rowToOrgPerson(row), row } : null;
}

function cacheGetPersonByMail(mail) {
  const m = String(mail || '').toLowerCase();
  if (!m) return null;
  const row = openDb().prepare(
    'SELECT * FROM org_people WHERE mail = ? OR lower(user_principal_name) = ? LIMIT 1',
  ).get(m, m);
  return row ? { person: rowToOrgPerson(row), row } : null;
}

// Exact display-name cache lookup. CRM owners are known only by name (owner_id is a
// Dynamics systemuser GUID, not an AAD id), so directory resolution must go by name.
// Prefers a real internal @microsoft.com row when the same name resolves to several.
function cacheGetPersonByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const row = openDb().prepare(
    `SELECT * FROM org_people
     WHERE display_name <> '' AND lower(display_name) = ?
     ORDER BY (CASE WHEN mail LIKE '%@microsoft.com' THEN 0 ELSE 1 END), updated_at DESC
     LIMIT 1`,
  ).get(n);
  return row ? { person: rowToOrgPerson(row), row } : null;
}

// Resolve a CRM owner (display name only) to a directory person. Cache-first when fresh;
// otherwise the live directory drives it (exact match, then a prefix fallback). Returns
// null when the name can't be matched — callers keep the raw owner name in that case.
async function resolveOrgPersonByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const cached = cacheGetPersonByName(clean);
  if (cached && orgIsFresh(cached.row.updated_at)) return cached.person;
  const esc = escapeODataLiteral(clean);
  const attempts = [
    `/users?$filter=displayName eq '${esc}'&$select=${ORG_PERSON_SELECT}&$top=1`,
    `/users?$filter=startswith(displayName,'${esc}')&$select=${ORG_PERSON_SELECT}&$top=1`,
  ];
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const res = await callGraph(attempts[i]); // eslint-disable-line no-await-in-loop
      const person = projectOrgPerson((res.value || [])[0]);
      if (person && person.id) { cacheUpsertPerson(person); return person; }
    } catch { /* try the next filter, then fall back to any stale cache row */ }
  }
  return cached ? cached.person : null;
}

function cacheGetReports(parentId) {
  if (!parentId) return [];
  return openDb().prepare('SELECT * FROM org_people WHERE manager_id = ? ORDER BY display_name').all(parentId)
    .map(rowToOrgPerson)
    .filter(Boolean);
}

const orgLike = (v) => `${String(v || '').replace(/[%_\\]/g, '\\$&')}%`;

// Cached name/mail matches used to *augment* (never replace) live individual search.
function cacheSearchPeople(q, limit = 25) {
  const pref = orgLike(q);
  const mid = `%${String(q || '').replace(/[%_\\]/g, '\\$&')}%`;
  return openDb().prepare(`
    SELECT * FROM org_people
    WHERE display_name LIKE ? ESCAPE '\\'
       OR mail LIKE ? ESCAPE '\\'
       OR user_principal_name LIKE ? ESCAPE '\\'
       OR display_name LIKE ? ESCAPE '\\'
    ORDER BY (CASE WHEN mail LIKE '%@microsoft.com' THEN 0 ELSE 1 END), display_name
    LIMIT ?
  `).all(pref, pref, pref, mid, limit).map(rowToOrgPerson).filter(Boolean);
}

// Cached job-title matches used to *augment* (never replace) the live product-search pool.
function cacheSearchByTitle(kw, limit = 15) {
  if (!kw) return [];
  return openDb().prepare(
    "SELECT * FROM org_people WHERE job_title LIKE ? ESCAPE '\\' ORDER BY display_name LIMIT ?",
  ).all(orgLike(kw), limit).map(rowToOrgPerson).filter(Boolean);
}

// ── Cache-first traversal wrappers ───────────────────────────────────────────
async function getOrgPersonCached(userId, opts = {}) {
  const refresh = Boolean(opts.refresh);
  if (userId === 'me') {
    const meId = appPrefs.get('orgMeId', null);
    if (!refresh && meId) {
      const cached = cacheGetPerson(meId);
      if (cached && orgIsFresh(cached.row.updated_at)) return cached.person;
    }
    const live = await fetchOrgPerson('me');
    if (live && live.id) { cacheUpsertPerson(live); appPrefs.set('orgMeId', live.id); }
    return live;
  }
  if (!refresh) {
    const cached = cacheGetPerson(userId);
    if (cached && orgIsFresh(cached.row.updated_at)) return cached.person;
  }
  const live = await fetchOrgPerson(userId);
  if (live && live.id) cacheUpsertPerson(live);
  return live;
}

// Resolve one step up the reporting line. Returns { manager, definitiveNone } where
// definitiveNone means the directory CONFIRMED there is no manager (a real top of
// org) as opposed to a lookup that simply failed — the chain walker needs that
// distinction so it can say why it stopped instead of implying a top-of-org.
async function resolveManagerStep(userId, opts = {}) {
  const refresh = Boolean(opts.refresh);
  if (!refresh) {
    const row = cacheGetPersonRow(userId);
    if (row && orgIsFresh(row.manager_fetched_at)) {
      if (!row.manager_id) return { manager: null, definitiveNone: true }; // resolved top-of-chain
      const mgr = cacheGetPerson(row.manager_id);
      if (mgr) return { manager: mgr.person, definitiveNone: false };      // else fall through to live
    }
  }
  const { manager, definitiveNone } = await liveManager(userId);
  const ts = orgNow();
  if (manager && manager.id) {
    cacheUpsertPerson(manager);
    cacheSetManagerEdge(userId, manager.id, ts);
  } else if (definitiveNone) {
    cacheSetManagerEdge(userId, '', ts);
  }
  return { manager, definitiveNone };
}

async function getOrgManagerCached(userId, opts = {}) {
  const { manager } = await resolveManagerStep(userId, opts);
  return manager;
}

async function getOrgReportsCached(userId, opts = {}) {
  const refresh = Boolean(opts.refresh);
  if (!refresh) {
    const row = cacheGetPersonRow(userId);
    if (row && orgIsFresh(row.reports_fetched_at)) return cacheGetReports(userId);
  }
  const reports = await fetchOrgReports(userId); // live, sorted
  const ts = orgNow();
  const tx = openDb().transaction(() => {
    for (const child of reports) cacheUpsertPerson(child, { managerId: userId, managerFetchedAt: ts });
    cacheSetReportsFetched(userId, ts);
  });
  tx();
  return reports;
}

// Walk the reporting line upward until the top of the org. Returns the chain plus
// WHY it ended: 'satya' / 'top' mean it is genuinely complete, while 'unresolved',
// 'depth' and 'cycle' mean the directory ran out of answers — the UI says so
// instead of presenting a truncated chain as if it reached the top.
const ORG_TOP_NAME = 'satya nadella';
const ORG_TOP_MAIL = 'satyan@microsoft.com';

async function getManagerChainCached(userId, depth, opts = {}) {
  const chain = [];
  let current = userId;
  let stoppedReason = 'depth';
  for (let i = 0; i < depth; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { manager, definitiveNone } = await resolveManagerStep(current, opts);
    if (!manager || !manager.id) {
      stoppedReason = definitiveNone ? 'top' : 'unresolved';
      break;
    }
    if (chain.some((m) => m.id === manager.id)) { stoppedReason = 'cycle'; break; }
    chain.push(manager);
    const managerName = String(manager.displayName || '').trim().toLowerCase();
    const managerMail = String(manager.mail || '').trim().toLowerCase();
    if (managerName === ORG_TOP_NAME || managerMail === ORG_TOP_MAIL) { stoppedReason = 'satya'; break; }
    current = manager.id;
  }
  // nearest manager first ... top of org last
  return { chain, stoppedReason, reachedTop: stoppedReason === 'satya' || stoppedReason === 'top' };
}

// ── WorkIQ-emitted signal helpers (Unified Search, group memberships, calendars) ─────
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Project a Microsoft Search driveItem hit into a compact document record.
function projectSearchDoc(hit) {
  const r = hit?.resource || {};
  const name = r.name || '';
  if (!name) return null;
  return {
    id: r.id || hit?.hitId || name,
    name,
    webUrl: r.webUrl || '',
    summary: stripHtml(hit?.summary),
    size: Number(r.size) || 0,
    mimeType: r.file?.mimeType || '',
    createdBy: r.createdBy?.user?.displayName || '',
    lastModifiedBy: r.lastModifiedBy?.user?.displayName || '',
    lastModifiedDateTime: r.lastModifiedDateTime || r.fileSystemInfo?.lastModifiedDateTime || '',
    driveId: r.parentReference?.driveId || '',
  };
}

// ── Meeting prep (per-meeting AI action) ─────────────────────────────
// Registrable-ish domain from an email address, minus common Microsoft-internal
// domains (which never indicate the *customer* on a meeting).
const MS_INTERNAL_DOMAINS = new Set([
  'microsoft.com', 'service.microsoft.com', 'exchange.microsoft.com',
  'microsoft.onmicrosoft.com', 'europe.corp.microsoft.com',
]);

function emailDomain(address) {
  const at = String(address || '').toLowerCase().trim();
  const idx = at.lastIndexOf('@');
  if (idx < 0) return '';
  return at.slice(idx + 1).replace(/[>)\s]+$/, '');
}

function isExternalDomain(domain) {
  if (!domain) return false;
  if (MS_INTERNAL_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.microsoft.com')) return false;
  return true;
}

// Bare host from a website field ("https://www.acme.com/x" -> "acme.com").
function websiteHost(website) {
  let s = String(website || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  return s;
}

function resolveMilestoneTpid(database, milestoneRow) {
  let tpid = null;
  if (milestoneRow?.parent_account_id) {
    const row = database.prepare("SELECT tpid FROM active_customers WHERE crm_account_id = ? AND tpid IS NOT NULL AND tpid != '' LIMIT 1").get(milestoneRow.parent_account_id);
    tpid = row?.tpid || null;
  }
  if (!tpid && milestoneRow?.customer_name) {
    const row = database.prepare("SELECT tpid FROM active_customers WHERE name = ? AND tpid IS NOT NULL AND tpid != '' LIMIT 1").get(milestoneRow.customer_name);
    tpid = row?.tpid || null;
  }
  return tpid;
}

// HoK activity task categories — value/label pairs mirrored from the renderer's
// TASK_CATEGORIES (Milestones.jsx) so the HoK suggester can be grounded on the exact
// allowed set and its returned category value can be validated server-side.
// KEEP IN SYNC with TASK_CATEGORIES in src/frontend/src/components/Milestones.jsx.
const HOK_TASK_CATEGORIES = [
  { value: 861980004, label: 'Architecture Design Session' },
  { value: 861980014, label: 'Assessment' },
  { value: 861980006, label: 'Blocker Escalation' },
  { value: 861980007, label: 'Consumption Plan' },
  { value: 861980002, label: 'Demo' },
  { value: 861980005, label: 'PoC/Pilot' },
  { value: 861980009, label: 'RFP/RFI' },
  { value: 606820005, label: 'Technical Close/Win Plan' },
  { value: 861980001, label: 'Workshop' },
];
const HOK_TASK_CATEGORY_VALUES = new Set(HOK_TASK_CATEGORIES.map((c) => String(c.value)));

// ── AI agent wiring ──────────────────────────────────────────────────────────
// Bind each declarative agent in the catalog to its concrete render implementation
// (the prompt builders above). Grounding is assembled by the individual IPC handlers
// and passed in as `input.context`; each agent's declared `tools` name exactly that
// grounding. The runtime applies the agent's memory and model options and makes the
// single model call, so every AI feature runs through one shared, self-describing path.
const AGENT_IMPLS = {
  'comprehensive-summary': { render: (context) => buildComprehensivePrompt(context) },
  'tech-stack': { render: (context) => buildTechStackPrompt(context) },
  'acr-analysis': { render: (context) => buildAcrAnalysisPrompt(context) },
  'sales-advisor': { render: (context) => buildSalesAdvisorPrompt(context) },
  'customer-analysis': { render: (context) => buildCustomerAnalysisPrompt(context) },
  'assistant': { render: (context, input) => buildAssistantAgentPrompt({ userName: input.userName, question: input.question, context }) },
  'secretary': { render: (context) => buildSecretaryPrompt(context) },
  'secretary-scope': { render: (context) => buildSecretaryScopePrompt(context) },
  'work-agent': { render: (_context, input) => buildWorkAgentPrompt(input) },
  'work-output': { render: context => buildWorkOutputPrompt(context) },
  'work-output-public-query': { render: context => buildWorkOutputQueryPrompt(context) },
  'work-output-gap-triage': { render: context => buildWorkOutputGapTriagePrompt(context) },
  'work-output-gap-answer': { render: context => buildWorkOutputGapAnswerPrompt(context) },
  'meeting-prep': { render: (context) => buildMeetingPrepPrompt(context) },
  'transcript-summarizer': { render: (context) => buildTranscriptSummaryPrompt(context) },
  'milestone-signal-finder': { render: (context) => buildMilestoneSignalPrompt(context) },
  'milestone-comment-suggester': { render: (context) => buildMilestoneCommentPrompt(context) },
  'milestone-hok-suggester': { render: (context) => buildMilestoneHokPrompt(context) },
  'workload-suggester': { render: (context) => buildWorkloadSuggesterPrompt(context) },
  'workload-discoverer': { render: (context) => buildWorkloadDiscoverPrompt(context) },
  'org-title-mapper': { render: (_context, input) => buildOrgKeywordPrompt(input.description) },
  'org-roster-matcher': { render: (_context, input) => buildOrgMatchPrompt(input.description, input.pool) },
  'stakeholder-influence-analyst': { render: (context) => buildStakeholderInfluencePrompt(context) },
};

const RESOLVED_AGENTS = resolveAgents(AGENT_IMPLS);

// Create a runtime bound to a just-resolved model provider. The provider is resolved
// per request (GitHub Copilot when signed in, else Azure Foundry), so the runtime is
// cheap to construct here and keeps the provider explicit at each call site.
function makeAgentRuntime(provider) {
  return createAgentRuntime({ provider, agents: RESOLVED_AGENTS });
}

let modelActivitySubscription = null;

function broadcastModelActivity(activity) {
  const targets = typeof webContents?.getAllWebContents === 'function'
    ? webContents.getAllWebContents()
    : BrowserWindow.getAllWindows().map(win => win.webContents);
  for (const contents of targets) {
    try {
      if (!contents.isDestroyed()) contents.send('se-model-activity', activity);
    } catch { /* a closing window must not affect queued model work */ }
  }
}

function registerAppIpc() {
  const db = openDb();
  seedCachedProfiles(db);
  registerHandler('se-copy-milestone-teams-message', (_event, payload) => (
    copyMilestoneTeamsMessage(payload, clipboard)
  ));
  if (!modelActivitySubscription && typeof copilotProvider.onActivity === 'function') {
    modelActivitySubscription = copilotProvider.onActivity(broadcastModelActivity);
  }

  // Customer profiles are read from the local SQLite cache only. There is no cloud
  // backend: the app keeps all data on this machine.
  registerHandler('se-cloud-profiles', async () => {
    seedCachedProfiles(db);
    return db.prepare('SELECT * FROM active_cached_customer_profiles WHERE deleted_at IS NULL ORDER BY display_name').all().map(rowToProfile);
  });

  registerHandler('se-workspace-get', (_event, profileId) => loadProfileWorkspace(db, profileId));

  // Enumerate the dedicated AI agents (instruction focus, knowledge, tools, memory,
  // model) so Settings can show what each SE Assist AI feature is and how it is grounded.
  registerHandler('se-agents-list', () => describeCatalog());

  registerHandler('se-workspace-save-profile', (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');
    const summary = String(payload?.summary || '').trim();
    const relationshipHealth = String(payload?.relationshipHealth || 'unknown').trim() || 'unknown';
    const updatedAt = nowIso();
    const result = db.prepare(
      `UPDATE cached_customer_profiles
       SET summary = ?, relationship_health = ?, version = version + 1, updated_at = ?, synced_at = CURRENT_TIMESTAMP
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(summary, relationshipHealth, updatedAt, profileId);
    if (result.changes === 0) throw new Error('Profile not found');
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-workspace-save-todo', (_event, payload) => {
    return db.transaction(() => {
      const todo = customerTasks.saveTask(db, payload);
      return { ...(todo.profileId ? loadProfileWorkspace(db, todo.profileId) : { ok: true }), todo };
    })();
  });

  registerHandler('se-workspace-delete-todo', (_event, payload) => {
    return db.transaction(() => {
      const todo = customerTasks.deleteTask(db, payload);
      return todo.profileId ? loadProfileWorkspace(db, todo.profileId) : { ok: true };
    })();
  });

  registerHandler('se-task-assignment-options', () => {
    seedCachedProfiles(db);
    return customerTasks.getAssignmentOptions(db);
  });

  registerHandler('se-meeting-tasks-get', (_event, payload = {}) => {
    return meetingTasks.getMeetingTasks(db, payload.eventId);
  });

  registerHandler('se-meeting-tasks-create', (_event, payload = {}) => {
    return meetingTasks.createMeetingTasks(db, payload.eventId);
  });

  registerHandler('se-workspace-save-asset', (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    const title = String(payload?.title || '').trim();
    if (!profileId) throw new Error('profileId is required');
    if (!title) throw new Error('Asset title is required');
    const id = String(payload?.id || crypto.randomUUID());
    const updatedAt = nowIso();
    const tags = Array.isArray(payload?.tags)
      ? payload.tags
      : String(payload?.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    db.prepare(
      `INSERT INTO cached_customer_assets
         (id, profile_id, asset_type, title, url, tags_json, freshness_label, notes, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         asset_type=excluded.asset_type,
         title=excluded.title,
         url=excluded.url,
         tags_json=excluded.tags_json,
         freshness_label=excluded.freshness_label,
         notes=excluded.notes,
         version=cached_customer_assets.version + 1,
         deleted_at=NULL,
         updated_at=excluded.updated_at,
         synced_at=CURRENT_TIMESTAMP`,
    ).run(
      id,
      profileId,
      String(payload?.assetType || 'link'),
      title,
      payload?.url || null,
      JSON.stringify(tags),
      String(payload?.freshnessLabel || 'unknown'),
      String(payload?.notes || ''),
      updatedAt,
    );
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-workspace-delete-asset', (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    const id = String(payload?.id || '').trim();
    if (!profileId || !id) throw new Error('profileId and id are required');
    const updatedAt = nowIso();
    db.prepare(
      `UPDATE cached_customer_assets
       SET deleted_at = ?, version = version + 1, updated_at = ?, synced_at = CURRENT_TIMESTAMP
       WHERE id = ? AND profile_id = ?`,
    ).run(updatedAt, updatedAt, id, profileId);
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-workspace-prepare-meeting', async (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');

    const provider = await resolveChatProvider();
    if (!provider) {
      throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    }
    const runtime = makeAgentRuntime(provider);

    const workspace = loadProfileWorkspace(db, profileId);
    const customer = payload?.customer || {};
    const tpid = String(customer.tpid || workspace.profile.tpid || '').trim();
    const teams = loadTeamsIntelligence(db, tpid, profileId);
    const email = loadEmailIntelligence(db, tpid);
    const meetings = loadMeetingIntelligence(db, tpid);
    const accountTeam = loadAccountTeam(db, tpid);
    const context = {
      profile: workspace.profile,
      customer,
      todos: workspace.todos,
      assets: workspace.assets,
      transcripts: workspace.transcripts,
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
      teams,
      email,
      meetings,
      accountTeam,
    };

    let completion;
    try {
      completion = await runtime.run('comprehensive-summary', { input: { context } });
    } catch (err) {
      throw new Error(`AI summary generation failed: ${err.message || String(err)}`);
    }

    const brief = {
      title: `Comprehensive summary — ${customer.name || workspace.profile.displayName}`,
      summary: completion.content,
      metadata: {
        generatedAt: nowIso(),
        source: provider.source,
        provider: provider.provider,
        foundryEnabled: provider.kind === 'foundry',
        authMode: provider.authMode,
        deployment: provider.deployment,
        model: completion.model || provider.deployment,
        modelRole: completion.modelRole || 'primary',
        usage: completion.usage,
        counts: {
          openTodos: workspace.todos.filter((todo) => todo.status !== 'done').length,
          assets: workspace.assets.length,
          transcripts: workspace.transcripts.length,
          opportunities: context.opportunities.length,
          milestones: context.milestones.length,
          teamsChats: teams.chatCount || 0,
          teamsMessages: teams.messageCount || 0,
          emails: email.emailCount || 0,
          meetings: meetings.meetingCount || 0,
          accountTeamMicrosoft: accountTeam.counts?.microsoft || 0,
        },
      },
    };

    const id = crypto.randomUUID();
    const occurredAt = nowIso();

    // Formatting is deterministic: a second model call adds latency and consumes quota
    // without adding new analysis. The saved markdown is rendered locally instead.
    const htmlPath = writeHtmlArtifact('summary', id, { ...brief, occurredAt });
    if (htmlPath) brief.metadata.htmlStyle = 'document';
    if (htmlPath) brief.metadata.htmlPath = htmlPath;
    db.prepare(
      `INSERT INTO cached_customer_timeline_events
         (id, profile_id, event_type, source, source_id, title, occurred_at, summary, metadata_json, relevance_score, version, updated_at)
       VALUES (?, ?, 'ai_brief', 'foundry', ?, ?, ?, ?, ?, 1.0, 1, ?)`,
    ).run(id, profileId, id, brief.title, occurredAt, brief.summary, JSON.stringify(brief.metadata), occurredAt);

    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-workspace-generate-tech-stack', async (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');

    const provider = await resolveChatProvider();
    if (!provider) {
      throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    }
    const runtime = makeAgentRuntime(provider);

    const workspace = loadProfileWorkspace(db, profileId);
    const customer = payload?.customer || {};
    const tpid = String(customer.tpid || workspace.profile.tpid || '').trim();
    const teams = loadTeamsIntelligence(db, tpid, profileId);
    const email = loadEmailIntelligence(db, tpid);
    const context = {
      profile: workspace.profile,
      customer,
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
      teams,
      email,
    };

    let completion;
    try {
      completion = await runtime.run('tech-stack', { input: { context } });
    } catch (err) {
      throw new Error(`Tech stack generation failed: ${err.message || String(err)}`);
    }

    const brief = {
      title: `Tech stack — ${customer.name || workspace.profile.displayName}`,
      summary: completion.content,
      metadata: {
        generatedAt: nowIso(),
        source: provider.source,
        provider: provider.provider,
        foundryEnabled: provider.kind === 'foundry',
        authMode: provider.authMode,
        deployment: provider.deployment,
        model: completion.model || provider.deployment,
        modelRole: completion.modelRole || 'primary',
        usage: completion.usage,
        counts: {
          opportunities: context.opportunities.length,
          milestones: context.milestones.length,
          teamsMessages: teams.messageCount || 0,
          emails: email.emailCount || 0,
        },
      },
    };

    const id = crypto.randomUUID();
    const occurredAt = nowIso();

    const htmlPath = writeHtmlArtifact('techstack', id, { ...brief, occurredAt });
    if (htmlPath) brief.metadata.htmlStyle = 'document';
    if (htmlPath) brief.metadata.htmlPath = htmlPath;
    db.prepare(
      `INSERT INTO cached_customer_timeline_events
         (id, profile_id, event_type, source, source_id, title, occurred_at, summary, metadata_json, relevance_score, version, updated_at)
       VALUES (?, ?, 'tech_stack', 'foundry', ?, ?, ?, ?, ?, 1.0, 1, ?)`,
    ).run(id, profileId, id, brief.title, occurredAt, brief.summary, JSON.stringify(brief.metadata), occurredAt);
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-acr-analysis', async (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    if (!acrIpc?.getAcrService) throw new Error('ACR service unavailable.');

    const workspace = loadProfileWorkspace(db, profileId);
    const customer = payload?.customer || {};
    const tpid = String(customer.tpid || workspace.profile.tpid || '').trim();
    if (!tpid) throw new Error('This customer has no TPID, so Azure consumption cannot be analyzed.');

    const level = Number(payload?.level) || 2;
    const fiscalYear = payload?.fiscalYear;

    // Pull the monthly ACR-by-service series for this customer (monetary signal).
    let acr;
    try {
      acr = await acrIpc.getAcrService().getAccountMonthlyServiceAcr({
        tpids: [tpid],
        level,
        fiscalYear,
        force: true,
      });
    } catch (err) {
      throw new Error(`Could not load Azure consumption for the analysis: ${err.message || String(err)}`);
    }
    if (!acr.services || acr.services.length === 0) {
      throw new Error(`No Azure consumption recorded for this account in ${acr.fiscalYear}, so there is nothing to analyze yet.`);
    }

    // Reuse the most recent tech-stack brief as additional grounding, if present.
    const techRow = db.prepare(
      `SELECT summary FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'tech_stack' AND deleted_at IS NULL
       ORDER BY occurred_at DESC LIMIT 1`,
    ).get(profileId);
    const techStackSummary = techRow?.summary || '';

    const context = {
      customer,
      acr,
      techStackSummary,
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
    };

    let completion;
    try {
      completion = await runtime.run('acr-analysis', { input: { context } });
    } catch (err) {
      throw new Error(`ACR analysis failed: ${err.message || String(err)}`);
    }

    const brief = {
      title: `Azure Consumption analysis — ${customer.name || workspace.profile.displayName}`,
      summary: completion.content,
      metadata: {
        generatedAt: nowIso(),
        source: provider.source,
        provider: provider.provider,
        authMode: provider.authMode,
        deployment: provider.deployment,
        model: completion.model || provider.deployment,
        modelRole: completion.modelRole || 'primary',
        usage: completion.usage,
        counts: {
          fiscalYear: acr.fiscalYear,
          serviceLevel: acr.level,
          services: acr.services.length,
          months: acr.months.length,
          grandTotal: acr.grandTotal,
        },
      },
    };

    const id = crypto.randomUUID();
    const occurredAt = nowIso();

    const htmlPath = writeHtmlArtifact('acr-analysis', id, { ...brief, occurredAt });
    if (htmlPath) brief.metadata.htmlStyle = 'document';
    if (htmlPath) brief.metadata.htmlPath = htmlPath;

    db.prepare(
      `INSERT INTO cached_customer_timeline_events
         (id, profile_id, event_type, source, source_id, title, occurred_at, summary, metadata_json, relevance_score, version, updated_at)
       VALUES (?, ?, 'acr_analysis', 'foundry', ?, ?, ?, ?, ?, 1.0, 1, ?)`,
    ).run(id, profileId, id, brief.title, occurredAt, brief.summary, JSON.stringify(brief.metadata), occurredAt);
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-sales-advisor', async (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    const workspace = loadProfileWorkspace(db, profileId);
    const customer = payload?.customer || {};
    const storedTpid = String(workspace.profile.tpid || '').trim();
    const suppliedTpid = String(customer.tpid || '').trim();
    if (storedTpid && suppliedTpid && storedTpid !== suppliedTpid) {
      throw new Error('Customer TPID does not match the stored profile.');
    }
    const tpid = storedTpid || suppliedTpid;
    const capacityAllowed = Boolean(tpid && getEffectiveTpids(db).includes(tpid));
    const objective = String(payload?.objective || '').trim();

    // Contacts (the outreach pool) + internal account team, scoped to this TPID.
    let contacts = [];
    let accountTeam = [];
    if (tpid) {
      try {
        contacts = db.prepare(
          `SELECT full_name, job_title, email, linkedin_url FROM active_customer_contacts
           WHERE tpid = ? ORDER BY (linkedin_url IS NULL), full_name LIMIT 60`,
        ).all(tpid);
      } catch { /* table may be absent */ }
      try {
        accountTeam = db.prepare(
          `SELECT person_name, person_email, org, engagement FROM active_customer_account_team
           WHERE tpid = ? AND org = 'microsoft' ORDER BY engagement DESC LIMIT 40`,
        ).all(tpid);
      } catch { /* table may be absent / different schema */ }
    }

    // Reuse the latest tech-stack brief + Teams/email intelligence as grounding.
    const techRow = db.prepare(
      `SELECT summary FROM active_cached_customer_timeline_events
       WHERE profile_id = ? AND event_type = 'tech_stack' AND deleted_at IS NULL
       ORDER BY occurred_at DESC LIMIT 1`,
    ).get(profileId);
    const teams = loadTeamsIntelligence(db, tpid, profileId);
    const email = loadEmailIntelligence(db, tpid);

    // ACR consumption (best-effort — needs Microsoft sign-in + VPN; never blocks the plan).
    let acr = {};
    if (tpid && acrIpc?.getAcrService) {
      try {
        acr = await acrIpc.getAcrService().getAccountMonthlyServiceAcr({
          tpids: [tpid],
          level: 2,
        });
      } catch { /* consumption is optional context */ }
    }

    let aiCapacity = {};
    if (capacityAllowed && capacityIpc?.getCapacityService) {
      try {
        aiCapacity = await capacityIpc.getCapacityService().getCustomerCapacity({ tpid });
      } catch (err) {
        aiCapacity = { error: err.message || String(err) };
      }
    } else if (tpid) {
      aiCapacity = { error: 'Customer is not in the configured account roster.' };
    }

    const context = {
      customer,
      acr,
      aiCapacity,
      techStackSummary: techRow?.summary || '',
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
      contacts,
      accountTeam,
      teams,
      email,
      objective,
    };

    let completion;
    try {
      completion = await runtime.run('sales-advisor', { input: { context } });
    } catch (err) {
      throw new Error(`Sales advisor failed: ${err.message || String(err)}`);
    }

    const brief = {
      title: `Sales play — ${customer.name || workspace.profile.displayName}`,
      summary: completion.content,
      metadata: {
        generatedAt: nowIso(),
        source: provider.source,
        provider: provider.provider,
        authMode: provider.authMode,
        deployment: provider.deployment,
        model: completion.model || provider.deployment,
        modelRole: completion.modelRole || 'primary',
        usage: completion.usage,
        objective: objective || null,
        counts: {
          opportunities: context.opportunities.length,
          milestones: context.milestones.length,
          contacts: contacts.length,
          accountTeam: accountTeam.length,
          acrServices: (acr.services || []).length,
          hasTechStack: !!techRow?.summary,
        },
      },
    };

    const id = crypto.randomUUID();
    const occurredAt = nowIso();

    const htmlPath = writeHtmlArtifact('sales-advisor', id, { ...brief, occurredAt });
    if (htmlPath) brief.metadata.htmlStyle = 'document';
    if (htmlPath) brief.metadata.htmlPath = htmlPath;

    db.prepare(
      `INSERT INTO cached_customer_timeline_events
         (id, profile_id, event_type, source, source_id, title, occurred_at, summary, metadata_json, relevance_score, version, updated_at)
       VALUES (?, ?, 'sales_advisor', 'foundry', ?, ?, ?, ?, ?, 1.0, 1, ?)`,
    ).run(id, profileId, id, brief.title, occurredAt, brief.summary, JSON.stringify(brief.metadata), occurredAt);
    return loadProfileWorkspace(db, profileId);
  });

  // Suggest workloads — pull the LAST 4 WEEKS of emails, meetings and Teams chats for the SE's
  // roster accounts and ask the model to propose one or more workloads, each resolved to a
  // real customer (tpid + name). The AI step is grounded on the candidate roster so it returns
  // real tpids, never free text. Proposals are validated (resolvable tpid) then persisted as
  // draft `workload_suggestions` rows — a fresh run REPLACES the prior draft set. The account's
  // SSP, opportunities and milestones (step "Build details") are deterministic DB reads done in
  // the renderer, so this handler is purely: gather signal -> AI -> validate -> persist.
  registerHandler('se-suggest-workloads', async (_event, payload = {}) => {
    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    // Look-back window for the comms scan. Single source of truth: change the day count
    // here and the human label follows through to the prompt and the error/flash copy.
    const SUGGEST_WINDOW_DAYS = 28;
    const SUGGEST_WINDOW_LABEL = 'last 4 weeks';
    const since = new Date(Date.now() - SUGGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rosterTpids = getEffectiveTpids(db);
    if (!rosterTpids.length) {
      throw new Error('No accounts are configured in the roster. Add accounts in Settings → Default Accounts first.');
    }

    // Optional account scoping. The renderer may pass an explicit subset of tpids to
    // suggest for (the account filter). When present, restrict the scan to the
    // intersection with the roster and fail loudly if the selection matches no roster
    // account — never silently fall back to scanning everything. An empty/absent
    // selection keeps the default behaviour of scanning the whole roster.
    const requestedTpids = Array.isArray(payload?.tpids)
      ? [...new Set(payload.tpids.map((t) => String(t == null ? '' : t).trim()).filter(Boolean))]
      : [];
    let scanTpids = rosterTpids;
    if (requestedTpids.length) {
      const rosterSet = new Set(rosterTpids.map((t) => String(t)));
      scanTpids = requestedTpids.filter((t) => rosterSet.has(t));
      if (!scanTpids.length) {
        throw new Error('None of the selected accounts are in your roster. Adjust the account filter and try again.');
      }
    }

    // Resolve roster tpids to real customers. A TPID (top-parent id) can roll up MANY crm
    // account rows with different names, so collapse to ONE entry per tpid — otherwise the
    // scan budget below is spent on duplicate rows of the same tpid and the model only ever
    // sees a couple of accounts. Prefer the curated per-tpid profile display name as the label,
    // then the account's TOP-PARENT name.
    const placeholders = scanTpids.map(() => '?').join(', ');
    // A "TPID <n>" display name is a PLACEHOLDER the profile tables seed before the real customer
    // name is resolved — never use it as an account label (it's what produced the numeric-looking
    // tags on suggested workloads). Treat it as absent so a real name always wins.
    const isPlaceholderName = (s) => /^TPID\s+\d+$/i.test(String(s == null ? '' : s).trim());
    // Order so the Dynamics top-parent row (parenting_level 861980000) is preferred as the label.
    const customerRows = db.prepare(
      `SELECT tpid, crm_account_id, name, parenting_level FROM active_customers WHERE tpid IN (${placeholders})
       ORDER BY (parenting_level = 861980000) DESC, name`,
    ).all(...scanTpids);

    const canonicalName = new Map();
    for (const table of ['teams_customer_profile', 'email_customer_profile', 'meeting_customer_profile']) {
      try {
        const rows = db.prepare(
          `SELECT tpid, display_name FROM ${table} WHERE tpid IN (${placeholders}) AND COALESCE(display_name, '') <> ''`,
        ).all(...scanTpids);
        for (const r of rows) {
          const key = String(r.tpid);
          if (isPlaceholderName(r.display_name)) continue; // skip "TPID N" placeholders
          if (!canonicalName.has(key)) canonicalName.set(key, r.display_name);
        }
      } catch { /* profile tables are optional on older DBs */ }
    }

    // Best real customer-table name per tpid (top-parent first, skip empty/placeholder names).
    const customerNameByTpid = new Map();
    const crmByTpid = new Map();
    for (const row of customerRows) {
      const tpid = String(row.tpid);
      if (!crmByTpid.has(tpid)) crmByTpid.set(tpid, row.crm_account_id);
      const nm = String(row.name || '').trim();
      if (!customerNameByTpid.has(tpid) && nm && !isPlaceholderName(nm)) {
        customerNameByTpid.set(tpid, row.name);
      }
    }

    // One authoritative customer per tpid: curated profile name (non-placeholder) → real top-parent
    // customer name → the "TPID N" placeholder only as a last resort so the account is still labeled.
    const customerByTpid = new Map();
    for (const tpid of scanTpids.map(String)) {
      if (customerByTpid.has(tpid)) continue;
      const name = canonicalName.get(tpid) || customerNameByTpid.get(tpid) || null;
      if (name == null && !crmByTpid.has(tpid)) continue; // no customer row at all for this tpid
      customerByTpid.set(tpid, {
        tpid,
        crm_account_id: crmByTpid.get(tpid) || null,
        name: name || `TPID ${tpid}`,
      });
    }
    const customers = [...customerByTpid.values()];

    // Recent comms for an account within [sinceIso, now]. Parameterized by window so the scan can
    // be widened and re-run below when the deduped result is thin.
    const recentEmails = (tpid, sinceIso) => {
      try {
        return db.prepare(
          `SELECT e.message_id, e.subject, e.from_name, e.received_at,
                  substr(COALESCE(e.body_text, ''), 1, 500) AS excerpt
           FROM active_emails e
           JOIN active_email_customer_links l ON l.message_id = e.message_id
           WHERE l.tpid = ? AND COALESCE(e.received_at, e.sent_at) >= ?
           ORDER BY COALESCE(e.received_at, e.sent_at) DESC
           LIMIT 15`,
        ).all(tpid, sinceIso);
      } catch { return []; }
    };
    const recentMeetings = (tpid, sinceIso) => {
      try {
        return db.prepare(
          `SELECT m.event_id, m.subject, m.organizer_name, m.start_at,
                  substr(COALESCE(m.body_text, ''), 1, 500) AS excerpt
           FROM active_meetings m
           JOIN active_meeting_customer_links l ON l.event_id = m.event_id
           WHERE l.tpid = ? AND m.start_at >= ?
           ORDER BY m.start_at DESC
           LIMIT 15`,
        ).all(tpid, sinceIso);
      } catch { return []; }
    };
    const recentChats = (tpid, sinceIso) => {
      try {
        return db.prepare(
          `SELECT msg.message_id, tc.chat_id, tc.topic, msg.sender_name, msg.sent_at,
                  substr(COALESCE(msg.body_text, ''), 1, 500) AS excerpt
           FROM active_teams_chat_messages msg
           JOIN active_teams_chats tc ON tc.chat_id = msg.chat_id
           JOIN active_teams_chat_customer_links l ON l.chat_id = msg.chat_id
           WHERE l.tpid = ? AND msg.sent_at >= ?
           ORDER BY msg.sent_at DESC
           LIMIT 20`,
        ).all(tpid, sinceIso);
      } catch { return []; }
    };

    const MAX_ACCOUNTS_TO_MODEL = 25;
    const clip = (s, n) => String(s == null ? '' : s).slice(0, n).trim();
    // Provenance snapshot for a suggestion — the comms (capped) that grounded it, tagged with the
    // window they were pulled from.
    const sourceFor = (account, sinceIso, windowLabel) => ({
      since: sinceIso,
      windowLabel,
      counts: {
        emails: account.emails.length,
        meetings: account.meetings.length,
        chats: account.chats.length,
      },
      emails: account.emails.slice(0, 8).map((e) => ({
        id: e.message_id || null,
        subject: clip(e.subject, 200) || null,
        from: e.from_name || null,
        date: e.received_at || null,
        excerpt: clip(e.excerpt, 200) || null,
      })),
      meetings: account.meetings.slice(0, 8).map((m) => ({
        id: m.event_id || null,
        subject: clip(m.subject, 200) || null,
        from: m.organizer_name || null,
        date: m.start_at || null,
        excerpt: clip(m.excerpt, 200) || null,
      })),
      chats: account.chats.slice(0, 10).map((c) => ({
        id: c.message_id || null,
        chatId: c.chat_id || null,
        subject: clip(c.topic, 200) || null,
        from: c.sender_name || null,
        date: c.sent_at || null,
        excerpt: clip(c.excerpt, 200) || null,
      })),
    });

    // One window-scoped pass: gather comms in [sinceIso, now] for every roster account with recent
    // signal (most-active first, capped), run the model, and validate its proposals. Returns the
    // validated suggestions plus how many accounts were actually scanned. No throw on an empty
    // window — the caller decides whether to widen the look-back.
    async function runSuggestPass(sinceIso, windowLabel) {
      const candidates = [];
      for (const customer of customers) {
        const tpid = String(customer.tpid);
        const emails = recentEmails(tpid, sinceIso);
        const meetings = recentMeetings(tpid, sinceIso);
        const chats = recentChats(tpid, sinceIso);
        if (!emails.length && !meetings.length && !chats.length) continue;
        candidates.push({
          tpid,
          name: customer.name,
          crmAccountId: customer.crm_account_id,
          emails,
          meetings,
          chats,
          // Efforts already declined (dismissed concept keys) or already tracked (existing workload
          // titles) for this account — the model uses these to avoid re-proposing handled work.
          dismissedConcepts: dismissedConceptsByTpid.get(tpid) || [],
          existingWorkloadTitles: existingTitlesByTpid.get(tpid) || [],
        });
      }
      candidates.sort((a, b) =>
        (b.emails.length + b.meetings.length + b.chats.length)
        - (a.emails.length + a.meetings.length + a.chats.length));
      const accounts = candidates.slice(0, MAX_ACCOUNTS_TO_MODEL);
      if (!accounts.length) return { validated: [], accountsScanned: 0 };

      let completion;
      try {
        completion = await runtime.run('workload-suggester', { input: { context: { accounts, since: sinceIso, windowLabel } } });
      } catch (err) {
        throw new Error(`Workload suggestion failed: ${err.message || String(err)}`);
      }
      const parsed = extractJsonBlock(completion.content);
      if (parsed == null) {
        throw new Error('The model did not return usable JSON for workload suggestions. Try again.');
      }
      const rawList = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed.suggestions) ? parsed.suggestions : null);
      if (!Array.isArray(rawList)) {
        throw new Error('The model returned an unexpected shape for workload suggestions (expected a JSON array).');
      }
      // Validate each proposal: a resolvable roster tpid, a non-empty title. Snapshot the account
      // name from the local customers table (authoritative) rather than trusting the model.
      const passValidated = [];
      for (const item of rawList) {
        const tpid = String(item?.tpid || '').trim();
        const customer = customerByTpid.get(tpid);
        const account = accounts.find((a) => a.tpid === tpid);
        if (!customer || !account) continue;
        const title = String(item?.title || '').trim();
        if (!title) continue;
        const description = String(item?.description || '').trim();
        // Stable per-effort key: prefer the model's slug, fall back to one derived from the title so
        // every suggestion always carries a key (a missing key must never mean "un-dismissable").
        const conceptKey = normalizeConceptKey(item?.conceptKey || item?.concept_key) || deriveConceptKey(title);
        passValidated.push({
          tpid,
          accountName: customer.name || account.name || null,
          conceptKey,
          title: title.slice(0, 300),
          description: description.slice(0, 1200),
          source: sourceFor(account, sinceIso, windowLabel),
        });
      }
      return { validated: passValidated, accountsScanned: accounts.length };
    }

    // Secondary step — drop proposals that already exist as a workload (fuzzy, transient) or were
    // PERMANENTLY DISMISSED (exact, by concept key). Existing-workload overlap re-evaluates every
    // run so its fuzzy match is safe; permanent dismissal uses the stable concept key so it never
    // silently over-suppresses. In-batch near-dups are handled by dedupeSuggestions.
    const existingWorkloads = db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(customer_tpid), ''), TRIM(tpid)) AS tpid,
              COALESCE(NULLIF(TRIM(title), ''), name) AS title, description
       FROM active_workloads`,
    ).all();
    // Existing workload titles per account — fed to the model as "already tracked" context (belt);
    // dedupeSuggestions(existingWorkloads) below is the deterministic backstop (suspenders).
    const existingTitlesByTpid = new Map();
    for (const w of existingWorkloads) {
      const tpid = String(w.tpid || '');
      if (!tpid || !w.title) continue;
      if (!existingTitlesByTpid.has(tpid)) existingTitlesByTpid.set(tpid, []);
      existingTitlesByTpid.get(tpid).push(w.title);
    }

    // Permanent dismissals, keyed on the stable per-effort CONCEPT KEY (Option A). Exact
    // (tpid, concept_key) matching — stable across runs and volume-independent, with no fuzzy
    // over-suppression. Legacy fuzzy-era rows (concept_key NULL) are ignored: they no longer match.
    const dismissedRows = db.prepare(
      `SELECT TRIM(tpid) AS tpid, concept_key, title
       FROM workload_suggestion_dismissals
       WHERE COALESCE(TRIM(concept_key), '') <> ''`,
    ).all();
    const dismissedKeysByTpid = new Map();     // tpid -> Set<conceptKey>  (run-time suppression)
    const dismissedConceptsByTpid = new Map(); // tpid -> [{key,title}]    (model "already handled")
    for (const r of dismissedRows) {
      const tpid = String(r.tpid);
      const key = normalizeConceptKey(r.concept_key);
      if (!key) continue;
      if (!dismissedKeysByTpid.has(tpid)) dismissedKeysByTpid.set(tpid, new Set());
      dismissedKeysByTpid.get(tpid).add(key);
      if (!dismissedConceptsByTpid.has(tpid)) dismissedConceptsByTpid.set(tpid, []);
      dismissedConceptsByTpid.get(tpid).push({ key, title: r.title || null });
    }

    // Run the primary window; if the deduped result is thin (< TARGET_MIN), look further back once
    // and keep whichever window yields more distinct, non-existing suggestions. The wider pass is a
    // best-effort enhancement — if it fails, the primary result still stands.
    const TARGET_MIN = 8;
    const WIDER_WINDOW_DAYS = 84;
    const WIDER_WINDOW_LABEL = 'last 12 weeks';
    const primary = await runSuggestPass(since, SUGGEST_WINDOW_LABEL);
    let validated = dedupeSuggestions(dropDismissedByKey(primary.validated, dismissedKeysByTpid), existingWorkloads);
    let accountsScanned = primary.accountsScanned;
    if (validated.length < TARGET_MIN) {
      const widerSince = new Date(Date.now() - WIDER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      try {
        const wider = await runSuggestPass(widerSince, WIDER_WINDOW_LABEL);
        const widerValidated = dedupeSuggestions(dropDismissedByKey(wider.validated, dismissedKeysByTpid), existingWorkloads);
        if (widerValidated.length > validated.length) {
          validated = widerValidated;
          accountsScanned = wider.accountsScanned;
        }
      } catch { /* wider look-back failed — keep the primary pass's (valid) results */ }
    }

    if (!accountsScanned && !validated.length) {
      throw new Error(`No emails, meetings, or Teams chats were found for your accounts in the ${WIDER_WINDOW_LABEL}, so there is nothing to suggest workloads from.`);
    }

    // A fresh run replaces the prior draft set (approved workloads are already separate rows).
    const persist = db.transaction((rows) => {
      db.prepare('DELETE FROM workload_suggestions').run();
      const insert = db.prepare(
        `INSERT INTO workload_suggestions (tpid, account_name, title, description, source_json, concept_key, status)
         VALUES (?, ?, ?, ?, ?, ?, 'suggested')`,
      );
      const created = [];
      for (const row of rows) {
        const result = insert.run(
          row.tpid, row.accountName, row.title, row.description, JSON.stringify(row.source), row.conceptKey || null,
        );
        created.push({ id: Number(result.lastInsertRowid), ...row });
      }
      return created;
    });
    const created = persist(validated);

    return {
      ok: true,
      count: created.length,
      accountsScanned,
      suggestions: created,
      provider: provider.provider,
    };
  });

  // Workload "Discover" — for ONE account + a free-text workload description, use the model to
  // pick the specific emails/meetings/chats that fit the description and propose the workload's
  // title/description/category, then attach the DETERMINISTIC account extras (SSP, open
  // opportunities, milestones-by-opportunity) the New workload popup renders. Fails loud when no
  // provider is configured or the account cannot be resolved — never silently returns empty.
  registerHandler('se-workload-discover', async (_event, payload = {}) => {
    const description = String(payload?.description || '').trim();
    const tpid = String(payload?.tpid || '').trim();
    if (!description) throw new Error('Enter a workload description to discover matching activity.');
    if (!tpid) throw new Error('Select an account to discover activity for.');
    const categories = Array.isArray(payload?.categories)
      ? payload.categories.map((c) => String(c || '').trim()).filter(Boolean)
      : [];

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    // Resolve the account name (prefer a curated per-tpid profile display name, like suggest) —
    // preferring the real TOP-PARENT customer name and ignoring "TPID <n>" placeholders that the
    // profile tables seed before the real name resolves.
    const isPlaceholderName = (s) => /^TPID\s+\d+$/i.test(String(s == null ? '' : s).trim());
    const customerRow = db.prepare(
      `SELECT tpid, crm_account_id, name FROM active_customers WHERE tpid = ?
         AND COALESCE(TRIM(name), '') <> ''
       ORDER BY (parenting_level = 861980000) DESC, name LIMIT 1`,
    ).get(tpid) || db.prepare('SELECT tpid, crm_account_id, name FROM active_customers WHERE tpid = ? LIMIT 1').get(tpid);
    if (!customerRow) throw new Error('That account is not in the local customer table. Run "Sync from CRM" first.');
    let accountName = (customerRow.name && !isPlaceholderName(customerRow.name)) ? customerRow.name : null;
    for (const table of ['teams_customer_profile', 'email_customer_profile', 'meeting_customer_profile']) {
      try {
        const r = db.prepare(`SELECT display_name FROM ${table} WHERE tpid = ? AND COALESCE(display_name,'') <> '' LIMIT 1`).get(tpid);
        if (r?.display_name && !isPlaceholderName(r.display_name)) { accountName = r.display_name; break; }
      } catch { /* profile tables optional on older DBs */ }
    }
    if (!accountName) accountName = customerRow.name || `TPID ${tpid}`;

    // Candidate comms for this account (recent, capped). Mirrors the milestone-signal finder:
    // emails + past meetings + Teams chats collapsed to ONE candidate per THREAD (so a picked
    // chat persists as a single workload signal keyed by chat_id, not N per-message rows).
    const CANDIDATE_LIMIT = 20;
    let emails = [];
    let meetings = [];
    let chats = [];
    try { emails = loadEmailIntelligence(db, tpid, CANDIDATE_LIMIT).recentEmails || []; } catch { /* optional */ }
    try { meetings = loadMeetingIntelligence(db, tpid, CANDIDATE_LIMIT, { window: 'past' }).recentMeetings || []; } catch { /* optional */ }
    try {
      const chatMessages = loadTeamsIntelligenceFromCli(db, tpid, 60).recentMessages || [];
      const byThread = new Map();
      for (const m of chatMessages) {
        const key = m.chat_id || m.message_id;
        if (!key) continue;
        let t = byThread.get(key);
        if (!t) { t = { chat_id: m.chat_id || key, topic: m.topic || null, sender_name: m.sender_name || null, sent_at: m.sent_at || null, excerpts: [] }; byThread.set(key, t); }
        if (t.excerpts.length < 3 && m.excerpt) t.excerpts.push(m.excerpt);
      }
      chats = Array.from(byThread.values()).slice(0, CANDIDATE_LIMIT).map((t) => ({
        chat_id: t.chat_id, topic: t.topic, sender_name: t.sender_name, sent_at: t.sent_at,
        excerpt: t.excerpts.join('  ⏎  '),
      }));
    } catch { /* optional */ }

    // Tag each candidate with a stable cid and index it back to a workload-signal descriptor.
    // Chat nativeId is the THREAD chat_id (matches addWorkloadSignal / signal_links grain).
    const candIndex = new Map();
    emails.forEach((e, i) => { const cid = `e${i}`; e.cid = cid; candIndex.set(cid, { signalType: 'email', nativeId: e.message_id, signalTitle: e.subject || null, signalDate: e.received_at || null }); });
    meetings.forEach((m, i) => { const cid = `m${i}`; m.cid = cid; candIndex.set(cid, { signalType: 'meeting', nativeId: m.event_id, signalTitle: m.subject || null, signalDate: m.start_at || null }); });
    chats.forEach((c, i) => { const cid = `c${i}`; c.cid = cid; candIndex.set(cid, { signalType: 'chat', nativeId: c.chat_id, signalTitle: c.topic || null, signalDate: c.sent_at || null }); });

    const context = {
      description,
      account: { name: accountName },
      categories,
      signal: {
        emails: emails.map((e) => ({ cid: e.cid, subject: e.subject, from_name: e.from_name, received_at: e.received_at, excerpt: e.excerpt })),
        meetings: meetings.map((m) => ({ cid: m.cid, subject: m.subject, organizer_name: m.organizer_name, start_at: m.start_at, excerpt: m.excerpt })),
        chats: chats.map((c) => ({ cid: c.cid, topic: c.topic, sender_name: c.sender_name, sent_at: c.sent_at, excerpt: c.excerpt })),
      },
    };

    let completion;
    try {
      completion = await runtime.run('workload-discoverer', { input: { context } });
    } catch (err) {
      throw new Error(`Workload discovery failed: ${err.message || String(err)}`);
    }
    const parsed = extractJsonBlock(completion.content);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The model did not return usable JSON for workload discovery. Try again.');
    }

    // Map the model's cid picks back to real workload-signal descriptors (dedupe per kind+id).
    const items = parsed.items || {};
    const seen = new Set();
    const signals = [];
    for (const key of ['emails', 'meetings', 'chats']) {
      const arr = Array.isArray(items[key]) ? items[key] : [];
      for (const p of arr) {
        const desc = candIndex.get(String(p?.cid || ''));
        if (!desc || !desc.nativeId) continue;
        const dedupeKey = `${desc.signalType}:${desc.nativeId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        signals.push({ ...desc, rationale: String(p?.reason || '').trim().slice(0, 300) || null });
      }
    }

    const title = String(parsed.title || '').trim().slice(0, 300);
    const proposedDescription = String(parsed.description || '').trim().slice(0, 1200);
    const rawCategory = String(parsed.category || '').trim();
    const category = categories.includes(rawCategory) ? rawCategory : (categories[0] || null);

    // Deterministic account extras (no AI): the account's SSP, open opportunities, and the
    // milestones under each — the same shape the "Suggest workloads" gated picker uses.
    const opportunities = db.prepare(
      `SELECT o.opportunity_id, o.name, o.owner_name AS ssp_name
       FROM active_opportunities o
       JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
       WHERE cu.tpid = ? AND (o.state_code = 0 OR o.state_code IS NULL)
       ORDER BY o.name`,
    ).all(tpid);
    const milestones = db.prepare(
      `SELECT m.milestone_id, m.name, m.status_label, m.opportunity_id, m.milestone_date
       FROM active_milestones m
       JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
       JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
       WHERE cu.tpid = ?
       ORDER BY COALESCE(m.milestone_date, '9999-12-31'), m.name`,
    ).all(tpid);
    // Prefill SSP only when the account's open opportunities agree on a single owner (unambiguous).
    const sspSet = [...new Set(opportunities.map((o) => (o.ssp_name || '').trim()).filter(Boolean))];
    const sspName = sspSet.length === 1 ? sspSet[0] : null;

    return {
      ok: true,
      tpid,
      accountName,
      fields: { title, description: proposedDescription, category, sspName },
      signals,
      opportunities,
      milestones,
      counts: { emails: emails.length, meetings: meetings.length, chats: chats.length, matched: signals.length },
      provider: provider.provider,
    };
  });

  // Research dossier — surface the markdown "customer docs" in the vault. `get`
  // returns metadata for the profile card (no render); `open` renders the dossier
  // to a sandboxed HTML file the renderer opens via openGeneratedFile. Both fail
  // loudly with an explicit reason rather than silently degrading.
  registerHandler('se-customer-research-get', (_event, payload = {}) => {
    const name = String(payload?.name || '').trim();
    const tpid = String(payload?.tpid || '').trim();
    if (!name && !tpid) throw new Error('A customer name or TPID is required to locate the research dossier.');
    const doc = researchDossier.getDossier({ name, tpid });
    // Strip the heavy markdown body from the metadata response.
    return {
      ok: doc.ok,
      found: doc.found,
      available: doc.available !== false,
      account: doc.account || null,
      tpid: doc.tpid || null,
      lastUpdated: doc.lastUpdated || null,
      topics: (doc.topics || []).map((t) => ({ num: t.num, title: t.title })),
      reason: doc.reason || null,
    };
  });

  registerHandler('se-customer-research-open', (_event, payload = {}) => {
    const name = String(payload?.name || '').trim();
    const tpid = String(payload?.tpid || '').trim();
    if (!name && !tpid) throw new Error('A customer name or TPID is required to open the research dossier.');
    const rendered = researchDossier.renderDossierHtml({ name, tpid });
    if (!rendered.found) {
      return { ok: true, found: false, available: rendered.available !== false, reason: rendered.reason || 'No research dossier found for this account.' };
    }
    const id = crypto.randomUUID();
    const htmlPath = writeRawHtmlArtifact('research-dossier', id, rendered.html);
    if (!htmlPath) throw new Error('Could not write the rendered research dossier to disk.');
    return {
      ok: true,
      found: true,
      htmlPath,
      account: rendered.account,
      title: rendered.title,
      lastUpdated: rendered.lastUpdated || null,
      topics: (rendered.topics || []).map((t) => ({ num: t.num, title: t.title })),
    };
  });

  // Customer Analysis Engine — deterministic pass. Fast, local, no AI: synthesizes
  // dossier priorities + MSX opps/milestones + ACR momentum + engagement into
  // priorities / opportunity areas / tailored suggestions. Drives the profile panel.
  registerHandler('se-customer-insights', async (_event, payload = {}) => {
    const customer = payload?.customer || {};
    if (!customer.name && !customer.tpid) throw new Error('A customer name or TPID is required for insights.');
    const inputs = await gatherCustomerInsightInputs(db, {
      profileId: String(payload?.profileId || '').trim() || null,
      customer,
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
      includeAcr: payload?.includeAcr !== false,
    });
    const result = customerInsights.computeCustomerInsights(inputs);
    return { ...result, dossierAvailable: inputs.dossierAvailable };
  });

  // Customer Analysis Engine — AI narration pass. Feeds the deterministic facts to
  // the model to produce a tailored, prioritized analysis + HTML briefing artifact.
  registerHandler('se-customer-analysis', async (_event, payload = {}) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId) throw new Error('profileId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    const workspace = loadProfileWorkspace(db, profileId);
    const customer = payload?.customer || {};
    const tpid = String(customer.tpid || workspace.profile.tpid || '').trim();

    const inputs = await gatherCustomerInsightInputs(db, {
      profileId,
      customer: { ...customer, tpid },
      opportunities: payload?.opportunities || [],
      milestones: payload?.milestones || [],
      includeAcr: true,
    });
    const insights = customerInsights.computeCustomerInsights(inputs);

    let completion;
    try {
      completion = await runtime.run('customer-analysis', { input: { context: { customer, insights, dossierAvailable: inputs.dossierAvailable } } });
    } catch (err) {
      throw new Error(`Customer analysis failed: ${err.message || String(err)}`);
    }

    const brief = {
      title: `Customer analysis — ${customer.name || workspace.profile.displayName}`,
      summary: completion.content,
      metadata: {
        generatedAt: nowIso(),
        source: provider.source,
        provider: provider.provider,
        authMode: provider.authMode,
        deployment: provider.deployment,
        model: completion.model || provider.deployment,
        modelRole: completion.modelRole || 'primary',
        usage: completion.usage,
        confidence: insights.confidence,
        counts: {
          priorities: insights.priorities.length,
          opportunityAreas: insights.opportunityAreas.length,
          suggestions: insights.suggestions.length,
          hasDossier: inputs.dossierAvailable,
          hasAcr: insights.dataCoverage.hasAcr,
          openOpportunities: insights.dataCoverage.openOpportunities,
          milestones: insights.dataCoverage.milestones,
        },
        insights,
      },
    };

    const id = crypto.randomUUID();
    const occurredAt = nowIso();

    const htmlPath = writeHtmlArtifact('customer-analysis', id, { ...brief, occurredAt });
    if (htmlPath) brief.metadata.htmlStyle = 'document';
    if (htmlPath) brief.metadata.htmlPath = htmlPath;

    db.prepare(
      `INSERT INTO cached_customer_timeline_events
         (id, profile_id, event_type, source, source_id, title, occurred_at, summary, metadata_json, relevance_score, version, updated_at)
       VALUES (?, ?, 'customer_analysis', 'foundry', ?, ?, ?, ?, ?, 1.0, 1, ?)`,
    ).run(id, profileId, id, brief.title, occurredAt, brief.summary, JSON.stringify(brief.metadata), occurredAt);
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-workspace-delete-timeline-event', (_event, payload) => {
    const profileId = String(payload?.profileId || '').trim();
    const id = String(payload?.id || '').trim();
    if (!profileId || !id) throw new Error('profileId and id are required');
    // Best-effort removal of the generated HTML artifact (sandboxed to generated dir).
    try {
      const row = db
        .prepare('SELECT metadata_json FROM active_cached_customer_timeline_events WHERE id = ? AND profile_id = ?')
        .get(id, profileId);
      const htmlPath = row ? (JSON.parse(row.metadata_json || '{}').htmlPath || '') : '';
      if (htmlPath && path.resolve(htmlPath).startsWith(path.resolve(generatedDir()))) {
        fs.rmSync(htmlPath, { force: true });
      }
    } catch {
      /* ignore artifact cleanup errors */
    }
    const updatedAt = nowIso();
    const result = db.prepare(
      `UPDATE cached_customer_timeline_events
       SET deleted_at = ?, version = version + 1, updated_at = ?, synced_at = CURRENT_TIMESTAMP
       WHERE id = ? AND profile_id = ?`,
    ).run(updatedAt, updatedAt, id, profileId);
    if (result.changes === 0) throw new Error('Generation not found');
    return loadProfileWorkspace(db, profileId);
  });

  registerHandler('se-assistant-chat', async (_event, payload) => {
    const provider = await resolveChatProvider();
    if (!provider) {
      throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    }
    const runtime = makeAgentRuntime(provider);
    const userName = resolveAssistantUserName(payload?.userName);
    if (!userName) {
      throw new Error(
        'AI assistant: I could not determine who you are. Sign in with Microsoft (Settings → Microsoft 365 sign-in) so I can read your name and find the milestones you are on. (Advanced: you can also set SE_ASSIST_USER_NAME in .env to override the name used for matching.)',
      );
    }
    const question = String(payload?.question || '').trim()
      || 'Which of my milestones are most pressing right now, and what is top of mind for those customers?';
    const history = Array.isArray(payload?.history)
      ? payload.history.slice(-6).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 1500) }))
      : [];

    const context = gatherAssistantContext(db, userName);

    let completion;
    try {
      completion = await runtime.run('assistant', { input: { context, userName, question, history } });
    } catch (err) {
      throw new Error(`AI assistant failed: ${err.message || String(err)}`);
    }

    return {
      ok: true,
      reply: completion.content,
      meta: {
        userName,
        pressingCount: context.pressingCount,
        customers: Object.keys(context.topOfMind).length,
        authMode: provider.authMode,
      },
    };
  });

  registerHandler('se-secretary-scan', async (_event, payload = {}) => {
    // Secretary's own chat agents are pinned to one Copilot model and reasoning level; Deep
    // Research (Work Outputs) and the Work Agent keep using the Settings model.
    const { model: secretaryModel, reasoningEffort } = SECRETARY_CHAT_MODEL;
    const provider = await resolveChatProvider({
      copilotOnly: true,
      copilotOnlyMessage: `Secretary runs only on GitHub Copilot model "${secretaryModel}" with ${reasoningEffort} reasoning. Connect GitHub Copilot in User Home → GitHub sign-in.`,
    });
    const runtime = makeAgentRuntime(provider);
    const userName = resolveAssistantUserName(payload?.userName) || 'the SE';
    try {
      const result = await scanSecretaryInbox({
        db, runtime, userName, guidance: payload.guidance, days: payload.days,
        // Secretary reads only email already pulled; the pull state lets it report freshness.
        lastPull: {
          result: ingestState.lastResult || appPrefs.get('lastIngestResult', null),
          lastError: ingestState.lastError,
          lastErrorAt: ingestState.lastErrorAt,
          running: ingestState.running,
          autoEnabled: Boolean(appPrefs.get('autoIngestEnabled', false)),
          autoIntervalMin: Math.max(15, Number(appPrefs.get('autoIngestIntervalMin', 60)) || 60),
        },
        parseJson: extractJsonBlock,
      });
      return { ...result, provider: provider.provider, reasoningEffort };
    } catch (err) {
      throw new Error(`Secretary failed: ${err.message || String(err)}`);
    }
  });

  let workOutputs;
  const outputService = () => {
    workOutputs ||= createWorkOutputs({
      db, client: getWorkIqClient(),
      ensureConnected: ensureWorkIqWithGuidance,
      resolveRuntime: async () => {
        const provider = await resolveChatProvider({
          copilotOnly: true,
          copilotOnlyMessage: 'Deep Research runs only on GitHub Copilot. Connect GitHub Copilot in User Home → GitHub sign-in.',
        });
        const model = provider.deployment;
        return {
          model,
          runtime: makeAgentRuntime({
            ...provider,
            chat: (system, user, options) => provider.chat(system, user, {
              ...options,
              ...(options?.modelRole === 'utility' ? {} : { model }),
            }),
          }),
        };
      },
    });
    return workOutputs;
  };
  registerHandler('se-work-output-open', (_event, payload = {}) => ({ ok: true, investigation: outputService().open(payload.task) }));
  registerHandler('se-work-output-get', (_event, payload = {}) => ({ ok: true, investigation: outputService().get(payload.investigationId) }));
  registerHandler('se-work-output-run', async (event, payload = {}) => {
    if (typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 100) {
      throw new Error('A valid output request ID is required.');
    }
    const service = outputService();
    const cancel = () => service.cancel(payload.investigationId, payload.area, event.sender.id);
    event.sender.once('destroyed', cancel);
    try {
      return await service.run({ ...payload, userName: resolveAssistantUserName(payload.userName) || 'the SE' }, progress => {
        if (!event.sender.isDestroyed()) event.sender.send('se-work-output-progress', progress);
      }, event.sender.id);
    } finally {
      event.sender.removeListener('destroyed', cancel);
    }
  });
  registerHandler('se-work-output-cancel', (event, payload = {}) => outputService().cancel(payload.investigationId, payload.area, event.sender.id));
  // Gap classification and per-gap research share one in-memory job per research subject. They
  // stream progress on the same channel as output runs, tagged with area 'gaps'.
  const gapHandler = method => async (event, payload = {}) => {
    if (typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 100) {
      throw new Error('A valid gap request ID is required.');
    }
    const service = outputService();
    const cancel = () => service.cancel(payload.investigationId, 'gaps', event.sender.id);
    event.sender.once('destroyed', cancel);
    try {
      return await service[method]({ ...payload, userName: resolveAssistantUserName(payload.userName) || 'the SE' }, progress => {
        if (!event.sender.isDestroyed()) event.sender.send('se-work-output-progress', progress);
      }, event.sender.id);
    } finally {
      event.sender.removeListener('destroyed', cancel);
    }
  };
  registerHandler('se-work-output-gap-triage', gapHandler('triageGaps'));
  registerHandler('se-work-output-gap-research', gapHandler('researchGap'));
  registerHandler('se-work-output-tasks', (_event, payload = {}) => {
    seedCachedProfiles(db);
    return outputService().createTasks(payload);
  });
  registerHandler('se-work-output-reply', (_event, payload = {}) => createSecretaryReplyDraft(outputService().draft(payload)));
  // Deep Research subjects are the saved Work Outputs investigations. Listing and removing them
  // reads local state only, so neither needs a model provider or WorkIQ.
  registerHandler('se-work-output-list', () => {
    try {
      return { ok: true, subjects: outputService().list() };
    } catch (err) {
      return { ok: false, error: `Could not load research subjects: ${err.message || String(err)}` };
    }
  });
  registerHandler('se-work-output-remove', (_event, payload = {}) => {
    try {
      return outputService().remove(payload.investigationId);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  // Deep Research lists and searches only email already pulled into the local database.
  registerHandler('se-email-search', (_event, payload = {}) => {
    try {
      return {
        ok: true,
        ...searchEmails(db, { query: payload.query, account: payload.account, cursor: payload.cursor, limit: payload.limit }),
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  registerHandler('se-email-detail', (_event, payload = {}) => {
    try {
      return { ok: true, email: readEmail(db, payload.messageId) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  const workAgentRuns = new Map();
  registerHandler('se-work-agent-cancel', (event, payload = {}) => {
    const run = workAgentRuns.get(`${event.sender.id}:${String(payload.requestId || '')}`);
    run?.abort(new Error('Investigation stopped by the user.'));
    return { ok: true, cancelled: Boolean(run) };
  });
  registerHandler('se-work-agent-chat', async (event, payload = {}) => {
    const requestId = String(payload?.requestId || '');
    if (!requestId || requestId.length > 100) throw new Error('A valid Work Agent request ID is required.');
    const key = `${event.sender.id}:${requestId}`;
    if (workAgentRuns.has(key)) throw new Error('This Work Agent request is already running.');
    const controller = new AbortController();
    const cancelOnClose = () => controller.abort(new Error('Investigation stopped because its window closed.'));
    event.sender.once('destroyed', cancelOnClose);
    workAgentRuns.set(key, controller);
    try {
      const provider = await resolveChatProvider({ copilotOnly: true });
      controller.signal.throwIfAborted();
      const runtime = makeAgentRuntime(provider);
      const userName = resolveAssistantUserName(payload?.userName) || 'the SE';
      const task = payload?.task && typeof payload.task === 'object' ? payload.task : {};
      if (!String(task.title || '').trim()) throw new Error('Select a todo item for the Work Agent to investigate.');
      const question = String(payload?.question || '').trim();
      if (question.length > 6000) throw new Error('The question is too long. Keep it under 6,000 characters.');
      const accountScope = createAccountScope(db);
      accountScope.assertText([task.account, task.title, task.summary, question].filter(Boolean).join(' '));
      const history = Array.isArray(payload?.history)
        ? payload.history.filter((h) => h && ['user', 'assistant'].includes(h.role)).slice(-12)
          .map((h) => ({ role: h.role, content: String(h.content || '').slice(0, 12000) }))
        : [];
      const blockedSources = normalizeBlockedSources(payload.blockedSources);
      const sources = new Map();
      const researchWarnings = new Set();
      const onProgress = (progress) => {
        for (const source of progress.sources || []) sources.set(source.url, source);
        if (progress.warning) researchWarnings.add(progress.warning);
        if (!event.sender.isDestroyed()) event.sender.send('se-work-agent-progress', { ...progress, requestId });
      };
      const tools = createWorkAgentTools({
        client: getWorkIqClient(),
        ensureConnected: ensureWorkIqWithGuidance,
        signal: controller.signal,
        sourceMessageId: task.sourceMessageId,
        accountScope,
        blockedSources,
        onProgress,
        privateTerms: [task.account, task.from, task.title, task.subject, task.sourceMessageId, userName === 'the SE' ? null : userName],
      });
      try {
        const completion = await runtime.run('work-agent', {
          input: { context: { userName, task }, userName, task, question, history },
          deps: { tools, onProgress, signal: controller.signal, blockedSources, requireTools: !history.some((entry) => entry.role === 'assistant') },
        });
        const partial = Boolean(completion.blockedSources?.length || completion.researchLimitReached);
        const excludedUrls = new Set((completion.blockedSources || []).map(source => source.url));
        return {
          ok: true, outcome: partial ? 'partial' : 'complete', reply: completion.content, provider: provider.provider,
          meta: {
            model: completion.model || provider.deployment, reasoningEffort: 'high',
            sources: [...sources.values()].filter(source => !excludedUrls.has(source.url)),
            researchLimitReached: Boolean(completion.researchLimitReached),
            blockedSources: completion.blockedSources || [],
            researchWarnings: [...researchWarnings],
          },
        };
      } catch (err) {
        onProgress({ phase: 'error', label: err.message || String(err) });
        if (err.cause?.blockedSource) {
          return {
            ok: false, error: `Work Agent is blocked: ${err.message}`,
            blockedSource: err.cause.blockedSource,
          };
        }
        if (['COPILOT_WEB_RATE_LIMIT', 'COPILOT_WEB_HTTP_ERROR', 'PUBLIC_WEB_RATE_LIMIT', 'PUBLIC_WEB_HTTP_ERROR'].includes(err.cause?.code)
          && Number.isFinite(err.cause.retryAt) && err.cause.retryAt > Date.now()) {
          return {
            ok: false, error: `Work Agent could not finish: ${err.message}`,
            retryAt: err.cause.retryAt,
          };
        }
        throw new Error(`Work Agent failed: ${err.message || String(err)}`);
      }
    } finally {
      event.sender.removeListener('destroyed', cancelOnClose);
      workAgentRuns.delete(key);
    }
  });

  // Add one todo to an existing workload. Uses the app-owned workload_todos table.
  registerHandler('se-workload-todo-add', async (_event, payload = {}) => {
    const workloadId = Number(payload?.workloadId);
    const title = String(payload?.title || '').trim();
    if (!Number.isFinite(workloadId) || workloadId <= 0) throw new Error('A valid workloadId is required.');
    if (!title) throw new Error('A todo title is required.');
    const wl = db.prepare('SELECT id FROM active_workloads WHERE id = ?').get(workloadId);
    if (!wl) throw new Error('That workload no longer exists.');
    const dueDate = payload?.dueDate ? String(payload.dueDate).slice(0, 10) : null;
    const result = db.prepare(
      `INSERT INTO workload_todos (workload_id, title, done, due_date, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM active_workload_todos WHERE workload_id = ?), 0),
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(workloadId, title.slice(0, 300), dueDate, workloadId);
    return { ok: true, todoId: Number(result.lastInsertRowid) };
  });

  // Secretary "Reply all": create a THREADED reply-all DRAFT in the user's mailbox pre-filled with
  // the proposed solution text, then return its Outlook web link so the renderer can open it for the
  // user to verify and send manually. Uses Graph createReplyAll via WorkIQ's do_action (POST); the
  // draft is saved but NOT sent — the app never sends mail on the user's behalf. Fails loud if the
  // draft can't be created (e.g. WorkIQ lacks Mail.ReadWrite), rather than silently doing nothing.
  async function createSecretaryReplyDraft(payload = {}) {
    const messageId = String(payload?.messageId || '').trim();
    const comment = String(payload?.comment || '').trim();
    if (!messageId) throw new Error('This action item has no source email to reply to.');
    if (!comment) throw new Error('There is no drafted text to put in the reply.');

    const wiq = getWorkIqClient({ log: () => {} });
    let res;
    try {
      // Graph escapes the message id path segment for us via WorkIQ; pass it raw.
      res = await wiq.doAction(`/me/messages/${messageId}/createReplyAll`, { comment });
    } catch (err) {
      throw new Error(`Could not create the reply draft: ${err.message || String(err)}`);
    }
    if (res?.error || (res?.status && res.status >= 400)) {
      const detail = res?.error || `HTTP ${res.status}`;
      throw new Error(`Could not create the reply draft (${detail}). Your mailbox connection may not permit drafting replies.`);
    }
    const draft = res?.data || {};
    const webLink = draft.webLink || draft.web_link || null;
    if (!webLink) {
      throw new Error('The reply draft was created but no Outlook link was returned to open it.');
    }
    return { ok: true, webLink: toOutlookWebReaderLink(webLink), draftId: draft.id || null };
  }
  registerHandler('se-secretary-reply-draft', (_event, payload = {}) => createSecretaryReplyDraft(payload));

  // Per-meeting AI prep: identify the customer account(s), Microsoft product(s),
  // and a concise prep note (Background, Agenda, My actions, Customer actions,
  // Desired outcome) for a single calendar meeting held in the local datastore.
  // Uses the same GitHub Copilot provider as every other AI action.
  registerHandler('se-meeting-prep', async (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    const meeting = db.prepare(
      `SELECT event_id, subject, organizer_name, organizer_address, start_at, end_at,
              is_online_meeting, location, body_text, attendees_json
       FROM active_meetings WHERE event_id = ?`,
    ).get(eventId);
    if (!meeting) throw new Error('Meeting not found in the local datastore.');

    // Parse attendees + collect external (non-Microsoft) email domains.
    let attendees = [];
    try {
      const raw = JSON.parse(meeting.attendees_json || '[]');
      if (Array.isArray(raw)) {
        attendees = raw.map((a) => ({
          name: a?.name || a?.emailAddress?.name || '',
          address: a?.address || a?.emailAddress?.address || '',
        })).filter((a) => a.name || a.address);
      }
    } catch { /* attendees optional */ }

    const domainSet = new Set();
    for (const a of attendees) {
      const d = emailDomain(a.address);
      if (isExternalDomain(d)) domainSet.add(d);
    }
    const orgDomain = emailDomain(meeting.organizer_address);
    if (isExternalDomain(orgDomain)) domainSet.add(orgDomain);
    const externalDomains = [...domainSet];

    // Accounts already linked to this meeting (authoritative). Resolve each TPID to
    // its top-level (parent) account name — never a child account.
    let linkedCustomers = [];
    try {
      linkedCustomers = db.prepare(
        `SELECT l.tpid AS tpid,
                COALESCE(
                  (SELECT c2.name FROM active_customers c2
                    WHERE c2.tpid = l.tpid
                      AND (c2.parent_crm_account_id IS NULL OR c2.parent_crm_account_id = '')
                    LIMIT 1),
                  'TPID ' || l.tpid
                ) AS name
         FROM active_meeting_customer_links l
         WHERE l.event_id = ?
         GROUP BY l.tpid`,
      ).all(eventId);
    } catch { /* links table optional */ }

    // Candidate accounts: known customers whose website host matches an external
    // attendee domain (a strong, unconfirmed hint layered on top of the links).
    // Match against any account row's website, but report the top-level (parent) name.
    let candidateCustomers = [];
    if (externalDomains.length) {
      let roster = [];
      try {
        roster = db.prepare(
          `SELECT c.tpid AS tpid, c.website AS website,
                  COALESCE(
                    (SELECT p.name FROM active_customers p
                      WHERE p.tpid = c.tpid
                        AND (p.parent_crm_account_id IS NULL OR p.parent_crm_account_id = '')
                      LIMIT 1),
                    c.name
                  ) AS name
           FROM active_customers c
           WHERE c.website IS NOT NULL AND c.website != ''`,
        ).all();
      } catch { /* ignore */ }
      const linkedTpids = new Set(linkedCustomers.map((c) => String(c.tpid)));
      const seenTpids = new Set();
      for (const r of roster) {
        const host = websiteHost(r.website);
        if (!host) continue;
        const hit = externalDomains.some((d) => d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`));
        if (hit && !linkedTpids.has(String(r.tpid)) && !seenTpids.has(String(r.tpid))) {
          seenTpids.add(String(r.tpid));
          candidateCustomers.push({ name: r.name, tpid: r.tpid, host });
        }
      }
    }

    // Wider account roster (top-level accounts only) for precise naming.
    let knownAccounts = [];
    try {
      knownAccounts = db.prepare(
        `SELECT tpid, name FROM active_customers
         WHERE tpid IS NOT NULL AND tpid != ''
           AND (parent_crm_account_id IS NULL OR parent_crm_account_id = '')
         GROUP BY tpid ORDER BY name`,
      ).all().map((r) => ({ name: r.name, tpid: r.tpid }));
    } catch { /* ignore */ }

    const products = Array.isArray(payload?.products) ? payload.products.slice(0, 200) : [];

    const context = {
      meeting: { ...meeting, attendees, externalDomains },
      linkedCustomers,
      candidateCustomers,
      knownAccounts,
      products,
    };

    let completion;
    try {
      completion = await runtime.run('meeting-prep', { input: { context } });
    } catch (err) {
      throw new Error(`Meeting prep failed: ${err.message || String(err)}`);
    }

    return {
      ok: true,
      reply: completion.content,
      meta: {
        eventId,
        subject: meeting.subject || '',
        linkedCustomers: linkedCustomers.length,
        candidateCustomers: candidateCustomers.length,
        externalDomains: externalDomains.length,
        authMode: provider.authMode,
        deployment: provider.deployment,
      },
    };
  });

  // ── Milestone Signal Finder ──────────────────────────────────────────
  // Given ONE engagement milestone, resolve its account (TPID) and pull the
  // account's recent emails, meetings and Teams chats, then run a dedicated agent
  // to surface the items specifically related to this milestone. Grounded strictly
  // in the local datastore; if no signal pipeline is present the result says so.
  registerHandler('se-milestone-signal', async (_event, payload = {}) => {
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!milestoneId) throw new Error('milestoneId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    // Milestone + its opportunity/account context.
    const milestone = db.prepare(
      `SELECT m.milestone_id, m.name, m.workload, m.milestone_category, m.status_label,
              m.milestone_status, m.milestone_date, m.monthly_use, m.comments_json,
              o.name AS opp_name, o.customer_name, o.parent_account_id
       FROM active_milestones m
       LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
       WHERE m.milestone_id = ?`,
    ).get(milestoneId);
    if (!milestone) throw new Error('Milestone not found in the local datastore.');

    // Resolve the account TPID (CRM account id first, then customer name). Signal
    // links (email/meeting/teams) are all keyed by TPID.
    const tpid = resolveMilestoneTpid(db, milestone);

    // Before anything else, self-heal the persisted set: remove any AI links the
    // customer-link verifier has rejected for this account. This corrects links
    // saved by earlier builds that surfaced 'ai-rejected' (cross-customer) items.
    if (tpid) {
      try { signalLinks.pruneRejectedMilestoneSignals(db, milestoneId, tpid); } catch { /* best-effort */ }
    }

    // Recent customer signal for the account, via the existing intelligence
    // loaders (they respect the SE_ASSIST_EMAIL_SOURCE toggle and degrade to
    // empty when the pipeline/tables are absent on an org build). Up to 20 items
    // per source form the candidate pool the agent reasons over. Meetings are
    // limited to today's date and backwards (window:'past') so far-future
    // recurring placeholders don't crowd out the substantive recent activity.
    const CANDIDATE_LIMIT = 20;
    let emails = [];
    let meetings = [];
    let chats = [];
    if (tpid) {
      try { emails = loadEmailIntelligence(db, tpid, CANDIDATE_LIMIT).recentEmails || []; } catch { /* optional */ }
      try { meetings = loadMeetingIntelligence(db, tpid, CANDIDATE_LIMIT, { window: 'past' }).recentMeetings || []; } catch { /* optional */ }
      try {
        // Pull a wider window of messages (up to 60) then collapse into one
        // candidate PER THREAD. The model relates the milestone to a chat, not to
        // each individual message, so a picked thread persists as a single link
        // (ref_id = chat_id) instead of N near-identical per-message cards.
        const chatMessages = loadTeamsIntelligenceFromCli(db, tpid, 60).recentMessages || [];
        const byThread = new Map();
        for (const m of chatMessages) {
          const key = m.chat_id || m.message_id;
          if (!key) continue;
          let t = byThread.get(key);
          if (!t) {
            // messages arrive newest-first, so the first seen is the representative
            t = { chat_id: m.chat_id || key, topic: m.topic || null, sender_name: m.sender_name || null, sent_at: m.sent_at || null, excerpts: [], count: 0 };
            byThread.set(key, t);
          }
          t.count += 1;
          if (t.excerpts.length < 3 && m.excerpt) t.excerpts.push(m.excerpt);
        }
        chats = Array.from(byThread.values()).slice(0, CANDIDATE_LIMIT).map((t) => ({
          chat_id: t.chat_id,
          topic: t.topic,
          sender_name: t.sender_name,
          sent_at: t.sent_at,
          messageCount: t.count,
          excerpt: t.excerpts.join('  ⏎  '),
        }));
      } catch { /* optional */ }
    }

    const totalSignal = emails.length + meetings.length + chats.length;

    // Honest short-circuits: nothing to reason over means we surface the reason
    // explicitly rather than asking the model to narrate emptiness. Previously
    // persisted links (if any) are still returned so the user's audited set stays visible.
    if (!tpid) {
      return {
        ok: true,
        summary: 'This milestone\'s account could not be matched to a known customer (no TPID), so related emails, meetings, and chats cannot be searched. Run "Sync from CRM" in Settings to link the account.',
        links: signalLinks.readMilestoneSignals(db, milestoneId),
        counts: { emails: 0, meetings: 0, chats: 0, picked: 0 },
        note: 'no-tpid',
        meta: { milestoneId, tpid: null },
      };
    }
    if (totalSignal === 0) {
      return {
        ok: true,
        summary: 'No local emails, meetings, or Teams chats are linked to this account yet, so there is no signal to relate to this milestone. Run an M365 ingest (Settings) to populate this.',
        links: signalLinks.readMilestoneSignals(db, milestoneId),
        counts: { emails: 0, meetings: 0, chats: 0, picked: 0 },
        note: 'no-signal',
        meta: { milestoneId, tpid },
      };
    }

    const rawComments = safeParseJson(milestone.comments_json, []) || [];
    const comments = (Array.isArray(rawComments) ? rawComments : []).slice(0, 6).map((c) => ({
      poster: c.userId || c.poster || c.modifiedBy || null,
      date: c.modifiedOn || c.date || null,
      text: c.comment || c.text || '',
    }));

    // Tag every candidate with a stable id (cid) and index it back to its real
    // reference id + display snapshot, so the model's JSON picks can be persisted.
    const candIndex = new Map();
    emails.forEach((e, i) => {
      const cid = `e${i}`; e.cid = cid;
      candIndex.set(cid, { kind: 'email', ref_id: e.message_id, chat_id: null, title: e.subject || null, subtitle: e.from_name || null, item_date: e.received_at || null });
    });
    meetings.forEach((m, i) => {
      const cid = `m${i}`; m.cid = cid;
      candIndex.set(cid, { kind: 'meeting', ref_id: m.event_id, chat_id: null, title: m.subject || null, subtitle: m.organizer_name || null, item_date: m.start_at || null });
    });
    chats.forEach((c, i) => {
      const cid = `c${i}`; c.cid = cid;
      candIndex.set(cid, { kind: 'chat', ref_id: c.chat_id, chat_id: c.chat_id || null, title: c.topic || null, subtitle: c.sender_name || null, item_date: c.sent_at || null });
    });

    const context = {
      milestone: { ...milestone, comments },
      signal: {
        emails: emails.map((e) => ({ cid: e.cid, subject: e.subject, from_name: e.from_name, received_at: e.received_at, excerpt: e.excerpt })),
        meetings: meetings.map((m) => ({ cid: m.cid, subject: m.subject, organizer_name: m.organizer_name, start_at: m.start_at, excerpt: m.excerpt })),
        chats: chats.map((c) => ({ cid: c.cid, topic: c.topic, sender_name: c.sender_name, sent_at: c.sent_at, excerpt: c.excerpt })),
      },
    };

    let completion;
    try {
      completion = await runtime.run('milestone-signal-finder', { input: { context } });
    } catch (err) {
      throw new Error(`Milestone signal search failed: ${err.message || String(err)}`);
    }

    // Parse the model's strict-JSON picks. Unknown cids (hallucinations) are dropped.
    const parsed = extractJsonBlock(completion.content) || {};
    const picks = [];
    const seenRef = new Set();
    for (const key of ['emails', 'meetings', 'chats']) {
      const arr = Array.isArray(parsed[key]) ? parsed[key] : [];
      for (const p of arr) {
        const cand = candIndex.get(String(p?.cid || ''));
        if (!cand || !cand.ref_id) continue;
        const dedupeKey = `${cand.kind}:${cand.ref_id}`;
        if (seenRef.has(dedupeKey)) continue;
        seenRef.add(dedupeKey);
        picks.push({ ...cand, reason: String(p?.reason || '').trim().slice(0, 300) });
      }
    }
    // Persist ADDITIVELY: merge the fresh picks into this milestone's link set
    // WITHOUT deleting what was found before. The LLM is non-deterministic, so a
    // later run may surface fewer (or zero) items — destroying the prior audited
    // set on every refresh made valid links "disappear". Instead we only ever add
    // (addMilestoneSignal's INSERT OR IGNORE dedupes on signal_links' UNIQUE(
    // signal_type, signal_id, target_type, target_id)); the user prunes anything
    // unwanted with the per-link delete button. Result: refresh is safe and
    // cumulative, and a once-found link never vanishes on its own.
    let inserted = 0;
    try {
      const persist = db.transaction(() => {
        for (const p of picks) {
          const r = signalLinks.addMilestoneSignal(db, {
            milestoneId,
            kind: p.kind,
            refId: p.ref_id,
            chatId: p.chat_id || null,
            title: p.title || null,
            subtitle: p.subtitle || null,
            itemDate: p.item_date || null,
            reason: p.reason || null,
            source: 'ai',
            tpid,
          });
          inserted += r.changes || 0;
        }
      });
      persist();
    } catch (err) {
      throw new Error(`Could not save milestone signal links: ${err.message || String(err)}`);
    }

    // Heal tpid on any still-NULL milestone rows (e.g. links backfilled from the
    // legacy milestone_signal_links table, which never stored a tpid). The insert
    // above uses INSERT OR IGNORE and so never updates an existing row; this stamps
    // the live-resolved account tpid on rows that lack one, never overwriting a real
    // value. Keeps "every milestone signal carries its account tpid" self-maintaining
    // beyond the one-time migration-025 backfill. Snapshot fields are untouched.
    if (tpid) {
      try {
        db.prepare(
          `UPDATE signal_links SET tpid = ?, updated_at = CURRENT_TIMESTAMP
            WHERE target_type = 'milestone' AND target_id = ?
              AND (tpid IS NULL OR TRIM(tpid) = '')`,
        ).run(tpid, milestoneId);
      } catch { /* best-effort: tpid healing must never fail the finder */ }
    }

    // Collapse any folder-copy duplicate email links (defensive: candidates are
    // already deduped upstream, but a legacy set may still hold two copies).
    signalLinks.dedupeMilestoneEmailSignals(db, milestoneId);

    const finalLinks = signalLinks.readMilestoneSignals(db, milestoneId);

    // Summary reflects the additive reality: new finds, nothing-new (but existing
    // links kept), or genuinely-empty. Never imply the set is empty when it isn't.
    let summary;
    if (typeof parsed.summary === 'string' && parsed.summary.trim() && picks.length) {
      summary = parsed.summary.trim();
    } else if (inserted > 0) {
      summary = `Added ${inserted} newly related item${inserted === 1 ? '' : 's'} to this milestone.`;
    } else if (finalLinks.length > 0) {
      summary = `No new related items found in this refresh; keeping the ${finalLinks.length} already linked.`;
    } else {
      summary = 'The local signal shows no emails, meetings, or chats clearly tied to this milestone yet.';
    }

    return {
      ok: true,
      summary,
      links: finalLinks,
      counts: { emails: emails.length, meetings: meetings.length, chats: chats.length, picked: picks.length, inserted, total: finalLinks.length },
      note: finalLinks.length ? null : 'none-related',
      meta: {
        milestoneId,
        tpid,
        authMode: provider.authMode,
        deployment: provider.deployment,
      },
    };
  });

  // Read persisted milestone↔signal links (no model call) — used to render the
  // stable, audited set when a milestone card opens. Self-heals first: drops any
  // AI links the customer-link verifier has rejected for this account, so links
  // saved by earlier builds (cross-customer alias collisions) disappear on open
  // without waiting for a Refresh.
  registerHandler('se-milestone-signal-links', async (_event, payload = {}) => {
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!milestoneId) throw new Error('milestoneId is required');
    try {
      const milestone = db.prepare(
        `SELECT o.customer_name, o.parent_account_id
         FROM active_milestones m
         LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
         WHERE m.milestone_id = ?`,
      ).get(milestoneId);
      const tpid = resolveMilestoneTpid(db, milestone);
      if (tpid) signalLinks.pruneRejectedMilestoneSignals(db, milestoneId, tpid);
      signalLinks.dedupeMilestoneEmailSignals(db, milestoneId);
    } catch { /* best-effort self-heal; still return whatever is persisted */ }
    const links = signalLinks.readMilestoneSignals(db, milestoneId);
    return { ok: true, links };
  });

  // Remove persisted milestone↔signal link(s). The card names each signal by its
  // natural key { kind, nativeId } (a chat key's nativeId is the thread chat_id, so
  // one key removes the whole thread's single canonical row). We delete straight from
  // signal_links (target_type='milestone') — there is no legacy table or reconcile
  // any more. Fails loud when no keys are supplied.
  registerHandler('se-milestone-signal-unlink', async (_event, payload = {}) => {
    const keys = Array.isArray(payload?.keys) ? payload.keys : null;
    if (!keys || !keys.length) {
      throw new Error('A keys array ([{ kind, nativeId }]) is required to remove a milestone signal link');
    }
    try {
      const removed = signalLinks.removeMilestoneSignalsByKeys(db, payload?.milestoneId, keys);
      return { ok: true, removed };
    } catch (err) {
      throw new Error(`Could not remove milestone signal link: ${err.message || String(err)}`);
    }
  });

  // ── Meeting ↔ milestone links (manual, from the meeting detail panel) ───────
  // A meeting can be linked to one or more milestones straight from the meeting popup.
  // This reuses the canonical signal_links graph (signal_type='meeting',
  // signal_id='meeting:<event_id>', target_type='milestone'), so a link made here is the
  // SAME row the milestone "Related signal" panel reads — there is no second source of
  // truth, and the link surfaces in the milestone detail popup and everywhere else that
  // reads signal_links. source='manual' so the milestone self-heal (which only prunes AI
  // links whose account was rejected) never removes a user's deliberate pick.
  registerHandler('se-meeting-milestone-links', (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    const signalId = `meeting:${eventId}`;
    try {
      const rows = db.prepare(
        `SELECT sl.target_id AS milestone_id, sl.source, sl.created_at,
                m.name AS milestone_name, m.status_label, m.milestone_date,
                o.name AS opportunity_name, o.owner_name AS ssp_name
           FROM active_signal_links sl
           LEFT JOIN active_milestones m ON m.milestone_id = sl.target_id
           LEFT JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
          WHERE sl.signal_type = 'meeting' AND sl.signal_id = ? AND sl.target_type = 'milestone'
          ORDER BY COALESCE(m.milestone_date, '9999-12-31'), m.name`,
      ).all(signalId);
      return { ok: true, links: rows };
    } catch (err) {
      throw new Error(`Could not read linked milestones: ${err.message || String(err)}`);
    }
  });

  registerHandler('se-meeting-link-milestone', (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    if (!milestoneId) throw new Error('milestoneId is required');
    // Snapshot the meeting so the milestone panel renders a meaningful card, and
    // resolve the milestone's own account so the link is tpid-scoped for future reads.
    let mtg = null;
    try {
      mtg = db.prepare('SELECT subject, organizer_name, start_at FROM active_meetings WHERE event_id = ?').get(eventId);
    } catch { mtg = null; }
    if (!mtg) throw new Error('Meeting not found in the local datastore.');
    let tpid = null;
    try {
      const r = db.prepare(
        `SELECT c.tpid FROM active_milestones m
           JOIN active_opportunities o ON o.opportunity_id = m.opportunity_id
           JOIN active_customers c ON c.crm_account_id = o.parent_account_id
          WHERE m.milestone_id = ? AND c.tpid IS NOT NULL AND TRIM(c.tpid) <> '' LIMIT 1`,
      ).get(milestoneId);
      tpid = r?.tpid || null;
    } catch { tpid = null; }
    try {
      const res = signalLinks.linkSignal(db, {
        signalType: 'meeting',
        nativeId: eventId,
        targetType: 'milestone',
        targetId: milestoneId,
        tpid,
        signalTitle: mtg.subject || null,
        signalSubtitle: mtg.organizer_name || null,
        signalDate: mtg.start_at || null,
        source: 'manual',
      });
      return { ok: true, ...res };
    } catch (err) {
      throw new Error(`Could not link the meeting to the milestone: ${err.message || String(err)}`);
    }
  });

  registerHandler('se-meeting-unlink-milestone', (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    if (!milestoneId) throw new Error('milestoneId is required');
    try {
      const removed = signalLinks.unlinkSignal(db, {
        signalType: 'meeting',
        nativeId: eventId,
        targetType: 'milestone',
        targetId: milestoneId,
      });
      return { ok: true, removed };
    } catch (err) {
      throw new Error(`Could not unlink the meeting from the milestone: ${err.message || String(err)}`);
    }
  });

  // ── Meeting working notes (prep brief / transcript / summary / personal) ────
  // App-owned per-meeting text (migration 026). Kept out of the meetings inventory
  // table so the calendar re-sync can never clobber it. Get returns the row (or null);
  // Save upserts only the fields present in `patch`, so writing one field never wipes
  // the others. Fails loud on a missing meeting rather than orphaning a note.
  registerHandler('se-meeting-notes-get', (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    try {
      const row = db.prepare(
        `SELECT event_id, preparation_notes, transcript, summary, personal_notes, updated_at
           FROM meeting_notes WHERE event_id = ?`,
      ).get(eventId);
      return { ok: true, notes: row || null };
    } catch (err) {
      throw new Error(`Could not read meeting notes: ${err.message || String(err)}`);
    }
  });

  registerHandler('se-meeting-notes-save', (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    const patch = payload && typeof payload.patch === 'object' && payload.patch ? payload.patch : {};
    const FIELDS = ['preparation_notes', 'transcript', 'summary', 'personal_notes'];
    const cols = FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(patch, f));
    if (!cols.length) throw new Error('No writable meeting-note fields supplied');
    const exists = db.prepare('SELECT 1 FROM active_meetings WHERE event_id = ?').get(eventId);
    if (!exists) throw new Error('Meeting not found in the local datastore.');
    try {
      const previous = db.prepare('SELECT transcript, summary FROM meeting_notes WHERE event_id = ?').get(eventId);
      const invalidatesActions = ['transcript', 'summary'].some(field => cols.includes(field)
        && String(patch[field] || '') !== String(previous?.[field] || ''));
      const insertCols = ['event_id', ...cols].join(', ');
      const insertVals = ['@event_id', ...cols.map((c) => `@${c}`)].join(', ');
      const setList = [
        ...cols.map((c) => `${c} = @${c}`),
        ...(invalidatesActions ? ['summary_actions_json = NULL', 'summary_transcript_hash = NULL'] : []),
      ].join(', ');
      const bind = { event_id: eventId };
      for (const c of cols) bind[c] = patch[c] == null ? null : String(patch[c]);
      db.prepare(
        `INSERT INTO meeting_notes (${insertCols}, updated_at)
         VALUES (${insertVals}, CURRENT_TIMESTAMP)
         ON CONFLICT(event_id) DO UPDATE SET ${setList}, updated_at = CURRENT_TIMESTAMP`,
      ).run(bind);
      const row = db.prepare(
        `SELECT event_id, preparation_notes, transcript, summary, personal_notes, updated_at
           FROM meeting_notes WHERE event_id = ?`,
      ).get(eventId);
      return { ok: true, notes: row };
    } catch (err) {
      throw new Error(`Could not save meeting notes: ${err.message || String(err)}`);
    }
  });

  // ── Fetch a Teams meeting transcript (WorkIQ / M365 Copilot OAuth) ──────────
  // Pulls the WebVTT transcript for a completed online meeting and returns it cleaned to
  // readable "Speaker: text" lines. Delegated /me access, so it works for meetings the
  // signed-in user organized; other cases (not online, no transcript, not resolvable) are
  // returned as explicit reasons the UI renders honestly. Does NOT persist — the renderer
  // drops the text into the Transcript field and saves via se-meeting-notes-save, mirroring
  // how the Prepare brief flows into preparation_notes. (Teams' AI recap / aiInsights is not
  // fetchable — WorkIQ denies that Graph path — so it is deliberately not offered.)
  registerHandler('se-meeting-fetch-transcript', async (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');
    let meeting = null;
    try {
      meeting = db.prepare(
        'SELECT event_id, subject, is_online_meeting, online_meeting_url FROM active_meetings WHERE event_id = ?',
      ).get(eventId);
    } catch (err) {
      throw new Error(`Could not read the meeting: ${err.message || String(err)}`);
    }
    if (!meeting) return { ok: false, reason: 'not_found', message: 'Meeting not found in the local datastore.' };
    try {
      const wiq = getWorkIqClient({ log: () => {} });
      return await meetingTranscript.fetchTranscript(wiq, meeting);
    } catch (err) {
      return { ok: false, reason: 'error', message: `Could not fetch the transcript: ${err.message || String(err)}` };
    }
  });

  // ── Summarize a meeting transcript (existing AI provider) ───────────────────
  // Honest in-app substitute for the native Teams AI recap (which the app cannot fetch —
  // WorkIQ denies the aiInsights Graph path): runs the app's own model over the transcript
  // already stored on the meeting (meeting_notes.transcript) and returns a concise recap.
  // Reads the transcript from the datastore (or accepts an explicit one), errors clearly when
  // no provider is configured (like every other AI feature) or when there is no transcript
  // yet. Saves the summary and its structured actions together, so Task creation is a
  // separate, retryable step and unchanged transcripts can reuse the same recap.
  registerHandler('se-meeting-summarize-transcript', async (_event, payload = {}) => {
    const eventId = String(payload?.eventId || '').trim();
    if (!eventId) throw new Error('eventId is required');

    // Prefer an explicitly supplied transcript (e.g. just fetched/edited in the UI); else read
    // the persisted one. Fail loud when there is nothing to summarize.
    const meeting = meetingTasks.getMeeting(db, eventId);
    const subject = meeting.subject || '';
    const previousNotes = db.prepare('SELECT * FROM meeting_notes WHERE event_id = ?').get(eventId);
    if (Object.hasOwn(payload, 'transcript') && typeof payload.transcript !== 'string') throw new Error('Transcript must be text.');
    const transcript = String(Object.hasOwn(payload, 'transcript') ? payload.transcript : previousNotes?.transcript || '');
    if (!transcript.trim()) {
      return { ok: false, reason: 'no_transcript', message: 'There is no transcript to summarize yet. Fetch or paste a transcript first.' };
    }

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    // Bound the transcript so a very long meeting stays within the model window. VTT is dense;
    // ~48k chars keeps well under the agent's budget while covering typical meetings.
    const MAX_CHARS = 48000;
    const clipped = transcript.length > MAX_CHARS;
    const context = { subject, meetingDate: meeting.start_at, transcript: clipped ? transcript.slice(0, MAX_CHARS) : transcript };

    let recap = meetingTasks.getReusableSummary(previousNotes, transcript);
    const reused = Boolean(recap);
    try {
      if (!recap) {
        const completion = await runtime.run('transcript-summarizer', { input: { context } });
        if (completion.finishReason && !['stop', 'completed'].includes(completion.finishReason)) {
          throw new Error('The AI recap is incomplete. No summary or Tasks were saved. Try summarizing again.');
        }
        recap = meetingTasks.parseTranscriptSummary(completion.content);
      }
      meetingTasks.saveSummary(db, eventId, transcript, recap, previousNotes);
    } catch (err) {
      throw new Error(`Transcript summarization failed: ${err.message || String(err)}`);
    }
    return {
      ok: true,
      summary: recap.summary,
      actionItems: recap.actionItems,
      meta: { eventId, subject, transcriptChars: transcript.length, clipped, reused, authMode: provider.authMode, deployment: provider.deployment },
    };
  });

  // ── Signals browser (emails / meetings / chats + their account tags) ────
  // A read/manage surface over the ingested M365 signal. Each item can be tagged
  // to one or more customer accounts via the *_customer_links tables; a tag is a
  // link row. "Removing a tag" is a SOFT reject (match_method='ai-rejected') — the
  // same convention every read path already filters out — so it survives the next
  // ingest (the verifier persists rejections) and never resurrects. Purely additive:
  // existing read paths are untouched.
  const SIGNAL_MEDIA = {
    email: {
      itemTable: 'emails', idCol: 'message_id', linkTable: 'email_customer_links', linkKey: 'message_id',
      dateCol: 'sent_at', titleCol: 'subject', openCol: 'web_link',
      listCols: `e.message_id AS id, e.subject AS title, e.from_name, e.from_address, e.sent_at AS item_date,
                 e.has_attachments, e.importance, e.web_link, NULL AS online_url`,
      detailCols: `e.message_id AS id, e.subject AS title, e.from_name, e.from_address, e.to_json, e.cc_json,
                   e.sent_at AS item_date, e.received_at, e.folder, e.importance, e.has_attachments,
                   e.web_link, e.body_text`,
      searchCols: ['e.subject', 'e.from_name', 'e.from_address', 'e.body_text'],
    },
    meeting: {
      itemTable: 'meetings', idCol: 'event_id', linkTable: 'meeting_customer_links', linkKey: 'event_id',
      dateCol: 'start_at', titleCol: 'subject', openCol: 'web_link',
      listCols: `e.event_id AS id, e.subject AS title, e.organizer_name AS from_name, e.organizer_address AS from_address,
                 e.start_at AS item_date, e.is_online_meeting, e.location, e.web_link, e.online_meeting_url AS online_url`,
      detailCols: `e.event_id AS id, e.subject AS title, e.organizer_name AS from_name, e.organizer_address AS from_address,
                   e.attendees_json, e.start_at AS item_date, e.end_at, e.location, e.is_online_meeting,
                   e.online_meeting_url, e.importance, e.sensitivity, e.is_cancelled, e.web_link,
                   COALESCE(e.body_text, e.body_preview) AS body_text, e.raw_json`,
      searchCols: ['e.subject', 'e.organizer_name', 'e.location', 'e.body_text'],
    },
    chat: {
      itemTable: 'teams_chats', idCol: 'chat_id', linkTable: 'teams_chat_customer_links', linkKey: 'chat_id',
      dateCol: 'last_message_at', titleCol: 'topic', openCol: null,
      listCols: `e.chat_id AS id, COALESCE(NULLIF(e.topic,''), e.last_message_from, e.chat_type) AS title,
                 e.last_message_from AS from_name, NULL AS from_address, e.last_message_at AS item_date,
                 e.chat_type, e.member_count, e.has_unread, e.last_message_preview, NULL AS online_url`,
      detailCols: `e.chat_id AS id, COALESCE(NULLIF(e.topic,''), e.chat_type) AS title, e.chat_type, e.member_count,
                   e.has_unread, e.last_message_at AS item_date, e.last_message_from, e.last_message_preview`,
      searchCols: ['e.topic', 'e.last_message_from', 'e.last_message_preview'],
    },
  };

  // Attach the non-rejected account tags to a set of items (batched by id).
  function attachSignalTags(medium, cfg, items) {
    if (!items.length) return items;
    const byId = new Map(items.map((it) => [String(it.id), it]));
    for (const it of items) it.tags = [];
    const ids = [...byId.keys()];
    const chunk = 400;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const ph = slice.map(() => '?').join(',');
      let rows = [];
      try {
        rows = db.prepare(
          `SELECT l.${cfg.linkKey} AS id, l.tpid, l.match_method, l.tier, l.confidence,
                  (SELECT c.name FROM active_customers c WHERE c.tpid = l.tpid AND c.name IS NOT NULL AND c.name != ''
                    ORDER BY (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '') DESC LIMIT 1) AS account_name
           FROM active_${cfg.linkTable} l
           WHERE l.${cfg.linkKey} IN (${ph}) AND l.match_method <> 'ai-rejected'`,
        ).all(...slice);
      } catch { rows = []; }
      for (const r of rows) {
        const it = byId.get(String(r.id));
        if (it) it.tags.push({ tpid: r.tpid, account_name: r.account_name || r.tpid, match_method: r.match_method, tier: r.tier, confidence: r.confidence });
      }
    }
    return items;
  }

  // List signals across one or all media, optionally filtered by account (tpid) or text.
  registerHandler('se-signals-list', (_event, payload = {}) => {
    const media = payload?.medium && payload.medium !== 'all'
      ? [String(payload.medium)]
      : ['email', 'meeting', 'chat'];
    const tpid = String(payload?.tpid || '').trim();
    const search = String(payload?.search || '').trim();
    const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 60));
    const results = [];
    let available = false;
    for (const medium of media) {
      const cfg = SIGNAL_MEDIA[medium];
      if (!cfg) continue;
      try {
        const where = [];
        const params = [];
        if (tpid) {
          where.push(`e.${cfg.idCol} IN (SELECT ${cfg.linkKey} FROM active_${cfg.linkTable} WHERE tpid = ? AND match_method <> 'ai-rejected')`);
          params.push(tpid);
        } else {
          // Default surface: only items that carry at least one live account tag.
          where.push(`EXISTS (SELECT 1 FROM active_${cfg.linkTable} l WHERE l.${cfg.linkKey} = e.${cfg.idCol} AND l.match_method <> 'ai-rejected')`);
        }
        if (search) {
          const like = `%${search.replace(/[%_]/g, (m) => '\\' + m)}%`;
          where.push('(' + cfg.searchCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
          for (let i = 0; i < cfg.searchCols.length; i += 1) params.push(like);
        }
        const rows = db.prepare(
          `SELECT ${cfg.listCols}, '${medium}' AS medium
           FROM active_${cfg.itemTable} e
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY (e.${cfg.dateCol} IS NULL), e.${cfg.dateCol} DESC
           LIMIT ${limit}`,
        ).all(...params);
        attachSignalTags(medium, cfg, rows);
        results.push(...rows);
        available = true;
      } catch {
        /* medium tables absent on older/org builds — skip */
      }
    }
    // Interleave by date across media so an "all" view is chronologically coherent.
    results.sort((a, b) => {
      const da = a.item_date ? Date.parse(a.item_date) : 0;
      const dbb = b.item_date ? Date.parse(b.item_date) : 0;
      return dbb - da;
    });
    return { ok: true, available, items: results.slice(0, limit) };
  });

  // Full metadata + account tags for one signal item.
  registerHandler('se-signal-detail', (_event, payload = {}) => {
    const medium = String(payload?.medium || '').trim();
    const id = String(payload?.id || '').trim();
    const cfg = SIGNAL_MEDIA[medium];
    if (!cfg) throw new Error('A valid medium (email|meeting|chat) is required');
    if (!id) throw new Error('An item id is required');
    let item = null;
    try {
      item = db.prepare(
        `SELECT ${cfg.detailCols}, '${medium}' AS medium FROM active_${cfg.itemTable} e WHERE e.${cfg.idCol} = ?`,
      ).get(id);
    } catch (err) {
      throw new Error(`Could not read ${medium} detail: ${err.message || String(err)}`);
    }
    if (!item) throw new Error('Item not found in the local datastore.');
    // All tags for the item, including rejected ones (flagged) so the UI can show state.
    let tags = [];
    try {
      tags = db.prepare(
        `SELECT l.tpid, l.match_method, l.tier, l.confidence, l.matched_term,
                (SELECT c.name FROM active_customers c WHERE c.tpid = l.tpid AND c.name IS NOT NULL AND c.name != ''
                  ORDER BY (c.parent_crm_account_id IS NULL OR c.parent_crm_account_id = '') DESC LIMIT 1) AS account_name
         FROM active_${cfg.linkTable} l WHERE l.${cfg.linkKey} = ?
         ORDER BY (l.match_method = 'ai-rejected'), l.tier`,
      ).all(id);
    } catch { tags = []; }
    // For chats, include a handful of recent messages as the "body".
    let messages = [];
    if (medium === 'chat') {
      try {
        messages = db.prepare(
          `SELECT sender_name, sent_at, substr(body_text, 1, 600) AS excerpt
           FROM active_teams_chat_messages WHERE chat_id = ? AND body_text IS NOT NULL AND body_text != ''
           ORDER BY (sent_at IS NULL), sent_at DESC LIMIT 20`,
        ).all(id);
      } catch { messages = []; }
    }
    // Meetings: surface attachments from the raw Graph event when the ingest captured
    // them. Honest — we only list what is actually present in raw_json; otherwise the
    // panel shows an empty state (never a fabricated attachment). We also mirror Graph's
    // hasAttachments flag so the panel can say "has attachments, open in Outlook" when the
    // list itself was not expanded during ingest.
    let attachments = [];
    if (medium === 'meeting' && item && item.raw_json) {
      try {
        const raw = JSON.parse(item.raw_json);
        if (Array.isArray(raw?.attachments)) {
          attachments = raw.attachments
            .filter((a) => a && !a.isInline)
            .map((a) => ({
              name: a.name || a.contentType || 'Attachment',
              contentType: a.contentType || null,
              size: typeof a.size === 'number' ? a.size : null,
            }));
        }
        if (raw && typeof raw.hasAttachments === 'boolean') item.has_attachments = raw.hasAttachments ? 1 : 0;
      } catch { /* leave attachments empty on unparseable raw_json */ }
    }
    if (item && 'raw_json' in item) delete item.raw_json; // never ship the whole blob to the renderer
    return { ok: true, item: { ...item, attachments, tags: tags.filter((t) => t.match_method !== 'ai-rejected'), messages } };
  });

  // Remove an account tag from a signal item (soft reject). Idempotent.
  registerHandler('se-signal-untag', (_event, payload = {}) => {
    const medium = String(payload?.medium || '').trim();
    const id = String(payload?.id || '').trim();
    const tpid = String(payload?.tpid || '').trim();
    const cfg = SIGNAL_MEDIA[medium];
    if (!cfg) throw new Error('A valid medium (email|meeting|chat) is required');
    if (!id) throw new Error('An item id is required');
    if (!tpid) throw new Error('A tpid (account) is required');
    try {
      const res = db.prepare(
        `UPDATE ${cfg.linkTable} SET match_method = 'ai-rejected'
         WHERE ${cfg.linkKey} = ? AND tpid = ? AND match_method <> 'ai-rejected'`,
      ).run(id, tpid);
      let remaining = 0;
      try {
        remaining = db.prepare(
          `SELECT COUNT(*) n FROM ${cfg.linkTable} WHERE ${cfg.linkKey} = ? AND match_method <> 'ai-rejected'`,
        ).get(id).n;
      } catch { /* ignore */ }
      return { ok: true, removed: res.changes || 0, remaining };
    } catch (err) {
      throw new Error(`Could not remove the account tag: ${err.message || String(err)}`);
    }
  });

  // ── Milestone Comment Suggester ──────────────────────────────────────
  // Draft the NEXT progress comment for one milestone from the account's emails,
  // meetings and Teams chats that happened between the previous comment's date and
  // today (inclusive). The window is computed here; only in-window items are handed
  // to the agent, which writes a short, grounded comment body the SE can edit before
  // posting. Honest short-circuits (no TPID / no in-window activity) tell the user
  // plainly rather than fabricating an update.
  registerHandler('se-milestone-comment-suggest', async (_event, payload = {}) => {
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!milestoneId) throw new Error('milestoneId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    const milestone = db.prepare(
      `SELECT m.milestone_id, m.name, m.workload, m.status_label, m.milestone_date, m.comments_json,
              o.name AS opp_name, o.customer_name, o.parent_account_id
       FROM active_milestones m
       LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
       WHERE m.milestone_id = ?`,
    ).get(milestoneId);
    if (!milestone) throw new Error('Milestone not found in the local datastore.');

    const tpid = resolveMilestoneTpid(db, milestone);
    if (!tpid) {
      return {
        ok: false,
        error: 'This milestone\'s account could not be matched to a known customer (no TPID), so recent activity cannot be gathered. Run "Sync from CRM" in Settings.',
      };
    }

    // Window lower bound: the most-recent existing comment's date (start of that
    // day, inclusive). With no prior comment we fall back to the last 30 days and
    // flag it so the caller can tell the user we had no previous comment to anchor to.
    const rawComments = safeParseJson(milestone.comments_json, []) || [];
    const sortedComments = (Array.isArray(rawComments) ? rawComments : [])
      .map((c) => ({ date: c.modifiedOn || c.date || null, text: c.comment || c.text || '', poster: c.userId || c.poster || null }))
      .filter((c) => c.date)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const lastComment = sortedComments[0] || null;

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let sinceDate;
    let noPriorComment = false;
    const lastMs = lastComment ? new Date(lastComment.date).getTime() : NaN;
    if (Number.isFinite(lastMs)) {
      const d = new Date(lastMs);
      sinceDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    } else {
      noPriorComment = true;
      sinceDate = new Date(endOfToday.getTime() - 30 * 86400000);
    }
    const sinceMs = sinceDate.getTime();
    const untilMs = endOfToday.getTime();
    const inWindow = (raw) => {
      const t = raw ? Date.parse(raw) : NaN;
      return Number.isFinite(t) && t >= sinceMs && t <= untilMs;
    };

    // Pull a generous candidate window per source, then keep only what falls inside
    // [previous comment day, end of today]. Meetings use window:'past' so far-future
    // recurring placeholders never enter the pool.
    const WIN = 50;
    let emails = [];
    let meetings = [];
    let chats = [];
    try { emails = (loadEmailIntelligence(db, tpid, WIN).recentEmails || []).filter((e) => inWindow(e.received_at)); } catch { /* optional */ }
    try { meetings = (loadMeetingIntelligence(db, tpid, WIN, { window: 'past' }).recentMeetings || []).filter((m) => inWindow(m.start_at)); } catch { /* optional */ }
    try {
      const chatMessages = (loadTeamsIntelligenceFromCli(db, tpid, 60).recentMessages || []).filter((m) => inWindow(m.sent_at));
      const byThread = new Map();
      for (const m of chatMessages) {
        const key = m.chat_id || m.message_id;
        if (!key) continue;
        let t = byThread.get(key);
        if (!t) { t = { chat_id: m.chat_id || key, topic: m.topic || null, sender_name: m.sender_name || null, sent_at: m.sent_at || null, excerpts: [] }; byThread.set(key, t); }
        if (t.excerpts.length < 3 && m.excerpt) t.excerpts.push(m.excerpt);
      }
      chats = Array.from(byThread.values()).map((t) => ({
        chat_id: t.chat_id, topic: t.topic, sender_name: t.sender_name, sent_at: t.sent_at,
        excerpt: t.excerpts.join('  ⏎  '),
      }));
    } catch { /* optional */ }

    const total = emails.length + meetings.length + chats.length;
    const windowMeta = { since: sinceDate.toISOString(), until: endOfToday.toISOString(), noPriorComment };

    // No in-window activity: say so plainly and do NOT fabricate a comment.
    if (total === 0) {
      const sinceLabel = sinceDate.toLocaleDateString();
      return {
        ok: true,
        suggestion: '',
        hasActivity: false,
        window: windowMeta,
        counts: { emails: 0, meetings: 0, chats: 0 },
        message: noPriorComment
          ? `No emails, meetings, or Teams chats found for this account in the last 30 days (no previous comment to anchor to).`
          : `No emails, meetings, or Teams chats found for this account since the last comment (${sinceLabel}).`,
      };
    }

    const context = {
      milestone: {
        ...milestone,
        lastComment: lastComment ? { date: lastComment.date, text: (lastComment.text || '').slice(0, 400) } : null,
      },
      window: windowMeta,
      signal: { emails, meetings, chats },
    };

    let completion;
    try {
      completion = await runtime.run('milestone-comment-suggester', { input: { context } });
    } catch (err) {
      throw new Error(`Comment suggestion failed: ${err.message || String(err)}`);
    }

    // The agent returns the comment body as plain text; strip any accidental wrapping
    // quotes or code fences so the box gets clean, editable prose.
    let suggestion = String(completion.content || '').trim();
    suggestion = suggestion.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
    if ((suggestion.startsWith('"') && suggestion.endsWith('"')) || (suggestion.startsWith('“') && suggestion.endsWith('”'))) {
      suggestion = suggestion.slice(1, -1).trim();
    }

    return {
      ok: true,
      suggestion,
      hasActivity: true,
      window: windowMeta,
      counts: { emails: emails.length, meetings: meetings.length, chats: chats.length },
      meta: { milestoneId, tpid, authMode: provider.authMode, deployment: provider.deployment },
    };
  });

  // Milestone HoK Activity Suggester — draft the next HoK activity (subject/description/
  // category) for one milestone from the emails, meetings and Teams chats already LINKED to
  // it as Related signal. Unlike the comment suggester (which scans a fresh date window),
  // this grounds on the persisted, user-curated signal links so the activity reflects exactly
  // what the SE decided relates to this milestone. If nothing is linked yet, say so plainly
  // rather than inventing an activity, and never auto-create — the UI pre-fills the form.
  registerHandler('se-milestone-hok-suggest', async (_event, payload = {}) => {
    const milestoneId = String(payload?.milestoneId || '').trim();
    if (!milestoneId) throw new Error('milestoneId is required');

    const provider = await resolveChatProvider();
    if (!provider) throw new Error(NO_MODEL_PROVIDER_MESSAGE);
    const runtime = makeAgentRuntime(provider);

    const milestone = db.prepare(
      `SELECT m.milestone_id, m.name, m.workload, m.status_label, m.milestone_date,
              o.name AS opp_name, o.customer_name
       FROM active_milestones m
       LEFT JOIN active_opportunities o ON m.opportunity_id = o.opportunity_id
       WHERE m.milestone_id = ?`,
    ).get(milestoneId);
    if (!milestone) throw new Error('Milestone not found in the local datastore.');

    // The persisted Related-signal links are the source of truth (title/subtitle/date/reason
    // snapshots). Enrich each with a body excerpt from the underlying source row when it still
    // exists, falling back to the snapshot alone if the row was purged from the local cache.
    // NOTE (migration 024 thread grain): a chat link's ref_id is now the thread chat_id, not a
    // per-message message_id, so the chat body excerpt below no longer resolves and chats fall
    // back to their snapshot. Email/meeting excerpts are unaffected (ref_id is still their id).
    const links = signalLinks.readMilestoneSignals(db, milestoneId);
    if (!links.length) {
      return {
        ok: true,
        hasSignal: false,
        message: 'No related signals are linked to this milestone yet. Use "Find emails, meetings & chats" to gather signal first, then try HoK AI.',
      };
    }

    const emailBody = db.prepare('SELECT body_text FROM active_emails WHERE message_id = ?');
    const meetingBody = db.prepare('SELECT body_text FROM active_meetings WHERE event_id = ?');
    const chatBody = db.prepare('SELECT body_text FROM active_teams_chat_messages WHERE message_id = ?');
    const excerptFor = (link) => {
      try {
        let row = null;
        if (link.kind === 'email') row = emailBody.get(link.ref_id);
        else if (link.kind === 'meeting') row = meetingBody.get(link.ref_id);
        else if (link.kind === 'chat') row = chatBody.get(link.ref_id);
        return row && row.body_text ? String(row.body_text).replace(/\s+/g, ' ').trim() : '';
      } catch { return ''; }
    };

    const signals = { emails: [], meetings: [], chats: [] };
    for (const l of links) {
      const enriched = { ...l, excerpt: excerptFor(l) };
      if (l.kind === 'email') signals.emails.push(enriched);
      else if (l.kind === 'meeting') signals.meetings.push(enriched);
      else if (l.kind === 'chat') signals.chats.push(enriched);
    }

    const context = { milestone, signals, categories: HOK_TASK_CATEGORIES };

    let completion;
    try {
      completion = await runtime.run('milestone-hok-suggester', { input: { context } });
    } catch (err) {
      throw new Error(`HoK activity suggestion failed: ${err.message || String(err)}`);
    }

    const parsed = safeParseJson(completion.content, null);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'The model did not return a usable HoK activity suggestion. Try again.' };
    }
    // Accept the multi-activity contract ({ activities: [...] }); tolerate a bare array or a
    // single legacy object so a stray model response still parses rather than failing loudly
    // for a benign shape difference.
    let rawActivities;
    if (Array.isArray(parsed)) rawActivities = parsed;
    else if (Array.isArray(parsed.activities)) rawActivities = parsed.activities;
    else rawActivities = [parsed];

    const suggestions = [];
    for (const item of rawActivities) {
      if (!item || typeof item !== 'object') continue;
      const subject = String(item.subject || '').trim();
      const description = String(item.description || '').trim();
      // Only accept a category that is one of the allowed values; otherwise leave it blank so
      // the user picks one rather than silently applying an invented code.
      const rawCategory = item.category == null ? '' : String(item.category).trim();
      const category = HOK_TASK_CATEGORY_VALUES.has(rawCategory) ? rawCategory : '';
      if (!subject) continue;
      suggestions.push({ subject, description, category });
    }

    const counts = { emails: signals.emails.length, meetings: signals.meetings.length, chats: signals.chats.length };
    const meta = { milestoneId, authMode: provider.authMode, deployment: provider.deployment };

    if (!suggestions.length) {
      // Signal existed but nothing worth logging — say so plainly rather than inventing an activity.
      return {
        ok: true,
        hasSignal: true,
        suggestions: [],
        suggestion: null,
        message: 'The linked signal did not warrant a specific HoK activity. Review it and log one manually if needed.',
        counts,
        meta,
      };
    }

    return {
      ok: true,
      hasSignal: true,
      suggestions,
      // Keep `suggestion` (the first activity) for callers that expect the single-object shape.
      suggestion: suggestions[0],
      counts,
      meta,
    };
  });

  // ── GitHub Copilot model provider: sign-in + status ──────────────────
  registerHandler('github-sign-in-start', async () => {
    return await githubAuth.startDeviceLogin();
  });
  registerHandler('github-sign-in-wait', async (_event, flowId) => {
    return await githubAuth.waitForDeviceLogin(String(flowId || ''));
  });
  registerHandler('github-sign-out', async () => {
    return githubAuth.signOut();
  });
  registerHandler('github-status', async () => {
    return githubAuth.getStatus();
  });
  registerHandler('copilot-probe', async () => {
    return await copilotProvider.probe();
  });
  registerHandler('copilot-list-models', async () => {
    try {
      return { ok: true, ...(await copilotProvider.listModels()) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  registerHandler('copilot-set-model', async (_event, modelId) => {
    const effective = copilotProvider.setModel(String(modelId || ''));
    return { ok: true, model: effective };
  });
  registerHandler('copilot-set-utility-model', async (_event, modelId) => {
    const effective = copilotProvider.setUtilityModel(String(modelId || ''));
    return {
      ok: true,
      model: effective,
      usesPrimary: copilotProvider.utilityUsesPrimaryModel(),
    };
  });
  registerHandler('model-activity-status', () => (
    typeof copilotProvider.getActivity === 'function'
      ? copilotProvider.getActivity()
      : { phase: 'idle', running: 0, queued: 0, cooldownUntil: null, requests: [] }
  ));
  registerHandler('model-provider-status', async () => {
    const gh = githubAuth.getStatus();
    const foundry = readDesktopFoundryConfig();
    const active = gh.signedIn ? 'github-copilot' : (foundry.enabled ? 'foundry' : null);
    return {
      active,
      copilot: {
        signedIn: gh.signedIn,
        login: gh.login,
        model: copilotProvider.getModelName(),
        utilityModel: typeof copilotProvider.getModelNameForRole === 'function'
          ? copilotProvider.getModelNameForRole('utility')
          : copilotProvider.getModelName(),
        utilityUsesPrimary: typeof copilotProvider.utilityUsesPrimaryModel === 'function'
          ? copilotProvider.utilityUsesPrimaryModel()
          : true,
      },
      foundry: { enabled: foundry.enabled, deployment: foundry.deployment || null },
    };
  });

  // ── Customer-data ingestion (WorkIQ) + owned-account detection ──────────────
  // WorkIQ carries its own admin-consented M365 Copilot OAuth (separate from MSX/MSAL
  // and GitHub). These handlers surface its connection state and let the user sign in
  // from the app instead of running the Copilot CLI by hand.
  registerHandler('workiq-status', async (_event, opts = {}) => {
    try {
      const state = await workiqAuth.status({ probe: opts.probe !== false });
      // A lapsed session can usually be healed in place, so the "Check" button
      // repairs rather than merely reporting. WorkIQ clears its own cached account
      // on expiry, so `recoverable` (backed by the account we remembered) — not
      // `account` — is what decides whether a silent reconnect is possible.
      if (!state.connected && state.recoverable && opts.autoReconnect !== false && opts.probe !== false) {
        const healed = await workiqAuth.ensureConnected({ reason: 'status-check' });
        return {
          ok: true,
          ...state,
          account: healed.connected ? (healed.account || state.account) : state.account,
          connected: healed.connected,
          reconnected: healed.reconnected,
          status: healed.connected ? null : (healed.status ?? state.status ?? null),
          code: healed.connected ? null : (healed.code ?? state.code ?? null),
          error: healed.connected ? null : (healed.error || state.error || null),
          autoReconnect: workiqAuth.autoReconnectState(),
        };
      }
      return { ok: true, ...state, autoReconnect: workiqAuth.autoReconnectState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  registerHandler('workiq-connect', async () => {
    try {
      const result = await workiqAuth.login();
      // login() already verified the new sign-in with a real read; return that check so the
      // Settings card shows its outcome instead of starting another one.
      if (!result.success) return result;
      return { ...result, state: { ok: true, ...result.state, autoReconnect: workiqAuth.autoReconnectState() } };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
  registerHandler('workiq-disconnect', async () => {
    try {
      return await workiqAuth.logout();
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  registerHandler('derive-owned-accounts', async () => {
    if (!msxIpc?.executeCrmRequest) return { ok: false, error: 'MSX/CRM unavailable — sign in to Microsoft first.' };
    try {
      const owned = await deriveOwnedAccounts(msxIpc.executeCrmRequest);
      return { ok: true, ...owned };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  registerHandler('apply-owned-accounts', async (_event, tpids) => {
    try {
      const effective = saveRoster(db, tpids || []);
      return { ok: true, tpids: effective };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  registerHandler('m365-ingest-run', async (event, payload = {}) => {
    return runIngestionJob({
      mode: payload.mode === 'backfill' ? 'backfill' : 'incremental',
      mediums: Array.isArray(payload.mediums) ? payload.mediums : undefined,
      webContents: event.sender,
    });
  });

  registerHandler('m365-ingest-status', async () => {
    return {
      running: ingestState.running,
      lastRunAt: ingestState.lastRunAt || appPrefs.get('lastIngestAt', null),
      lastResult: ingestState.lastResult || appPrefs.get('lastIngestResult', null),
      lastError: ingestState.lastError,
      lastErrorAt: ingestState.lastErrorAt,
      autoIngest: {
        enabled: Boolean(appPrefs.get('autoIngestEnabled', false)),
        intervalMin: Number(appPrefs.get('autoIngestIntervalMin', 60)) || 60,
      },
      autoIngestLog: appPrefs.get('autoIngestLastLog', null),
      counts: ingestCounts(db),
    };
  });

  registerHandler('m365-autoingest-set', async (_event, cfg = {}) => {
    if (typeof cfg.enabled === 'boolean') appPrefs.set('autoIngestEnabled', cfg.enabled);
    if (cfg.intervalMin != null) appPrefs.set('autoIngestIntervalMin', Math.max(15, Number(cfg.intervalMin) || 60));
    return {
      ok: true,
      enabled: Boolean(appPrefs.get('autoIngestEnabled', false)),
      intervalMin: Number(appPrefs.get('autoIngestIntervalMin', 60)) || 60,
    };
  });

  // ── Privacy: delete all local data ───────────────────────────────────────────
  // Wipes every locally persisted store back to a fresh-install state: all SQLite
  // tables are emptied (then VACUUM overwrites the freed pages so a raw scan of
  // seassist.db turns up nothing), and the on-disk side stores — encrypted sign-in
  // tokens (secure/), generated HTML reports (generated/), Teams staging copies
  // (teams-exports/), plaintext prefs (app-prefs.json) and any leftover ingestion
  // staging temp files — are deleted. This signs the user out and is irreversible.
  //
  // We empty the tables in place rather than deleting the .db file so the live
  // better-sqlite3 handle captured by the already-registered IPC handlers stays
  // valid; deleting the file would leave those closures pointing at a dead handle.
  registerHandler('se-wipe-local-data', async () => {
    const removed = [];
    const failed = [];
    const rmFile = (p) => {
      try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(p); } }
      catch (e) { failed.push({ path: p, error: e.message }); }
    };
    const rmDir = (p) => {
      try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); } }
      catch (e) { failed.push({ path: p, error: e.message }); }
    };
    try {
      const userData = app.getPath('userData');

      // 1) Empty every user table, then reclaim/overwrite freed pages.
      const database = openDb();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);
      database.pragma('foreign_keys = OFF');
      try {
        const clearAll = database.transaction(() => {
          for (const t of tables) database.prepare(`DELETE FROM "${t}"`).run();
        });
        clearAll();
      } finally {
        database.pragma('foreign_keys = ON');
      }
      try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      try { database.exec('VACUUM'); } catch { /* best effort */ }
      removed.push(`sqlite: cleared ${tables.length} tables`);

      // 2) Delete the on-disk side stores.
      rmDir(path.join(userData, 'secure'));         // encrypted MS/GitHub tokens (signs out)
      rmDir(path.join(userData, 'generated'));       // generated HTML reports
      rmDir(path.join(userData, 'teams-exports'));   // Teams staging copies
      rmFile(path.join(userData, 'app-prefs.json')); // plaintext prefs (model, schedule)

      // 3) Sweep leftover ingestion staging temp files.
      try {
        const tmp = os.tmpdir();
        for (const f of fs.readdirSync(tmp)) {
          if (/^seassist-.*\.json$/i.test(f)) rmFile(path.join(tmp, f));
        }
      } catch { /* best effort */ }

      // 4) Reset in-memory ingestion state so the UI doesn't surface stale results.
      ingestState.running = false;
      ingestState.lastRunAt = null;
      ingestState.lastResult = null;
      ingestState.lastError = null;
      ingestState.lastErrorAt = null;

      return { ok: true, removed, failed };
    } catch (err) {
      return { ok: false, error: err.message || String(err), removed, failed };
    }
  });

  // ── My Org (org chart) ──────────────────────────────────────────────────────
  // Traversal is cache-first (migration 012): served from the local org cache when fresh,
  // fetched live on a miss / when stale, and written through on every live read. Pass
  // { refresh: true } (the Refresh button) to bypass the cache and re-pull the branch live.
  registerHandler('org-get-tree', async (_event, payload = {}) => {
    try {
      const target = String(payload.userId || '').trim() || 'me';
      const refresh = Boolean(payload.refresh);
      // Walk the whole reporting line — it normally terminates at Satya Nadella.
      // The cap is only a defence against malformed/cyclic directory data, so it
      // sits well above any real Microsoft chain depth.
      const depth = Math.min(Math.max(Number(payload.managerDepth) || 30, 0), 40);
      const person = await getOrgPersonCached(target, { refresh });
      if (!person) return { ok: false, error: 'Person not found in the directory.' };
      const anchor = person.id || target;
      const [managerChain, reports] = await Promise.all([
        getManagerChainCached(anchor, depth, { refresh }),
        getOrgReportsCached(anchor, { refresh }).catch(() => []),
      ]);
      return {
        ok: true,
        person,
        managers: managerChain.chain,
        reports,
        managerChain: {
          reachedTop: managerChain.reachedTop,
          stoppedReason: managerChain.stoppedReason,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  registerHandler('org-get-reports', async (_event, payload = {}) => {
    const userId = String(payload.userId || '').trim();
    if (!userId) return { ok: false, error: 'userId is required' };
    try {
      const reports = await getOrgReportsCached(userId, { refresh: Boolean(payload.refresh) });
      return { ok: true, userId, reports };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  registerHandler('org-search-people', async (_event, payload = {}) => {
    const q = String(payload.query || '').trim();
    if (q.length < 3) return { ok: true, people: [] };
    const esc = escapeODataLiteral(q);
    const attempts = [
      `/users?$filter=startswith(displayName,'${esc}') or startswith(mail,'${esc}') or startswith(userPrincipalName,'${esc}') or startswith(givenName,'${esc}') or startswith(surname,'${esc}')&$select=${ORG_PERSON_SELECT}&$top=50`,
      `/users?$filter=startswith(displayName,'${esc}')&$select=${ORG_PERSON_SELECT}&$top=50`,
    ];

    // The live directory is ALWAYS queried — cached rows only *augment* the results, never
    // replace them — so people not yet in the cache are never missed. If every live attempt
    // fails (e.g. offline), we degrade to cached matches rather than returning nothing.
    let live = [];
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        const res = await callGraph(attempts[i]); // eslint-disable-line no-await-in-loop
        live = (res.value || []).map(projectOrgPerson).filter(Boolean);
        if (live.length) break;
      } catch { /* try the next filter, then fall through to the cache */ }
    }

    // Rank real internal employees ahead of external guests and resource/room mailboxes,
    // which otherwise crowd out the person the user is actually looking for.
    const isResource = (p) => /(calendar|photography|room|reception|mailbox|\(non ea|test)/i.test(p.displayName)
      || /onmicrosoft\.com$/i.test(p.mail);
    const isInternal = (p) => /@microsoft\.com$/i.test(p.mail);
    const isReal = (p) => !isResource(p) || isInternal(p);
    const score = (p) => {
      let s = 0;
      if (isInternal(p)) s += 4;
      if (p.jobTitle) s += 2;
      if (!isResource(p)) s += 1;
      return s;
    };

    // Write-through: remember the real people this search surfaced.
    cacheUpsertPeople(live.filter(isReal));

    // Union live ∪ cached-matches (live wins on id), so a cached person the live top-50
    // dropped still appears. This can only ever ADD candidates, never hide fresh ones.
    const byId = new Map();
    for (const p of live) if (p && p.id) byId.set(p.id, p);
    for (const p of cacheSearchPeople(q, 25)) if (p && p.id && !byId.has(p.id)) byId.set(p.id, p);

    const people = Array.from(byId.values())
      .filter(isReal)
      .sort((a, b) => (score(b) - score(a)) || a.displayName.localeCompare(b.displayName))
      .slice(0, 15);
    return { ok: true, people };
  });

  // Resolve a person's display name (+ title) from their email — used to auto-fill an SSP's
  // name once the SE types the email on the Customers grid. Cache-first (org_people, keyed by
  // mail/UPN), then a live directory lookup via WorkIQ Graph for anyone not yet cached. Returns
  // { ok:true, resolved:false } (not an error) when the email doesn't match a directory person,
  // so the UI can say so plainly and leave the name for manual entry.
  registerHandler('se-resolve-person-by-email', async (_event, payload = {}) => {
    const email = String(payload?.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'A valid email is required.' };
    }
    // 1) Cache-first: a fresh cached directory row resolves instantly (offline-friendly).
    try {
      const cached = cacheGetPersonByMail(email);
      if (cached?.person?.displayName) {
        return { ok: true, resolved: true, source: 'cache', name: cached.person.displayName, title: cached.person.jobTitle || '' };
      }
    } catch { /* fall through to live */ }
    // 2) Live directory lookup via WorkIQ Graph (write-through into the cache on success).
    try {
      const esc = escapeODataLiteral(email);
      const res = await callGraph(
        `/users?$filter=mail eq '${esc}' or userPrincipalName eq '${esc}'&$select=${ORG_PERSON_SELECT}&$top=1`,
      );
      const person = projectOrgPerson((res.value || [])[0]);
      if (person?.displayName && person.displayName !== '(unknown)') {
        if (person.id) { try { cacheUpsertPerson(person); } catch { /* best-effort cache */ } }
        return { ok: true, resolved: true, source: 'graph', name: person.displayName, title: person.jobTitle || '' };
      }
      return { ok: true, resolved: false, message: 'No directory match for that email.' };
    } catch (err) {
      // WorkIQ not signed in / offline — report honestly so the UI doesn't imply "no such person".
      return { ok: false, error: `Directory lookup unavailable: ${err.message || String(err)}` };
    }
  });

  registerHandler('org-customer-team', async (_event, payload = {}) => {
    const tpid = String(payload.tpid || '').trim();
    if (!tpid) return { ok: false, error: 'tpid is required' };
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT person_name, person_email, engagement FROM active_customer_account_team
         WHERE tpid = ? AND org = 'microsoft'
         ORDER BY engagement DESC, person_name LIMIT 25`,
      ).all(tpid);
    } catch (err) {
      return { ok: false, error: `Account-team data unavailable: ${err.message}` };
    }

    // CRM ownership augmentation: pull everyone who OWNS a milestone or opportunity on any
    // account under this TPID. These are internal sellers/owners from Dynamics — surfaced
    // even when they never emailed/Teams'd on the account (the comms roster above misses
    // them). Best-effort: a query failure never breaks the comms-derived roster.
    let ownerRows = [];
    try {
      ownerRows = db.prepare(
        `SELECT MAX(owner_name) AS owner_name,
                SUM(opp_owned)  AS opp_owned,
                SUM(ms_owned)   AS ms_owned
         FROM (
           SELECT o.owner_name AS owner_name, 1 AS opp_owned, 0 AS ms_owned
             FROM active_opportunities o
             JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
            WHERE cu.tpid = ? AND COALESCE(TRIM(o.owner_name), '') <> ''
           UNION ALL
           SELECT m.owner_name AS owner_name, 0 AS opp_owned, 1 AS ms_owned
             FROM active_milestones m
             JOIN active_opportunities o2 ON m.opportunity_id = o2.opportunity_id
             JOIN active_customers cu2 ON cu2.crm_account_id = o2.parent_account_id
            WHERE cu2.tpid = ? AND COALESCE(TRIM(m.owner_name), '') <> ''
         )
         GROUP BY lower(TRIM(owner_name))
         ORDER BY (SUM(ms_owned) + SUM(opp_owned)) DESC, owner_name
         LIMIT 50`,
      ).all(tpid, tpid);
    } catch { ownerRows = []; }

    if (!rows.length && !ownerRows.length) return { ok: true, tpid, members: [] };

    const members = await Promise.all(rows.map(async (row) => {
      const email = (row.person_email || '').toLowerCase();
      const base = { name: row.person_name, email, engagement: row.engagement };
      if (!email) return { ...base, person: null, manager: null };

      // Cache-first: reuse a fresh cached directory match for this member before hitting live.
      let person = null;
      const cached = cacheGetPersonByMail(email);
      if (cached && orgIsFresh(cached.row.updated_at)) {
        person = cached.person;
      } else {
        try {
          const esc = escapeODataLiteral(email);
          const res = await callGraph(
            `/users?$filter=mail eq '${esc}' or userPrincipalName eq '${esc}'&$select=${ORG_PERSON_SELECT}&$top=1`,
          );
          person = projectOrgPerson((res.value || [])[0]);
          if (person && person.id) cacheUpsertPerson(person); // write-through
        } catch { /* unresolved directory lookup */ }
      }
      let manager = null;
      if (person && person.id) manager = await getOrgManagerCached(person.id);
      return { ...base, person, manager };
    }));

    // Merge CRM owners into the roster. Resolve each owner's directory person by name, then
    // either TAG an existing comms member (no duplicate) or add a new CRM-sourced member.
    const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const byPersonId = new Map();
    const byEmail = new Map();
    const byName = new Map();
    for (const m of members) {
      if (m.person?.id) byPersonId.set(m.person.id, m);
      if (m.email) byEmail.set(normKey(m.email), m);
      if (m.name) byName.set(normKey(m.name), m);
    }

    const resolvedOwners = await Promise.all(ownerRows.map(async (o) => ({
      counts: {
        ownedOpportunities: Number(o.opp_owned) || 0,
        ownedMilestones: Number(o.ms_owned) || 0,
      },
      name: o.owner_name,
      person: await resolveOrgPersonByName(o.owner_name),
    })));

    // Synchronous merge (avoids read-modify-write races when two owner spellings map to
    // the same directory person). Collect brand-new owners for a follow-up manager fetch.
    const newOwners = [];
    for (const { counts, name, person } of resolvedOwners) {
      let existing = null;
      if (person?.id && byPersonId.has(person.id)) existing = byPersonId.get(person.id);
      else if (person?.mail && byEmail.has(normKey(person.mail))) existing = byEmail.get(normKey(person.mail));
      else if (byName.has(normKey(name))) existing = byName.get(normKey(name));

      if (existing) {
        existing.crmOwner = true;
        existing.ownedOpportunities = (existing.ownedOpportunities || 0) + counts.ownedOpportunities;
        existing.ownedMilestones = (existing.ownedMilestones || 0) + counts.ownedMilestones;
        if (!existing.person && person) existing.person = person;
        if (!existing.email && person?.mail) existing.email = person.mail;
        continue;
      }
      const member = {
        name: person?.displayName || name,
        email: person?.mail || '',
        engagement: 0,
        person: person || null,
        manager: null,
        crmOwner: true,
        ownedOpportunities: counts.ownedOpportunities,
        ownedMilestones: counts.ownedMilestones,
      };
      // Register so later owner rows dedupe against this new member too.
      if (person?.id) byPersonId.set(person.id, member);
      if (member.email) byEmail.set(normKey(member.email), member);
      byName.set(normKey(member.name), member);
      newOwners.push(member);
    }

    await Promise.all(newOwners.map(async (member) => {
      if (member.person?.id) member.manager = await getOrgManagerCached(member.person.id);
    }));

    return { ok: true, tpid, members: [...members, ...newOwners] };
  });

  registerHandler('org-customer-relationships', (event, payload = {}) => {
    const tpid = String(payload.tpid || '').trim();
    if (!tpid) return { ok: false, error: 'tpid is required' };
    if (!getEffectiveTpids(db).includes(tpid)) {
      return { ok: false, error: 'This customer is not in the signed-in user\'s roster.' };
    }
    try {
      const teamRows = db.prepare(
        `SELECT person_name, person_email, org
         FROM active_customer_account_team
         WHERE tpid = ?`,
      ).all(tpid);
      const emailRows = db.prepare(
        `SELECT e.message_id, e.subject, e.web_link,
                e.from_name, e.from_address, e.to_json, e.cc_json, e.sent_at, e.received_at
         FROM active_email_customer_links l
         JOIN active_emails e ON e.message_id = l.message_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'`,
      ).all(tpid);
      const meetingRows = db.prepare(
        `SELECT e.event_id, e.subject, e.web_link,
                e.organizer_name, e.organizer_address, e.attendees_json, e.start_at
         FROM active_meeting_customer_links l
         JOIN active_meetings e ON e.event_id = l.event_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'`,
      ).all(tpid);
      const teamsRows = db.prepare(
        `SELECT c.chat_id, c.topic, c.raw_json AS chat_raw_json, c.last_message_at,
                m.sender_name, m.sender_id, m.sent_at, m.raw_json AS message_raw_json
         FROM active_teams_chat_customer_links l
         JOIN active_teams_chats c ON c.chat_id = l.chat_id
         LEFT JOIN active_teams_chat_messages m ON m.chat_id = c.chat_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'`,
      ).all(tpid);
      return {
        ok: true,
        tpid,
        ...buildCustomerRelationshipGraph({
          teamRows,
          emailRows,
          meetingRows,
          teamsRows,
        }),
      };
    } catch (err) {
      return {
        ok: false,
        error: `Customer interaction data unavailable: ${err.message || String(err)}`,
      };
    }
  });

  // ── Stakeholder influence map ──────────────────────────────────────────────────
  // Profiles only non-Microsoft people linked to one roster account, from local data.
  // Scores are recomputed deterministically on every read; only the user's corrections and
  // the latest AI assessment are stored. The model sees P# handles and "[email]"
  // placeholders, never email addresses. The AI analysis runs only on GitHub Copilot.
  const INFLUENCE_COPILOT_REQUIRED = 'The Stakeholder Influence Map analysis runs only on GitHub Copilot. Connect GitHub Copilot in User Home → GitHub sign-in.';
  const influenceRuns = new Set();

  function influenceAccount(payload) {
    const tpid = String(payload?.tpid || '').trim();
    if (!tpid) return { error: { ok: false, error: 'tpid is required' } };
    if (!getEffectiveTpids(db).includes(tpid)) {
      return { error: { ok: false, error: 'This customer is not in the signed-in user\'s roster.' } };
    }
    return { tpid };
  }

  function influenceMap(tpid) {
    const inputs = influenceStore.loadAccountInputs(db, tpid);
    return {
      ok: true,
      tpid,
      analyzing: influenceRuns.has(tpid),
      // Lets the UI disable Analyze with the reason instead of letting it fail.
      copilotConnected: githubAuth.isSignedIn(),
      ...stakeholderInfluence.buildInfluenceMap(inputs),
    };
  }

  registerHandler('influence-map-get', (_event, payload = {}) => {
    const account = influenceAccount(payload);
    if (account.error) return account.error;
    try {
      return influenceMap(account.tpid);
    } catch (err) {
      return { ok: false, error: `Influence map unavailable: ${err.message || String(err)}` };
    }
  });

  // Stance, note and exclusion are the user's own corrections. They are allowed only for
  // people this account's map actually profiles (or already has a correction for).
  registerHandler('influence-override-set', (_event, payload = {}) => {
    const account = influenceAccount(payload);
    if (account.error) return account.error;
    const personId = String(payload.personId || '').trim();
    if (!personId) return { ok: false, error: 'personId is required' };
    const patch = {};
    for (const key of ['stance', 'note', 'hidden']) {
      if (Object.hasOwn(payload, key)) patch[key] = payload[key];
    }
    if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to change: send a stance, a note or hidden.' };
    try {
      const inputs = influenceStore.loadAccountInputs(db, account.tpid);
      if (!stakeholderInfluence.profiledPersonIds(inputs).has(personId)) {
        return { ok: false, error: 'This person is not on this account\'s influence map.' };
      }
      influenceStore.setOverride(db, { tpid: account.tpid, personId, ...patch });
      return influenceMap(account.tpid);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  registerHandler('influence-assessment-clear', (_event, payload = {}) => {
    const account = influenceAccount(payload);
    if (account.error) return account.error;
    if (influenceRuns.has(account.tpid)) {
      return { ok: false, reason: 'busy', error: 'An analysis is running for this account. Wait for it to finish, then delete it.' };
    }
    try {
      const cleared = influenceStore.clearAssessment(db, account.tpid);
      return { ...influenceMap(account.tpid), cleared };
    } catch (err) {
      return { ok: false, error: `Could not delete the AI analysis: ${err.message || String(err)}` };
    }
  });

  // The AI judges only observable stance and adopted suggestions; every quote it returns is
  // checked verbatim against the text it was shown. Nothing is saved unless the whole
  // response parses, and people excluded while the model was running are dropped first.
  registerHandler('influence-map-analyze', async (_event, payload = {}) => {
    const account = influenceAccount(payload);
    if (account.error) return account.error;
    const { tpid } = account;
    if (influenceRuns.has(tpid)) {
      return { ok: false, reason: 'busy', error: 'An influence analysis is already running for this account.' };
    }
    // Copilot only: there is no Foundry path, even when Foundry settings are present.
    if (!githubAuth.isSignedIn()) return { ok: false, reason: 'copilot_required', error: INFLUENCE_COPILOT_REQUIRED };
    influenceRuns.add(tpid);
    try {
      const { context, refToId, sources } = stakeholderInfluence.buildAnalystContext(influenceStore.loadAccountInputs(db, tpid));
      if (!context.people.length) {
        return {
          ok: false,
          reason: 'no_people',
          error: 'Nobody outside Microsoft appears in this account\'s linked email or meetings yet, so there is nothing to analyze.',
        };
      }
      if (!context.transcripts.length && !context.emailThreads.length) {
        return {
          ok: false,
          reason: 'no_text',
          error: 'This account has no linked meeting transcripts or readable email text, so the AI has nothing to judge stance from. The signal scores do not need it.',
        };
      }
      const provider = await resolveChatProvider({ copilotOnly: true, copilotOnlyMessage: INFLUENCE_COPILOT_REQUIRED });
      const completion = await makeAgentRuntime(provider).run('stakeholder-influence-analyst', { input: { context } });
      if (completion.finishReason && !['stop', 'completed'].includes(completion.finishReason)) {
        throw new Error(completion.finishReason === 'length'
          ? 'The AI response was cut off before it finished. Nothing was saved. Try Analyze again.'
          : `The AI response did not finish (${completion.finishReason}). Nothing was saved. Try Analyze again.`);
      }
      const result = stakeholderInfluence.parseInfluenceAssessment(completion.content, { refToId, sources });
      const hidden = new Set(influenceStore.loadAccountInputs(db, tpid).overrides
        .filter((item) => item.hidden).map((item) => item.personId));
      result.people = result.people.filter((person) => !hidden.has(person.personId));
      const model = completion.model || provider.deployment || null;
      influenceStore.saveAssessment(db, {
        tpid,
        provider: provider.kind,
        model,
        analyzedAt: new Date().toISOString(),
        inputHash: stakeholderInfluence.hashAnalystContext(context),
        result,
      });
      influenceRuns.delete(tpid);
      return {
        ...influenceMap(tpid),
        meta: {
          provider: provider.kind,
          model,
          people: context.people.length,
          transcripts: context.transcripts.length,
          emailThreads: context.emailThreads.length,
        },
      };
    } catch (err) {
      return { ok: false, error: `Influence analysis failed: ${err.message || String(err)}` };
    } finally {
      influenceRuns.delete(tpid);
    }
  });


  // ── A Microsoft person's customer footprint (org chart detail panel) ─────────
  // Given a directory person's email, find the account-linked emails, meetings and
  // Teams chats they took part in, and the customer people they were in contact with.
  // Scoped to items already linked to an account (the same `*_customer_links` tables
  // every other read path uses), so this only ever surfaces customer-relevant signal.
  // Read-only and local: no Graph call, no model call.
  registerHandler('org-person-activity', (event, payload = {}) => {
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return { ok: false, error: 'A person email is required.' };
    }
    const limit = Math.max(1, Math.min(100, Number(payload.limit) || 40));
    // Participants are stored as JSON, so the address always appears wrapped in quotes
    // ("address": "ada@contoso.com"). Anchoring the LIKE on those quotes is what stops a
    // short alias from matching a longer one that merely ends with it — an unanchored
    // %ana@contoso.com% would also match "diana@contoso.com" and pull in items this
    // person was never on. Wildcards in the address itself are escaped.
    const escaped = email.replace(/[%_\\]/g, (m) => `\\${m}`);
    const like = `%"${escaped}"%`;

    const rows = (sql, params) => {
      try { return db.prepare(sql).all(...params); } catch { return null; }
    };

    const emails = rows(
      `SELECT e.message_id AS id, e.subject AS title, e.web_link AS url,
              COALESCE(e.received_at, e.sent_at) AS date,
              e.from_name, e.from_address, e.to_json, e.cc_json
       FROM active_emails e
       WHERE EXISTS (SELECT 1 FROM active_email_customer_links l
                      WHERE l.message_id = e.message_id AND l.match_method <> 'ai-rejected')
         AND (lower(e.from_address) = ?
              OR lower(e.to_json) LIKE ? ESCAPE '\\'
              OR lower(e.cc_json) LIKE ? ESCAPE '\\')
       ORDER BY (date IS NULL), date DESC
       LIMIT ?`,
      [email, like, like, limit],
    );
    const meetings = rows(
      `SELECT e.event_id AS id, e.subject AS title, e.web_link AS url, e.start_at AS date,
              e.organizer_name, e.organizer_address, e.attendees_json
       FROM active_meetings e
       WHERE EXISTS (SELECT 1 FROM active_meeting_customer_links l
                      WHERE l.event_id = e.event_id AND l.match_method <> 'ai-rejected')
         AND (lower(e.organizer_address) = ? OR lower(e.attendees_json) LIKE ? ESCAPE '\\')
       ORDER BY (date IS NULL), date DESC
       LIMIT ?`,
      [email, like, limit],
    );
    const chats = rows(
      `SELECT c.chat_id AS id, COALESCE(NULLIF(c.topic,''), 'Teams chat') AS title,
              c.last_message_at AS date, c.raw_json AS chat_raw_json
       FROM active_teams_chats c
       WHERE EXISTS (SELECT 1 FROM active_teams_chat_customer_links l
                      WHERE l.chat_id = c.chat_id AND l.match_method <> 'ai-rejected')
         AND lower(c.raw_json) LIKE ? ESCAPE '\\'
       ORDER BY (date IS NULL), date DESC
       LIMIT ?`,
      [like, limit],
    );

    // Every medium is optional (tables may be absent on an older/org build). Only
    // when ALL THREE are unavailable is there genuinely no pipeline — say so rather
    // than implying the person simply has no customer activity.
    if (emails === null && meetings === null && chats === null) {
      return {
        ok: false,
        error: 'No ingested email, meeting, or Teams data is available on this machine yet. Run an M365 ingest in Settings.',
      };
    }

    // Customer-side contacts, derived from the same items so every name is backed
    // by a real interaction. Microsoft-internal participants are excluded.
    const contacts = new Map();
    const noteContact = (value) => {
      const participant = participantFrom(value);
      if (!participant) return;
      const address = String(participant.email || '').toLowerCase();
      if (!address || address === email) return;
      // Same internal-domain rule the relationship graph uses, so a person is never
      // "Microsoft" in one panel and a customer contact in another.
      if (isInternalEmail(address)) return;
      const existing = contacts.get(address);
      if (existing) { existing.sharedEvents += 1; return; }
      contacts.set(address, {
        id: address,
        name: participant.name || address.split('@')[0],
        email: address,
        sharedEvents: 1,
      });
    };

    const items = [];
    for (const row of emails || []) {
      items.push({ id: `email:${row.id}`, kind: 'email', title: row.title || '(no subject)', date: row.date, url: row.url });
      noteContact({ name: row.from_name, email: row.from_address });
      for (const value of [...participantList(row.to_json), ...participantList(row.cc_json)]) noteContact(value);
    }
    for (const row of meetings || []) {
      items.push({ id: `meeting:${row.id}`, kind: 'meeting', title: row.title || '(no subject)', date: row.date, url: row.url });
      noteContact({ name: row.organizer_name, email: row.organizer_address });
      for (const value of participantList(row.attendees_json)) noteContact(value);
    }
    for (const row of chats || []) {
      items.push({ id: `chat:${row.id}`, kind: 'teams', title: row.title, date: row.date, url: null });
      for (const value of collectTeamsMembers(row.chat_raw_json)) noteContact(value);
    }

    items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const customers = Array.from(contacts.values())
      .sort((a, b) => b.sharedEvents - a.sharedEvents || a.name.localeCompare(b.name));

    return {
      ok: true,
      email,
      customers,
      items,
      counts: {
        emails: (emails || []).length,
        meetings: (meetings || []).length,
        chats: (chats || []).length,
        customers: customers.length,
      },
    };
  });

  registerHandler('org-product-search', async (_event, payload = {}) => {
    const description = String(payload.description || '').trim();
    if (description.length < 3) {
      return { ok: false, error: 'Describe the product group you need (at least a few words).' };
    }
    const provider = await resolveChatProvider();
    if (!provider) return { ok: false, error: NO_MODEL_PROVIDER_MESSAGE };
    const runtime = makeAgentRuntime(provider);

    // Pass A — the model proposes job-title prefixes to search the directory.
    let keywords = [];
    try {
      const reply = await runtime.run('org-title-mapper', { input: { description } });
      const parsed = extractJsonBlock(reply.content) || {};
      keywords = Array.isArray(parsed.titleKeywords) ? parsed.titleKeywords : [];
    } catch (err) {
      return { ok: false, error: `Role keyword generation failed: ${err.message || String(err)}` };
    }
    keywords = keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6);
    if (!keywords.length) keywords = [description.split(/\s+/).slice(0, 3).join(' ')];

    // Directory lookup — tenant-wide startswith(jobTitle,...), capped per keyword. The live
    // directory always drives discovery; cached title matches only augment the pool afterwards.
    const poolMap = new Map();
    await Promise.all(keywords.map(async (kw) => {
      const url = `/users?$filter=startswith(jobTitle,'${escapeODataLiteral(kw)}')&$select=${ORG_PERSON_SELECT}&$top=25`;
      try {
        const res = await callGraph(url);
        for (const user of (res.value || [])) {
          const p = projectOrgPerson(user);
          if (p && p.id && !poolMap.has(p.id)) poolMap.set(p.id, p);
        }
      } catch { /* skip this keyword */ }
    }));
    // Write-through: cache everyone the live directory returned for these roles.
    cacheUpsertPeople(Array.from(poolMap.values()));
    // Augment (never replace) the pool with cached specialists the live top-25s may have missed.
    for (const kw of keywords) {
      for (const p of cacheSearchByTitle(kw, 15)) {
        if (p && p.id && !poolMap.has(p.id)) poolMap.set(p.id, p);
      }
    }
    const pool = Array.from(poolMap.values()).slice(0, 120);
    if (!pool.length) {
      return { ok: true, keywords, matches: [], note: 'No directory matches for the suggested roles. Try describing the product differently.' };
    }

    // Pass B — the model narrows the pool to the best-fit people.
    const matches = [];
    try {
      const reply = await runtime.run('org-roster-matcher', { input: { description, pool } });
      const parsed = extractJsonBlock(reply.content) || {};
      const picks = Array.isArray(parsed.matches) ? parsed.matches : [];
      const byId = new Map(pool.map((p) => [p.id, p]));
      for (const pick of picks) {
        const person = byId.get(String(pick.id || '').trim());
        if (person && !matches.some((m) => m.id === person.id)) {
          matches.push({ ...person, reason: String(pick.reason || '').slice(0, 240) });
        }
      }
    } catch (err) {
      return { ok: false, error: `Match selection failed: ${err.message || String(err)}` };
    }
    return { ok: true, keywords, matches, poolSize: pool.length };
  });

  // ── Unified Microsoft Search: account documents (feature 1) ──────────────────
  // Tenant-wide document discovery for a customer — surfaces the decks / QBRs / notes
  // people across the field have created about this account, with author + open link.
  registerHandler('customer-search-documents', async (_event, payload = {}) => {
    const query = String(payload.query || '').trim();
    if (query.length < 2) return { ok: false, error: 'A search term is required.' };
    const size = Math.min(Math.max(Number(payload.size) || 15, 1), 25);
    try {
      const data = await callGraphAction('/search/query', {
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: query },
          from: 0,
          size,
        }],
      });
      const container = data?.value?.[0]?.hitsContainers?.[0] || {};
      const docs = (container.hits || []).map(projectSearchDoc).filter(Boolean);
      return { ok: true, docs, total: container.total ?? docs.length, more: Boolean(container.moreResultsAvailable) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // ── Account-team availability: getSchedule (feature 4) ───────────────────────
  registerHandler('org-get-schedule', async (_event, payload = {}) => {
    const emails = Array.from(new Set(
      (payload.emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
    )).slice(0, 20);
    if (!emails.length) return { ok: false, error: 'At least one attendee email is required.' };
    const timeZone = String(payload.timeZone || 'Eastern Standard Time');
    const interval = Math.min(Math.max(Number(payload.intervalMinutes) || 60, 5), 1440);
    if (!payload.start || !payload.end) return { ok: false, error: 'start and end are required.' };
    try {
      const data = await callGraphAction('/me/calendar/getSchedule', {
        schedules: emails,
        startTime: { dateTime: payload.start, timeZone },
        endTime: { dateTime: payload.end, timeZone },
        availabilityViewInterval: interval,
      });
      const schedules = (data?.value || []).map((s) => ({
        email: s.scheduleId || '',
        availabilityView: s.availabilityView || '',
        error: s.error?.message || null,
        workingHours: s.workingHours || null,
        items: (s.scheduleItems || []).map((it) => ({
          status: it.status || 'unknown',
          subject: it.subject || '',
          start: it.start?.dateTime || '',
          end: it.end?.dateTime || '',
          isPrivate: Boolean(it.isPrivate),
        })),
      }));
      return { ok: true, schedules, timeZone, intervalMinutes: interval };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // ── Account-team availability: findMeetingTimes suggestions (feature 4) ───────
  registerHandler('org-find-meeting-times', async (_event, payload = {}) => {
    const emails = Array.from(new Set(
      (payload.emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
    )).slice(0, 20);
    if (!emails.length) return { ok: false, error: 'At least one attendee email is required.' };
    if (!payload.start || !payload.end) return { ok: false, error: 'start and end are required.' };
    const timeZone = String(payload.timeZone || 'Eastern Standard Time');
    const durationMin = Math.min(Math.max(Number(payload.durationMinutes) || 30, 15), 480);
    const duration = `PT${durationMin}M`;
    try {
      const data = await callGraphAction('/me/findMeetingTimes', {
        attendees: emails.map((address) => ({ type: 'required', emailAddress: { address } })),
        timeConstraint: {
          activityDomain: 'work',
          timeSlots: [{
            start: { dateTime: payload.start, timeZone },
            end: { dateTime: payload.end, timeZone },
          }],
        },
        meetingDuration: duration,
        maxCandidates: Math.min(Math.max(Number(payload.maxCandidates) || 5, 1), 10),
        minimumAttendeePercentage: Number(payload.minimumAttendeePercentage) || 100,
      });
      const suggestions = (data?.meetingTimeSuggestions || []).map((s) => ({
        confidence: s.confidence ?? null,
        start: s.meetingTimeSlot?.start?.dateTime || '',
        end: s.meetingTimeSlot?.end?.dateTime || '',
        timeZone: s.meetingTimeSlot?.start?.timeZone || timeZone,
        availabilityPct: s.attendeeAvailability?.length > 0
          ? Math.round((s.attendeeAvailability.filter((a) => a.availability === 'free').length / s.attendeeAvailability.length) * 100)
          : null,
      }));
      return { ok: true, suggestions, emptyReason: data?.emptySuggestionsReason || null };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  console.log('[app-ipc] IPC handlers registered');
}

module.exports = {
  registerAppIpc,
  seedCachedProfiles,
  runIngestionJob,
  maybeRunScheduledIngestion,
  maybeReconnectWorkIq,
};
