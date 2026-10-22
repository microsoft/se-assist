/**
 * entra-auth.js — in-app Microsoft (Entra ID) sign-in for SE Assist.
 *
 * Replaces the `az login` requirement with an interactive MSAL public-client flow:
 *   - One system-browser sign-in (SSO, no device code) obtains a multi-resource
 *     refresh token, which is then exchanged SILENTLY for per-resource access tokens
 *     (Dynamics CRM and Microsoft Graph) — exactly how the Azure CLI behaves.
 *   - The MSAL token cache is persisted encrypted via safeStorage, so the sign-in
 *     survives app restarts and refreshes itself in the background.
 *
 * By default this reuses the Azure CLI's well-known public client ID, which is a
 * first-party app Dynamics/Graph already honor — so no new app registration or admin
 * consent is needed. Override with SEASSIST_ENTRA_CLIENT_ID if you have a dedicated one.
 */
const { shell } = require('electron');
const secureStore = require('./secure-store');

// Azure CLI public client ID — a first-party Microsoft app trusted by Graph and
// Dynamics. Reusing it mints the same tokens the app already used via `az` today.
const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const CACHE_KEY = 'entra-msal-cache';
const ACCOUNT_KEY = 'entra-account';

const SUCCESS_HTML =
  '<html><body style="font-family:system-ui;background:#1e1e2e;color:#cdd6f4;text-align:center;padding-top:80px">' +
  '<h2>Signed in to SE Assist</h2><p>You can close this tab and return to the app.</p></body></html>';
const ERROR_HTML =
  '<html><body style="font-family:system-ui;background:#1e1e2e;color:#f38ba8;text-align:center;padding-top:80px">' +
  '<h2>Sign-in failed</h2><p>Please return to SE Assist and try again.</p></body></html>';

function normalizeResource(resource) {
  return String(resource || '').replace(/\/+$/, '');
}

const createEntraAuth = ({
  defaultTenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47',
  defaultCrmUrl = 'https://microsoftsales.crm.dynamics.com',
  clientId = process.env.SEASSIST_ENTRA_CLIENT_ID || AZURE_CLI_CLIENT_ID,
} = {}) => {
  let msal = null;
  let pca = null;
  let pcaTenant = null;
  let homeAccountId = secureStore.readJson(ACCOUNT_KEY)?.homeAccountId || null;
  let cachedUserName = secureStore.readJson(ACCOUNT_KEY)?.userName || null;
  // The human display name ("Ni Yao") as it appears on MSX deal teams / milestone
  // owners — distinct from `userName`, which is the UPN/email. Used to resolve "you"
  // for the AI assistant without a hardcoded SE_ASSIST_USER_NAME.
  let cachedDisplayName = secureStore.readJson(ACCOUNT_KEY)?.displayName || null;

  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      const cached = secureStore.readString(CACHE_KEY);
      if (cached) ctx.tokenCache.deserialize(cached);
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        secureStore.writeString(CACHE_KEY, ctx.tokenCache.serialize());
      }
    },
  };

  // Build (or rebuild for a new tenant) the MSAL public client application.
  function getApp(tenantId) {
    const tenant = tenantId || defaultTenantId;
    if (pca && pcaTenant === tenant) return pca;
    if (!msal) msal = require('@azure/msal-node');
    pca = new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
      },
      cache: { cachePlugin },
    });
    pcaTenant = tenant;
    return pca;
  }

  async function resolveAccount(app) {
    const accounts = await app.getTokenCache().getAllAccounts();
    if (!accounts.length) return null;
    const match = homeAccountId
      ? accounts.find((a) => a.homeAccountId === homeAccountId)
      : null;
    return match || accounts[0];
  }

  function rememberAccount(account) {
    if (!account) return;
    homeAccountId = account.homeAccountId;
    cachedUserName = account.username || account.name || cachedUserName;
    // Prefer the display-name claim ("Ni Yao") over the UPN for milestone matching.
    cachedDisplayName = account.name || account.idTokenClaims?.name || cachedDisplayName;
    secureStore.writeJson(ACCOUNT_KEY, { homeAccountId, userName: cachedUserName, displayName: cachedDisplayName });
  }

  // Interactive system-browser sign-in. Resolves once the user completes auth.
  //
  // We acquire the **Dataverse / MSX CRM** scope here, NOT Microsoft Graph. This tenant
  // enforces a Conditional Access "token protection" policy on Graph that rejects the
  // unbound token a loopback public-client flow produces (AADSTS530084). CRM/Dataverse is
  // pre-consented for this first-party client and is not token-protected, so it signs in
  // cleanly — and mail/calendar/Teams now come from WorkIQ (its own auth), so the app does
  // not need a Graph token at all. (Reference: mcaps-microsoft/frontier-solution-engineer,
  // which authorizes Dataverse/Power BI and never Graph for exactly this reason.)
  async function signIn(settings = {}) {
    const tenantId = settings.tenantId || defaultTenantId;
    const resource = normalizeResource(settings.resource || defaultCrmUrl);
    const app = getApp(tenantId);
    try {
      const result = await app.acquireTokenInteractive({
        scopes: [`${resource}/.default`],
        openBrowser: async (url) => { await shell.openExternal(url); },
        successTemplate: SUCCESS_HTML,
        errorTemplate: ERROR_HTML,
      });
      rememberAccount(result.account);
      return { success: true, userName: result.account?.username || result.account?.name || null };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  async function signOut() {
    const app = getApp();
    try {
      const account = await resolveAccount(app);
      if (account) await app.getTokenCache().removeAccount(account);
    } catch {
      // ignore
    }
    homeAccountId = null;
    cachedUserName = null;
    cachedDisplayName = null;
    secureStore.remove(CACHE_KEY);
    secureStore.remove(ACCOUNT_KEY);
    return { success: true };
  }

  // Silently acquire an access token for a resource (CRM or Graph). Throws a tagged
  // error when interaction is required so callers can prompt sign-in or fall back.
  async function getTokenForResource(resource, tenantId) {
    const app = getApp(tenantId);
    const account = await resolveAccount(app);
    if (!account) {
      const err = new Error('Not signed in to Microsoft. Use "Sign in with Microsoft" in Settings.');
      err.code = 'NO_ACCOUNT';
      throw err;
    }
    try {
      const result = await app.acquireTokenSilent({
        account,
        scopes: [`${normalizeResource(resource)}/.default`],
      });
      rememberAccount(result.account || account);
      return result.accessToken;
    } catch (error) {
      const err = new Error(`Microsoft sign-in expired or interaction required: ${error.message || error}`);
      err.code = 'INTERACTION_REQUIRED';
      throw err;
    }
  }

  async function getStatus() {
    try {
      const app = getApp();
      const account = await resolveAccount(app);
      if (!account) return { signedIn: false };
      return {
        signedIn: true,
        userName: account.username || account.name || cachedUserName || null,
        displayName: account.name || account.idTokenClaims?.name || cachedDisplayName || null,
        tenantId: pcaTenant,
        clientId,
      };
    } catch {
      return { signedIn: Boolean(homeAccountId), userName: cachedUserName, displayName: cachedDisplayName };
    }
  }

  // Synchronous best-effort check used to decide token source without awaiting.
  function isSignedInSync() {
    return Boolean(homeAccountId);
  }

  // Synchronous best-effort display name for the signed-in user, as it appears on
  // MSX deal teams / milestone owners. Lets features resolve "you" from the Microsoft
  // sign-in instead of a hardcoded SE_ASSIST_USER_NAME. Falls back to the UPN.
  function getSignedInName() {
    return (cachedDisplayName || cachedUserName || '').trim() || null;
  }

  return { signIn, signOut, getTokenForResource, getStatus, isSignedInSync, getSignedInName };
};

module.exports = { createEntraAuth, AZURE_CLI_CLIENT_ID };
