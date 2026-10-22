'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPACITY_MODEL_ID,
  QUERYDATA_URL,
  createCapacityService,
  normalizeTpid,
  reportUrlForTpid,
  tokenIdentity,
} = require('../capacity-query');

function token(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message } }),
  };
}

function dsrResponse(select, rows) {
  let dimensionIndex = 0;
  let measureIndex = 0;
  const schema = select.map((entry) => ({
    N: entry.Column ? `G${dimensionIndex++}` : `M${measureIndex++}`,
  }));
  const names = select.map((entry) => entry.NativeReferenceName);
  const dataRows = rows.map((row, index) => ({
    ...(index === 0 ? { S: schema } : {}),
    C: names.map((name) => row[name] ?? null),
  }));
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      results: [{
        result: {
          data: {
            descriptor: { Select: select.map(() => ({})) },
            dsr: {
              DS: [{
                PH: [{ DM0: dataRows }],
                IC: true,
              }],
            },
          },
        },
      }],
    }),
  };
}

function quotaUnitFromQuery(query) {
  const serialized = JSON.stringify(query.Where || []);
  if (serialized.includes(`"'Standard'"`) || serialized.includes(`"'GlobalStandard'"`)) {
    return 'TPM';
  }
  if (serialized.includes('Provisioned')) return 'PTU';
  return null;
}

function queryResponse(options, { emptySummary = false } = {}) {
  const body = JSON.parse(options.body);
  const query = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query;
  const select = query.Select;
  const names = select.map((entry) => entry.NativeReferenceName);
  const unit = quotaUnitFromQuery(query);
  if (names.includes('deployedPct')) {
    return dsrResponse(select, [{
      quotaType: 'DataZoneStandard',
      model: 'gpt-5.4',
      location: 'eastus2',
      approved: 1000,
      deployedPct: 0.25,
    }]);
  }
  if (names.includes('quotaType')) {
    return dsrResponse(select, [{
      quotaType: 'GlobalStandard',
      model: 'gpt-5.4',
      approved: 2000,
      deployed: 500,
    }]);
  }
  if (names.includes('tpid')) {
    return dsrResponse(select, emptySummary ? [] : [{
      tpid: '1002',
      approved: unit === 'PTU' ? 30 : 3000,
      deployed: unit === 'PTU' ? 5 : 750,
    }]);
  }
  if (names.includes('state')) {
    return dsrResponse(select, [{
      state: 'In Progress',
      priority: 'P1',
      model: 'gpt-5.4',
      requestedAmount: 500,
      approvedAmount: null,
      requestedRegion: 'East US 2',
    }]);
  }
  return dsrResponse(select, [{
    milestoneId: '7-123',
    name: 'AI rollout',
    totalPipe: 50000,
    blockedPipe: 50000,
    blockedCount: 1,
    blockedWithUatCount: 1,
  }]);
}

test('normalizes and validates TPIDs', () => {
  assert.equal(normalizeTpid(1002), '1002');
  assert.throws(() => normalizeTpid("1002' OR 1=1"), /numeric customer TPID/);
});

test('builds a TPID-filtered report URL', () => {
  const url = reportUrlForTpid('1002');
  assert.match(url, /dbcfbd54-9c35-4021-943d-8d2ce16133dc/);
  assert.match(decodeURIComponent(url), /Account\/TPID eq '1002'/);
});

test('derives a non-secret cache identity from token claims', () => {
  assert.equal(tokenIdentity(token({ tid: 'tenant', oid: 'account' })), 'tenant:account');
  assert.equal(tokenIdentity('not-a-jwt'), null);
});

test('queries the MSIT capacity model and reuses identity-scoped cache entries', async () => {
  let calls = 0;
  let activeToken = token({ tid: 'tenant', oid: 'account-1' });
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, QUERYDATA_URL);
    const body = JSON.parse(options.body);
    assert.equal(body.modelId, CAPACITY_MODEL_ID);
    return queryResponse(options);
  };
  const service = createCapacityService({
    getPowerBiToken: async () => activeToken,
    fetchImpl,
    now: () => 1000,
  });

  const [first, concurrent] = await Promise.all([
    service.getCustomerCapacity({ tpid: '1002' }),
    service.getCustomerCapacity({ tpid: '1002' }),
  ]);
  const second = await service.getCustomerCapacity({ tpid: '1002' });
  activeToken = token({ tid: 'tenant', oid: 'account-2' });
  const switchedAccount = await service.getCustomerCapacity({ tpid: '1002' });

  assert.equal(calls, 12);
  assert.equal(first, concurrent);
  assert.equal(first, second);
  assert.notEqual(first, switchedAccount);
  assert.deepEqual(first.summary, {
    tpid: '1002',
    units: {
      TPM: {
        approved: 3000,
        deployed: 750,
        available: 2250,
        deployedPct: 0.25,
      },
      PTU: {
        approved: 30,
        deployed: 5,
        available: 25,
        deployedPct: 1 / 6,
      },
    },
    openRequestCount: 1,
    blockedMilestoneCount: 1,
    blockedPipeline: 50000,
  });
  assert.equal(first.quotas.length, 2);
  const regionalQuota = first.quotas.find((row) => row.location === 'eastus2');
  const globalQuota = first.quotas.find((row) => row.location === 'Global');
  assert.equal(regionalQuota.deployed, 250);
  assert.equal(regionalQuota.available, 750);
  assert.equal(globalQuota.deployed, 500);
  assert.equal(first.openRequests[0].model, 'gpt-5.4');
  assert.equal(first.milestones[0].blockedWithUatCount, 1);
});

test('aggregates portfolio capacity by model and customer', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0]
        .SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      const unit = quotaUnitFromQuery(
        body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query,
      );
      if (names.includes('deployedPct')) {
        if (unit === 'PTU') {
          return dsrResponse(select, [{
            tpid: '1001',
            customerName: 'Contoso',
            model: 'gpt-5.4',
            approved: 10,
            deployedPct: 0.2,
          }]);
        }
        return dsrResponse(select, [
          {
            tpid: '1002',
            customerName: 'Fabrikam',
            quotaType: 'DataZoneStandard',
            model: 'gpt-5.4',
            approved: 1000,
            deployedPct: 0.25,
          },
          {
            tpid: '1001',
            customerName: 'Contoso',
            quotaType: 'DataZoneStandard',
            model: 'gpt-5.4',
            approved: 500,
            deployedPct: 0.1,
          },
        ]);
      }
      if (names.includes('model')) {
        return dsrResponse(select, [{
          tpid: '1001',
          customerName: 'Contoso',
          model: 'gpt-5.5',
          approved: 2000,
          deployed: 400,
        }]);
      }
      return dsrResponse(select, [
        ...(unit === 'PTU' ? [{
          tpid: '1001',
          customerName: 'Contoso',
          approved: 10,
          deployed: 2,
        }] : [
          {
            tpid: '1001',
            customerName: 'Contoso',
            approved: 2500,
            deployed: 450,
          },
          {
            tpid: '1002',
            customerName: 'Fabrikam',
            approved: 1000,
            deployed: 250,
          },
        ]),
      ]);
    },
  });

  const result = await service.getPortfolioCapacity({
    tpids: ['1001', '1002', '1002'],
  });

  assert.equal(result.summary.customerCount, 2);
  assert.equal(result.summary.modelCount, 2);
  assert.equal(result.summary.units.TPM.totalApproved, 3500);
  assert.equal(result.summary.units.TPM.totalDeployed, 700);
  assert.equal(result.summary.units.PTU.totalApproved, 10);
  assert.deepEqual(
    result.models.filter((row) => row.unit === 'TPM').map((row) => row.model),
    ['gpt-5.5', 'gpt-5.4'],
  );
  const contosoTpm = result.customers.find(
    (row) => row.tpid === '1001' && row.unit === 'TPM',
  );
  assert.equal(contosoTpm.customerName, 'Contoso');
  assert.equal(contosoTpm.approved, 2500);
});

test('returns customer quota breakdown by subscription', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const select = body.queries[0].Query.Commands[0]
        .SemanticQueryDataShapeCommand.Query.Select;
      const names = select.map((entry) => entry.NativeReferenceName);
      const unit = quotaUnitFromQuery(
        body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query,
      );
      if (names.includes('deployedPct')) {
        return dsrResponse(select, [
          {
            subscriptionId: 'sub-a',
            quotaType: 'DataZoneStandard',
            model: 'gpt-5.4',
            location: 'eastus2',
            approved: 1000,
            deployedPct: 0.25,
          },
          {
            subscriptionId: 'sub-a',
            quotaType: 'ProvisionedManaged',
            model: 'gpt-4.1',
            location: 'eastus2',
            approved: 20,
            deployedPct: 0.25,
          },
        ]);
      }
      if (names.includes('model')) {
        return dsrResponse(select, [{
          subscriptionId: 'sub-b',
          quotaType: 'GlobalStandard',
          model: 'gpt-5.5',
          approved: 2000,
          deployed: 400,
        }]);
      }
      return dsrResponse(select, unit === 'PTU'
        ? [{ subscriptionId: 'sub-a', approved: 20, deployed: 5 }]
        : [
          { subscriptionId: 'sub-a', approved: 1000, deployed: 250 },
          { subscriptionId: 'sub-b', approved: 2000, deployed: 400 },
        ]);
    },
  });

  const result = await service.getCustomerSubscriptions({ tpid: '1001' });

  assert.equal(result.rows.length, 3);
  assert.equal(result.subscriptions.length, 3);
  assert.equal(result.subscriptions[0].subscriptionId, 'sub-b');
  assert.equal(result.subscriptions[0].available, 1600);
  assert.equal(result.subscriptions.find((row) => row.unit === 'PTU').available, 15);
  assert.equal(result.subscriptions.find((row) => row.unit === 'PTU').modelCount, 1);
  assert.equal(result.rows.find((row) => row.subscriptionId === 'sub-a').deployed, 250);
});

test('customer metadata drilldown omits duplicate quota detail queries', async () => {
  let calls = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      return queryResponse(options);
    },
  });

  const result = await service.getCustomerCapacity({
    tpid: '1002',
    includeQuotas: false,
  });

  assert.equal(calls, 4);
  assert.deepEqual(result.quotas, []);
  assert.equal(result.summary.units.TPM.approved, 3000);
  assert.equal(result.summary.units.PTU.approved, 30);
});

test('forced refresh invalidates related customer capacity caches', async () => {
  let calls = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      return queryResponse(options);
    },
  });

  await service.getCustomerCapacity({ tpid: '1002' });
  assert.equal(calls, 6);
  await service.getCustomerCapacity({
    tpid: '1002',
    includeQuotas: false,
    force: true,
  });
  assert.equal(calls, 10);
  await service.getCustomerCapacity({ tpid: '1002' });
  assert.equal(calls, 16);
});

test('fails fast when the Power BI host is unreachable', async () => {
  let calls = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async () => {
      calls += 1;
      const error = new Error('fetch failed');
      error.cause = { code: 'ENOTFOUND' };
      throw error;
    },
  });

  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /Cannot reach the Power BI capacity model/,
  );
  assert.ok(calls >= 1 && calls <= 3);
});

test('operation deadline includes token acquisition', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => new Promise(() => {}),
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    },
    operationTimeoutMs: 5,
  });

  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /operation timed out/,
  );
});

test('fatal fan-out errors release sibling requests for an immediate retry', async () => {
  let mode = 'failing';
  let failingCalls = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      if (mode === 'healthy') return queryResponse(options);
      failingCalls += 1;
      if (failingCalls === 1) return errorResponse(400, 'Bad query');
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    requestTimeoutMs: 100,
    operationTimeoutMs: 100,
    maxAttempts: 1,
  });

  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /HTTP 400/,
  );
  mode = 'healthy';
  const result = await service.getCustomerCapacity({ tpid: '1002', force: true });
  assert.equal(result.summary.units.TPM.approved, 3000);
});

test('limits querydata fan-out to three concurrent requests', async () => {
  let active = 0;
  let maximumActive = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return queryResponse(options);
    },
  });

  await service.getCustomerCapacity({ tpid: '1002' });
  assert.equal(maximumActive, 3);
});

test('retries throttled querydata requests', async () => {
  let calls = 0;
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0' },
          text: async () => 'throttled',
        };
      }
      return queryResponse(options);
    },
    retryBaseMs: 0,
    sleepFn: async () => {},
  });

  const result = await service.getCustomerCapacity({ tpid: '1002' });
  assert.equal(result.summary.units.TPM.approved, 3000);
  assert.equal(calls, 7);
});

test('rejects incomplete DSR pages without continuation tokens', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => {
      const response = queryResponse(options);
      const body = JSON.parse(await response.text());
      body.results[0].result.data.dsr.DS[0].IC = false;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      };
    },
    maxAttempts: 1,
  });
  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /incomplete result without a continuation token/,
  );
});

test('keeps requests and milestones when a customer has no quota rows', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => queryResponse(options, { emptySummary: true }),
  });
  const result = await service.getCustomerCapacity({ tpid: '1002' });
  assert.equal(result.summary.units.TPM.approved, 0);
  assert.equal(result.summary.units.PTU.approved, 0);
  assert.equal(result.summary.openRequestCount, 1);
  assert.equal(result.summary.blockedMilestoneCount, 1);
});

test('surfaces Power BI authorization errors', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async () => errorResponse(403, 'Denied'),
  });
  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /not authorized \(HTTP 403\).*Denied/,
  );
});

test('times out stalled Power BI requests', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    requestTimeoutMs: 5,
    maxAttempts: 1,
  });
  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /timed out/,
  );
});

test('times out stalled Power BI response bodies', async () => {
  const service = createCapacityService({
    getPowerBiToken: async () => token({ tid: 'tenant', oid: 'account' }),
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      text: async () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    }),
    requestTimeoutMs: 5,
    maxAttempts: 1,
  });
  await assert.rejects(
    service.getCustomerCapacity({ tpid: '1002' }),
    /timed out/,
  );
});
