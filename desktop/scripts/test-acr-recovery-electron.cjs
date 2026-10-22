'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', '..');
const requireApp = createRequire(path.join(root, 'desktop', 'acr-ipc.js'));
const report = { scope: 'Real shell webview + production preload + ACR IPC/service + both actual Consumption pages; isolated SQLite and synthetic Power BI responses.', checks: [] };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
let mainWindow;
let guest;
let server;
let db;
let now = new Date('2026-08-15T12:00:00Z');
let overlayResolve;
let holdOverlay = false;
let offline = false;
const requests = [];
global.fetch = async () => { throw new Error('Live network is disabled in the Electron ACR test.'); };
const categories = ['Foundry Models', 'Foundry Tools', 'Azure App Service', 'GitHub', 'SQL Database', 'Analytics', 'Virtual Network', 'Virtual Machines', 'Storage'];
const factRows = categories.flatMap((serviceLevel2, index) => ['FY27-Jul', 'FY27-Aug'].map((fiscalMonth, month) => ({
  tpid: '1', account: 'Test customer', serviceLevel1: 'Test services', serviceLevel2, serviceLevel3: 'Family',
  serviceLevel4: `Product ${index + 1}`, fiscalMonth, acr: (index + 1) * 100 * (month + 1),
})));
const nativeRows = [
  { tpid: '1', account: 'Test customer', fiscalMonth: 'FY27-Jul', acr: 10.12 },
  { tpid: '1', account: 'Test customer', fiscalMonth: 'FY27-Aug', acr: 20.34 },
];
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const card = prefix => `[...document.querySelectorAll('.card')].find(card=>card.querySelector('.card-header-custom')?.textContent.includes(${JSON.stringify(prefix)}))`;
async function js(code) {
  const result = await guest.executeJavaScript(`(() => { try { return (${code}); } catch(error) { return { expressionError:error.message,page:document.body.innerText }; } })()`, true);
  if (result?.expressionError) throw new Error(`${code}\n${result.expressionError}\n${result.page}`);
  return result;
}
async function waitFor(code, name, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (typeof code === 'function' ? code() : await js(code)) return;
    await tick();
  }
  throw new Error(`Timed out: ${name}\n${await js('document.body.innerText')}`);
}
async function expand(title) {
  const button = `[...document.querySelectorAll('button[aria-expanded]')].find(button=>button.textContent.trim().startsWith(${JSON.stringify(title)}))`;
  await waitFor(button, `${title} toggle`);
  await js(`${button}.click()`);
}
async function refresh(title) {
  const button = `[...${card(title)}.querySelectorAll('button')].find(button=>button.textContent==='Refresh chart')`;
  await waitFor(`(() => {
    const target = ${button};
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`, `${title}: refresh enabled and clicked`);
}
function response(query) {
  const adjustment = query.Where.find(item => item.Condition?.In?.Expressions?.[0]?.Column?.Property === 'AdjustmentFlag')
    ?.Condition.In.Values[0][0].Literal.Value;
  assert.ok(["'N/A'", "'XCR - Anthropic'"].includes(adjustment), `Unexpected adjustment scope: ${adjustment}`);
  let filtered = adjustment === "'XCR - Anthropic'" ? nativeRows : factRows;
  const month = query.Where.find(item => item.Condition?.In?.Expressions?.[0]?.Column?.Property === 'FiscalMonth')
    ?.Condition.In.Values[0][0].Literal.Value.replaceAll("'", '');
  if (month) filtered = filtered.filter(row => row.fiscalMonth === month);
  const names = query.Select.map(column => column.NativeReferenceName);
  const dims = query.Select.filter(column => column.Column).map(column => column.NativeReferenceName);
  const grouped = new Map();
  for (const fact of filtered) {
    const key = JSON.stringify(dims.map(dim => fact[dim]));
    if (!grouped.has(key)) grouped.set(key, { ...fact, acr: 0 });
    grouped.get(key).acr += fact.acr;
  }
  let dimension = 0;
  let measure = 0;
  const schema = query.Select.map(column => ({ N: column.Column ? `G${dimension++}` : `M${measure++}` }));
  return {
    status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ results: [{ result: { data: {
      descriptor: { Select: names.map(() => ({})) },
      dsr: { DS: [{ IC: true, PH: [{ DM0: [...grouped.values()].map((row, index) => ({
        ...(index === 0 ? { S: schema } : {}), C: names.map(name => row[name] ?? null),
      })) }] }] },
    } } }] }),
  };
}

async function run() {
  const Database = requireApp('better-sqlite3');
  const { createAcrService } = requireApp('./services/acr-querydata');
  const { ACR_MODEL_ID } = requireApp('./services/acr-schema');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  requireApp('./sqlite-ipc').initSchema(db);
  requireApp('./account-roster').saveRoster(db, ['1']);
  db.prepare('INSERT INTO customers(id,name,tpid,parenting_level) VALUES (?,?,?,?)').run(1, 'Test customer', '1', 861980000);
  db.prepare('INSERT INTO app_settings VALUES (?,?)').run('acr_model_id', String(ACR_MODEL_ID));
  let service;
  const filename = path.join(root, 'desktop', 'acr-ipc.js');
  const module = { exports: {} };
  const stubs = {
    electron: require('electron'),
    './msx-ipc': { getAccessTokenForResource: async () => ({ token: 'synthetic-token' }), getSignedInIdentity: () => 'test-user' },
    './sqlite-ipc': { openDb: () => db },
    './services/acr-request-log': { createAcrFileLogger: () => ({ info() {}, warn() {} }) },
    './services/acr-querydata': {
      POWERBI_RESOURCE: 'https://analysis.windows.net/powerbi/api',
      createAcrService: options => {
        service = createAcrService({
          ...options, clock: () => now, sleepImpl: async () => {},
          fetchImpl: async (_url, options) => {
            const query = JSON.parse(options.body).queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
            const month = query.Where.find(item => item.Condition?.In?.Expressions?.[0]?.Column?.Property === 'FiscalMonth')?.Condition.In.Values[0][0].Literal.Value;
            const cols = query.Select.map(column => column.NativeReferenceName);
            requests.push({ cols, month });
            if (offline) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
            if (holdOverlay && cols.includes('serviceLevel4') && month) return new Promise(resolve => { overlayResolve = () => resolve(response(query)); });
            return response(query);
          },
        });
        return service;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : requireApp(name),
    process, console,
  }, { filename });
  module.exports.registerAcrIpc();
  ipcMain.handle('se-db-query', (_event, sql, params = []) => db.prepare(sql).all(...params));
  ipcMain.handle('se-get-account-roster', () => ({ ok: true, tpids: ['1'] }));
  const beforeArchived = requests.length;
  await assert.rejects(module.exports.getAcrService().getModelMonthlyAcr({
    tpids: ['2'], fiscalYears: ['FY27'], modelLevel: 4,
  }), error => error.code === 'ACCOUNT_ARCHIVED');
  check('Production roster validation rejects archived TPIDs before a data request', requests.length === beforeArchived);
  await module.exports.getAcrService().getModelMonthlyAcr({ tpids: ['1'], fiscalYears: ['FY27'], modelLevel: 4 });
  now = new Date('2026-09-24T12:00:00Z');
  holdOverlay = true;

  const { createServer } = await import(pathToFileURL(path.join(root, 'src', 'frontend', 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  server = await createServer({
    root: path.join(root, 'src', 'frontend'), server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false },
    plugins: [{
      name: 'acr-recovery-tests',
      configureServer(vite) {
        vite.middlewares.use((request, res, next) => {
          if (request.url !== '/__acr-recovery-tests') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><title>ACR recovery tests</title></head><body><div id="root"></div>
            <script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
            <script type="module" src="/tests/acr-recovery-harness.jsx"></script></body></html>`);
        });
      },
    }],
  });
  await server.listen();
  mainWindow = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const attached = new Promise(resolve => mainWindow.webContents.once('did-attach-webview', (_event, contents) => {
    guest = contents;
    resolve();
  }));
  const preload = pathToFileURL(path.join(root, 'desktop', 'se-assist-preload.js')).href;
  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0"><webview style="width:100vw;height:100vh" webpreferences="backgroundThrottling=no" preload="${preload}" src="http://127.0.0.1:5173/__acr-recovery-tests"></webview></body></html>`));
  await attached;
  await waitFor(`document.body.innerText.includes('Test customer')`, 'account page', 60000);
  check('The test renderer is a webview, matching the real desktop shell', guest.getType() === 'webview');
  const sharedBefore = requests.filter(request => request.cols.includes('serviceLevel4')).length;
  await expand('Apps');
  await waitFor(() => Boolean(overlayResolve), 'background month read');
  await waitFor(`${card('Foundry Models')}?.textContent.includes('$100')`, 'cached chart while loading');
  check('Cached closed-month data stays visible while the next month loads', await js(`${card('Foundry Models')}.textContent.includes('$100')`));
  check('ACR progress reaches the guest webview', await js(`Boolean(document.querySelector('.acr-progress'))`));
  check('Four Apps charts share one pending month query', requests.filter(request => request.cols.includes('serviceLevel4')).length === sharedBefore + 1);
  holdOverlay = false;
  overlayResolve();
  await waitFor(`${card('Foundry Models')}?.textContent.includes('$300')`, 'automatic cache update');
  check('Chart updates on background completion without navigation', await js(`${card('Foundry Models')}.textContent.includes('$300') && !${card('Foundry Models')}.textContent.includes('still being prepared')`));
  await waitFor(`document.querySelector('[data-anthropic-total]')?.textContent==='$30.46'`, 'separate native Anthropic total');
  check('Native Anthropic spend renders exact USD without changing ordinary Azure ACR', await js(`document.querySelector('[data-anthropic-total]').textContent==='$30.46' && ${card('Foundry Models')}.textContent.includes('$300')`));
  const afterApps = requests.length;
  await expand('Data');
  await expand('Infra');
  await waitFor(`${card('Storage by product')}?.querySelector('.recharts-wrapper') && ${card('Databases by product')}?.querySelector('.recharts-wrapper')`, 'other category charts');
  check('Data and Infra reuse the same dataset without extra data requests', requests.length === afterApps);
  const chartTitles = ['Foundry Models', 'Foundry Tools', 'Compute services', 'Developer Tools', 'Databases by product', 'Analytics by product', 'VM by product', 'Networking by product', 'Storage by product'];
  await waitFor(chartTitles.map(title => `${card(title)}?.querySelector('.recharts-wrapper')`).join(' && '), 'all nine chart plots');
  check('All nine charts display series rather than transport errors', await js(`!document.body.innerText.includes('Could not load')`));

  await js(`location.hash='#/consumption'`);
  await waitFor(`document.body.innerText.includes('Azure Consumption')`, 'portfolio page');
  await expand('Apps');
  await waitFor(`${card('Foundry Models')}?.querySelector('.recharts-wrapper')`, 'portfolio Apps');
  check('Portfolio page also renders the shared cached Apps data', await js(`${card('Foundry Models')}.textContent.includes('$300')`));
  await waitFor(`document.querySelector('[data-anthropic-total]')?.textContent==='$30.46'`, 'portfolio native spend');
  check('Portfolio and account views retain the same separate native spend', true);

  // Give this already-complete base a current timestamp, so explicit chart refresh exercises a live request.
  const sharedKey = db.prepare('SELECT cache_key FROM acr_row_cache').all().find(row => {
    const spec = JSON.parse(row.cache_key);
    return spec.cols.includes('serviceLevel4') && spec.month === '';
  }).cache_key;
  db.prepare("UPDATE acr_row_cache SET pulled_at='2026-09-24T12:00:00.000Z' WHERE cache_key=?").run(sharedKey);
  service.clearCache();
  offline = true;
  await refresh('Foundry Models');
  await waitFor(`${card('Foundry Models')}?.textContent.includes('ENOTFOUND')`, 'honest refresh failure');
  check('Failed chart refresh preserves data and the original network classification', await js(`${card('Foundry Models')}.textContent.includes('$300') && !${card('Foundry Models')}.textContent.includes('Connect to corpnet/VPN')`));
  await service.waitForBackgroundRefreshes();
  offline = false;
  const beforeRetry = requests.length;
  await refresh('Foundry Models');
  await waitFor(() => requests.length > beforeRetry, 'new live request from chart-local retry');
  check('Chart-local retry issues one new live Power BI request', requests.length === beforeRetry + 1);
  await waitFor(`${card('Foundry Models')}?.textContent.includes('$300') && !${card('Foundry Models')}?.textContent.includes('ENOTFOUND')`, 'recovered chart');
  check('Chart-local refresh recovers data without a whole-page refresh', true);
  check('Current production schema retains valid foreign keys', db.pragma('foreign_key_check').length === 0);
  report.requestCount = requests.length;
  report.ok = true;
}

app.whenReady().then(async () => {
  let code = 0;
  const deadline = setTimeout(() => { console.error('ACR Electron test exceeded 120 seconds.'); app.exit(1); }, 120000);
  try { await run(); }
  catch (error) { report.ok = false; report.error = error.stack; report.requests = requests; console.error(error.stack); code = 1; }
  finally {
    clearTimeout(deadline);
    console.log(JSON.stringify(report, null, 2));
    if (process.env.SE_ASSIST_TEST_REPORT) fs.writeFileSync(process.env.SE_ASSIST_TEST_REPORT, JSON.stringify(report, null, 2));
    mainWindow?.destroy();
    if (server) await server.close();
    db?.close();
    app.exit(code);
  }
}).catch(error => { console.error(error); app.exit(1); });
