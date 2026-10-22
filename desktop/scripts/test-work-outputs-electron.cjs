'use strict';

// Uses real Electron IPC/preload/React and an isolated SQLite DB. Only model and remote services are scripted.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { isBuiltin, createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..', '..');
const requireApp = createRequire(path.join(root, 'desktop', 'app-ipc.js'));
const report = { environment: 'Real Electron + production preload + actual IPC handlers + React output cards + isolated SQLite', upstream: 'Scripted model and WorkIQ/public responses; not a live service benchmark', checks: [] };
const action = {
  title: 'Schedule the review', description: 'Include the architecture team.', owner: 'Ada', ownerStatus: 'confirmed',
  dueDate: '2026-10-02', dueDateConfirmed: true, dependsOn: ['Confirm agenda'], evidence: 'Source email: Ada agreed to arrange the review.',
};
let window;
let server;
let db;
let selectedModelError = false;
let failActions = true;
let hangWriter = false;
const calls = { reads: [], writers: [], queries: [], triages: [], scans: [], web: [], drafts: [], opened: [], connections: 0 };
const rendererErrors = [];
report.rendererErrors = rendererErrors;
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
global.fetch = async () => { throw new Error('Live network is disabled in the Electron output test.'); };

async function js(code) {
  let timer;
  const result = await Promise.race([
    window.webContents.executeJavaScript(`(() => {
      try { return (${code}); }
      catch (error) { return { testExpressionError: error.message, page: document.body.innerText }; }
    })()`, true),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Renderer test expression timed out: ${code}`)), 5000); }),
  ]).finally(() => clearTimeout(timer));
  if (result?.testExpressionError) throw new Error(`Renderer test expression failed: ${code}\n${result.testExpressionError}\n${result.page}`);
  return result;
}
async function waitFor(code, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (typeof code === 'function' ? code() : await js(code)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}\n${await js('document.body.innerText')}\n${rendererErrors.join('\n')}`);
}
const card = title => `document.querySelector('section[aria-label="${title}"]')`;
const button = (title, text) => `[...${card(title)}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const status = title => `${card(title)}?.querySelector('.work-output-status')?.textContent`;
async function click(title, text) {
  await waitFor(`${button(title, text)} && !${button(title, text)}.disabled`, `${title}: ${text} enabled`);
  await js(`${button(title, text)}.click()`);
}
async function value(selector, text) {
  await js(`(() => {
    const input = ${selector};
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(text)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
}

function registerIpc() {
  const file = path.join(root, 'desktop', 'app-ipc.js');
  const unused = new Set([
    './msx-ipc', './acr-ipc', './capacity-ipc', './services/owned-accounts',
    './services/m365-ingest', './services/meeting-transcript', './services/research-dossier',
    './services/signal-links', './services/workload-suggestion-dedup', './services/workload-concept-key',
    './services/customer-insights', './services/customer-relationship-graph', './services/html-render',
    './services/safe-json', './services/intelligence',
  ]);
  const workiq = {
    readTool: async (name, args) => {
      calls.reads.push({ name, args });
      if (name === 'fetch') {
        if (args.entityUrls[0].startsWith('/me/mailFolders/inbox/messages?')) {
          throw new Error('Secretary must read stored email, not the live inbox.');
        }
        const sourceId = decodeURIComponent(args.entityUrls[0].split('/messages/')[1].split('?')[0]);
        if (sourceId === 'source-denied') throw Object.assign(new Error('Synthetic permission denial'), { statusCode: 403, code: 'Forbidden' });
        return { structuredContent: { results: [{ statusCode: 200, data: {
          id: sourceId, subject: 'Synthetic alignment plan', body: { contentType: 'text', content: 'Ada will arrange the review.' },
          webLink: 'https://outlook.office.com/mail/read/test',
        } }] } };
      }
      if (failActions && args.query[0].includes('explicit commitments')) {
        failActions = false;
        throw new Error('Synthetic action search failure');
      }
      return { structuredContent: { 'application/vnd.ms-workiq.retrieval': {
        markdown: 'Scoped evidence for the task.', resultCount: 1, retrievalHits: [],
      } } };
    },
    doAction: async (url, body) => {
      calls.drafts.push({ url, body });
      return { status: 201, data: { id: 'draft-id', webLink: 'https://outlook.office.com/mail/drafts/test' } };
    },
  };
  const stubs = {
    electron: require('electron'),
    './sqlite-ipc': { openDb: () => db },
    './services/app-prefs': { get: (key, fallback) => key === 'autoIngestEnabled' ? true : fallback },
    './services/github-auth': { isSignedIn: () => !selectedModelError },
    './services/identity-store': { getSavedName: () => 'Test user' },
    './services/copilot-provider': {
      probe: async () => ({ ok: true }), getModelName: () => 'electron-test-model',
      chat: async (_system, user, options) => {
        const secretary = ['Secretary', 'Secretary Search Scope'].includes(options.requestLabel);
        assert.equal(options.reasoningEffort, 'high');
        assert.equal(options.model, secretary ? 'gpt-5.6-luna' : options.modelRole === 'utility' ? undefined : 'electron-test-model');
        if (secretary) assert.equal(options.modelPinned, true);
        if (options.requestLabel === 'Secretary Search Scope') {
          calls.scans.push(options.requestLabel);
          return { content: JSON.stringify({
            since: new Date(Date.now() - 2 * 86400000).toISOString(),
            until: new Date(Date.now() - 5000).toISOString(), label: 'since the offsite',
          }), finishReason: 'stop', model: options.model };
        }
        if (options.requestLabel === 'Secretary') {
          calls.scans.push(options.requestLabel);
          const payload = JSON.parse(user.slice(user.indexOf('Emails (JSON):') + 'Emails (JSON):'.length));
          check('The extraction model receives only readable, non-completed messages', payload.emails.length === 3
            && payload.emails.every(email => !['done', 'protected', 'archived'].includes(email.messageId)));
          return { content: JSON.stringify(payload.emails.filter(email => email.messageId !== 'notification').map(email => ({
            title: email.messageId === 'direct' ? 'Send the notes' : 'Confirm the pricing call',
            summary: email.messageId === 'direct' ? 'Send the requested notes.' : 'Account owner is coordinating the open pricing request.',
            priority: 'high', sourceMessageId: email.messageId,
            ownership: email.messageId === 'direct' ? 'direct' : 'shared',
            owner: email.messageId === 'direct' ? 'Test user' : 'Account owner',
          }))), finishReason: 'stop', model: options.model };
        }
        const context = JSON.parse(user);
        if (options.requestLabel === 'Research Gap Triage') {
          calls.triages.push(context);
          return { content: JSON.stringify({
            gaps: context.gaps.map(gap => ({ id: gap.id, kind: 'person', reason: 'The account team must confirm this decision.' })),
            technicalQuestion: null,
          }), finishReason: 'stop', model: 'electron-test-model' };
        }
        if (context.technicalQuestion) {
          calls.queries.push(context);
          return { content: JSON.stringify({ query: 'Official product deployment requirements' }), finishReason: 'stop', model: 'electron-test-model' };
        }
        calls.writers.push(context.area);
        if (hangWriter) {
          return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }
        return {
          content: JSON.stringify({
            content: context.area === 'reply' ? 'Please confirm the review date. Thank you.' : `${context.area}: scoped findings.`,
            gaps: context.area === 'situation' ? ['Review time is unconfirmed.'] : [],
            needsInput: false, actions: context.area === 'actions' ? [action] : [],
          }),
          finishReason: 'stop', model: 'electron-test-model',
        };
      },
    },
    './services/workiq-client': { getWorkIqClient: () => workiq },
    './services/workiq-auth': { ensureConnected: async () => { calls.connections++; return { connected: true }; } },
    './services/work-outputs': {
      createWorkOutputs: options => requireApp('./services/work-outputs').createWorkOutputs({
        ...options,
        webTool: async (name, args) => {
          calls.web.push({ name, args });
          return { structuredContent: { type: 'output_text', text: { value: 'Useful uncited public research.', annotations: [] } } };
        },
      }),
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(file),
    require: name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (unused.has(name)) return Object.freeze({});
      if (isBuiltin(name)) return require(name);
      return requireApp(name);
    },
    process, URL, AbortController, AbortSignal, setTimeout, clearTimeout, console,
  }, { filename: file });
  mod.exports.registerAppIpc();
  ipcMain.handle('se-open-external', (_event, url) => {
    check('Only a valid test draft/source URL reaches the external opener', /^https:\/\/outlook\.office\.com\//.test(url));
    calls.opened.push(url);
    return true;
  });
  ipcMain.handle('se-db-query', (_event, sql, params = []) => db.prepare(sql).all(...params));
}

function seedScanEmails(kind) {
  const ids = ['direct', 'shared', 'notification', 'done', 'protected', 'archived'];
  db.transaction(() => {
    for (const id of ids) {
      db.prepare('DELETE FROM email_customer_links WHERE message_id = ?').run(id);
      db.prepare('DELETE FROM emails WHERE message_id = ?').run(id);
    }
    const bodies = {
      direct: 'Test user, send the requested notes.',
      shared: 'Account owner is coordinating the pending pricing call.',
      notification: 'You have been added to a team.',
      done: 'Previously completed ask.',
      protected: 'Sender has sent you a protected message.\nRead the message\nMicrosoft Purview Message Encryption',
      archived: 'Do not analyze this archived account email.',
    };
    const selected = kind === 'empty' ? [] : kind === 'protected' ? ['protected'] : ids;
    for (const id of selected) {
      const received = new Date(Date.now() - 60000).toISOString();
      const raw = {
        id, conversationId: `thread-${id}`, subject: id,
        from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
        receivedDateTime: received, toRecipients: [], ccRecipients: [],
        body: { contentType: 'text', content: bodies[id] }, webLink: `https://outlook.office.com/mail/read/${id}`,
      };
      db.prepare(`INSERT INTO emails(message_id, conversation_id, subject, from_name, from_address, received_at,
        body_text, body_source, raw_json, web_link, is_customer_related) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
        .run(id, raw.conversationId, id, 'Sender', 'sender@example.com', received, bodies[id], 'body', JSON.stringify(raw), raw.webLink);
      db.prepare('INSERT INTO email_customer_links(message_id, tpid, match_method) VALUES (?,?,?)')
        .run(id, id === 'archived' ? '2002' : '1001', 'manual');
    }
  })();
}

async function run() {
  const Database = requireApp('better-sqlite3');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  requireApp('./sqlite-ipc').initSchema(db);
  requireApp('./account-roster').saveRoster(db, ['1001']);
  db.exec(`
    INSERT INTO customers(tpid,name) VALUES ('1001','Contoso'), ('2002','Archived customer');
    INSERT INTO cached_customer_profiles(id,tpid,display_name,updated_at) VALUES ('p1','1001','Contoso','2026-09-01');
    INSERT INTO workloads(id,title,tpid,account_name) VALUES (1,'Review workload','1001','Contoso');
    INSERT INTO emails(message_id,subject,received_at) VALUES
      ('source-main','Synthetic alignment plan','2026-01-01T10:00:00Z'),
      ('source-no-provider','Synthetic provider case','2026-01-01T10:00:00Z'),
      ('source-denied','Synthetic access case','2026-01-01T10:00:00Z'),
      ('source-archived','Archived source','2026-01-01T10:00:00Z');
    INSERT INTO email_customer_links(message_id,tpid,match_method) VALUES
      ('source-main','1001','manual'), ('source-no-provider','1001','manual'),
      ('source-denied','1001','manual'), ('source-archived','2002','manual');
    INSERT INTO email_triage(conversation_id,status) VALUES ('thread-done','done');
    INSERT INTO app_settings(key,value) VALUES ('signed_in_user_upn','test.user@microsoft.com');
  `);
  db.prepare('INSERT INTO email_sync(scope_key,last_run_at) VALUES (?,?)').run('1001', new Date().toISOString());
  registerIpc();
  const { createServer } = await import(pathToFileURL(path.join(root, 'src', 'frontend', 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  server = await createServer({
    root: path.join(root, 'src', 'frontend'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false },
    plugins: [{
      name: 'work-output-test-page',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/__work-output-tests') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><title>Work output tests</title></head><body><div id="root"></div>
            <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
            <script type="module" src="/tests/work-outputs-harness.jsx"></script></body></html>`);
        });
      },
    }],
  });
  await server.listen();
  window = new BrowserWindow({
    show: false, width: 1300, height: 1000,
    webPreferences: { preload: path.join(root, 'desktop', 'se-assist-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  window.webContents.on('render-process-gone', (_event, details) => { rendererErrors.push(`Renderer process exited: ${JSON.stringify(details)}`); });
  await window.loadURL('http://127.0.0.1:5173/__work-output-tests');
  await waitFor(`${status('Reply draft')}==='Ready with gaps'`, 'default outputs finish');
  check('Current situation succeeds while Action checklist fails independently', await js(`${status('Current situation')}==='Ready with gaps' && ${status('Action checklist')}==='Failed'`));
  check('Reply retains qualification for unavailable action findings', await js(`${card('Reply draft')}.innerText.includes('Action checklist is failed')`));
  check('Technical research is opt-in', calls.web.length === 0 && await js(`${status('Technical recommendation')}==='Not started'`));
  check('Defaults share one exact email read', calls.reads.filter(call => call.name === 'fetch').length === 1);
  await waitFor(`document.querySelector('.work-output-gap-list')?.textContent.includes('Ask a person')`, 'saved gap classification');
  check('Open questions are classified through the current Utility agent contract', calls.triages.length === 1
    && db.prepare("SELECT kind FROM work_output_gaps WHERE text='Review time is unconfirmed.'").get()?.kind === 'person');

  const writersBeforeRetry = calls.writers.length;
  await click('Action checklist', 'Retry this area');
  await waitFor(`${status('Action checklist')}==='Ready with gaps' && ${status('Reply draft')}==='Needs refresh'`, 'area retry and downstream freshness');
  check('Retry reruns only the failed area writer', calls.writers.length === writersBeforeRetry + 1 && calls.writers.at(-1) === 'actions');
  check('Retry does not reread the shared email', calls.reads.filter(call => call.name === 'fetch').length === 1);
  check('Outdated reply cannot be copied or drafted', await js(`${button('Reply draft','Copy')}.disabled && ${button('Reply draft','Open reply-all draft in Outlook')}.disabled`));
  const workSearches = calls.reads.length;
  await click('Reply draft', 'Refresh this area');
  await waitFor(`${status('Reply draft')}==='Ready with gaps'`, 'refresh draft');
  check('Refreshing reply does no new searches', calls.reads.length === workSearches);
  await value(`${card('Reply draft')}.querySelector('input[aria-label="Reply draft focus"]')`, 'Different draft focus');
  check('An edited focus labels the previous result and disables actions before refresh', await js(`${status('Reply draft')}==='Needs refresh' && ${button('Reply draft','Copy')}.disabled`));
  await value(`${card('Reply draft')}.querySelector('input[aria-label="Reply draft focus"]')`, '');
  await click('Reply draft', 'Open reply-all draft in Outlook');
  await waitFor(`${card('Reply draft')}.innerText.includes('nothing was sent automatically')`, 'draft success');
  check('Reply action uses only saved draft text', calls.drafts.length === 1 && calls.drafts[0].body.comment === 'Please confirm the review date. Thank you.');

  await js(`${card('Action checklist')}.querySelector('input[type=checkbox]').click()`);
  await js(`${card('Action checklist')}.querySelector('input[role=combobox][aria-label="Workload"]').click()`);
  await waitFor(`[...document.querySelectorAll('[role=option]')].some(el=>el.textContent.includes('Review workload'))`, 'workload picker');
  await js(`[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes('Review workload')).click()`);
  await click('Action checklist', 'Create selected Tasks');
  await waitFor(`${card('Action checklist')}.innerText.includes('Created as an SE Assist Task.')`, 'Task created');
  const todo = db.prepare('SELECT * FROM cached_customer_todos').get();
  check('Task creation preserves chosen customer/workload and deadline', todo.profile_id === 'p1' && todo.workload_id === 1 && todo.due_at === '2026-10-02');
  check('Created checklist items cannot be submitted twice', await js(`${card('Action checklist')}.querySelector('input[type=checkbox]').disabled`));

  await value(`${card('Technical recommendation')}.querySelector('input[aria-label="Technical recommendation focus"]')`, 'What are the deployment trade-offs?');
  await click('Technical recommendation', 'Generate recommendation');
  await waitFor(`${status('Technical recommendation')}==='Ready with gaps'`, 'technical recommendation');
  check('Only the optional technical output calls public search', calls.web.length === 1 && calls.queries.length === 1);
  check('New technical findings mark the existing reply stale', await js(`${status('Reply draft')}==='Needs refresh'`));
  check('New technical findings also mark the existing action checklist stale', await js(`${status('Action checklist')}==='Needs refresh'`));
  const readsBeforeRefine = calls.reads.length;
  await js(`${card('Current situation')}.querySelector('.work-output-refine summary').click()`);
  await value(`${card('Current situation')}.querySelector('textarea')`, 'Make it shorter.');
  await click('Current situation', 'Apply refinement');
  await waitFor(`${status('Current situation')}==='Ready with gaps' && ${status('Action checklist')}==='Needs refresh'`, 'refinement freshness');
  check('Refinement uses saved evidence only and retains gaps', calls.reads.length === readsBeforeRefine && await js(`${card('Current situation')}.innerText.includes('Review time is unconfirmed.')`));

  const callsBeforeReload = calls.writers.length;
  await window.reload();
  await waitFor(`${status('Action checklist')}==='Needs refresh'`, 'reload saved outputs');
  await new Promise(resolve => setTimeout(resolve, 150));
  check('Reload restores saved findings and Task links without automatically rerunning areas', calls.writers.length === callsBeforeReload && await js(`${card('Action checklist')}.innerText.includes('Created as an SE Assist Task.')`));

  hangWriter = true;
  await click('Reply draft', 'Refresh this area');
  await waitFor(`${status('Reply draft')}==='Working'`, 'active area');
  await click('Reply draft', 'Stop this area');
  await waitFor(`${status('Reply draft')}==='Failed'`, 'cancel retained');
  check('Cancelled output retains previous result and leaves other results present', await js(`${card('Reply draft')}.innerText.includes('Previous result retained') && ${card('Current situation')}.innerText.includes('situation: scoped findings.')`));
  await click('Reply draft', 'Retry this area');
  await waitFor(`${status('Reply draft')}==='Working'`, 'area working before close');
  await js(`document.querySelector('button[aria-label="Close outputs"]').click()`);
  await waitFor(`[...document.querySelectorAll('button')].some(button=>button.textContent==='Reopen saved outputs')`, 'closed panel');
  await js(`[...document.querySelectorAll('button')].find(button=>button.textContent==='Reopen saved outputs').click()`);
  await waitFor(`${status('Reply draft')}==='Failed'`, 'reopened cancelled output');
  check('Closing and immediately reopening retains the cancelled area and saved results', await js(`${card('Current situation')}.innerText.includes('situation: scoped findings.') && ${card('Reply draft')}.innerText.includes('Previous result retained')`));
  hangWriter = false;

  selectedModelError = true;
  const callsBeforeMissingProvider = calls.reads.length;
  await js(`window.selectOutputTestTask('source-no-provider')`);
  await waitFor(`${status('Reply draft')}==='Failed'`, 'missing provider areas');
  check('Missing provider stops research before any remote read', calls.reads.length === callsBeforeMissingProvider);
  check('Missing provider shows actionable sign-in guidance and preserves technical details', await js(`${card('Current situation')}.textContent.includes('runs only on GitHub Copilot')
    && document.querySelector('.work-output-banner').innerText.includes('GitHub Copilot sign-in needed')
    && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Open GitHub sign-in')`));
  selectedModelError = false;
  const denialStart = calls.reads.length;
  await js(`window.selectOutputTestTask('source-denied')`);
  await waitFor(`${status('Reply draft')}==='Failed'`, 'source denial');
  check('A denied source is requested once across the three default areas', calls.reads.length === denialStart + 1);
  check('Blocked area explicitly disables generic retry', await js(`${button('Current situation','Retry this area')}.disabled && ${card('Current situation')}.innerText.includes('Refresh after access is fixed')`));
  const beforeArchivedSource = calls.reads.length;
  await js(`window.selectOutputTestTask('source-archived')`);
  await waitFor(`document.body.innerText.includes('archived accounts')`, 'archived source rejected');
  check('Production roster guards reject archived-only sources before remote research', calls.reads.length === beforeArchivedSource);

  seedScanEmails('mixed');
  const readsBeforeScan = calls.reads.length;
  const connectionsBeforeScan = calls.connections;
  await js(`window.selectOutputTestTask('secretary-scan')`);
  const scanButton = `[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Find all ToDo in the last 24 hours'))`;
  await waitFor(`${scanButton}`, 'scan button');
  await js(`${scanButton}.click()`);
  await waitFor(`document.querySelectorAll('.sec-task').length===2`, 'scan findings');
  check('Secretary distinguishes direct tasks from shared follow-ups', await js(`document.querySelector('.sec-agent-log').innerText.includes('1 direct task and 1 shared follow-up')`));
  check('Protected notice and done exclusion counts are visible', await js(`document.querySelector('.sec-scan-coverage').innerText.includes('3 analyzed') && document.querySelector('.sec-scan-coverage').innerText.includes('1 excluded as done') && document.querySelector('.sec-scan-coverage').innerText.includes('1 email could not be read')`));
  check('Secretary displays the exact pinned model and high reasoning', await js(`document.querySelector('.sec-scan-coverage').innerText.includes('Model: gpt-5.6-luna') && document.querySelector('.sec-scan-coverage').innerText.includes('high reasoning')`));
  await js(`[...document.querySelectorAll('.sec-task')].find(button=>button.textContent.includes('Shared follow-up')).click()`);
  check('Shared item reader preserves the other owner and does not assign the task to the user', await js(`document.querySelector('.sec-ownership-note').textContent.includes('not assigned to you') && document.querySelector('.sec-ownership-note').textContent.includes('Account owner')`));
  await js(`document.querySelector('.sec-unreadable-message button').click()`);
  await waitFor(() => calls.opened.at(-1) === 'https://outlook.office.com/mail/read/protected', 'protected Outlook link');
  check('Protected message action opens its original Outlook URL', calls.opened.at(-1) === 'https://outlook.office.com/mail/read/protected');
  await value(`document.querySelector('textarea[aria-label="Optional Secretary search"]')`, 'Find todos since the offsite');
  await js(`document.querySelector('button[title="Send"]').click()`);
  await waitFor(`document.querySelector('.sec-agent-log').lastElementChild.textContent.includes('Found 1 direct task')
    && document.querySelector('.sec-agent-log').lastElementChild.textContent.includes('since the offsite')`, 'pinned search scope');
  check('Custom Secretary scope also uses the exact pinned model', calls.scans.includes('Secretary Search Scope'));
  seedScanEmails('protected');
  await waitFor(`!${scanButton}.disabled`, 'scan finished');
  await js(`${scanButton}.click()`);
  await waitFor(`document.querySelector('.sec-empty')?.textContent.includes('incomplete coverage')`, 'protected-only scan');
  check('Protected-only inbox does not claim there are no tasks', await js(`document.querySelector('.sec-agent-log').lastElementChild.textContent.includes('Coverage is incomplete') && document.querySelector('.sec-scan-coverage').innerText.includes('0 analyzed')`));
  seedScanEmails('empty');
  await waitFor(`!${scanButton}.disabled`, 'protected-only scan finished');
  await js(`${scanButton}.click()`);
  await waitFor(`document.querySelector('.sec-agent-log').lastElementChild.textContent.includes('No pulled customer email was found')`, 'no stored email in this time range');
  check('An empty stored period is distinguished from unreadable coverage', await js(`!document.querySelector('.sec-unreadable-message')`));
  const modelsBeforeMissingPull = calls.scans.length;
  db.exec('DELETE FROM email_sync');
  await waitFor(`!${scanButton}.disabled`, 'empty period scan finished');
  await js(`${scanButton}.click()`);
  await waitFor(`document.querySelector('.sec-agent-log').lastElementChild.textContent.includes('no record of a completed email pull')`, 'missing pull error');
  check('Missing pull metadata fails before any model call', calls.scans.length === modelsBeforeMissingPull);
  check('Secretary never reads or connects to WorkIQ', calls.reads.length === readsBeforeScan && calls.connections === connectionsBeforeScan);
  check('No renderer errors occurred', rendererErrors.length === 0);
  const latestMigration = Math.max(...fs.readdirSync(path.join(root, 'desktop', 'migrations'))
    .filter(name => /^\d+_.*\.sql$/.test(name)).map(name => Number(name.split('_')[0])));
  check('Production migrations and Task foreign keys remain valid', db.pragma('user_version', { simple: true }) === latestMigration && db.pragma('foreign_key_check').length === 0);
  report.counts = { writers: calls.writers.length, workiqCalls: calls.reads.length, publicCalls: calls.web.length, drafts: calls.drafts.length };
  report.codeHashes = Object.fromEntries([
    'desktop\\app-ipc.js', 'desktop\\se-assist-preload.js', 'desktop\\services\\work-outputs.js',
    'src\\frontend\\src\\components\\WorkOutputsPanel.jsx',
    'desktop\\services\\secretary-scan.js', 'desktop\\services\\email-content.js',
    'src\\frontend\\src\\components\\SecretarySection.jsx',
  ].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}

app.whenReady().then(async () => {
  let exitCode = 0;
  const deadline = setTimeout(() => { console.error('Electron output tests exceeded the 90-second deadline.'); app.exit(1); }, 90000);
  try { await run(); report.ok = true; }
  catch (error) {
    report.ok = false;
    report.error = error.stack;
    console.error(error.stack);
    if (window && !window.isDestroyed()) {
      try { report.failurePage = await js('document.body.innerText'); }
      catch (diagnostic) { report.diagnosticError = diagnostic.stack; console.error(diagnostic.stack); }
    }
    exitCode = 1;
  }
  finally {
    clearTimeout(deadline);
    if (process.env.SE_ASSIST_TEST_REPORT) fs.writeFileSync(process.env.SE_ASSIST_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    window?.destroy();
    if (server) await server.close();
    db?.close();
    app.exit(exitCode);
  }
}).catch(error => { console.error(error); app.exit(1); });
