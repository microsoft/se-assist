'use strict';

const { tokenIdentity } = require('./capacity-query');

const POWERBI_RESOURCE = 'https://analysis.windows.net/powerbi/api';
const DATASET_ID = '8e35b612-23f3-4e65-a55d-d298ac36a7e5';
const MODEL_ID = 6524744;
const METADATA_REPORT_ID = 'e740d5dd-5f0b-40ac-9007-44ba368859a5';
const REPORT_URL =
  'https://msit.powerbi.com/groups/me/orgapps/697b7b0a-9aee-427d-b74f-21c1e4057f26/report/7b40300b-5d07-44ee-8b12-6c0da233d335/2805f3ded0a51517b8c0?experience=power-bi';
const EXECUTE_QUERIES_URL =
  `https://api.powerbi.com/v1.0/myorg/datasets/${DATASET_ID}/executeQueries`;
const METADATA_URL =
  `https://df-msit-scus-redirect.analysis.windows.net/explore/reports/${METADATA_REPORT_ID}/modelsAndExploration`;

const WINDOW_DAYS = 90;
const ENGAGEMENT_MONTHS = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const MAX_DETAIL_ROWS = 50_000;
const MAX_ENGAGEMENT_ROWS = 10_000;

const SOURCE = 'Foundry Deep-Dives · 3P Weekly Tokens';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTpid(value) {
  const tpid = String(value == null ? '' : value).trim();
  if (!/^\d{1,20}$/.test(tpid)) {
    throw new Error('Foundry usage requires a numeric customer TPID.');
  }
  return tpid;
}

function normalizeTpids(values) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const tpids = [];
  for (const value of input) {
    try {
      const tpid = normalizeTpid(value);
      if (!seen.has(tpid)) {
        seen.add(tpid);
        tpids.push(tpid);
      }
    } catch {
      // Invalid roster entries are excluded; an entirely invalid roster fails below.
    }
  }
  if (tpids.length === 0) {
    throw new Error('No valid customer TPIDs are configured. Add accounts in User Home first.');
  }
  return tpids;
}

function daxTpidSet(tpids) {
  return `{${normalizeTpids(tpids).join(',')}}`;
}

function buildPortfolioQuery(tpids) {
  return `
EVALUATE
VAR __StartDate = TODAY() - ${WINDOW_DAYS}
RETURN
TOPN(
  500,
  SUMMARIZECOLUMNS(
    'DimTPID'[TPID],
    'DimTPID'[TPName],
    TREATAS(${daxTpidSet(tpids)}, 'DimTPID'[TPID]),
    FILTER(
      ALL('DimDate'[DATE]),
      'DimDate'[DATE] >= __StartDate && 'DimDate'[DATE] <= TODAY()
    ),
    "Tokens", SUM('FactTokensDaily'[InputPlusOutputTokens]),
    "LastUsageDate", MAX('FactTokensDaily'[DATE]),
    "Subscriptions", DISTINCTCOUNT('FactTokensDaily'[AzSubscriptionGuid]),
    "Models", DISTINCTCOUNT('FactTokensDaily'[ModelKey])
  ),
  [Tokens], DESC,
  'DimTPID'[TPName], ASC
)`;
}

function buildDetailQuery(tpid) {
  return `
EVALUATE
VAR __StartDate = TODAY() - ${WINDOW_DAYS}
RETURN
TOPN(
  ${MAX_DETAIL_ROWS + 1},
  FILTER(
    SUMMARIZECOLUMNS(
      'FactTokensDaily'[Week],
      'FactTokensDaily'[Month],
      'FactTokensDaily'[CloudCustomerGuid],
      'DimSubscription'[AzSubscriptionGuid],
      'FactTokensDaily'[DeploymentRegion],
      'FactTokensDaily'[ProviderType],
      'FactTokensDaily'[Model],
      'FactTokensDaily'[ModelVersion],
      'FactTokensDaily'[OfferingName],
      TREATAS({${normalizeTpid(tpid)}}, 'DimTPID'[TPID]),
      FILTER(
        ALL('DimDate'[DATE]),
        'DimDate'[DATE] >= __StartDate && 'DimDate'[DATE] <= TODAY()
      ),
      "Tokens", SUM('FactTokensDaily'[InputPlusOutputTokens])
    ),
    [Tokens] <> 0
  ),
  'FactTokensDaily'[Week], ASC,
  [Tokens], DESC
)`;
}

function buildEngagementQuery(tpid) {
  return `
EVALUATE
VAR __StartMonth = EDATE(TODAY(), -${ENGAGEMENT_MONTHS})
RETURN
TOPN(
  ${MAX_ENGAGEMENT_ROWS + 1},
  FILTER(
    SUMMARIZECOLUMNS(
      'FoundryCustomerEngagementLevel_CU'[MonthKey],
      'FoundryCustomerEngagementLevel_CU'[CloudCustomerGuid],
      'FoundryCustomerEngagementLevel_CU'[CurrentCategory],
      TREATAS({${normalizeTpid(tpid)}}, 'DimCustomer'[TPID]),
      FILTER(
        ALL('FoundryCustomerEngagementLevel_CU'[MonthKey]),
        'FoundryCustomerEngagementLevel_CU'[MonthKey] >= __StartMonth
      ),
      "CustomerUnits", MAX('FoundryCustomerEngagementLevel_CU'[CurrCU])
    ),
    NOT ISBLANK([CustomerUnits])
  ),
  'FoundryCustomerEngagementLevel_CU'[MonthKey], ASC
)`;
}

function parsePowerBiDate(value) {
  if (!value) return null;
  const match = /^\/Date\((\d+)\)\/$/.exec(String(value));
  if (match) return new Date(Number(match[1])).toISOString();
  const raw = String(value);
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
      ? `${raw}Z`
      : raw,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function responseErrorMessage(body) {
  const details = body?.error?.['pbi.error']?.details;
  const detailed = Array.isArray(details)
    ? details.map((entry) => entry?.detail?.value).find(Boolean)
    : null;
  return body?.error?.message
    || body?.message
    || detailed
    || null;
}

function retryDelay(response, attempt, retryBaseMs) {
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 120_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
  }
  return Math.min(retryBaseMs * (2 ** (attempt - 1)), 30_000);
}

function formatHttpError(status, body) {
  const detail = responseErrorMessage(body);
  if (status === 401 || status === 403) {
    return `Power BI denied access to Foundry Deep-Dives (HTTP ${status})${detail ? `: ${detail}` : ''}. Sign in with Microsoft in User Home, confirm you can open the source report, and connect to corpnet/VPN.`;
  }
  if (status === 404) {
    return `The Foundry Deep-Dives semantic model is unavailable (HTTP 404)${detail ? `: ${detail}` : ''}. The report may have been republished and its model identifiers need updating.`;
  }
  return `Power BI could not load Foundry Deep-Dives (HTTP ${status})${detail ? `: ${detail}` : ''}.`;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function textValue(value) {
  return value == null ? '' : String(value);
}

function uniqueCount(rows, key) {
  return new Set(rows.map((row) => row[key]).filter(Boolean)).size;
}

function createFoundryUsageService({
  getPowerBiToken,
  fetchImpl = global.fetch,
  now = Date.now,
  sleepFn = delay,
  cacheTtlMs = CACHE_TTL_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryBaseMs = RETRY_BASE_MS,
} = {}) {
  if (typeof getPowerBiToken !== 'function') {
    throw new Error('createFoundryUsageService: getPowerBiToken function is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createFoundryUsageService: fetch implementation is required.');
  }

  const cache = new Map();
  const inFlight = new Map();

  async function requestJson(url, options, operation) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        const text = await response.text();
        clearTimeout(timeout);
        let body = text;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          // Preserve non-JSON response text for the surfaced error.
        }
        if (response.ok) return body;
        if ([429, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
          await sleepFn(retryDelay(response, attempt, retryBaseMs));
          continue;
        }
        throw new Error(formatHttpError(response.status, body));
      } catch (error) {
        clearTimeout(timeout);
        if (error?.name === 'AbortError') {
          lastError = new Error(`${operation} timed out after ${Math.round(requestTimeoutMs / 1000)} seconds.`);
        } else {
          lastError = error;
        }
        const code = error?.cause?.code || error?.code;
        const retryableConnection = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
        if ((retryableConnection || error?.name === 'AbortError') && attempt < maxAttempts) {
          await sleepFn(retryBaseMs * attempt);
          continue;
        }
        break;
      }
    }
    if (lastError?.cause || /fetch failed|ENOTFOUND|ECONN/i.test(lastError?.message || '')) {
      throw new Error(`Cannot reach the Foundry Deep-Dives Power BI model. Connect to corpnet/VPN and retry. ${lastError.message}`);
    }
    throw lastError || new Error(`${operation} failed.`);
  }

  async function executeDax(token, query, operation) {
    const body = await requestJson(
      EXECUTE_QUERIES_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          queries: [{ query }],
          serializerSettings: { includeNulls: false },
        }),
      },
      operation,
    );
    const resultError = body?.results?.[0]?.error;
    if (resultError) {
      throw new Error(`${operation} failed: ${resultError.message || JSON.stringify(resultError)}`);
    }
    const rows = body?.results?.[0]?.tables?.[0]?.rows;
    if (!Array.isArray(rows)) {
      throw new Error(`${operation} returned an invalid Power BI result.`);
    }
    return rows;
  }

  async function readModelFreshness(token) {
    const body = await requestJson(
      METADATA_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://msit.powerbi.com',
          Referer: 'https://msit.powerbi.com/',
          'X-PowerBI-HostEnv': 'Embed for Organization',
        },
      },
      'Foundry semantic-model freshness check',
    );
    const model = Array.isArray(body?.models)
      ? body.models.find((candidate) => (
        Number(candidate.id) === MODEL_ID && candidate.dbName === DATASET_ID
      ))
      : null;
    if (!model) {
      throw new Error('Power BI did not return freshness metadata for the expected Foundry semantic model.');
    }
    const sourceRefreshedAt = parsePowerBiDate(model.lastRefreshTime || model.LastRefreshTime);
    if (!sourceRefreshedAt) {
      throw new Error('Power BI returned the Foundry model without a valid last-refresh timestamp.');
    }
    return sourceRefreshedAt;
  }

  async function readFreshnessSafely(token) {
    try {
      return {
        sourceRefreshedAt: await readModelFreshness(token),
        sourceRefreshError: null,
      };
    } catch (error) {
      return {
        sourceRefreshedAt: null,
        sourceRefreshError: error.message || String(error),
      };
    }
  }

  async function cachedLoad({ key, force, loader }) {
    if (force) cache.delete(key);
    const cached = cache.get(key);
    if (cached && now() - cached.cachedAt < cacheTtlMs) return cached.data;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = loader();
    inFlight.set(key, task);
    try {
      const data = await task;
      cache.set(key, { cachedAt: now(), data });
      return data;
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
    }
  }

  async function getPortfolio({ tpids, force = false } = {}) {
    const normalizedTpids = normalizeTpids(tpids);
    const token = await getPowerBiToken();
    if (!token) {
      throw new Error('Could not acquire a Power BI token. Sign in with Microsoft in User Home and ensure you are on corpnet/VPN.');
    }
    const identity = tokenIdentity(token);
    const key = identity ? `${identity}:portfolio:${normalizedTpids.join(',')}` : null;
    const load = async () => {
      const [rows, freshness] = await Promise.all([
        executeDax(token, buildPortfolioQuery(normalizedTpids), 'Foundry portfolio query'),
        readFreshnessSafely(token),
      ]);
      const customers = rows
        .map((row) => ({
          tpid: textValue(row['DimTPID[TPID]']),
          customerName: textValue(row['DimTPID[TPName]']) || `TPID ${row['DimTPID[TPID]']}`,
          tokens: numberValue(row['[Tokens]']),
          lastUsageAt: parsePowerBiDate(row['[LastUsageDate]']),
          subscriptionCount: numberValue(row['[Subscriptions]']),
          modelCount: numberValue(row['[Models]']),
        }))
        .filter((row) => row.tpid && row.tokens > 0)
        .sort((left, right) => right.tokens - left.tokens || left.customerName.localeCompare(right.customerName));
      return {
        customers,
        totalTokens: customers.reduce((sum, row) => sum + row.tokens, 0),
        fetchedAt: new Date(now()).toISOString(),
        ...freshness,
        source: SOURCE,
        reportUrl: REPORT_URL,
        windowDays: WINDOW_DAYS,
      };
    };
    return key ? cachedLoad({ key, force, loader: load }) : load();
  }

  async function getCustomer({ tpid: rawTpid, force = false } = {}) {
    const tpid = normalizeTpid(rawTpid);
    const token = await getPowerBiToken();
    if (!token) {
      throw new Error('Could not acquire a Power BI token. Sign in with Microsoft in User Home and ensure you are on corpnet/VPN.');
    }
    const identity = tokenIdentity(token);
    const key = identity ? `${identity}:customer:${tpid}` : null;
    const load = async () => {
      const [detailRows, engagementRows, freshness] = await Promise.all([
        executeDax(token, buildDetailQuery(tpid), 'Foundry customer usage query'),
        executeDax(token, buildEngagementQuery(tpid), 'Foundry engagement query'),
        readFreshnessSafely(token),
      ]);
      if (detailRows.length > MAX_DETAIL_ROWS) {
        throw new Error(`Foundry usage returned more than ${MAX_DETAIL_ROWS.toLocaleString()} rows for TPID ${tpid}. Narrow the source report or reduce the rolling window before retrying.`);
      }
      if (engagementRows.length > MAX_ENGAGEMENT_ROWS) {
        throw new Error(`Foundry engagement returned more than ${MAX_ENGAGEMENT_ROWS.toLocaleString()} rows for TPID ${tpid}.`);
      }
      const rows = detailRows
        .map((row) => ({
          week: parsePowerBiDate(row['FactTokensDaily[Week]']),
          month: parsePowerBiDate(row['FactTokensDaily[Month]']),
          cloudCustomerGuid: textValue(row['FactTokensDaily[CloudCustomerGuid]']),
          subscriptionId: textValue(row['DimSubscription[AzSubscriptionGuid]']),
          region: textValue(row['FactTokensDaily[DeploymentRegion]']) || 'Unspecified',
          providerType: textValue(row['FactTokensDaily[ProviderType]']) || 'Unspecified',
          model: textValue(row['FactTokensDaily[Model]']) || 'Unspecified',
          modelVersion: textValue(row['FactTokensDaily[ModelVersion]']) || 'Unspecified',
          offeringName: textValue(row['FactTokensDaily[OfferingName]']) || 'Unspecified',
          tokens: numberValue(row['[Tokens]']),
        }))
        .filter((row) => row.week && row.tokens > 0)
        .sort((left, right) => (
          left.week.localeCompare(right.week)
          || right.tokens - left.tokens
        ));
      const engagement = engagementRows
        .map((row) => ({
          month: parsePowerBiDate(row['FoundryCustomerEngagementLevel_CU[MonthKey]']),
          cloudCustomerGuid: textValue(row['FoundryCustomerEngagementLevel_CU[CloudCustomerGuid]']),
          level: textValue(row['FoundryCustomerEngagementLevel_CU[CurrentCategory]']) || 'Unclassified',
          customerUnits: numberValue(row['[CustomerUnits]']),
        }))
        .filter((row) => row.month && row.cloudCustomerGuid)
        .sort((left, right) => left.month.localeCompare(right.month) || left.level.localeCompare(right.level));
      return {
        tpid,
        rows,
        engagement,
        summary: {
          totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
          subscriptionCount: uniqueCount(rows, 'subscriptionId'),
          modelCount: uniqueCount(rows, 'model'),
          regionCount: uniqueCount(rows, 'region'),
          weekCount: uniqueCount(rows, 'week'),
        },
        fetchedAt: new Date(now()).toISOString(),
        ...freshness,
        source: SOURCE,
        reportUrl: REPORT_URL,
        windowDays: WINDOW_DAYS,
      };
    };
    return key ? cachedLoad({ key, force, loader: load }) : load();
  }

  return { getPortfolio, getCustomer };
}

module.exports = {
  CACHE_TTL_MS,
  DATASET_ID,
  ENGAGEMENT_MONTHS,
  EXECUTE_QUERIES_URL,
  MAX_DETAIL_ROWS,
  METADATA_REPORT_ID,
  METADATA_URL,
  MODEL_ID,
  POWERBI_RESOURCE,
  REPORT_URL,
  SOURCE,
  WINDOW_DAYS,
  buildDetailQuery,
  buildEngagementQuery,
  buildPortfolioQuery,
  createFoundryUsageService,
  normalizeTpid,
  normalizeTpids,
  parsePowerBiDate,
};
