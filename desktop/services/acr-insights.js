'use strict';

// Deterministic ACR analysis engine (starter). Pure functions over the local
// snapshot rows persisted by the `acr-snapshot` IPC into `acr_account_metrics`
// and `acr_service_metrics`. No network, no AI — fully unit-testable and the
// factual substrate the AI briefing layer (se-acr-analysis) can cite.
//
// Design goal: surface *trends* (where consumption is going) and *opportunities*
// (where to lean in) from monthly ACR series, honestly. Every number is derived
// from the snapshot; when data is insufficient we say so rather than guess.

const { orderFiscalMonths, compareFiscalMonths } = require('./acr-schema');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (den ? round((num / den) * 100) : null);

/**
 * Collapse snapshot rows [{ fiscal_month, <keyField>, acr }] into a
 * dimension → { monthly: {fm: $}, total } map plus the ordered month axis.
 */
function nestByDimension(rows, keyField) {
  const byKey = new Map();
  const monthSet = new Set();
  for (const r of rows || []) {
    const key = String(r[keyField] ?? '').trim() || '(Unassigned)';
    const fm = String(r.fiscal_month ?? '').trim();
    if (!fm) continue;
    const amount = Number(r.acr) || 0;
    monthSet.add(fm);
    if (!byKey.has(key)) byKey.set(key, { key, monthly: {}, total: 0 });
    const entry = byKey.get(key);
    entry.monthly[fm] = (entry.monthly[fm] || 0) + amount;
    entry.total += amount;
  }
  const months = orderFiscalMonths([...monthSet]);
  return { byKey, months };
}

/**
 * Per-entity momentum over the ordered months: latest value, previous value,
 * MoM $/%, first→last delta, and the count of trailing consecutive up/down
 * months (streak). Streak sign encodes direction (+ up, − down).
 */
function entityMomentum(entry, months) {
  const series = months.map((m) => entry.monthly[m] || 0);
  const nonZero = series.filter((v) => v > 0);
  const latest = series.length ? series[series.length - 1] : 0;
  const previous = series.length > 1 ? series[series.length - 2] : 0;
  const momDollar = round(latest - previous);
  const first = nonZero.length ? nonZero[0] : 0;

  // Trailing streak of monotonic moves (ignores flat months).
  let streak = 0;
  for (let i = series.length - 1; i > 0; i -= 1) {
    const d = series[i] - series[i - 1];
    if (d > 0) { if (streak >= 0) streak += 1; else break; }
    else if (d < 0) { if (streak <= 0) streak -= 1; else break; }
    else break;
  }

  return {
    name: entry.key,
    total: round(entry.total),
    latest: round(latest),
    previous: round(previous),
    momDollar,
    momPct: pct(momDollar, previous),
    lifetimeDelta: round(latest - first),
    activeMonths: nonZero.length,
    streak,
  };
}

/**
 * Compute deterministic portfolio insights from snapshot rows.
 *
 * @param {object} input
 * @param {Array}  input.accountRows  [{ fiscal_month, account, acr }]
 * @param {Array}  input.serviceRows  [{ fiscal_month, service, acr }]
 * @param {number} [input.topN=5]
 * @returns {object} structured insights (see shape below)
 */
function computePortfolioInsights({ accountRows = [], serviceRows = [], topN = 5 } = {}) {
  const acct = nestByDimension(accountRows, 'account');
  const svc = nestByDimension(serviceRows, 'service');
  const months = acct.months.length ? acct.months : svc.months;

  if (months.length === 0) {
    return {
      ok: true,
      insufficientData: true,
      reason: 'No snapshot rows found. Run "Download FY26+FY27" on the Azure Consumption page first.',
      months: [],
      insights: [],
    };
  }

  const accounts = [...acct.byKey.values()].map((e) => entityMomentum(e, months));
  const services = [...svc.byKey.values()].map((e) => entityMomentum(e, months));

  const latestMonth = months[months.length - 1];
  const prevMonth = months.length > 1 ? months[months.length - 2] : null;

  const portfolioLatest = round(accounts.reduce((s, a) => s + a.latest, 0));
  const portfolioPrev = round(accounts.reduce((s, a) => s + a.previous, 0));
  const portfolioTotal = round(accounts.reduce((s, a) => s + a.total, 0));
  const portfolioMom = round(portfolioLatest - portfolioPrev);

  const byLatestDesc = (a, b) => b.latest - a.latest;
  const byMomDesc = (a, b) => b.momDollar - a.momDollar;
  const byMomAsc = (a, b) => a.momDollar - b.momDollar;

  // Growth opportunities: biggest absolute MoM gainers with real momentum.
  const growers = accounts.filter((a) => a.momDollar > 0).sort(byMomDesc).slice(0, topN);
  // Risks: biggest MoM decliners.
  const decliners = accounts.filter((a) => a.momDollar < 0).sort(byMomAsc).slice(0, topN);
  // Fast-rising / eroding services (product-line signal).
  const risingServices = services.filter((s) => s.momDollar > 0).sort(byMomDesc).slice(0, topN);
  const erodingServices = services.filter((s) => s.momDollar < 0).sort(byMomAsc).slice(0, topN);

  // Newly-active workloads: a service with spend in the latest month but none in
  // the first half of the window → a landing worth doubling down on.
  const midIdx = Math.floor(months.length / 2);
  const earlyMonths = months.slice(0, Math.max(1, midIdx));
  const newWorkloads = services
    .filter((s) => s.latest > 0 && earlyMonths.every((m) => !(svc.byKey.get(s.name)?.monthly[m])))
    .sort(byLatestDesc)
    .slice(0, topN);

  // Concentration: share of latest ACR held by the single largest account.
  const topAccount = [...accounts].sort(byLatestDesc)[0] || null;
  const concentrationPct = topAccount ? pct(topAccount.latest, portfolioLatest) : null;

  // Sustained-growth accounts: ≥3 consecutive up months.
  const sustained = accounts.filter((a) => a.streak >= 3).sort((a, b) => b.streak - a.streak).slice(0, topN);
  // Sustained decline: ≤ −3 → churn/optimization risk needing outreach.
  const churnRisk = accounts.filter((a) => a.streak <= -3).sort((a, b) => a.streak - b.streak).slice(0, topN);

  // Human-readable insight cards (deterministic, each with a severity).
  const insights = [];
  const money = (n) => `$${Math.abs(round(n)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  insights.push({
    kind: 'portfolio-trend',
    severity: portfolioMom >= 0 ? 'positive' : 'warning',
    title: `Portfolio ${portfolioMom >= 0 ? 'grew' : 'declined'} ${money(portfolioMom)} MoM`,
    detail: `Latest month (${latestMonth}) ACR is ${money(portfolioLatest)}${prevMonth ? ` vs ${money(portfolioPrev)} in ${prevMonth}` : ''} (${pct(portfolioMom, portfolioPrev) ?? '—'}%).`,
  });

  if (growers.length) {
    insights.push({
      kind: 'growth-opportunity',
      severity: 'positive',
      title: `${growers.length} account${growers.length > 1 ? 's' : ''} accelerating`,
      detail: growers.map((g) => `${g.name} +${money(g.momDollar)} (${g.momPct ?? '—'}%)`).join('; '),
      entities: growers,
    });
  }
  if (sustained.length) {
    insights.push({
      kind: 'momentum',
      severity: 'positive',
      title: `${sustained.length} account${sustained.length > 1 ? 's' : ''} on a 3+ month climb`,
      detail: sustained.map((s) => `${s.name} (${s.streak} months up)`).join('; '),
      entities: sustained,
    });
  }
  if (newWorkloads.length) {
    insights.push({
      kind: 'new-workload',
      severity: 'positive',
      title: `${newWorkloads.length} newly-active service${newWorkloads.length > 1 ? 's' : ''}`,
      detail: newWorkloads.map((s) => `${s.name} (${money(s.latest)} in ${latestMonth})`).join('; '),
      entities: newWorkloads,
    });
  }
  if (decliners.length) {
    insights.push({
      kind: 'risk',
      severity: 'warning',
      title: `${decliners.length} account${decliners.length > 1 ? 's' : ''} declining MoM`,
      detail: decliners.map((d) => `${d.name} −${money(d.momDollar)} (${d.momPct ?? '—'}%)`).join('; '),
      entities: decliners,
    });
  }
  if (churnRisk.length) {
    insights.push({
      kind: 'churn-risk',
      severity: 'critical',
      title: `${churnRisk.length} account${churnRisk.length > 1 ? 's' : ''} in sustained decline`,
      detail: churnRisk.map((c) => `${c.name} (${Math.abs(c.streak)} months down)`).join('; '),
      entities: churnRisk,
    });
  }
  if (concentrationPct != null && concentrationPct >= 40 && topAccount) {
    insights.push({
      kind: 'concentration',
      severity: 'warning',
      title: `Revenue concentration: ${topAccount.name} is ${concentrationPct}% of latest ACR`,
      detail: `A single account driving ${concentrationPct}% of consumption is a diversification risk.`,
    });
  }

  return {
    ok: true,
    insufficientData: false,
    generatedAt: new Date().toISOString(),
    months,
    latestMonth,
    prevMonth,
    portfolio: {
      total: portfolioTotal,
      latest: portfolioLatest,
      previous: portfolioPrev,
      momDollar: portfolioMom,
      momPct: pct(portfolioMom, portfolioPrev),
      accountCount: accounts.length,
      serviceCount: services.length,
    },
    growers,
    decliners,
    risingServices,
    erodingServices,
    newWorkloads,
    sustained,
    churnRisk,
    concentration: topAccount ? { account: topAccount.name, latest: topAccount.latest, sharePct: concentrationPct } : null,
    insights,
  };
}

module.exports = {
  computePortfolioInsights,
  nestByDimension,
  entityMomentum,
  // re-exported for callers/tests
  compareFiscalMonths,
};
