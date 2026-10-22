'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isBuiltin } = require('node:module');
const agents = require('../agents');
const prompts = require('../agents/prompts');
const secretaryScan = require('../secretary-scan');
const { secretaryDb, message, storeEmail, addCustomer, markPulled } = require('./secretary-fixture');

const appIpcPath = path.join(__dirname, '..', '..', 'app-ipc.js');
const FOUNDRY_ENV = Object.freeze({
  AI_FOUNDRY_ENDPOINT: 'https://example.openai.azure.com',
  AI_FOUNDRY_DEPLOYMENT: 'foundry-deployment',
  AI_FOUNDRY_API_KEY: 'test-key',
});
const unusedDependencies = new Set([
  './msx-ipc', './acr-ipc', './capacity-ipc', './services/owned-accounts',
  './services/m365-ingest', './services/outlook-link', './services/meeting-transcript', './services/teams-chat-message',
  './services/customer-tasks', './services/meeting-tasks', './services/work-outputs', './services/email-search', './services/work-agent-tools',
  './services/research-dossier', './services/signal-links', './services/workload-suggestion-dedup',
  './services/workload-concept-key', './services/customer-insights', './services/customer-relationship-graph',
  './services/html-render', './services/row-mappers', './services/safe-json', './services/intelligence',
  './services/stakeholder-influence', './services/stakeholder-influence-store',
]);
const databases = [];
after(() => {
  for (const db of databases) db.close();
});

// The pull records its sync time as SQLite CURRENT_TIMESTAMP (UTC, whole seconds, no zone).
const sqliteTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function harness({ signedIn = true, env = {}, pulled = true, prefs = {} } = {}) {
  const handlers = new Map();
  const modelCalls = [];
  const foundryCalls = [];
  const workiqCalls = [];
  const db = secretaryDb();
  databases.push(db);
  addCustomer(db, 'T-1', 'Contoso');
  const pulledAt = sqliteTime(Date.now() - 5 * 60 * 1000);
  if (pulled) {
    storeEmail(db, message('email-1', new Date(Date.now() - 60 * 60 * 1000).toISOString(), {
      conversationId: 'thread-1', subject: 'Review notes',
      body: { contentType: 'text', content: 'Test User, please send the review notes.' },
      bodyPreview: 'Please send the review notes.',
    }));
    markPulled(db, pulledAt);
  }
  const settings = new Map(Object.entries({ autoIngestEnabled: true, autoIngestIntervalMin: 60, ...prefs }));
  // Any WorkIQ method Secretary might call is recorded and fails, so a live mailbox read cannot pass unnoticed.
  const workiqClient = new Proxy({}, {
    get: (_target, name) => (typeof name !== 'string' || name === 'then' ? undefined : async (...args) => {
      workiqCalls.push({ name, args });
      throw new Error('Secretary must not read the mailbox through WorkIQ.');
    }),
  });
  const stubs = {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { isPackaged: false } },
    './sqlite-ipc': { openDb: () => db },
    './account-roster': { ...require('../../account-roster'), getEffectiveTpids: () => [] },
    './services/app-prefs': {
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
      set: (key, value) => settings.set(key, value),
    },
    './services/github-auth': { isSignedIn: () => signedIn },
    './services/copilot-provider': {
      probe: async () => ({ ok: true }),
      getModelName: () => 'settings-model',
      chat: async (_system, _user, options) => {
        modelCalls.push(options);
        let content;
        if (options.requestLabel === 'Secretary Search Scope') {
          // The scan fixes "now" before this call, so the resolved window must end before it.
          const until = new Date(Date.now() - 60 * 1000);
          content = { since: new Date(until.getTime() - 2 * 86400000).toISOString(), until: until.toISOString(), label: 'since the offsite' };
        } else {
          content = [{
            title: 'Send the review notes', summary: 'Send the review notes to the sender.', priority: 'high',
            sourceMessageId: 'email-1', ownership: 'direct', owner: 'Test User',
          }];
        }
        return { content: JSON.stringify(content), finishReason: 'stop', model: options.model };
      },
    },
    './services/model-request-scheduler': require('../model-request-scheduler'),
    './services/identity-store': { getSavedName: () => '' },
    './services/workiq-client': { getWorkIqClient: () => workiqClient },
    './services/workiq-auth': { ensureConnected: async () => {
      workiqCalls.push({ name: 'ensureConnected' });
      throw new Error('Secretary must not connect to WorkIQ.');
    } },
    './services/secretary-scan': secretaryScan,
    './services/agents': agents,
    './services/agents/prompts': prompts,
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname: path.dirname(appIpcPath),
    require: name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (unusedDependencies.has(name)) return Object.freeze({});
      if (isBuiltin(name)) return require(name);
      throw new Error(`Unexpected Secretary IPC test dependency: ${name}`);
    },
    process: { env, platform: process.platform, resourcesPath: path.dirname(appIpcPath) },
    URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url) => {
      foundryCalls.push(url);
      throw new Error('Secretary must not call Azure AI Foundry.');
    },
    console: { ...console, log: () => {} },
  };
  vm.runInNewContext(fs.readFileSync(appIpcPath, 'utf8'), context, { filename: appIpcPath });
  module.exports.registerAppIpc();
  const event = { senderFrame: { url: 'http://localhost:5173' } };
  return {
    modelCalls, foundryCalls, workiqCalls, internals: context,
    pulledAt: new Date(`${pulledAt.replace(' ', 'T')}Z`).toISOString(),
    scan: (payload = {}) => handlers.get('se-secretary-scan')(event, { userName: 'Test User', ...payload }),
  };
}

test('actual Secretary IPC runs its scope and scan calls on the pinned Copilot model, never the Settings model', async () => {
  const client = harness({ env: FOUNDRY_ENV });
  const result = await client.scan({ guidance: 'Find todos since the offsite' });
  assert.deepEqual(client.modelCalls.map(call => call.requestLabel), ['Secretary Search Scope', 'Secretary']);
  for (const call of client.modelCalls) {
    assert.equal(call.model, 'gpt-5.6-luna');
    assert.equal(call.reasoningEffort, 'high');
    assert.equal(call.modelPinned, true);
  }
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'github-copilot');
  assert.equal(result.reasoningEffort, 'high');
  assert.deepEqual(result.models, ['gpt-5.6-luna']);
  assert.equal(result.scope.label, 'since the offsite');
  assert.deepEqual(result.items.map(item => item.sourceMessageId), ['email-1']);
  assert.equal(client.foundryCalls.length, 0);
});

test('actual Secretary IPC reads the pulled customer email from SQLite and never reads the mailbox through WorkIQ', async () => {
  const client = harness();
  const result = await client.scan({ guidance: 'Find todos since the offsite' });
  assert.equal(client.workiqCalls.length, 0);
  assert.equal(result.source, 'local-customer-emails');
  assert.equal(result.pulledAt, client.pulledAt);
  assert.equal(result.analyzed, 1);
  assert.deepEqual(result.pullWarnings, []);
  assert.deepEqual(result.items.map(item => [item.sourceMessageId, item.account]), [['email-1', 'Contoso']]);
});

test('actual Secretary IPC passes the saved pull state so a partial or manual-only pull is reported, not hidden', async () => {
  const client = harness({ prefs: {
    autoIngestEnabled: false,
    lastIngestResult: {
      mode: 'manual', ranAt: new Date().toISOString(), errors: [], degraded: false,
      results: [{ medium: 'email', stagedMessages: 1, failedAccounts: [{ account: 'Fabrikam', error: 'WorkIQ timed out' }] }],
    },
  } });
  const result = await client.scan({ guidance: 'Find todos since the offsite' });
  assert.deepEqual(result.pullWarnings, [
    'The latest pull could not search 1 account (Fabrikam); their newest email may be missing.',
    'Automatic background pulls are off, so stored email updates only when you choose Pull new items.',
  ]);
  assert.equal(client.workiqCalls.length, 0);
});

test('actual Secretary IPC fails loudly before any model call when no customer email has been pulled', async () => {
  const client = harness({ pulled: false });
  await assert.rejects(
    client.scan({ guidance: 'Find todos since the offsite' }),
    /Secretary failed: No customer-linked email has been pulled into SE Assist yet\. .*Pull new items/,
  );
  assert.equal(client.modelCalls.length, 0);
  assert.equal(client.workiqCalls.length, 0, 'Secretary must not fall back to reading the mailbox live.');
  assert.equal(client.foundryCalls.length, 0);
});

test('actual Secretary IPC fails loudly without GitHub Copilot instead of running on configured Foundry', async () => {
  const client = harness({ signedIn: false, env: FOUNDRY_ENV });
  await assert.rejects(
    client.scan({ guidance: 'Find todos since the offsite' }),
    /Secretary runs only on GitHub Copilot model "gpt-5\.6-luna" with high reasoning\. Connect GitHub Copilot in User Home → GitHub sign-in\./,
  );
  assert.equal(client.modelCalls.length, 0);
  assert.equal(client.foundryCalls.length, 0);
  assert.equal(client.workiqCalls.length, 0);
});

test('the Foundry path rejects a pinned Copilot-model request instead of substituting its deployment', async () => {
  const client = harness({ signedIn: false, env: FOUNDRY_ENV });
  const config = client.internals.readDesktopFoundryConfig(FOUNDRY_ENV);
  assert.equal(config.enabled, true);
  await assert.rejects(
    client.internals.callScheduledFoundry(config, 'system', 'user', {
      model: 'gpt-5.6-luna', reasoningEffort: 'high', modelPinned: true, requestLabel: 'Secretary',
    }),
    /Secretary runs only on GitHub Copilot model "gpt-5\.6-luna"; the Azure AI Foundry deployment "foundry-deployment" cannot run it\. Connect GitHub Copilot in User Home → GitHub sign-in\./,
  );
  assert.equal(client.foundryCalls.length, 0);
});
