'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..', '..');
const { createRequire } = require('node:module');
const requireApp = createRequire(path.join(root, 'desktop', 'app-ipc.js'));
const { copyMilestoneTeamsMessage } = requireApp('./services/teams-chat-message');
const report = {
  environment: 'Actual React chat buttons and production preload with isolated SQLite',
  upstream: 'External opener, directory IPC, and clipboard adapter are scripted. The production message copier is used; no chat is opened or sent and the system clipboard is untouched.',
  checks: [], rendererErrors: [], queryErrors: [],
};
const accountName = 'Contoso & Co + 100% #1? \u6771\u4eac';
const milestoneName = 'Azure & AI + PoC? #1 / 100%';
const recordId = '11111111-2222-3333-4444-555555555555';
const crmBaseUrl = 'https://microsoftsales.crm.dynamics.com';
const roles = [
  ['Cloud and AI Specialist', '  Ada   Marie Lovelace  ', 'ssp@example.test', 'Ada'],
  ['Account Technology Strategist', 'Grace Hopper', 'ats@example.test', 'Grace'],
  ['Account Executive', 'Ren\u00e9 P\u00e9rez', 'ae@example.test', 'Ren\u00e9'],
];
const opened = [];
const copiedMessages = [];
const operations = [];
const directoryQueries = [];
let failOpener = false;
let failClipboard = false;
let dropClipboardHtml = false;
let rejectClipboard = false;
let clipboardData;
let window;
let server;
let db;
let caseId = 0;
global.fetch = async () => { throw new Error('Live network is disabled in the Teams chat test.'); };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => window.webContents.executeJavaScript(`(() => (${code}))()`, true);

async function waitFor(condition, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (typeof condition === 'function' ? condition() : await js(condition)) return;
    await pause(30);
  }
  throw new Error(`Timed out: ${label}\n${await js('document.body.innerText')}`);
}

async function render(kind, overrides = {}) {
  const props = { kind, name: kind === 'account' ? accountName : milestoneName,
    ownerName: 'Avery Quinn', recordId, crmBaseUrl, ...overrides, caseId: String(++caseId) };
  await js(`window.renderTeamsChatTest(${JSON.stringify(props)})`);
  await waitFor(`document.querySelector('[data-test-case="${props.caseId}"]')`, 'new test case rendered');
}

async function click(expression) {
  await waitFor(`${expression} && !${expression}.disabled`, 'chat button enabled');
  await js(`(() => { ${expression}.click(); return true; })()`);
}

async function expectChat(expression, email, message) {
  const before = opened.length;
  await click(expression);
  await waitFor(() => opened.length === before + 1, 'chat URL captured');
  const url = new URL(opened.at(-1));
  assert.equal(url.origin, 'https://teams.microsoft.com');
  assert.equal(url.pathname, '/l/chat/0/0');
  assert.equal(url.searchParams.get('users'), email);
  assert.equal(url.searchParams.get('message'), message);
  assert.deepEqual([...url.searchParams.keys()], message === null ? ['users'] : ['users', 'message']);
}

async function expectMilestoneChat(expression, email, name, link, first = 'Avery') {
  const before = copiedMessages.length;
  const beforeOperations = operations.length;
  await expectChat(expression, email, null);
  await waitFor(`document.querySelector('.eng-detail-owner-note[role="status"]')?.textContent.includes('Formatted message copied')`, 'formatted-message paste instruction');
  assert.equal(copiedMessages.length, before + 1);
  assert.deepEqual(operations.slice(beforeOperations), ['copy', 'open']);
  const message = copiedMessages.at(-1);
  assert.equal(message.text, `Hi ${first}, can we talk about this milestone ${name}. ${link}`);
  const parsed = await js(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(message.html)}, 'text/html');
    const anchor = doc.querySelector('a');
    let clicked = null;
    anchor?.addEventListener('click', event => { event.preventDefault(); clicked = anchor.href; });
    anchor?.click();
    return {
      body: doc.body.textContent, name: anchor?.textContent, href: anchor?.getAttribute('href'),
      links: doc.querySelectorAll('a').length, tags: [...doc.body.querySelectorAll('*')].map(node => node.tagName), clicked,
    };
  })()`);
  assert.deepEqual(parsed, {
    body: `Hi ${first}, can we talk about this milestone ${name}.`,
    name, href: link, links: 1, tags: ['P', 'A'], clicked: link,
  });
}

async function run() {
  const Database = requireApp('better-sqlite3');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  requireApp('./sqlite-ipc').initSchema(db);
  requireApp('./account-roster').saveRoster(db, ['1001']);
  db.prepare('INSERT INTO customers(tpid,name) VALUES (?,?)').run('1001', accountName);
  for (const [role, name, email] of roles) {
    db.prepare('INSERT INTO customer_account_team_roles(tpid,role,person_name,person_email) VALUES (?,?,?,?)')
      .run('1001', role, name, email);
  }
  db.prepare('INSERT INTO org_people(id,display_name,mail) VALUES (?,?,?)')
    .run('owner', 'Avery Quinn', 'owner@example.test');
  ipcMain.handle('se-db-query', (_event, sql, params = []) => {
    try { return db.prepare(sql).all(...params); }
    catch (error) { report.queryErrors.push(error.message); throw error; }
  });
  ipcMain.handle('se-open-external', (_event, url) => {
    operations.push('open');
    if (failOpener) throw new Error('Synthetic Teams opener failure');
    opened.push(url);
    return true;
  });
  ipcMain.handle('se-copy-milestone-teams-message', (_event, payload) => {
    if (rejectClipboard) return { ok: false, error: 'Synthetic clipboard permission failure' };
    return copyMilestoneTeamsMessage(payload, {
      write(data) {
        if (failClipboard) throw new Error('Synthetic clipboard write failure');
        operations.push('copy');
        clipboardData = data;
        copiedMessages.push(data);
      },
      readText: () => clipboardData?.text || '',
      readHTML: () => dropClipboardHtml ? '' : `<meta charset='utf-8'>${clipboardData?.html || ''}`,
    });
  });
  ipcMain.handle('se-milestone-signal-links', () => ({ ok: true, links: [] }));
  ipcMain.handle('org-search-people', (_event, { query }) => {
    directoryQueries.push(query);
    return { ok: true, people: query === 'Directory Owner'
      ? [{ displayName: query, mail: 'directory.owner@example.test' }] : [] };
  });
  const { createServer } = await import(pathToFileURL(path.join(root, 'src', 'frontend', 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  server = await createServer({
    root: path.join(root, 'src', 'frontend'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false },
    plugins: [{
      name: 'teams-chat-test-page',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/__teams-chat-tests') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><title>Teams chat tests</title></head><body><div id="root"></div>
            <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
            <script type="module" src="/tests/teams-chat-harness.jsx"></script></body></html>`);
        });
      },
    }],
  });
  await server.listen();
  window = new BrowserWindow({
    show: false, width: 1300, height: 1000,
    webPreferences: { preload: path.join(root, 'desktop', 'se-assist-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.rendererErrors.push(message); });
  window.webContents.on('render-process-gone', (_event, details) => report.rendererErrors.push(JSON.stringify(details)));
  await window.loadURL('http://127.0.0.1:5173/__teams-chat-tests');
  await waitFor('typeof window.renderTeamsChatTest === "function"', 'test renderer ready');
  const accountButton = index => `[...document.querySelectorAll('.ca-role-cell button')][${index}]`;
  const ownerButton = `document.querySelector('.eng-detail-head-actions .teams-chat-btn')`;
  await render('account');
  await waitFor(`document.querySelectorAll('.ca-role-cell button').length === 3`, 'account roles loaded');
  for (const [index, [role, , email, first]] of roles.entries()) {
    await expectChat(accountButton(index), email, `Hi ${first}, can we talk about ${accountName}?`);
    check(`${role} keeps its Message in Teams label, recipient and exactly URL-encoded account draft`, await js(`${accountButton(index)}.textContent.trim() === 'Message in Teams'`));
  }
  const renamedAccount = 'Renamed & expanded account';
  await render('account', { name: renamedAccount });
  await expectChat(accountButton(0), roles[0][2], `Hi Ada, can we talk about ${renamedAccount}?`);
  check('Changing the selected account name refreshes the draft callback', true);
  let before = opened.length;
  await render('account', { name: '' });
  await click(accountButton(0));
  await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('account has no name')`, 'missing account name reported');
  check('A missing account name blocks an incomplete draft explicitly', opened.length === before);
  await render('account');
  failOpener = true;
  await click(accountButton(0));
  await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Synthetic Teams opener failure')`, 'account opener failure shown');
  failOpener = false;
  check('Account chat opener errors are visible instead of unhandled rejections', opened.length === before);
  db.prepare("UPDATE customer_account_team_roles SET person_name = '' WHERE role = ?").run(roles[0][0]);
  await render('account', { mountKey: 'unnamed-contact' });
  await waitFor(`document.querySelectorAll('.ca-role-cell button').length === 3`, 'unnamed contact loaded');
  await click(accountButton(0));
  await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('contact has no saved name')`, 'missing contact name reported');
  check('A missing contact name blocks an incomplete draft instead of inventing a name or changing the recipient', opened.length === before);
  db.prepare("UPDATE customer_account_team_roles SET person_email = '' WHERE role = ?").run(roles[0][0]);
  await render('account', { mountKey: 'missing-email' });
  await waitFor(`document.querySelectorAll('.ca-role-cell button').length === 2`, 'missing email reflected');
  check('An account role without an email still has no chat launcher', true);
  check('Account-role chats never touch the formatted milestone clipboard action', copiedMessages.length === 0);
  await render('milestone');
  const milestoneLink = `${crmBaseUrl}/main.aspx?etn=msp_engagementmilestone&id=${recordId}&pagetype=entityrecord`;
  check('The milestone action keeps its Message owner label and explicitly explains copying and Ctrl+V', await js(`${ownerButton}.textContent.trim() === 'Message owner' && ${ownerButton}.title.includes('Copy a formatted message') && document.querySelector('.eng-detail-owner-note').textContent.includes('Ctrl+V')`));
  await expectMilestoneChat(ownerButton, 'owner@example.test', milestoneName, milestoneLink);
  check('A milestone copies a real named MSX hyperlink before opening its owner (not the SSP), with no raw markup in the Teams deep link', true);
  const updatedCrmUrl = 'https://other.crm.dynamics.com';
  const updatedName = 'Renamed milestone & follow-up';
  await render('milestone', { name: updatedName, crmBaseUrl: updatedCrmUrl });
  await expectMilestoneChat(ownerButton, 'owner@example.test', updatedName, `${updatedCrmUrl}/main.aspx?etn=msp_engagementmilestone&id=${recordId}&pagetype=entityrecord`);
  check('Changing the milestone name and CRM URL refreshes the copied hyperlink and its callback', true);
  const literalName = 'Scope <b>AI</b> & "data" + 100% \u6771\u4eac';
  await render('milestone', { name: literalName });
  await expectMilestoneChat(ownerButton, 'owner@example.test', literalName, milestoneLink);
  check('Special characters and markup in a milestone name stay literal text inside one clickable link', true);
  for (const [label, overrides] of [['CRM URL', { crmBaseUrl: '' }], ['milestone ID', { recordId: '' }], ['milestone name', { name: '' }]]) {
    before = opened.length;
    const beforeCopies = copiedMessages.length;
    await render('milestone', overrides);
    await click(ownerButton);
    await waitFor(`document.querySelector('.eng-detail-owner-note')?.textContent.includes('milestone name or MSX link is missing')`, `${label} failure shown`);
    check(`A missing ${label} is reported without copying or opening an incomplete milestone draft`, opened.length === before && copiedMessages.length === beforeCopies);
  }
  await render('milestone', { ownerName: 'Unresolvable Owner' });
  await click(ownerButton);
  await waitFor(`document.querySelector('.eng-detail-owner-note')?.textContent.includes("Couldn't find a Teams address")`, 'unresolved owner reported');
  check('An unresolved owner still fails explicitly rather than contacting the SSP', opened.length === before);
  await render('milestone', { ownerName: 'Directory Owner' });
  await expectMilestoneChat(ownerButton, 'directory.owner@example.test', milestoneName, milestoneLink, 'Directory');
  check('Live-directory resolution preserves the formatted message and intended recipient', directoryQueries.includes('Directory Owner'));
  for (const failure of ['write', 'html', 'permission']) {
    await render('milestone');
    before = opened.length;
    failClipboard = failure === 'write';
    dropClipboardHtml = failure === 'html';
    rejectClipboard = failure === 'permission';
    await click(ownerButton);
    const expectedError = failure === 'write' ? 'Synthetic clipboard write failure'
      : failure === 'html' ? 'clipboard did not retain' : 'Synthetic clipboard permission failure';
    await waitFor(`document.querySelector('.eng-detail-owner-note[role="alert"]')?.textContent.includes(${JSON.stringify(expectedError)})`, `${failure} clipboard failure shown`);
    failClipboard = false;
    dropClipboardHtml = false;
    rejectClipboard = false;
    check(`A clipboard ${failure} failure is explicit and blocks opening Teams instead of falling back to plain text`, opened.length === before);
  }
  await render('milestone');
  before = opened.length;
  failOpener = true;
  await click(ownerButton);
  await waitFor(`document.querySelector('.eng-detail-owner-note[role="alert"]')?.textContent.includes('Formatted message copied, but Teams could not open.') && document.querySelector('.eng-detail-owner-note').textContent.includes('Synthetic Teams opener failure')`, 'milestone opener failure shown');
  failOpener = false;
  check('Milestone opener errors distinguish the successful copy from the failed chat opening', opened.length === before);
  const copiesBeforeOpportunities = copiedMessages.length;
  await render('opportunity');
  await expectChat(ownerButton, 'owner@example.test', null);
  check('Opportunity-owner chats remain recipient-only without a milestone message', true);
  await render('opportunity', { crmBaseUrl: '' });
  await expectChat(ownerButton, 'owner@example.test', null);
  check('Opportunity chat still works without a CRM URL', true);
  check('Opportunity Message owner keeps its label and never changes the clipboard', copiedMessages.length === copiesBeforeOpportunities && await js(`${ownerButton}.textContent.includes('Message owner')`));
  await render('milestone');
  window.setSize(720, 1000);
  await waitFor('window.innerWidth <= 720', 'minimum desktop width applied');
  check('The longer milestone action and all header buttons fit at minimum desktop width', await js(`(() => {
    const card = document.querySelector('.eng-detail-card');
    const right = card.getBoundingClientRect().right;
    const buttons = [...document.querySelectorAll('.eng-detail-head-actions button')];
    return buttons.length === 4 && buttons.every(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= card.getBoundingClientRect().left && rect.right <= right;
    });
  })()`));
  window.setSize(1300, 1000);
  await render('milestone', { ownerName: '' });
  check('A record without an owner still has no Message owner button', await js(`${ownerButton} === null`));
  check('No renderer errors or schema/query errors occurred', report.rendererErrors.length === 0 && report.queryErrors.length === 0);
  check('The isolated production schema retains valid foreign keys', db.pragma('foreign_key_check').length === 0);
  report.opened = opened;
  report.copiedMessages = copiedMessages;
  report.directoryQueries = directoryQueries;
}

app.whenReady().then(async () => {
  let exitCode = 0;
  const deadline = setTimeout(() => { console.error('Teams chat tests exceeded the 90-second deadline.'); app.exit(1); }, 90000);
  try { await run(); report.ok = true; }
  catch (error) {
    report.ok = false;
    report.error = error.stack;
    console.error(error.stack);
    if (window && !window.isDestroyed()) report.failurePage = await js('document.body.innerText');
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (process.env.SE_ASSIST_TEST_REPORT) fs.writeFileSync(process.env.SE_ASSIST_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    window?.destroy();
    if (server) await server.close();
    db?.close();
    app.exit(exitCode);
  }
}).catch(error => { console.error(error); app.exit(1); });
