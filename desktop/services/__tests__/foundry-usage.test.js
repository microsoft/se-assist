'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DATASET_ID,
  EXECUTE_QUERIES_URL,
  METADATA_URL,
  buildDetailQuery,
  buildPortfolioQuery,
  createFoundryUsageService,
  normalizeTpid,
  normalizeTpids,
  parsePowerBiDate,
} = require('../foundry-usage');

function token(claims = { tid: 'tenant', oid: 'account' }) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] || headers[name.toLowerCase()] || null },
    text: async () => JSON.stringify(body),
  };
}

function executeRows(rows) {
  return response(200, {
    results: [{ tables: [{ rows }] }],
  });
}

function metadataResponse() {
  return response(200, {
    models: [{
      id: 6524744,
      dbName: DATASET_ID,
      lastRefreshTime: '/Date(1792415804553)/',
    }],
  });
}

test('validates and deduplicates Foundry TPIDs', () => {
  assert.equal(normalizeTpid(1001), '1001');
  assert.deepEqual(normalizeTpids(['1001', 1001, '1002']), ['1001', '1002']);
  assert.throws(() => normalizeTpid("1001' OR 1=1"), /numeric customer TPID/);
  assert.throws(() => normalizeTpids(['not-a-tpid']), /No valid customer TPIDs/);
});

test('builds roster-scoped rolling-window DAX without string interpolation', () => {
  const portfolio = buildPortfolioQuery(['1001', '1002']);
  assert.match(portfolio, /TODAY\(\) - 90/);
  assert.match(portfolio, /TREATAS\(\{1001,1002\}, 'DimTPID'\[TPID\]\)/);
  const detail = buildDetailQuery('1001');
  assert.match(detail, /'FactTokensDaily'\[Week\]/);
  assert.match(detail, /TREATAS\(\{1001\}, 'DimTPID'\[TPID\]\)/);
});

test('parses Power BI epoch and ISO timestamps', () => {
  assert.equal(parsePowerBiDate('/Date(1792415804553)/'), '2026-10-19T13:16:44.553Z');
  assert.equal(parsePowerBiDate('2026-10-18T00:00:00'), '2026-10-18T00:00:00.000Z');
  assert.equal(parsePowerBiDate('invalid'), null);
});

test('loads and caches a Foundry portfolio with model freshness', async () => {
  let calls = 0;
  const service = createFoundryUsageService({
    getPowerBiToken: async () => token(),
    now: () => 1792420000000,
    fetchImpl: async (url, options) => {
      calls += 1;
      if (url === METADATA_URL) return metadataResponse();
      assert.equal(url, EXECUTE_QUERIES_URL);
      const query = JSON.parse(options.body).queries[0].query;
      assert.match(query, /'DimTPID'\[TPName\]/);
      return executeRows([{
        'DimTPID[TPID]': 1001,
        'DimTPID[TPName]': 'CONTOSO',
        '[Tokens]': 1200000000,
        '[LastUsageDate]': '2026-10-18T00:00:00',
        '[Subscriptions]': 2,
        '[Models]': 3,
      }]);
    },
  });

  const first = await service.getPortfolio({ tpids: ['1001'] });
  const cached = await service.getPortfolio({ tpids: ['1001'] });
  const refreshed = await service.getPortfolio({ tpids: ['1001'], force: true });

  assert.equal(calls, 4);
  assert.equal(first, cached);
  assert.notEqual(first, refreshed);
  assert.equal(first.customers[0].customerName, 'CONTOSO');
  assert.equal(first.totalTokens, 1200000000);
  assert.equal(first.sourceRefreshedAt, '2026-10-19T13:16:44.553Z');
});

test('normalizes customer detail and engagement rows', async () => {
  const service = createFoundryUsageService({
    getPowerBiToken: async () => token(),
    now: () => 1792420000000,
    fetchImpl: async (url, options) => {
      if (url === METADATA_URL) return metadataResponse();
      const query = JSON.parse(options.body).queries[0].query;
      if (query.includes('FoundryCustomerEngagementLevel_CU')) {
        return executeRows([{
          'FoundryCustomerEngagementLevel_CU[MonthKey]': '2026-09-01T00:00:00',
          'FoundryCustomerEngagementLevel_CU[CloudCustomerGuid]': 'ccid-1',
          'FoundryCustomerEngagementLevel_CU[CurrentCategory]': 'L3',
          '[CustomerUnits]': 250.5,
        }]);
      }
      return executeRows([{
        'FactTokensDaily[Week]': '2026-10-10T00:00:00',
        'FactTokensDaily[Month]': '2026-10-01T00:00:00',
        'FactTokensDaily[CloudCustomerGuid]': 'ccid-1',
        'DimSubscription[AzSubscriptionGuid]': 'sub-1',
        'FactTokensDaily[DeploymentRegion]': 'eastus2',
        'FactTokensDaily[ProviderType]': 'Anthropic',
        'FactTokensDaily[Model]': 'claude-opus-4-8',
        'FactTokensDaily[ModelVersion]': '1',
        'FactTokensDaily[OfferingName]': 'GlobalStandard',
        '[Tokens]': 123456789,
      }]);
    },
  });

  const result = await service.getCustomer({ tpid: '1001' });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].week, '2026-10-10T00:00:00.000Z');
  assert.equal(result.rows[0].model, 'claude-opus-4-8');
  assert.equal(result.engagement[0].level, 'L3');
  assert.deepEqual(result.summary, {
    totalTokens: 123456789,
    subscriptionCount: 1,
    modelCount: 1,
    regionCount: 1,
    weekCount: 1,
  });
});

test('surfaces freshness metadata failure without hiding valid usage data', async () => {
  const service = createFoundryUsageService({
    getPowerBiToken: async () => token(),
    maxAttempts: 1,
    fetchImpl: async (url) => {
      if (url === METADATA_URL) {
        return response(403, { error: { message: 'Metadata denied' } });
      }
      return executeRows([]);
    },
  });

  const result = await service.getPortfolio({ tpids: ['1001'] });

  assert.equal(result.sourceRefreshedAt, null);
  assert.match(result.sourceRefreshError, /denied access.*Metadata denied/i);
});

test('fails loudly when Power BI denies the usage query', async () => {
  const service = createFoundryUsageService({
    getPowerBiToken: async () => token(),
    maxAttempts: 1,
    fetchImpl: async (url) => {
      if (url === METADATA_URL) return metadataResponse();
      return response(403, { error: { message: 'RLS denied' } });
    },
  });

  await assert.rejects(
    service.getPortfolio({ tpids: ['1001'] }),
    /denied access.*RLS denied/i,
  );
});
