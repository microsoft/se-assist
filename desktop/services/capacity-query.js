'use strict';

const { decodeDSRPage } = require('./acr-schema');

const POWERBI_RESOURCE = 'https://analysis.windows.net/powerbi/api';
const CAPACITY_MODEL_ID = 6469177;
const REPORT_BASE_URL =
  'https://msit.powerbi.com/groups/me/orgapps/b78312cf-0ea0-4148-8ce9-ff1d9c4aab17/report/dbcfbd54-9c35-4021-943d-8d2ce16133dc';
const QUERYDATA_URL =
  'https://df-msit-scus-redirect.analysis.windows.net/explore/querydata?synchronous=true';
const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const OPERATION_TIMEOUT_MS = 120 * 1000;
const WINDOW_SIZE = 30000;
const MAX_WINDOWS = 10;
const MAX_CONCURRENT_REQUESTS = 3;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;

const TPM_QUOTA_TYPES = [
  'DataZoneStandard',
  'Standard',
  'GlobalStandard',
];
const PTU_QUOTA_TYPES = [
  'DataZoneProvisionedManaged',
  'GlobalProvisionedManaged',
  'Provisioned',
  'ProvisionedManaged',
];
const SUPPORTED_QUOTA_TYPES = [...TPM_QUOTA_TYPES, ...PTU_QUOTA_TYPES];
const QUOTA_UNITS = ['TPM', 'PTU'];

function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire: () => new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
      } else {
        waiters.push(resolve);
      }
    }),
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else active = Math.max(0, active - 1);
    },
  };
}

const requestGate = createSemaphore(MAX_CONCURRENT_REQUESTS);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function isConnectionError(error) {
  const codes = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  const cause = error?.cause;
  return codes.has(error?.code)
    || codes.has(error?.errno)
    || codes.has(cause?.code)
    || codes.has(cause?.errno);
}

function deadlineError(operationTimeoutMs) {
  const error = new Error(
    `Power BI capacity operation timed out after ${Math.round(operationTimeoutMs / 1000)} seconds.`,
  );
  error.code = 'CAPACITY_DEADLINE';
  return error;
}

function normalizeTpid(value) {
  const tpid = String(value ?? '').trim();
  if (!/^\d+$/.test(tpid)) {
    throw new Error('A numeric customer TPID is required for AI capacity data.');
  }
  return tpid;
}

function normalizeTpids(values) {
  const input = Array.isArray(values) ? values : [values];
  const tpids = [...new Set(
    input
      .filter((value) => value != null && String(value).trim() !== '')
      .map(normalizeTpid),
  )];
  if (tpids.length === 0) {
    throw new Error('At least one numeric customer TPID is required for AI capacity data.');
  }
  if (tpids.length > 500) {
    throw new Error('AI capacity queries support at most 500 customer TPIDs at a time.');
  }
  return tpids.sort((left, right) => Number(left) - Number(right));
}

function reportUrlForTpid(value) {
  const tpid = normalizeTpid(value);
  const filter = encodeURIComponent(`Account/TPID eq '${tpid}'`);
  return `${REPORT_BASE_URL}?experience=power-bi&filter=${filter}`;
}

function column(source, entity, property, name) {
  return {
    source,
    entity,
    property,
    qname: `${entity}.${property}`,
    name,
    isColumn: true,
  };
}

function measure(source, entity, property, name) {
  return {
    source,
    entity,
    property,
    qname: `${entity}.${property}`,
    name,
    isColumn: false,
  };
}

const FIELDS = {
  accountTpid: column('a', 'Account', 'TPID', 'tpid'),
  customerName: column('a', 'Account', 'CustomerName', 'customerName'),
  quotaRawType: column('m', 'aicapacityquota_modelmap', 'Quota_Type', 'quotaRawType'),
  quotaType: column('m', 'aicapacityquota_modelmap', 'Quota_Type_Corr', 'quotaType'),
  model: column('m', 'aicapacityquota_modelmap', 'model', 'model'),
  subscriptionId: column('q', 'aicapacityquota', 'SubscriptionId', 'subscriptionId'),
  location: column('q', 'aicapacityquota', 'Location', 'location'),
  approved: measure('q', 'aicapacityquota', 'Quota Approved', 'approved'),
  deployedPct: measure('q', 'aicapacityquota', '% Deployed', 'deployedPct'),
  globalApproved: measure('q', 'aicapacityquota', 'Approved_GlobalDistro', 'approved'),
  globalDeployed: measure('q', 'aicapacityquota', 'Deployed_GlobalDistro', 'deployed'),

  requestState: column('u', 'UAT_AOAI Triage View', 'State', 'state'),
  requestPriority: column('u', 'UAT_AOAI Triage View', 'Action Priority', 'priority'),
  requestModel: column('u', 'UAT_AOAI Triage View', 'AOAI_Model', 'model'),
  requestedAmount: column('u', 'UAT_AOAI Triage View', 'AOAI_RequestedAmount', 'requestedAmount'),
  approvedAmount: column('u', 'UAT_AOAI Triage View', 'AOAI_Amount', 'approvedAmount'),
  requestedRegion: column('u', 'UAT_AOAI Triage View', 'AOAI_PreferredRegionMultiselect', 'requestedRegion'),
  requestedRegionLegacy: column('u', 'UAT_AOAI Triage View', 'AOAI_PreferredRegion', 'requestedRegionLegacy'),
  approvedRegion: column('u', 'UAT_AOAI Triage View', 'AOAI_ApprovedPrefferedRegion', 'approvedRegion'),
  requestDecision: column('u', 'UAT_AOAI Triage View', 'AOAI_Decision', 'decision'),
  requestedDate: column('u', 'UAT_AOAI Triage View', 'Requested Date', 'requestedDate'),
  actionUrl: column('u', 'UAT_AOAI Triage View', 'DashboardActionLink', 'actionUrl'),

  milestoneId: column('p', 'AI_Milestones', 'CRMEngagementMilestoneID', 'milestoneId'),
  milestoneName: column('p', 'AI_Milestones', 'EngagementMilestoneName', 'name'),
  milestoneStatus: column('p', 'AI_Milestones', 'EngagementMilestoneStatus', 'status'),
  milestoneReason: column('p', 'AI_Milestones', 'EngagementMilestoneStatusReasonField', 'statusReason'),
  milestoneUrl: column('p', 'AI_Milestones', 'MilestoneLink', 'milestoneUrl'),
  totalPipe: measure('p', 'AI_Milestones', 'Total Pipe', 'totalPipe'),
  qualifiedPipe: measure('p', 'AI_Milestones', 'Qualified Pipe', 'qualifiedPipe'),
  blockedPipe: measure('p', 'AI_Milestones', 'Total Blocked Capacity Pipe', 'blockedPipe'),
  blockedCount: measure('p', 'AI_Milestones', '# Blocked Capacity Milestones', 'blockedCount'),
  blockedWithUatPipe: measure(
    'p',
    'AI_Milestones',
    'Total Blocked Capacity Pipe w/ UAT',
    'blockedWithUatPipe',
  ),
  blockedWithUatCount: measure(
    'p',
    'AI_Milestones',
    '# Blocked Capacity Milestones w/ UAT',
    'blockedWithUatCount',
  ),
};

const sourceRef = (source) => ({ SourceRef: { Source: source } });
const columnExpression = (source, property) => ({
  Column: { Expression: sourceRef(source), Property: property },
});
const selectColumn = (field) => ({
  Column: {
    Expression: sourceRef(field.source),
    Property: field.property,
  },
  Name: field.qname,
  NativeReferenceName: field.name,
});
const selectMeasure = (field) => ({
  Measure: {
    Expression: sourceRef(field.source),
    Property: field.property,
  },
  Name: field.qname,
  NativeReferenceName: field.name,
});

function stringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function integerLiteral(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(number)) throw new Error('Power BI integer filter is out of range.');
  return `${number}L`;
}

function inFilter(field, values) {
  return {
    Condition: {
      In: {
        Expressions: [columnExpression(field.source, field.property)],
        Values: values.map((value) => [{ Literal: { Value: value } }]),
      },
    },
  };
}

function notInFilter(field, values) {
  return {
    Condition: {
      Not: {
        Expression: inFilter(field, values).Condition,
      },
    },
  };
}

function buildSemanticQuery({ sources, columns, filters }) {
  return {
    Version: 2,
    From: sources.map(({ name, entity }) => ({ Name: name, Entity: entity, Type: 0 })),
    Select: columns.map((field) => (
      field.isColumn ? selectColumn(field) : selectMeasure(field)
    )),
    Where: filters,
  };
}

function buildRequestBody(spec, restartTokens = null) {
  const projections = spec.columns.map((_, index) => index);
  const window = { Count: WINDOW_SIZE };
  if (restartTokens != null) window.RestartTokens = restartTokens;
  return {
    version: '1.0.0',
    queries: [{
      Query: {
        Commands: [{
          SemanticQueryDataShapeCommand: {
            Query: buildSemanticQuery(spec),
            Binding: {
              Primary: { Groupings: [{ Projections: projections, Subtotal: 0 }] },
              DataReduction: { Primary: { Window: window } },
              Version: 1,
            },
          },
        }],
      },
      QueryId: '',
    }],
    cancelQueries: [],
    modelId: CAPACITY_MODEL_ID,
    userPreferredLocale: 'en-US',
  };
}

function accountFilter(tpids) {
  const values = Array.isArray(tpids) ? tpids : [tpids];
  return inFilter(FIELDS.accountTpid, values.map(stringLiteral));
}

function quotaTypesForUnit(unit) {
  if (unit === 'TPM') return TPM_QUOTA_TYPES;
  if (unit === 'PTU') return PTU_QUOTA_TYPES;
  throw new Error(`Unsupported quota unit: ${unit}`);
}

function supportedQuotaFilter(unit = null) {
  const quotaTypes = unit ? quotaTypesForUnit(unit) : SUPPORTED_QUOTA_TYPES;
  return inFilter(
    FIELDS.quotaRawType,
    quotaTypes.map(stringLiteral),
  );
}

function regionalQuotaSpec(tpid) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.quotaType,
      FIELDS.model,
      FIELDS.location,
      FIELDS.approved,
      FIELDS.deployedPct,
    ],
    filters: [
      accountFilter(tpid),
      supportedQuotaFilter(),
      notInFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function globalQuotaSpec(tpid) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.quotaType,
      FIELDS.model,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [
      accountFilter(tpid),
      supportedQuotaFilter('TPM'),
      inFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function portfolioRegionalSpec(tpids, unit) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.accountTpid,
      FIELDS.customerName,
      FIELDS.model,
      FIELDS.approved,
      FIELDS.deployedPct,
    ],
    filters: [
      accountFilter(tpids),
      supportedQuotaFilter(unit),
      notInFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function portfolioGlobalSpec(tpids) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.accountTpid,
      FIELDS.customerName,
      FIELDS.model,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [
      accountFilter(tpids),
      supportedQuotaFilter('TPM'),
      inFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function portfolioCustomerSpec(tpids, unit) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.accountTpid,
      FIELDS.customerName,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [accountFilter(tpids), supportedQuotaFilter(unit)],
  };
}

function subscriptionRegionalSpec(tpid) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.subscriptionId,
      FIELDS.quotaType,
      FIELDS.model,
      FIELDS.location,
      FIELDS.approved,
      FIELDS.deployedPct,
    ],
    filters: [
      accountFilter(tpid),
      supportedQuotaFilter(),
      notInFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function subscriptionGlobalSpec(tpid) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.subscriptionId,
      FIELDS.quotaType,
      FIELDS.model,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [
      accountFilter(tpid),
      supportedQuotaFilter('TPM'),
      inFilter(FIELDS.quotaType, [stringLiteral('GlobalStandard')]),
    ],
  };
}

function subscriptionSummarySpec(tpid, unit) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.subscriptionId,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [accountFilter(tpid), supportedQuotaFilter(unit)],
  };
}

function summarySpec(tpid, unit) {
  return {
    sources: [
      { name: 'a', entity: 'Account' },
      { name: 'q', entity: 'aicapacityquota' },
      { name: 'm', entity: 'aicapacityquota_modelmap' },
    ],
    columns: [
      FIELDS.accountTpid,
      FIELDS.globalApproved,
      FIELDS.globalDeployed,
    ],
    filters: [accountFilter(tpid), supportedQuotaFilter(unit)],
  };
}

function requestSpec(tpid) {
  return {
    sources: [{ name: 'u', entity: 'UAT_AOAI Triage View' }],
    columns: [
      FIELDS.requestState,
      FIELDS.requestPriority,
      FIELDS.requestModel,
      FIELDS.requestedAmount,
      FIELDS.approvedAmount,
      FIELDS.requestedRegion,
      FIELDS.requestedRegionLegacy,
      FIELDS.approvedRegion,
      FIELDS.requestDecision,
      FIELDS.requestedDate,
      FIELDS.actionUrl,
    ],
    filters: [
      inFilter(
        column('u', 'UAT_AOAI Triage View', 'TPID', 'requestTpid'),
        [stringLiteral(tpid)],
      ),
      notInFilter(
        FIELDS.requestState,
        ['Closed', 'Done', 'Removed', 'Completed'].map(stringLiteral),
      ),
    ],
  };
}

function milestoneSpec(tpid) {
  return {
    sources: [{ name: 'p', entity: 'AI_Milestones' }],
    columns: [
      FIELDS.milestoneId,
      FIELDS.milestoneName,
      FIELDS.milestoneStatus,
      FIELDS.milestoneReason,
      FIELDS.milestoneUrl,
      FIELDS.totalPipe,
      FIELDS.qualifiedPipe,
      FIELDS.blockedPipe,
      FIELDS.blockedCount,
      FIELDS.blockedWithUatPipe,
      FIELDS.blockedWithUatCount,
    ],
    filters: [
      inFilter(
        column('p', 'AI_Milestones', 'TPID', 'milestoneTpid'),
        [integerLiteral(tpid)],
      ),
    ],
  };
}

function parsePage(text, body) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Power BI capacity query returned non-JSON data.');
  }
  const data = parsed?.results?.[0]?.result?.data;
  const dsr = data?.dsr;
  if (!dsr?.DS?.length) {
    if (data?.descriptor) return { PH: [], IC: true };
    const detail = parsed?.error?.message || parsed?.results?.[0]?.error?.message;
    throw new Error(detail || 'Power BI returned an invalid capacity query response.');
  }
  const expected = body?.queries?.[0]?.Query?.Commands?.[0]
    ?.SemanticQueryDataShapeCommand?.Query?.Select?.length ?? 0;
  const actual = data?.descriptor?.Select?.length ?? 0;
  if (expected > 0 && actual !== expected) {
    throw new Error(`Power BI capacity query returned ${actual} columns; expected ${expected}.`);
  }
  return dsr.DS[0];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function tokenIdentity(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const tenant = String(payload.tid || '').trim();
    const account = String(payload.oid || payload.sub || '').trim();
    return tenant && account ? `${tenant}:${account}` : null;
  } catch {
    return null;
  }
}

function quotaUnit(quotaType) {
  return /provisioned/i.test(String(quotaType || '')) ? 'PTU' : 'TPM';
}

function normalizeRegionalQuota(row, unitOverride = null) {
  const approved = numberOrZero(row.approved);
  const deployedPct = numberOrZero(row.deployedPct);
  const deployed = Math.round(approved * deployedPct);
  const unit = unitOverride || quotaUnit(row.quotaType);
  return {
    quotaType: row.quotaType || 'Unspecified',
    unit,
    model: row.model || (unit === 'PTU' ? 'Provisioned capacity' : 'Unspecified'),
    location: row.location || 'Unspecified',
    approved,
    deployed,
    available: Math.max(0, approved - deployed),
    deployedPct,
  };
}

function normalizeGlobalQuota(row) {
  const approved = numberOrZero(row.approved);
  const deployed = numberOrZero(row.deployed);
  return {
    quotaType: row.quotaType || 'GlobalStandard',
    unit: 'TPM',
    model: row.model || 'Unspecified',
    location: 'Global',
    approved,
    deployed,
    available: Math.max(0, approved - deployed),
    deployedPct: approved > 0 ? deployed / approved : 0,
  };
}

function normalizePortfolioRegional(row, unit) {
  return {
    ...normalizeRegionalQuota(row, unit),
    quotaType: 'Regional',
    tpid: String(row.tpid || '').trim(),
    customerName: row.customerName || `TPID ${row.tpid || ''}`,
  };
}

function normalizePortfolioGlobal(row) {
  return {
    ...normalizeGlobalQuota(row),
    tpid: String(row.tpid || '').trim(),
    customerName: row.customerName || `TPID ${row.tpid || ''}`,
  };
}

function normalizeCustomerSummary(row, unit) {
  const approved = numberOrZero(row.approved);
  const deployed = numberOrZero(row.deployed);
  return {
    tpid: String(row.tpid || '').trim(),
    customerName: row.customerName || `TPID ${row.tpid || ''}`,
    unit,
    approved,
    deployed,
    available: Math.max(0, approved - deployed),
    deployedPct: approved > 0 ? deployed / approved : 0,
  };
}

function normalizeSubscriptionRegional(row) {
  return {
    ...normalizeRegionalQuota(row),
    subscriptionId: row.subscriptionId || 'Unmapped subscription',
  };
}

function normalizeSubscriptionGlobal(row) {
  return {
    ...normalizeGlobalQuota(row),
    subscriptionId: row.subscriptionId || 'Unmapped subscription',
  };
}

function aggregateCapacityRows(rows, customerSummaryRows) {
  const modelMap = new Map();
  const customerModels = new Map();
  for (const row of rows) {
    const modelName = row.model || 'Unspecified';
    const modelKey = `${row.unit}:${modelName}`;
    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, {
        unit: row.unit,
        model: modelName,
        approved: 0,
        deployed: 0,
        available: 0,
        customers: new Set(),
      });
    }
    const model = modelMap.get(modelKey);
    model.approved += row.approved;
    model.deployed += row.deployed;
    model.available += row.available;
    if (row.tpid) model.customers.add(row.tpid);

    if (row.tpid) {
      const customerKey = `${row.unit}:${row.tpid}`;
      if (!customerModels.has(customerKey)) customerModels.set(customerKey, new Set());
      customerModels.get(customerKey).add(modelName);
    }
  }

  const models = [...modelMap.values()]
    .map((row) => ({
      unit: row.unit,
      model: row.model,
      approved: row.approved,
      deployed: row.deployed,
      available: row.available,
      deployedPct: row.approved > 0 ? row.deployed / row.approved : 0,
      customerCount: row.customers.size,
    }))
    .sort((left, right) => right.approved - left.approved || left.model.localeCompare(right.model));
  const customers = customerSummaryRows
    .filter((row) => row.tpid && (row.approved !== 0 || row.deployed !== 0))
    .map((row) => ({
      ...row,
      modelCount: customerModels.get(`${row.unit}:${row.tpid}`)?.size || 0,
    }))
    .sort((left, right) => (
      right.approved - left.approved
      || left.customerName.localeCompare(right.customerName)
    ));
  const units = Object.fromEntries(QUOTA_UNITS.map((unit) => [
    unit,
    {
      customerCount: 0,
      modelCount: models.filter((row) => row.unit === unit).length,
      totalApproved: 0,
      totalDeployed: 0,
      totalAvailable: 0,
    },
  ]));
  for (const customer of customers) {
    const summary = units[customer.unit];
    summary.customerCount += 1;
    summary.totalApproved += customer.approved;
    summary.totalDeployed += customer.deployed;
    summary.totalAvailable += customer.available;
  }
  return {
    models,
    customers,
    summary: {
      customerCount: new Set(customers.map((row) => row.tpid)).size,
      modelCount: new Set(models.map((row) => row.model)).size,
      units,
    },
  };
}

function aggregateSubscriptions(summaryRows, detailRows) {
  const detailDimensions = new Map();
  for (const row of detailRows) {
    const key = `${row.unit}:${row.subscriptionId}`;
    if (!detailDimensions.has(key)) {
      detailDimensions.set(key, {
        models: new Set(),
        regions: new Set(),
      });
    }
    const dimensions = detailDimensions.get(key);
    dimensions.models.add(row.model);
    dimensions.regions.add(row.location);
  }
  return summaryRows
    .map((row) => {
      const approved = numberOrZero(row.approved);
      const deployed = numberOrZero(row.deployed);
      const subscriptionId = row.subscriptionId || 'Unmapped subscription';
      const dimensions = detailDimensions.get(`${row.unit}:${subscriptionId}`);
      return {
        subscriptionId,
        unit: row.unit,
        approved,
        deployed,
        available: Math.max(0, approved - deployed),
        deployedPct: approved > 0 ? deployed / approved : 0,
        modelCount: dimensions?.models.size || 0,
        regionCount: dimensions?.regions.size || 0,
      };
    })
    .filter((row) => row.approved !== 0 || row.deployed !== 0)
    .sort((left, right) => right.approved - left.approved);
}

function normalizeRequest(row) {
  return {
    state: row.state || '',
    priority: row.priority || '',
    model: row.model || '',
    requestedAmount: numberOrZero(row.requestedAmount),
    approvedAmount: numberOrZero(row.approvedAmount),
    requestedRegion: row.requestedRegion || row.requestedRegionLegacy || '',
    approvedRegion: row.approvedRegion || '',
    decision: row.decision || '',
    requestedDate: row.requestedDate || null,
    actionUrl: row.actionUrl || null,
  };
}

function normalizeMilestone(row) {
  return {
    milestoneId: row.milestoneId || '',
    name: row.name || '',
    status: row.status || '',
    statusReason: row.statusReason || '',
    totalPipe: numberOrZero(row.totalPipe),
    qualifiedPipe: numberOrZero(row.qualifiedPipe),
    blockedPipe: numberOrZero(row.blockedPipe),
    blockedCount: numberOrZero(row.blockedCount),
    blockedWithUatPipe: numberOrZero(row.blockedWithUatPipe),
    blockedWithUatCount: numberOrZero(row.blockedWithUatCount),
    milestoneUrl: row.milestoneUrl || null,
  };
}

function summarize(tpid, quotaSummaries, requests, milestones) {
  const units = Object.fromEntries(QUOTA_UNITS.map((unit) => [
    unit,
    {
      approved: 0,
      deployed: 0,
      available: 0,
      deployedPct: 0,
    },
  ]));
  for (const quotaSummary of quotaSummaries) {
    const approved = numberOrZero(quotaSummary.approved);
    const deployed = numberOrZero(quotaSummary.deployed);
    units[quotaSummary.unit] = {
      approved,
      deployed,
      available: Math.max(0, approved - deployed),
      deployedPct: approved > 0 ? deployed / approved : 0,
    };
  }
  return {
    tpid,
    units,
    openRequestCount: requests.length,
    blockedMilestoneCount: milestones.reduce((sum, row) => sum + row.blockedCount, 0),
    blockedPipeline: milestones.reduce((sum, row) => sum + row.blockedPipe, 0),
  };
}

function rowsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createCapacityService({
  getPowerBiToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  operationTimeoutMs = OPERATION_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryBaseMs = RETRY_BASE_MS,
  sleepFn = delay,
} = {}) {
  if (typeof getPowerBiToken !== 'function') {
    throw new Error('createCapacityService: getPowerBiToken function is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createCapacityService: fetch implementation is required.');
  }

  const cache = new Map();
  const inFlight = new Map();
  const identityGenerations = new Map();

  function startOperation() {
    const controller = new AbortController();
    const operation = {
      controller,
      deadline: Date.now() + operationTimeoutMs,
      failure: null,
      timer: null,
    };
    operation.timer = setTimeout(() => {
      if (!operation.failure) operation.failure = deadlineError(operationTimeoutMs);
      controller.abort();
    }, operationTimeoutMs);
    return operation;
  }

  function failOperation(operation, error) {
    if (!operation.failure) operation.failure = error;
    operation.controller.abort();
    return operation.failure;
  }

  async function runOperation(work) {
    const operation = startOperation();
    const aborted = new Promise((_, reject) => {
      operation.controller.signal.addEventListener(
        'abort',
        () => reject(operation.failure || deadlineError(operationTimeoutMs)),
        { once: true },
      );
    });
    try {
      const workResult = (async () => {
        try {
          return await work(operation);
        } catch (error) {
          throw failOperation(operation, error);
        }
      })();
      return await Promise.race([workResult, aborted]);
    } finally {
      clearTimeout(operation.timer);
    }
  }

  async function acquireToken(operation) {
    if (operation.failure) throw operation.failure;
    return Promise.race([
      getPowerBiToken(),
      new Promise((_, reject) => {
        operation.controller.signal.addEventListener(
          'abort',
          () => reject(operation.failure || deadlineError(operationTimeoutMs)),
          { once: true },
        );
      }),
    ]);
  }

  function currentGeneration(identity) {
    if (!identity) return 0;
    return identityGenerations.get(identity) || 0;
  }

  function invalidateIdentity(identity) {
    if (!identity) return;
    identityGenerations.set(identity, currentGeneration(identity) + 1);
    const prefix = `${identity}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  function writeCache(cacheKey, identity, generation, data) {
    if (cacheKey && currentGeneration(identity) === generation) {
      cache.set(cacheKey, { cachedAt: now(), data });
    }
  }

  async function postPage(token, body, operation) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (operation.failure) throw operation.failure;
      if (Date.now() >= operation.deadline) {
        throw failOperation(operation, deadlineError(operationTimeoutMs));
      }
      let waitMs = retryBaseMs;
      await requestGate.acquire();
      if (operation.failure) {
        requestGate.release();
        throw operation.failure;
      }
      const remainingMs = operation.deadline - Date.now();
      if (remainingMs <= 0) {
        requestGate.release();
        throw failOperation(operation, deadlineError(operationTimeoutMs));
      }
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      operation.controller.signal.addEventListener('abort', abortRequest, { once: true });
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(requestTimeoutMs, remainingMs),
      );
      if (timeout.unref) timeout.unref();
      try {
        const response = await fetchImpl(QUERYDATA_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json;charset=UTF-8',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://msit.powerbi.com',
            Referer: 'https://msit.powerbi.com/',
            'X-Powerbi-Hostenv': 'Embed for Organization',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        const preview = String(text || '').slice(0, 500);
        if (response.status === 401 || response.status === 403) {
          const error = new Error(`Power BI capacity query is not authorized (HTTP ${response.status}). ${preview}`);
          error.code = 'CAPACITY_UNAUTHORIZED';
          throw error;
        }
        if (response.status === 429 || response.status === 503) {
          waitMs = retryDelay(response, attempt, retryBaseMs);
          lastError = new Error(`Power BI capacity query was throttled (HTTP ${response.status}).`);
        } else if (!response.ok) {
          const error = new Error(`Power BI capacity query failed (HTTP ${response.status}). ${preview}`);
          if (response.status < 500) error.code = 'CAPACITY_FATAL';
          throw error;
        } else {
          return parsePage(text, body);
        }
      } catch (err) {
        if (operation.failure) throw operation.failure;
        if (
          err?.code === 'CAPACITY_UNAUTHORIZED'
          || err?.code === 'CAPACITY_FATAL'
          || err?.code === 'CAPACITY_DEADLINE'
        ) {
          throw err;
        }
        if (isConnectionError(err)) {
          const error = new Error('Cannot reach the Power BI capacity model. Connect to corpnet/VPN and try again.');
          error.code = 'CAPACITY_OFFLINE';
          throw failOperation(operation, error);
        }
        lastError = controller.signal.aborted
          ? new Error(`Power BI capacity query timed out after ${Math.round(requestTimeoutMs / 1000)} seconds.`)
          : new Error(`Power BI capacity query failed: ${err.message || String(err)}`);
        waitMs = Math.min(retryBaseMs * (2 ** (attempt - 1)), 30_000);
      } finally {
        clearTimeout(timeout);
        operation.controller.signal.removeEventListener('abort', abortRequest);
        requestGate.release();
      }

      if (attempt < maxAttempts) {
        if (Date.now() + waitMs >= operation.deadline) {
          throw failOperation(operation, deadlineError(operationTimeoutMs));
        }
        await sleepFn(waitMs);
      }
    }
    throw new Error(`Power BI capacity query failed after ${maxAttempts} attempts: ${lastError?.message || 'unknown error'}`);
  }

  async function executeSpec(token, spec, operation) {
    const rows = [];
    let restartTokens = null;
    let previousRestart = null;
    for (let windowIndex = 0; windowIndex < MAX_WINDOWS; windowIndex++) {
      const body = buildRequestBody(spec, restartTokens);
      const dataSet = await postPage(token, body, operation);
      let pageRows = decodeDSRPage(dataSet, spec.columns);
      if (
        restartTokens != null
        && rows.length > 0
        && pageRows.length > 0
        && rowsEqual(rows[rows.length - 1], pageRows[0])
      ) {
        pageRows = pageRows.slice(1);
      }
      rows.push(...pageRows);
      if (dataSet.IC === true) return rows;
      if (dataSet.RT == null) {
        if (dataSet.IC === false) {
          throw new Error('Power BI capacity query returned an incomplete result without a continuation token.');
        }
        return rows;
      }
      const nextRestart = JSON.stringify(dataSet.RT);
      if (previousRestart === nextRestart) {
        throw new Error('Power BI capacity query continuation did not advance.');
      }
      previousRestart = nextRestart;
      restartTokens = dataSet.RT;
    }
    throw new Error(`Power BI capacity query exceeded ${MAX_WINDOWS} result windows.`);
  }

  async function loadCustomerCapacity({
    tpid,
    token,
    cacheKey,
    identity,
    generation,
    operation,
    includeQuotas,
  }) {
    const quotaRowsPromise = includeQuotas
      ? Promise.all([
        executeSpec(token, regionalQuotaSpec(tpid), operation),
        executeSpec(token, globalQuotaSpec(tpid), operation),
      ])
      : Promise.resolve([[], []]);
    const [[regionalRows, globalRows], summaryRowsByUnit, requestRows, milestoneRows] =
      await Promise.all([
        quotaRowsPromise,
        Promise.all(QUOTA_UNITS.map(
          (unit) => executeSpec(token, summarySpec(tpid, unit), operation),
        )),
        executeSpec(token, requestSpec(tpid), operation),
        executeSpec(token, milestoneSpec(tpid), operation),
      ]);
    if (summaryRowsByUnit.some((rows) => rows.length > 1)) {
      throw new Error('Power BI returned an invalid AI capacity summary.');
    }
    const summaryRows = summaryRowsByUnit.flatMap((rows, index) => (
      rows.map((row) => ({ ...row, unit: QUOTA_UNITS[index] }))
    ));
    const quotas = [
      ...regionalRows.map(normalizeRegionalQuota),
      ...globalRows.map(normalizeGlobalQuota),
    ].filter((row) => row.approved !== 0 || row.deployed !== 0);
    quotas.sort((left, right) => (
      right.available - left.available
      || left.model.localeCompare(right.model)
      || left.location.localeCompare(right.location)
    ));
    const requests = requestRows.map(normalizeRequest)
      .sort((left, right) => String(right.requestedDate).localeCompare(String(left.requestedDate)));
    const milestones = milestoneRows.map(normalizeMilestone)
      .filter((row) => row.totalPipe !== 0 || row.blockedCount !== 0)
      .sort((left, right) => right.blockedCount - left.blockedCount || right.totalPipe - left.totalPipe);
    const data = {
      summary: summarize(tpid, summaryRows, requests, milestones),
      quotas,
      requests,
      openRequests: requests,
      milestones,
      reportUrl: reportUrlForTpid(tpid),
      fetchedAt: new Date(now()).toISOString(),
      source: 'AI Capacity Allocation Insights',
    };
    writeCache(cacheKey, identity, generation, data);
    return data;
  }

  async function getCustomerCapacity({
    tpid: rawTpid,
    force = false,
    includeQuotas = true,
  } = {}) {
    const tpid = normalizeTpid(rawTpid);
    return runOperation(async (operation) => {
      const token = await acquireToken(operation);
      if (!token) {
        throw new Error('Could not acquire a Power BI token. Sign in with Microsoft in Settings and ensure you are on corpnet/VPN.');
      }
      const identity = tokenIdentity(token);
      if (force) invalidateIdentity(identity);
      const generation = currentGeneration(identity);
      const cacheKey = identity
        ? `${identity}:customer:${includeQuotas ? 'full' : 'metadata'}:${tpid}`
        : null;
      const cached = cacheKey ? cache.get(cacheKey) : null;
      if (!force && cached && now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.data;
      }
      const inFlightKey = cacheKey ? `${cacheKey}:g${generation}` : null;
      if (inFlightKey && inFlight.has(inFlightKey)) return inFlight.get(inFlightKey);

      const load = loadCustomerCapacity({
        tpid,
        token,
        cacheKey,
        identity,
        generation,
        operation,
        includeQuotas,
      });
      if (!cacheKey) return load;
      inFlight.set(inFlightKey, load);
      try {
        return await load;
      } finally {
        if (inFlight.get(inFlightKey) === load) inFlight.delete(inFlightKey);
      }
    });
  }

  async function loadPortfolioCapacity({
    tpids,
    token,
    cacheKey,
    identity,
    generation,
    operation,
  }) {
    const [
      regionalTpmRows,
      regionalPtuRows,
      globalRows,
      customerTpmRows,
      customerPtuRows,
    ] = await Promise.all([
      executeSpec(token, portfolioRegionalSpec(tpids, 'TPM'), operation),
      executeSpec(token, portfolioRegionalSpec(tpids, 'PTU'), operation),
      executeSpec(token, portfolioGlobalSpec(tpids), operation),
      executeSpec(token, portfolioCustomerSpec(tpids, 'TPM'), operation),
      executeSpec(token, portfolioCustomerSpec(tpids, 'PTU'), operation),
    ]);
    const rows = [
      ...regionalTpmRows.map((row) => normalizePortfolioRegional(row, 'TPM')),
      ...regionalPtuRows.map((row) => normalizePortfolioRegional(row, 'PTU')),
      ...globalRows.map(normalizePortfolioGlobal),
    ].filter((row) => row.tpid && (row.approved !== 0 || row.deployed !== 0));
    const customerSummaryRows = [
      ...customerTpmRows.map((row) => normalizeCustomerSummary(row, 'TPM')),
      ...customerPtuRows.map((row) => normalizeCustomerSummary(row, 'PTU')),
    ];
    const aggregates = aggregateCapacityRows(rows, customerSummaryRows);
    const data = {
      ...aggregates,
      rows,
      reportUrl: `${REPORT_BASE_URL}?experience=power-bi`,
      fetchedAt: new Date(now()).toISOString(),
      source: 'AI Capacity Allocation Insights',
    };
    writeCache(cacheKey, identity, generation, data);
    return data;
  }

  async function getPortfolioCapacity({ tpids: rawTpids, force = false } = {}) {
    const tpids = normalizeTpids(rawTpids);
    return runOperation(async (operation) => {
      const token = await acquireToken(operation);
      if (!token) {
        throw new Error('Could not acquire a Power BI token. Sign in with Microsoft in Settings and ensure you are on corpnet/VPN.');
      }
      const identity = tokenIdentity(token);
      if (force) invalidateIdentity(identity);
      const generation = currentGeneration(identity);
      const cacheKey = identity ? `${identity}:portfolio:${tpids.join(',')}` : null;
      const cached = cacheKey ? cache.get(cacheKey) : null;
      if (!force && cached && now() - cached.cachedAt < CACHE_TTL_MS) return cached.data;
      const inFlightKey = cacheKey ? `${cacheKey}:g${generation}` : null;
      if (inFlightKey && inFlight.has(inFlightKey)) return inFlight.get(inFlightKey);

      const load = loadPortfolioCapacity({
        tpids,
        token,
        cacheKey,
        identity,
        generation,
        operation,
      });
      if (!cacheKey) return load;
      inFlight.set(inFlightKey, load);
      try {
        return await load;
      } finally {
        if (inFlight.get(inFlightKey) === load) inFlight.delete(inFlightKey);
      }
    });
  }

  async function loadCustomerSubscriptions({
    tpid,
    token,
    cacheKey,
    identity,
    generation,
    operation,
  }) {
    const [regionalRows, globalRows, summaryTpmRows, summaryPtuRows] = await Promise.all([
      executeSpec(token, subscriptionRegionalSpec(tpid), operation),
      executeSpec(token, subscriptionGlobalSpec(tpid), operation),
      executeSpec(token, subscriptionSummarySpec(tpid, 'TPM'), operation),
      executeSpec(token, subscriptionSummarySpec(tpid, 'PTU'), operation),
    ]);
    const rows = [
      ...regionalRows.map(normalizeSubscriptionRegional),
      ...globalRows.map(normalizeSubscriptionGlobal),
    ].filter((row) => row.approved !== 0 || row.deployed !== 0);
    rows.sort((left, right) => (
      right.approved - left.approved
      || left.subscriptionId.localeCompare(right.subscriptionId)
      || left.model.localeCompare(right.model)
    ));
    const data = {
      tpid,
      subscriptions: aggregateSubscriptions([
        ...summaryTpmRows.map((row) => ({ ...row, unit: 'TPM' })),
        ...summaryPtuRows.map((row) => ({ ...row, unit: 'PTU' })),
      ], rows),
      rows,
      reportUrl: reportUrlForTpid(tpid),
      fetchedAt: new Date(now()).toISOString(),
      source: 'AI Capacity Allocation Insights',
    };
    writeCache(cacheKey, identity, generation, data);
    return data;
  }

  async function getCustomerSubscriptions({ tpid: rawTpid, force = false } = {}) {
    const tpid = normalizeTpid(rawTpid);
    return runOperation(async (operation) => {
      const token = await acquireToken(operation);
      if (!token) {
        throw new Error('Could not acquire a Power BI token. Sign in with Microsoft in Settings and ensure you are on corpnet/VPN.');
      }
      const identity = tokenIdentity(token);
      if (force) invalidateIdentity(identity);
      const generation = currentGeneration(identity);
      const cacheKey = identity ? `${identity}:subscriptions:${tpid}` : null;
      const cached = cacheKey ? cache.get(cacheKey) : null;
      if (!force && cached && now() - cached.cachedAt < CACHE_TTL_MS) return cached.data;
      const inFlightKey = cacheKey ? `${cacheKey}:g${generation}` : null;
      if (inFlightKey && inFlight.has(inFlightKey)) return inFlight.get(inFlightKey);

      const load = loadCustomerSubscriptions({
        tpid,
        token,
        cacheKey,
        identity,
        generation,
        operation,
      });
      if (!cacheKey) return load;
      inFlight.set(inFlightKey, load);
      try {
        return await load;
      } finally {
        if (inFlight.get(inFlightKey) === load) inFlight.delete(inFlightKey);
      }
    });
  }

  return { getCustomerCapacity, getCustomerSubscriptions, getPortfolioCapacity };
}

module.exports = {
  CACHE_TTL_MS,
  CAPACITY_MODEL_ID,
  POWERBI_RESOURCE,
  QUERYDATA_URL,
  REQUEST_TIMEOUT_MS,
  REPORT_BASE_URL,
  buildRequestBody,
  createCapacityService,
  normalizeTpid,
  normalizeTpids,
  reportUrlForTpid,
  tokenIdentity,
};
