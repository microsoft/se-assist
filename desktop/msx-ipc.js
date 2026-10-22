/**
 * msx-ipc.js — MSX (Dynamics CRM) auth + CRM bridge for SE Assist.
 *
 * Self-contained: imports only the vendored auth/crm services in ./services/.
 * (Previously this depended on the external msx-helper submodule, now removed.)
 *
 * Registers the handful of IPC channels SE Assist's own features use:
 *   ensure-auth, get-auth-status, crm-request.
 * Also exposes getAccessTokenForResource() for app-ipc's Microsoft Graph calls.
 */
const { app, ipcMain } = require("electron");

// ── Import vendored service factories ───────────────────────────────
const { createAuthService } = require("./services/msx-auth");
const { createCrmService } = require("./services/msx-crm");
const { createEntraAuth } = require("./services/entra-auth");
// Persists the signed-in name/UPN to the local SQLite app_settings table so the app
// knows "who you are" across restarts without a network sign-in (offline-friendly).
let identityStore;
try {
  identityStore = require("./services/identity-store");
} catch {
  identityStore = null;
}

// ── Constants ───────────────────────────────────────────────────────
const DEFAULT_CRM_URL = "https://microsoftsales.crm.dynamics.com";
const DEFAULT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CRM_PATH_PREFIX = "/api/data/v9.2/";
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 60 * 1000;
const MAX_CACHE_SIZE = 200;

// ── Helpers ──────────────────────────────────────────────────────────
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const responseCache = new Map();

const createCacheKey = (method, url) => `${method}:${url}`;

const getCachedResponse = (cacheKey) => {
  const cached = responseCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) { responseCache.delete(cacheKey); return null; }
  return cached.data;
};

const setCachedResponse = (cacheKey, data, ttlMs) => {
  if (responseCache.size >= MAX_CACHE_SIZE) {
    responseCache.delete(responseCache.keys().next().value);
  }
  responseCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
};

setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of responseCache) {
    if (now > cached.expiresAt) responseCache.delete(key);
  }
}, 60000).unref();

const parseJsonResponse = async (response) => {
  try { return await response.json(); } catch { return null; }
};

const parseErrorMessage = async (response) => {
  try {
    const data = await response.json();
    return data?.error?.message || data?.message || `HTTP ${response.status}`;
  } catch {
    try { return (await response.text()) || `HTTP ${response.status}`; }
    catch { return `HTTP ${response.status}`; }
  }
};

const getRetryAfterMs = (response) => {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) return null;
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
  const date = Date.parse(retryAfter);
  if (!isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
};

const isAllowedSender = (event) => {
  const senderUrl = event?.senderFrame?.url || "";
  if (senderUrl.startsWith("file://")) return true;
  if (senderUrl.startsWith("http://localhost:")) return true;
  if (senderUrl.startsWith("http://127.0.0.1:")) return true;
  return false;
};

// ── Service initialization ──────────────────────────────────────────
let authService, crmService, entraAuth;

function initMsxServices() {
  entraAuth = createEntraAuth({
    defaultTenantId: DEFAULT_TENANT_ID,
    defaultCrmUrl: DEFAULT_CRM_URL,
  });

  authService = createAuthService({
    defaultCrmUrl: DEFAULT_CRM_URL,
    defaultTenantId: DEFAULT_TENANT_ID,
    entraAuth,
  });

  crmService = createCrmService({
    crmPathPrefix: CRM_PATH_PREFIX,
    maxQueryLength: 4000,
    maxBodyLength: 200000,
  });
}

// ── fetchWithRetry ───────────────────────────────────────────────────
async function fetchWithRetry(url, options, config) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS, cache = false,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS, rawResponse = false,
  } = config || {};

  const method = (options.method || "GET").toUpperCase();
  const isWriteMethod = WRITE_METHODS.has(method);
  const isReadMethod = method === "GET";
  const safeTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
  const safeRetries = Math.min(Math.max(retries, 0), MAX_RETRIES);
  const safeCacheTtl = Math.min(Math.max(cacheTtlMs, 1000), MAX_CACHE_TTL_MS);
  const cacheKey = createCacheKey(method, url);

  if (cache && isReadMethod) {
    const cached = getCachedResponse(cacheKey);
    if (cached) return { ok: true, status: 200, data: cached };
  }

  let attempt = 0;
  let lastError = null;

  while (attempt <= safeRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), safeTimeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = rawResponse ? await response.text() : await parseJsonResponse(response);
        if (cache && isReadMethod && data) setCachedResponse(cacheKey, data, safeCacheTtl);
        return { ok: true, status: response.status, data };
      }

      if (response.status === 401 || response.status === 403) {
        authService.clearAuthCache();
        const errorData = rawResponse ? await response.text() : await parseJsonResponse(response);
        return { ok: false, status: response.status, data: errorData };
      }

      if (response.status === 429) {
        const retryAfterMs = getRetryAfterMs(response);
        if (retryAfterMs !== null && attempt < safeRetries) {
          await delay(retryAfterMs);
          attempt++;
          continue;
        }
      }

      if (!isWriteMethod && RETRYABLE_STATUS.has(response.status) && attempt < safeRetries) {
        await delay(backoffMs * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const message = await parseErrorMessage(response);
      return { ok: false, status: response.status, data: { message } };
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt < safeRetries && (error?.name === "AbortError" || error instanceof TypeError)) {
        await delay(backoffMs * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      return { ok: false, status: 0, data: { message: error?.message || "Network error" } };
    }
  }
  return { ok: false, status: 0, data: { message: lastError?.message || "Request failed" } };
}

// ── fetchCrmWithPaging ──────────────────────────────────────────────
async function fetchCrmWithPaging(url, options, config) {
  const { getAllPages } = config || {};
  const firstResponse = await fetchWithRetry(url, options, config);
  if (!getAllPages || !firstResponse.ok) return firstResponse;

  const aggregated = firstResponse?.data?.value ? [...firstResponse.data.value] : [];
  let nextLink = firstResponse?.data?.["@odata.nextLink"];
  const baseOrigin = new URL(url).origin;

  while (nextLink) {
    const nextUrl = new URL(nextLink);
    if (nextUrl.origin !== baseOrigin) return { ok: false, status: 400, data: { message: "Invalid nextLink origin." } };
    const pageResponse = await fetchWithRetry(nextUrl.toString(), options, { ...config, cache: false });
    if (!pageResponse.ok) return pageResponse;
    if (pageResponse?.data?.value) aggregated.push(...pageResponse.data.value);
    nextLink = pageResponse?.data?.["@odata.nextLink"];
  }
  return { ok: true, status: 200, data: { ...firstResponse.data, value: aggregated } };
}

// ── ensureAuth / getAuthStatus ──────────────────────────────────────
const ensureAuth = async (settings = {}) => {
  const crmUrl = settings.crmUrl || authService.authCache?.crmUrl || DEFAULT_CRM_URL;
  if (!crmService.ensureValidCrmOrigin(crmUrl)) {
    return { success: false, error: "CRM URL must be http or https." };
  }
  return authService.ensureAuth(settings);
};

const getAuthStatus = () => authService.getAuthStatus();

async function getAccessTokenForResource(resource, tenantId = DEFAULT_TENANT_ID) {
  if (!resource) return null;
  const token = await authService.generateAccessToken({ crmUrl: resource, tenantId });
  return {
    token,
    metadata: authService.updateAuthMetadataFromToken(token, resource),
  };
}

// ── CRM request execution (inlined; no telemetry/extensions) ─────────
const ensureAuthenticated = async () => {
  const authStatus = authService.getAuthStatus
    ? authService.getAuthStatus()
    : authService.getCachedAuthStatus?.();
  const needsAuth =
    !authService.authCache.token || authStatus?.isExpired || !authStatus?.isAuthenticated;
  if (needsAuth) {
    const result = await authService.ensureAuth({
      crmUrl: authService.authCache.crmUrl,
      tenantId: authService.authCache.tenantId,
    });
    if (!result?.success || !authService.authCache.token) {
      return { ok: false, status: 401, data: { message: result?.error || "Not authenticated." } };
    }
  }
  return null;
};

const executeCrmRequest = async (payload = {}) => {
  const authFailure = await ensureAuthenticated();
  if (authFailure) return authFailure;

  const method = String(payload.method || "GET").toUpperCase();
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    return { ok: false, status: 400, data: { message: "Invalid HTTP method." } };
  }

  const path = payload.path || "";
  if (!crmService.validateCrmPath(path)) {
    return { ok: false, status: 400, data: { message: "Invalid CRM path." } };
  }

  const isBatchRequest = path.endsWith("/$batch");
  if (payload.rawBody && (!isBatchRequest || method !== "POST")) {
    return { ok: false, status: 400, data: { message: "Raw body is only allowed for $batch POST requests." } };
  }

  if (
    payload.rawBody &&
    payload.contentType &&
    !String(payload.contentType).includes("multipart/mixed")
  ) {
    return { ok: false, status: 400, data: { message: "Invalid content type for $batch request." } };
  }

  if (!crmService.validateQueryLength(payload.query)) {
    return { ok: false, status: 400, data: { message: "Query string too large." } };
  }

  const bodyForValidation = payload.rawBody ?? payload.body;
  if (!crmService.validateBodySize(bodyForValidation)) {
    return { ok: false, status: 400, data: { message: "Body too large." } };
  }

  const url = crmService.buildCrmUrl(authService.authCache.crmUrl, path, payload.query);
  const contentTypeOverride = payload.contentType;
  const headers = {
    Authorization: `Bearer ${authService.authCache.token}`,
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Content-Type": contentTypeOverride || "application/json",
    Accept: "application/json",
    Prefer: 'odata.include-annotations="*"',
    "Cache-Control": "no-cache",
    "If-None-Match": "",
  };

  const options = { method, headers };
  if (payload.rawBody !== undefined && payload.rawBody !== null) {
    options.body = payload.rawBody;
  } else if (payload.body !== undefined && payload.body !== null) {
    options.body = JSON.stringify(payload.body);
  }

  if (payload.rawResponse) {
    return await fetchWithRetry(url.toString(), options, payload);
  }
  return await fetchCrmWithPaging(url.toString(), options, payload);
};

// ── Register IPC handlers used by SE Assist ─────────────────────────
function registerMsxIpcHandlers() {
  // Auth
  ipcMain.handle("ensure-auth", async (event, settings) => {
    if (!isAllowedSender(event)) return { success: false, error: "Unauthorized." };
    return await ensureAuth(settings);
  });
  ipcMain.handle("get-auth-status", async (event) => {
    if (!isAllowedSender(event)) return { isAuthenticated: false };
    return getAuthStatus();
  });

  // CRM
  ipcMain.handle("crm-request", async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, status: 403, data: { message: "Unauthorized request origin." } };
    return await executeCrmRequest(payload);
  });

  // In-app Microsoft (Entra ID) sign-in — the only auth path.
  ipcMain.handle("entra-sign-in", async (event, settings) => {
    if (!isAllowedSender(event)) return { success: false, error: "Unauthorized." };
    const result = await entraAuth.signIn(settings || {});
    if (result.success) {
      // Warm the CRM token + auth-status metadata so the rest of the app is ready.
      try { await authService.ensureAuth({ crmUrl: DEFAULT_CRM_URL, tenantId: DEFAULT_TENANT_ID }); } catch { /* ignore */ }
      // Persist the freshly signed-in name/UPN to local SQLite so it survives restarts.
      await persistSignedInIdentity();
    }
    return result;
  });

  ipcMain.handle("entra-sign-out", async (event) => {
    if (!isAllowedSender(event)) return { success: false, error: "Unauthorized." };
    authService.clearAuthCache();
    const result = await entraAuth.signOut();
    identityStore?.clearIdentity?.();
    return result;
  });

  ipcMain.handle("entra-status", async (event) => {
    if (!isAllowedSender(event)) return { signedIn: false };
    return await entraAuth.getStatus();
  });
}

// Best-effort synchronous display name for the signed-in Microsoft user, used to
// resolve "you" (e.g. for the AI assistant's milestone lookup) without a hardcoded
// SE_ASSIST_USER_NAME. Falls back to the name persisted in local SQLite from a prior
// sign-in, so it keeps working offline. Returns null when no name is known.
function getSignedInName() {
  let live = null;
  try {
    live = entraAuth ? entraAuth.getSignedInName() : null;
  } catch {
    live = null;
  }

  if (live) return live;
  try {
    return (identityStore?.getSavedName?.() || null) || null;
  } catch {
    return null;
  }
}

function getSignedInIdentity() {
  try {
    const upn = identityStore?.getSavedUpn?.();
    return upn ? String(upn).trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

// Pull the current signed-in name + UPN from the Entra session and persist them to the
// local SQLite app_settings table. Called after every successful interactive sign-in
// and once at startup, so the saved identity is always refreshed from the latest login.
async function persistSignedInIdentity() {
  if (!identityStore || !entraAuth) return;
  try {
    const status = await entraAuth.getStatus();
    if (status && status.signedIn) {
      identityStore.saveIdentity({ displayName: status.displayName, userName: status.userName });
    }
  } catch {
    // ignore — persistence is best-effort and must never block sign-in
  }
}

module.exports = {
  initMsxServices,
  registerMsxIpcHandlers,
  getAccessTokenForResource,
  executeCrmRequest,
  getSignedInName,
  getSignedInIdentity,
  persistSignedInIdentity,
};
