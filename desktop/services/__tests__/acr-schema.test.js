/**
 * acr-schema.test.js — unit tests for the pure ACR schema/query/decoder core.
 * Ported from mcaps-microsoft/frontier-solution-engineer's acr-schema.test.ts.
 * Run: node --test desktop/services/__tests__/acr-schema.test.js
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DIMENSIONS,
  MEASURES,
  isDimensionKey,
  isMeasureKey,
  buildAcrQuery,
  decodeDSRPage,
  resolvePeriod,
  fyOf,
  fyMonthOf,
  previousFiscalMonth,
  orderFiscalMonths,
  shapeRows,
  nestServiceHierarchy,
} = require('../acr-schema');

// ─── Test fixtures ───────────────────────────────────────────────
const page = (o) => o;
const dimSource = { source: 'd', prop: 'X', qname: 'q.X', name: 'source', isColumn: true, label: 'Source' };
const dimAlias = { source: 'd', prop: 'Y', qname: 'q.Y', name: 'alias', isColumn: true, label: 'Alias' };
const mAcr = { source: 'm', prop: '$ ACR', qname: 'M.ACR', name: 'acr', isColumn: false, pct: false, label: 'ACR' };
const mPct = { source: 'm', prop: '% X', qname: 'M.Pct', name: 'pct', isColumn: false, pct: true, label: 'Pct' };

// ─── Registry / type guards ──────────────────────────────────────
test('registries: keys each ColDef by its friendly name', () => {
  for (const [k, c] of Object.entries(DIMENSIONS)) assert.equal(c.name, k);
  for (const [k, c] of Object.entries(MEASURES)) assert.equal(c.name, k);
});

test('registries: marks only the percent measure as pct', () => {
  assert.equal(MEASURES.avgDailyAcrMomPct.pct, true);
  assert.equal(MEASURES.acr.pct, false);
});

test('type guards reflect membership', () => {
  assert.equal(isDimensionKey('serviceLevel3'), true);
  assert.equal(isDimensionKey('nope'), false);
  assert.equal(isMeasureKey('acr'), true);
  assert.equal(isMeasureKey('nope'), false);
});

// ─── decodeDSRPage ───────────────────────────────────────────────
test('decodeDSRPage: returns [] for an empty page', () => {
  assert.deepEqual(decodeDSRPage(page({ PH: [{ DM0: [] }] }), [dimSource, mAcr]), []);
  assert.deepEqual(decodeDSRPage(page({}), [dimSource, mAcr]), []);
});

test('decodeDSRPage: decodes dictionaries, repeat bits and null bits', () => {
  const ds = page({
    ValueDicts: { D0: ['ACME', 'GLOBEX'], D1: ['alpha', 'beta'] },
    PH: [{
      DM0: [
        { S: [{ N: 'G0', DN: 'D0' }, { N: 'G1', DN: 'D1' }, { N: 'M0' }], C: [0, 0, 100] },
        { C: [200], R: 0b011 },            // source+alias repeat, acr new
        { C: [1], R: 0b001, 'Ø': 0b100 },  // source repeat, alias new (beta), acr null
      ],
    }],
  });
  const rows = decodeDSRPage(ds, [dimSource, dimAlias, mAcr]);
  assert.deepEqual(rows, [
    { source: 'ACME', alias: 'alpha', acr: '100' },
    { source: 'ACME', alias: 'alpha', acr: '200' },
    { source: 'ACME', alias: 'beta', acr: '' },
  ]);
});

test('decodeDSRPage: scales percent measures by 100 and accepts numeric or string values', () => {
  const ds = page({
    PH: [{
      DM0: [
        { S: [{ N: 'G0' }, { N: 'M0' }], C: ['ACME', 0.123] },
        { C: [0.5], R: 0b01 },     // source repeat, pct new (number)
        { C: ['0.25'], R: 0b01 },  // pct as string
      ],
    }],
  });
  const rows = decodeDSRPage(ds, [dimSource, mPct]);
  assert.deepEqual(rows, [
    { source: 'ACME', pct: '12.3' },
    { source: 'ACME', pct: '50' },
    { source: 'ACME', pct: '25' },
  ]);
});

test('decodeDSRPage: maps schema positions back through column order (M before G)', () => {
  const ds = page({ PH: [{ DM0: [{ S: [{ N: 'M0' }, { N: 'G0' }], C: [42, 'ACME'] }] }] });
  assert.deepEqual(decodeDSRPage(ds, [dimSource, mAcr]), [{ acr: '42', source: 'ACME' }]);
});

test('decodeDSRPage: throws when the schema column count disagrees with the projection', () => {
  const ds = page({ PH: [{ DM0: [{ S: [{ N: 'G0' }], C: ['ACME'] }] }] });
  assert.throws(() => decodeDSRPage(ds, [dimSource, mAcr]), /schema has 1 columns/);
});

test('decodeDSRPage: throws on a dictionary index out of range', () => {
  const ds = page({
    ValueDicts: { D0: ['ACME'] },
    PH: [{ DM0: [{ S: [{ N: 'G0', DN: 'D0' }, { N: 'M0' }], C: [5, 1] }] }],
  });
  assert.throws(() => decodeDSRPage(ds, [dimSource, mAcr]), /index 5 out of range/);
});

test('decodeDSRPage: throws when C is exhausted', () => {
  const ds = page({ PH: [{ DM0: [{ S: [{ N: 'G0' }, { N: 'M0' }], C: ['ACME'] }] }] });
  assert.throws(() => decodeDSRPage(ds, [dimSource, mAcr]), /C exhausted/);
});

test('decodeDSRPage: throws when too many C values are supplied', () => {
  const ds = page({ PH: [{ DM0: [{ S: [{ N: 'G0' }, { N: 'M0' }], C: ['ACME', 1, 99] }] }] });
  assert.throws(() => decodeDSRPage(ds, [dimSource, mAcr]), /C values supplied/);
});

test('decodeDSRPage: throws on a non-numeric measure value', () => {
  const ds = page({ PH: [{ DM0: [{ S: [{ N: 'G0' }, { N: 'M0' }], C: ['ACME', 'not-a-number'] }] }] });
  assert.throws(() => decodeDSRPage(ds, [dimSource, mAcr]), /not numeric/);
});

// ─── buildAcrQuery ───────────────────────────────────────────────
const tpids = ['1234', '5678'];

test('buildAcrQuery: projects exactly the requested columns', () => {
  const cols = [DIMENSIONS.account, DIMENSIONS.serviceLevel2, MEASURES.acr];
  const q = buildAcrQuery(cols, tpids, 'FY26', 'FY26-May');
  assert.equal(q.Select.length, cols.length);
});

test('buildAcrQuery: emits the FiscalMonth filter only when a month is supplied', () => {
  const cols = [DIMENSIONS.account, MEASURES.acr];
  const withMonth = JSON.stringify(buildAcrQuery(cols, tpids, 'FY26', 'FY26-May'));
  const withoutMonth = JSON.stringify(buildAcrQuery(cols, tpids, 'FY26'));
  assert.match(withMonth, /FiscalMonth/);
  assert.doesNotMatch(withoutMonth, /FiscalMonth/);
});

test('buildAcrQuery: activates the ACRFields parameter only for selected F_ACR dimensions', () => {
  const withFAcr = JSON.stringify(buildAcrQuery([DIMENSIONS.account, DIMENSIONS.serviceLevel3, MEASURES.acr], tpids, 'FY26'));
  const withoutFAcr = JSON.stringify(buildAcrQuery([DIMENSIONS.account, MEASURES.acr], tpids, 'FY26'));
  assert.match(withFAcr, /ACRFields Fields/);
  assert.doesNotMatch(withoutFAcr, /ACRFields Fields/);
});

test('buildAcrQuery: lists the ACR_Measures literal for each selected measure', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, MEASURES.acr, MEASURES.avgDailyAcr], tpids, 'FY26'));
  assert.match(q, /\$ ACR/);
  assert.match(q, /\$ Average Daily ACR/);
});

test('buildAcrQuery: filters accounts by the stable TPID values', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, MEASURES.acr], tpids, 'FY26'));
  assert.match(q, /TPIDTxt/);
  assert.match(q, /1234/);
  assert.match(q, /5678/);
});

test('buildAcrQuery: always pins the Curated view and fiscal year', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, MEASURES.acr], tpids, 'FY26'));
  assert.match(q, /Curated/);
  assert.match(q, /FY26/);
});

test('buildAcrQuery: defaults the AccountSubscriptionParameter to SubscriptionName only', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, DIMENSIONS.serviceLevel2, MEASURES.acr], tpids, 'FY26'));
  assert.match(q, /SubscriptionName/);
  assert.doesNotMatch(q, /EnrollmentCustomerName/);
});

test('buildAcrQuery: activates enrollment via the AccountSubscriptionParameter, not ACRFields', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, DIMENSIONS.enrollmentName, MEASURES.acr], tpids, 'FY26'));
  assert.match(q, /EnrollmentCustomerName/);
  // enrollment is not an F_ACR ACRFields dimension, so ACRFields must stay off
  assert.doesNotMatch(q, /ACRFields Fields/);
});

test('buildAcrQuery: accepts an array of fiscal years (multi-FY time series)', () => {
  const cols = [DIMENSIONS.account, MEASURES.acr];
  const q = buildAcrQuery(cols, tpids, ['FY26', 'FY27']);
  const s = JSON.stringify(q);
  assert.match(s, /FY26/);
  assert.match(s, /FY27/);
  // The FiscalYear IN filter should carry both year literals.
  const fyFilter = q.Where.find((w) => w?.Condition?.In?.Expressions?.[0]?.Column?.Property === 'FiscalYear');
  assert.ok(fyFilter, 'FiscalYear filter present');
  assert.equal(fyFilter.Condition.In.Values.length, 2);
});

test('buildAcrQuery: serviceFilter scopes measures to specific L2 products + activates ACRFields', () => {
  const cols = [DIMENSIONS.account, MEASURES.acr];
  const q = buildAcrQuery(cols, tpids, 'FY26', undefined, {
    serviceFilter: { level: 2, values: ['Azure OpenAI', "O'Brien Svc"] },
  });
  const s = JSON.stringify(q);
  assert.match(s, /ServiceLevel2/);
  assert.match(s, /Azure OpenAI/);
  // Embedded apostrophes are doubled for the Power BI literal.
  assert.match(s, /O''Brien Svc/);
  // ACRFields must be activated so the ServiceLevel2 filter binds.
  assert.match(s, /ACRFields Fields/);
});

test('buildAcrQuery: no serviceFilter leaves the ServiceLevel2 filter off', () => {
  const q = JSON.stringify(buildAcrQuery([DIMENSIONS.account, MEASURES.acr], tpids, 'FY26'));
  assert.doesNotMatch(q, /ServiceLevel2/);
});

test('buildAcrQuery: native Anthropic is an explicit source, never added to ordinary ACR', () => {
  const cols = [DIMENSIONS.tpid, DIMENSIONS.account, DIMENSIONS.fiscalMonth, MEASURES.acr];
  const actuals = buildAcrQuery(cols, tpids, ['FY26', 'FY27']);
  const anthropic = buildAcrQuery(cols, tpids, ['FY26', 'FY27'], undefined, { adjustmentScope: 'anthropic' });
  const flag = (query) => query.Where.find((w) => w?.Condition?.In?.Expressions?.[0]?.Column?.Property === 'AdjustmentFlag').Condition.In.Values;
  assert.deepEqual(flag(actuals), [[{ Literal: { Value: "'N/A'" } }]]);
  assert.deepEqual(flag(anthropic), [[{ Literal: { Value: "'XCR - Anthropic'" } }]]);
  assert.deepEqual(buildAcrQuery(cols, tpids, ['FY26', 'FY27'], undefined, { adjustmentScope: 'actuals' }), actuals);
  assert.match(JSON.stringify(anthropic), /Curated/);
  assert.doesNotMatch(JSON.stringify(anthropic), /FACT_AzureConsumedRevenuePartnerUniqueId|DIM_SubSegmentHierarchy_SubSegmentId|XCR - W365/);
  assert.throws(() => buildAcrQuery(cols, tpids, 'FY27', undefined, { adjustmentScope: 'all' }), /Unknown ACR adjustment scope/);
});

// ─── Fiscal helpers ──────────────────────────────────────────────
test('fyOf / fyMonthOf: Microsoft fiscal year starts in July', () => {
  assert.equal(fyOf(new Date(2026, 5, 15)), 'FY26'); // June 2026 → FY26
  assert.equal(fyOf(new Date(2026, 6, 15)), 'FY27'); // July 2026 → FY27
  assert.equal(fyMonthOf(new Date(2026, 2, 1)), 'FY26-Mar');
});

test('resolvePeriod: latest resolves to the previous complete fiscal month', () => {
  const now = new Date(2026, 2, 15); // March 2026
  const { fiscalMonth } = previousFiscalMonth(now);
  const r = resolvePeriod('latest', now);
  assert.equal(r.fiscalMonth, fiscalMonth);
  assert.equal(r.label, fiscalMonth);
});

test('resolvePeriod: a whole fiscal year omits the month (time series)', () => {
  const now = new Date(2026, 2, 15);
  const r = resolvePeriod('FY26', now);
  assert.equal(r.fiscalYear, 'FY26');
  assert.equal(r.fiscalMonth, undefined);
});

test('resolvePeriod: a specific fiscal month is parsed', () => {
  const now = new Date(2026, 2, 15);
  const r = resolvePeriod('FY26-Mar', now);
  assert.equal(r.fiscalYear, 'FY26');
  assert.equal(r.fiscalMonth, 'FY26-Mar');
});

test('resolvePeriod: throws on an out-of-window or unparseable period', () => {
  const now = new Date(2026, 2, 15);
  assert.throws(() => resolvePeriod('FY10', now), /out-of-range|Unrecognized/);
  assert.throws(() => resolvePeriod('banana', now), /Unrecognized/);
});

test('orderFiscalMonths: sorts a fiscal year oldest → newest (Jul → Jun)', () => {
  const out = orderFiscalMonths(['FY26-Jun', 'FY26-Jul', 'FY26-Jan', 'FY26-Dec']);
  assert.deepEqual(out, ['FY26-Jul', 'FY26-Dec', 'FY26-Jan', 'FY26-Jun']);
});

test('shapeRows: coerces measures to numbers and passes dimensions through', () => {
  const rows = [{ account: 'ACME', acr: '1234.5' }, { account: 'GLOBEX', acr: '' }];
  const shaped = shapeRows(rows, [DIMENSIONS.account], [MEASURES.acr]);
  assert.deepEqual(shaped, [{ account: 'ACME', acr: 1234.5 }, { account: 'GLOBEX', acr: 0 }]);
});

test('nestServiceHierarchy: builds a grouped tree with subtotals at every level', () => {
  const rows = [
    // AI + Machine Learning › Foundry Models › NA › Azure Grok Models › Grok4 Fast Inp
    { serviceLevel1: 'AI + Machine Learning', serviceLevel2: 'Foundry Models', serviceLevel3: 'NA', fiscalMonth: 'FY26-Jul', acr: 100 },
    { serviceLevel1: 'AI + Machine Learning', serviceLevel2: 'Foundry Models', serviceLevel3: 'NA', fiscalMonth: 'FY26-Aug', acr: 50 },
    // AI + Machine Learning › Azure Machine Learning › NA
    { serviceLevel1: 'AI + Machine Learning', serviceLevel2: 'Azure Machine Learning', serviceLevel3: 'NA', fiscalMonth: 'FY26-Jul', acr: 30 },
    // Compute › Virtual Machines › NA
    { serviceLevel1: 'Compute', serviceLevel2: 'Virtual Machines', serviceLevel3: 'NA', fiscalMonth: 'FY26-Jul', acr: 400 },
  ];
  const { tree, months, grandTotal } = nestServiceHierarchy(rows, ['serviceLevel1', 'serviceLevel2', 'serviceLevel3']);

  assert.deepEqual(months, ['FY26-Jul', 'FY26-Aug']);
  assert.equal(grandTotal, 580);

  // Roots sorted by total desc: Compute (400) then AI + Machine Learning (180).
  assert.equal(tree[0].name, 'Compute');
  assert.equal(tree[0].total, 400);
  assert.equal(tree[1].name, 'AI + Machine Learning');
  assert.equal(tree[1].total, 180);
  assert.equal(tree[1].monthly['FY26-Jul'], 130);
  assert.equal(tree[1].monthly['FY26-Aug'], 50);

  // L2 children of AI + Machine Learning: Foundry Models (150) > Azure Machine Learning (30).
  const aiChildren = tree[1].children;
  assert.equal(aiChildren[0].name, 'Foundry Models');
  assert.equal(aiChildren[0].total, 150);
  assert.equal(aiChildren[0].level, 2);
  assert.equal(aiChildren[0].children[0].name, 'NA');
  assert.equal(aiChildren[0].children[0].level, 3);
  assert.ok(aiChildren[0].path.includes('\u203a'));

  // Leaf nodes at the requested depth carry no children.
  assert.equal(aiChildren[0].children[0].children, undefined);
});
