/**
 * MSX CRM helpers — build/validate Dynamics Web API URLs, paths, query and body sizes.
 * Vendored into SE Assist so the app no longer depends on the external msx-helper repo.
 * Self-contained (no imports).
 */
const normalizeCrmUrl = (urlString) => {
  const parsed = new URL(urlString);
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${pathname}`.replace(/\/$/, '');
};

const ensureValidCrmOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return ['https:', 'http:'].includes(url.protocol);
  } catch {
    return false;
  }
};

const buildCrmUrl = (crmUrl, path, query, crmPathPrefix) => {
  const normalized = normalizeCrmUrl(crmUrl);
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const normalizedPath = safePath.replace(crmPathPrefix, '/api/data/v9.2/');
  const url = new URL(`${normalized}${normalizedPath}`);
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
  }
  return url;
};

const validateCrmPath = (path, crmPathPrefix) => {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/')) return false;
  if (!path.startsWith(crmPathPrefix)) return false;
  return true;
};

const validateQueryLength = (query, maxQueryLength) => {
  if (!query) return true;
  try {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      params.set(key, String(value));
    });
    return params.toString().length <= maxQueryLength;
  } catch {
    return false;
  }
};

const validateBodySize = (body, maxBodyLength) => {
  if (body === undefined || body === null) return true;
  try {
    const bodyString = JSON.stringify(body);
    return bodyString.length <= maxBodyLength;
  } catch {
    return false;
  }
};

const createCrmService = ({ crmPathPrefix, maxQueryLength, maxBodyLength }) => {
  return {
    normalizeCrmUrl,
    ensureValidCrmOrigin,
    buildCrmUrl: (crmUrl, path, query) => buildCrmUrl(crmUrl, path, query, crmPathPrefix),
    validateCrmPath: (path) => validateCrmPath(path, crmPathPrefix),
    validateQueryLength: (query) => validateQueryLength(query, maxQueryLength),
    validateBodySize: (body) => validateBodySize(body, maxBodyLength)
  };
};

module.exports = {
  createCrmService,
  normalizeCrmUrl,
  ensureValidCrmOrigin,
  buildCrmUrl,
  validateCrmPath,
  validateQueryLength,
  validateBodySize
};
