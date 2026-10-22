'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computePortfolioInsights, entityMomentum, nestByDimension } = require('../acr-insights');

// A tiny 3-month window: FY26-Jul → FY26-Sep.
const accountRows = [
  // Contoso: steady 3-month climb 100 → 200 → 400.
  { fiscal_month: 'FY26-Jul', account: 'Contoso', acr: 100 },
  { fiscal_month: 'FY26-Aug', account: 'Contoso', acr: 200 },
  { fiscal_month: 'FY26-Sep', account: 'Contoso', acr: 400 },
  // Fabrikam: 3-month decline 300 → 200 → 100.
  { fiscal_month: 'FY26-Jul', account: 'Fabrikam', acr: 300 },
  { fiscal_month: 'FY26-Aug', account: 'Fabrikam', acr: 200 },
  { fiscal_month: 'FY26-Sep', account: 'Fabrikam', acr: 100 },
];

const serviceRows = [
  { fiscal_month: 'FY26-Jul', service: 'Virtual Machines', acr: 250 },
  { fiscal_month: 'FY26-Aug', service: 'Virtual Machines', acr: 260 },
  { fiscal_month: 'FY26-Sep', service: 'Virtual Machines', acr: 300 },
  // Azure OpenAI: lands only in the final month → "new workload".
  { fiscal_month: 'FY26-Sep', service: 'Azure OpenAI', acr: 200 },
];

test('nestByDimension orders months chronologically and sums per key', () => {
  const { byKey, months } = nestByDimension(accountRows, 'account');
  assert.deepEqual(months, ['FY26-Jul', 'FY26-Aug', 'FY26-Sep']);
  assert.equal(byKey.get('Contoso').total, 700);
  assert.equal(byKey.get('Contoso').monthly['FY26-Sep'], 400);
});

test('entityMomentum computes MoM, streak, and lifetime delta', () => {
  const { byKey, months } = nestByDimension(accountRows, 'account');
  const contoso = entityMomentum(byKey.get('Contoso'), months);
  assert.equal(contoso.latest, 400);
  assert.equal(contoso.previous, 200);
  assert.equal(contoso.momDollar, 200);
  assert.equal(contoso.momPct, 100);
  assert.equal(contoso.streak, 2); // 2 consecutive up-moves
  assert.equal(contoso.lifetimeDelta, 300);

  const fabrikam = entityMomentum(byKey.get('Fabrikam'), months);
  assert.equal(fabrikam.momDollar, -100);
  assert.equal(fabrikam.streak, -2);
});

test('computePortfolioInsights surfaces growers, decliners, and new workloads', () => {
  const res = computePortfolioInsights({ accountRows, serviceRows, topN: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.insufficientData, false);
  assert.equal(res.latestMonth, 'FY26-Sep');

  // Portfolio latest = 400 (Contoso) + 100 (Fabrikam) = 500; prev = 200 + 200 = 400.
  assert.equal(res.portfolio.latest, 500);
  assert.equal(res.portfolio.previous, 400);
  assert.equal(res.portfolio.momDollar, 100);

  assert.equal(res.growers[0].name, 'Contoso');
  assert.equal(res.decliners[0].name, 'Fabrikam');

  const newWl = res.newWorkloads.map((s) => s.name);
  assert.ok(newWl.includes('Azure OpenAI'));
  assert.ok(!newWl.includes('Virtual Machines'));

  // Concentration: Contoso is 400/500 = 80% of latest ACR.
  assert.equal(res.concentration.account, 'Contoso');
  assert.equal(res.concentration.sharePct, 80);

  // Insight cards exist and include a portfolio-trend card.
  assert.ok(res.insights.some((i) => i.kind === 'portfolio-trend'));
  assert.ok(res.insights.some((i) => i.kind === 'growth-opportunity'));
});

test('computePortfolioInsights reports insufficient data when empty', () => {
  const res = computePortfolioInsights({ accountRows: [], serviceRows: [] });
  assert.equal(res.ok, true);
  assert.equal(res.insufficientData, true);
  assert.match(res.reason, /snapshot/i);
});
