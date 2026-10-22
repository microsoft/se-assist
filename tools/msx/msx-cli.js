#!/usr/bin/env node
/**
 * msx-cli.js — standalone command-line access to MSX / Dataverse (Dynamics CRM),
 * mirroring the SE Assist desktop app's Entra sign-in so the CLI can run the same
 * authenticated Web API calls the app makes.
 *
 * Auth model (identical to desktop/services/entra-auth.js):
 *   - MSAL public client using the Azure CLI's first-party client ID (pre-consented
 *     for Dataverse), tenant 72f988bf… , acquiring a `<crmUrl>/.default` token.
 *   - Uses the INTERACTIVE system-browser (loopback) flow by default — the same as
 *     the desktop app. The system browser carries this device's PRT/compliance
 *     state, so it satisfies Conditional Access "compliant device" policies that
 *     the device-code flow cannot. Pass `--device-code` to force device code.
 *   - The MSAL token cache is persisted to a local file so subsequent runs are
 *     silent until the refresh token expires.
 *
 * ⚠️ The token cache file (.msx-token-cache.json) contains a refresh token. It is
 *    gitignored — never commit it. Use `logout` to wipe it.
 *
 * Requires @azure/msal-node, which is vendored in desktop/node_modules. Run this
 * script with that on the module path (the code below resolves it automatically).
 *
 * Usage:
 *   node tools/msx/msx-cli.js login              Sign in (system browser) and cache the token
 *   node tools/msx/msx-cli.js login --device-code  Sign in via device code instead
 *   node tools/msx/msx-cli.js whoami             Call WhoAmI (proves auth + IP access)
 *   node tools/msx/msx-cli.js status             Show cached account, no network call
 *   node tools/msx/msx-cli.js logout             Delete the cached token
 *   node tools/msx/msx-cli.js get "<path>"       Arbitrary GET, e.g.
 *                                                get "msp_engagementmilestones?\$top=1"
 *   node tools/msx/msx-cli.js create-fields      Dump msp_engagementmilestone attributes
 *                                                that are valid for create (type + required)
 *   node tools/msx/msx-cli.js token              Print a raw access token (for scripting)
 *
 * Env overrides: SEASSIST_CRM_URL, SEASSIST_TENANT_ID, SEASSIST_ENTRA_CLIENT_ID
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

// Resolve @azure/msal-node from the desktop app's node_modules so we don't need a
// second install. Falls back to a normal require if it's on the default path.
function loadMsal() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'desktop', 'node_modules', '@azure', 'msal-node'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  try { return require('@azure/msal-node'); } catch { /* fall through */ }
  console.error(
    'Could not load @azure/msal-node.\n' +
    'Install it in desktop/ first:  cd desktop && npm install\n'
  );
  process.exit(1);
}

const msal = loadMsal();

// ── Configuration (mirrors entra-auth.js defaults) ──────────────────────────
const CRM_URL = (process.env.SEASSIST_CRM_URL || 'https://microsoftsales.crm.dynamics.com').replace(/\/+$/, '');
const TENANT_ID = process.env.SEASSIST_TENANT_ID || '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CLIENT_ID = process.env.SEASSIST_ENTRA_CLIENT_ID || '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // Azure CLI
const API_VERSION = 'v9.2';
const CACHE_FILE = path.resolve(__dirname, '.msx-token-cache.json');
const ACCOUNT_FILE = path.resolve(__dirname, '.msx-account.json');

// ── MSAL setup with file-backed cache ───────────────────────────────────────
const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    try {
      if (fs.existsSync(CACHE_FILE)) ctx.tokenCache.deserialize(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch { /* ignore corrupt cache */ }
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) {
      try {
        fs.writeFileSync(CACHE_FILE, ctx.tokenCache.serialize(), { mode: 0o600 });
      } catch (e) { console.warn('Warning: could not persist token cache:', e.message); }
    }
  },
};

const pca = new msal.PublicClientApplication({
  auth: { clientId: CLIENT_ID, authority: `https://login.microsoftonline.com/${TENANT_ID}` },
  cache: { cachePlugin },
});

const SCOPES = [`${CRM_URL}/.default`];

function readAccountHint() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch { return null; }
}
function writeAccountHint(account) {
  if (!account) return;
  try {
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({
      homeAccountId: account.homeAccountId,
      username: account.username || account.name || null,
      name: account.name || null,
    }, null, 2), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

async function resolveAccount() {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (!accounts.length) return null;
  const hint = readAccountHint();
  const match = hint?.homeAccountId ? accounts.find((a) => a.homeAccountId === hint.homeAccountId) : null;
  return match || accounts[0];
}

async function acquireSilent() {
  const account = await resolveAccount();
  if (!account) return null;
  try {
    const res = await pca.acquireTokenSilent({ account, scopes: SCOPES });
    writeAccountHint(res.account || account);
    return res;
  } catch {
    return null;
  }
}

async function acquireDeviceCode() {
  const res = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (info) => {
      console.log('\n=== Sign in to MSX / Dynamics ===');
      console.log(info.message); // "To sign in, use a web browser to open … and enter the code …"
      console.log('=================================\n');
    },
  });
  writeAccountHint(res.account);
  return res;
}

// Open a URL in the OS default browser (no Electron `shell` here). The system
// browser on a managed Windows device carries the device/PRT state, which is what
// lets interactive sign-in satisfy Conditional Access "compliant device" policies
// that the device-code flow cannot.
function openInBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // Do NOT use `cmd /c start` — cmd splits the URL at its `&` characters, which
      // drops the OAuth `scope`/`redirect_uri` params (→ AADSTS900144). rundll32
      // receives the full URL as a single argv with no shell parsing.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    console.log('Open this URL in your browser to sign in:\n', url);
  }
}

// Interactive loopback sign-in — mirrors desktop/services/entra-auth.js. Opens the
// system browser and listens on a loopback redirect. Preferred over device code
// because it satisfies device-bound Conditional Access policies.
async function acquireInteractive() {
  const res = await pca.acquireTokenInteractive({
    scopes: SCOPES,
    openBrowser: async (url) => { openInBrowser(url); },
    successTemplate:
      '<html><body style="font-family:system-ui;text-align:center;padding-top:80px">' +
      '<h2>Signed in to MSX CLI</h2><p>You can close this tab and return to the terminal.</p></body></html>',
    errorTemplate:
      '<html><body style="font-family:system-ui;text-align:center;padding-top:80px">' +
      '<h2>Sign-in failed</h2><p>Return to the terminal and try again.</p></body></html>',
  });
  writeAccountHint(res.account);
  return res;
}

async function getToken({ interactive = false } = {}) {
  let res = await acquireSilent();
  if (!res && interactive) res = await acquireInteractive();
  if (!res) {
    throw new Error('Not signed in. Run:  node tools/msx/msx-cli.js login');
  }
  return res.accessToken;
}

// ── Dataverse Web API helper ────────────────────────────────────────────────
async function crmGet(relPath, token) {
  const url = `${CRM_URL}/api/data/${API_VERSION}/${String(relPath).replace(/^\/+/, '')}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      Prefer: 'odata.include-annotations="*"',
    },
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdLogin(mode) {
  const existing = await acquireSilent();
  if (existing) {
    console.log(`Already signed in as ${existing.account?.username || existing.account?.name}.`);
    console.log('Run `whoami` to test the connection, or `logout` to switch accounts.');
    return;
  }
  const useDeviceCode = String(mode || '').toLowerCase() === '--device-code';
  console.log(useDeviceCode
    ? 'Starting device-code sign-in (may be blocked by "compliant device" policy)…'
    : 'Opening your browser for interactive sign-in…');
  const res = useDeviceCode ? await acquireDeviceCode() : await acquireInteractive();
  console.log(`\n✅ Signed in as ${res.account?.username || res.account?.name}.`);
  console.log('Token cached at', CACHE_FILE);
}

async function cmdStatus() {
  const account = await resolveAccount();
  if (!account) { console.log('Not signed in.'); return; }
  console.log('Signed in (cached):');
  console.log('  user   :', account.username || account.name);
  console.log('  tenant :', TENANT_ID);
  console.log('  client :', CLIENT_ID);
  console.log('  crmUrl :', CRM_URL);
  console.log('  cache  :', fs.existsSync(CACHE_FILE) ? CACHE_FILE : '(none)');
}

async function cmdLogout() {
  try {
    const account = await resolveAccount();
    if (account) await pca.getTokenCache().removeAccount(account);
  } catch { /* ignore */ }
  for (const f of [CACHE_FILE, ACCOUNT_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
  console.log('Signed out; cached tokens removed.');
}

async function cmdWhoami() {
  const token = await getToken();
  const me = await crmGet('WhoAmI', token);
  console.log('WhoAmI OK ✅');
  console.log(JSON.stringify(me, null, 2));
}

async function cmdToken() {
  process.stdout.write(await getToken());
}

async function cmdGet(relPath) {
  if (!relPath) { console.error('Usage: get "<path>"  e.g. get "msp_engagementmilestones?$top=1"'); process.exit(2); }
  const token = await getToken();
  const data = await crmGet(relPath, token);
  console.log(JSON.stringify(data, null, 2));
}

// Dump every attribute of msp_engagementmilestone that is valid for create, with its
// type and required level, plus the lookup @odata.bind navigation-property names.
async function cmdCreateFields() {
  const token = await getToken();
  const entity = 'msp_engagementmilestone';

  const attrsResp = await crmGet(
    `EntityDefinitions(LogicalName='${entity}')/Attributes` +
    `?$select=LogicalName,SchemaName,AttributeType,IsValidForCreate,RequiredLevel,AttributeOf`,
    token
  );
  const attrs = (attrsResp.value || [])
    .filter((a) => {
      // IsValidForCreate may come back as a plain boolean or a managed-property object.
      const v = typeof a.IsValidForCreate === 'object' ? a.IsValidForCreate?.Value : a.IsValidForCreate;
      return v === true && !a.AttributeOf;
    })
    .map((a) => ({
      logical: a.LogicalName,
      type: a.AttributeType,
      required: (typeof a.RequiredLevel === 'object' ? a.RequiredLevel?.Value : a.RequiredLevel) || 'None',
    }))
    .sort((x, y) => {
      const rank = (r) => (r === 'ApplicationRequired' || r === 'SystemRequired' ? 0 : r === 'Recommended' ? 1 : 2);
      return rank(x.required) - rank(y.required) || x.logical.localeCompare(y.logical);
    });

  // Lookup navigation-property names for @odata.bind
  let rels = [];
  try {
    const relResp = await crmGet(
      `EntityDefinitions(LogicalName='${entity}')/ManyToOneRelationships` +
      `?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity`,
      token
    );
    rels = relResp.value || [];
  } catch (e) {
    console.warn('Could not read relationships:', e.message);
  }
  const bindByAttr = new Map();
  for (const r of rels) bindByAttr.set(r.ReferencingAttribute, { nav: r.ReferencingEntityNavigationPropertyName, target: r.ReferencedEntity });

  console.log(`\n# ${entity} — attributes valid for create (${attrs.length})\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('LOGICAL NAME', 34), pad('TYPE', 18), 'REQUIRED / BIND');
  console.log('-'.repeat(90));
  for (const a of attrs) {
    let extra = a.required;
    if (a.type === 'Lookup' || a.type === 'Owner' || a.type === 'Customer') {
      const b = bindByAttr.get(a.logical);
      if (b) extra += `  → bind: ${b.nav}@odata.bind = /${b.target}s(<id>)`;
    }
    console.log(pad(a.logical, 34), pad(a.type, 18), extra);
  }

  const outFile = path.resolve(__dirname, 'milestone-create-fields.json');
  fs.writeFileSync(outFile, JSON.stringify({ attributes: attrs, relationships: rels }, null, 2));
  console.log(`\nFull detail written to ${outFile}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    switch ((cmd || '').toLowerCase()) {
      case 'login': await cmdLogin(arg); break;
      case 'status': await cmdStatus(); break;
      case 'logout': await cmdLogout(); break;
      case 'whoami': await cmdWhoami(); break;
      case 'token': await cmdToken(); break;
      case 'get': await cmdGet(arg); break;
      case 'create-fields': await cmdCreateFields(); break;
      default:
        console.log('MSX / Dynamics CLI\n');
        console.log('Commands:');
        console.log('  login           Sign in via system browser (interactive) and cache the token');
        console.log('                  add --device-code to use the device-code flow instead');
        console.log('  whoami          Call WhoAmI (proves auth + IP access)');
        console.log('  status          Show the cached account (no network call)');
        console.log('  logout          Delete the cached token');
        console.log('  get "<path>"    Arbitrary GET, e.g. get "msp_engagementmilestones?$top=1"');
        console.log('  create-fields   Dump msp_engagementmilestone attributes valid for create');
        console.log('  token           Print a raw access token (for scripting)');
        console.log('\nEnv overrides: SEASSIST_CRM_URL, SEASSIST_TENANT_ID, SEASSIST_ENTRA_CLIENT_ID');
    }
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.status) console.error('   HTTP', err.status);
    if (err.body && typeof err.body === 'object') console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
}

main();
