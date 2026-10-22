/**
 * MSX auth service — acquires Dynamics CRM / Microsoft Graph access tokens from the
 * in-app Microsoft (Entra ID / MSAL) sign-in. This is the only supported auth path:
 * the user signs in once via "Sign in with Microsoft" (Settings → Microsoft 365
 * sign-in) and tokens are minted per-resource from the cached refresh token. There is
 * no Azure CLI (`az login`) fallback — a packaged build needs no CLI and no .env.
 */

const base64UrlDecode = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + (4 - (normalized.length % 4 || 4)) % 4, '=');
  return Buffer.from(padded, 'base64').toString('utf-8');
};

const updateAuthMetadataFromToken = (token, crmUrl) => {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(base64UrlDecode(payload));
    const aud = json.aud || '';
    const exp = json.exp ? Number(json.exp) * 1000 : null;
    const expiresAt = exp ? new Date(exp) : null;
    const minutesRemaining = expiresAt ? Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 60000), 0) : 0;
    return {
      isAuthenticated: true,
      userName: json.name || json.unique_name || json.upn || 'Unknown',
      audience: aud || crmUrl,
      expiresAt,
      minutesRemaining,
      isExpired: expiresAt ? expiresAt <= Date.now() : false,
      isExpiringSoon: minutesRemaining > 0 && minutesRemaining <= 10
    };
  } catch {
    return null;
  }
};

const createAuthService = ({ defaultCrmUrl, defaultTenantId, entraAuth = null }) => {
  const authCache = {
    token: null,
    metadata: null,
    crmUrl: defaultCrmUrl,
    tenantId: defaultTenantId
  };

  const getCachedAuthStatus = () => {
    if (!authCache.metadata) return null;
    return { ...authCache.metadata };
  };

  const clearAuthCache = () => {
    authCache.token = null;
    authCache.metadata = null;
  };

  const generateAccessToken = async (settings = {}) => {
    const crmUrl = settings.crmUrl || authCache.crmUrl || defaultCrmUrl;
    const tenantId = settings.tenantId || authCache.tenantId || defaultTenantId;

    // The in-app Microsoft sign-in (MSAL) mints per-resource tokens (CRM or Graph)
    // silently from the cached refresh token. It is the only auth path. When the user
    // isn't signed in (or the session expired), getTokenForResource throws a clear,
    // actionable error pointing at Settings → Microsoft 365 sign-in — surfaced to the
    // user rather than silently degrading.
    if (!entraAuth) {
      throw new Error('Microsoft sign-in is not available. Restart SE Assist and try again.');
    }
    const token = await entraAuth.getTokenForResource(crmUrl, tenantId);
    if (!token) {
      throw new Error('Not signed in. Sign in with your Microsoft account (Settings → Microsoft 365 sign-in) to connect MSX.');
    }
    return token;
  };

  const ensureAuth = async (settings = {}) => {
    const crmUrl = settings.crmUrl || authCache.crmUrl || defaultCrmUrl;
    const tenantId = settings.tenantId || authCache.tenantId || defaultTenantId;
    try {
      const token = await generateAccessToken({ crmUrl, tenantId });
      authCache.token = token;
      const metadata = updateAuthMetadataFromToken(token, crmUrl);
      authCache.metadata = metadata;
      authCache.crmUrl = crmUrl;
      authCache.tenantId = tenantId;
      return { success: true, metadata };
    } catch (error) {
      authCache.token = null;
      authCache.metadata = null;
      return { success: false, error: error.message };
    }
  };

  const getAuthStatus = () => {
    const metadata = getCachedAuthStatus();
    if (!metadata) {
      return { isAuthenticated: false };
    }
    return metadata;
  };

  return {
    authCache,
    ensureAuth,
    getAuthStatus,
    getCachedAuthStatus,
    clearAuthCache,
    updateAuthMetadataFromToken,
    generateAccessToken
  };
};

module.exports = {
  createAuthService,
  updateAuthMetadataFromToken
};
