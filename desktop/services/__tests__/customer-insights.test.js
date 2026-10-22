'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCustomerInsights,
  acrMomentumSummary,
  extractDossierSignals,
  normalizeOpportunities,
  normalizeMilestones,
} = require('../customer-insights');

// A 3-month ACR window for one account: VMs steady up, SQL eroding, Azure OpenAI new.
const acr = {
  fiscalYear: 'FY26',
  level: 2,
  months: ['FY26-Jul', 'FY26-Aug', 'FY26-Sep'],
  grandTotal: 1800,
  services: [
    { service: 'Virtual Machines', total: 810, monthly: { 'FY26-Jul': 250, 'FY26-Aug': 260, 'FY26-Sep': 300 } },
    { service: 'SQL Database', total: 600, monthly: { 'FY26-Jul': 300, 'FY26-Aug': 200, 'FY26-Sep': 100 } },
    { service: 'Azure OpenAI', total: 200, monthly: { 'FY26-Sep': 200 } },
  ],
};

const dossierTopics = [
  { num: 0, title: 'Snapshot', synthesis: 'Example enterprise software company; governed AI is a priority.' },
  { num: 2, title: 'Financial & Strategic Priorities', synthesis: 'Improve service delivery and operating efficiency.' },
  { num: 4, title: 'AI & Data Initiatives', synthesis: 'Building support-knowledge AI and internal reporting copilots.' },
  { num: 7, title: 'Triggers & Timing', synthesis: 'Planning an internal AI pilot for next quarter.' },
  { num: 9, title: 'Microsoft Pitch Mapping', synthesis: 'Foundry + Fabric + Purview as the governed AI/data layer.' },
];

const opportunities = [
  { name: 'Data platform modernization', sales_play: 'Analytics', estimated_close_date: '2099-01-01', state_code: 0 },
  { name: 'Won deal', sales_play: 'Migrate', estimated_close_date: '2020-01-01', state_code: 1 },
];

const milestones = [
  { name: 'Fabric pilot', workload: 'Analytics', status_label: 'Committed', monthly_use: 5000 },
];

test('acrMomentumSummary flags rising, eroding, and new services', () => {
  const s = acrMomentumSummary(acr);
  assert.equal(s.hasData, true);
  assert.equal(s.latestMonth, 'FY26-Sep');
  assert.deepEqual(s.rising.map((x) => x.name).sort(), ['Azure OpenAI', 'Virtual Machines'].sort());
  assert.equal(s.eroding[0].name, 'SQL Database');
  assert.equal(s.eroding[0].momDollar, -100);
  assert.equal(s.newWorkloads[0].name, 'Azure OpenAI');
  assert.equal(s.hasAiSpend, true);
});

test('acrMomentumSummary returns hasData:false with no series', () => {
  assert.equal(acrMomentumSummary(null).hasData, false);
  assert.equal(acrMomentumSummary({ services: [], months: [] }).hasData, false);
});

test('extractDossierSignals maps topic numbers to roles', () => {
  const d = extractDossierSignals(dossierTopics);
  assert.equal(d.hasDossier, true);
  assert.equal(d.byRole['financial-priorities'].num, 2);
  assert.equal(d.byRole['ai-data'].num, 4);
  assert.equal(d.byRole['triggers'].num, 7);
  assert.equal(d.byRole['pitch-mapping'].num, 9);
});

test('normalizers treat missing state_code as open and coerce numbers', () => {
  const o = normalizeOpportunities([{ name: 'X' }, { name: 'Y', state_code: 1 }]);
  assert.equal(o[0].isOpen, true);
  assert.equal(o[1].isOpen, false);
  const m = normalizeMilestones([{ name: 'M', monthly_use: '1200.5' }]);
  assert.equal(m[0].monthlyUse, 1200.5);
});

test('computeCustomerInsights: full data → high confidence + joined suggestions', () => {
  const r = computeCustomerInsights({
    customer: { name: 'Contoso', tpid: '123', segment: 'Software' },
    dossierTopics, opportunities, milestones, acr,
    engagement: { openQuestions: ['When can we see a Fabric demo?'], actionItems: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.dataCoverage, { hasDossier: true, hasAcr: true, acrSource: 'live', acrAsOf: null, openOpportunities: 1, milestones: 1, hasEngagement: true });

  // Priorities include the dossier financial + AI priorities.
  const pTitles = r.priorities.map((p) => p.title);
  assert.ok(pTitles.includes('Financial & strategic priorities'));
  assert.ok(pTitles.includes('AI & data initiatives'));

  // Opportunity areas include an expand (rising), a defend (eroding), and the open opp.
  const signals = r.opportunityAreas.map((o) => o.signal);
  assert.ok(signals.includes('acr-rising'));
  assert.ok(signals.includes('acr-erosion'));
  assert.ok(signals.includes('open-opp'));

  // Suggestions are sorted high→low and include the trigger×opp join and the erosion defense.
  assert.equal(r.suggestions[0].priority, 'high');
  const sTitles = r.suggestions.map((s) => s.title).join(' | ');
  assert.match(sTitles, /trigger/i);
  assert.match(sTitles, /health review for SQL Database/i);
});

test('computeCustomerInsights: AI whitespace when dossier flags AI but no Azure AI spend', () => {
  const acrNoAi = {
    ...acr,
    services: [{ service: 'Virtual Machines', total: 810, monthly: { 'FY26-Jul': 250, 'FY26-Aug': 260, 'FY26-Sep': 300 } }],
  };
  const r = computeCustomerInsights({ customer: { name: 'Contoso' }, dossierTopics, acr: acrNoAi });
  const whitespace = r.opportunityAreas.find((o) => o.signal === 'whitespace-ai');
  assert.ok(whitespace, 'expected an AI whitespace opportunity area');
  assert.match(r.suggestions.map((s) => s.title).join(' | '), /Foundry \/ OpenAI PoC/i);
});

test('computeCustomerInsights: sparse data → low confidence + honest notes + dossier suggestion', () => {
  const r = computeCustomerInsights({ customer: { name: 'Unknown Bank' } });
  assert.equal(r.confidence, 'low');
  assert.equal(r.dataCoverage.hasDossier, false);
  assert.equal(r.dataCoverage.hasAcr, false);
  assert.ok(r.notes.some((n) => /No research dossier/i.test(n)));
  assert.ok(r.notes.some((n) => /No Azure consumption/i.test(n)));
  assert.ok(r.suggestions.some((s) => /Generate a research dossier/i.test(s.title)));
});

test('computeCustomerInsights: cached ACR is disclosed via notes + dataCoverage.acrSource', () => {
  const r = computeCustomerInsights({
    customer: { name: 'Contoso', tpid: '123' },
    dossierTopics,
    acr,
    acrMeta: { source: 'local-cache', asOf: '2026-07-14T00:00:00Z' },
  });
  assert.equal(r.dataCoverage.hasAcr, true);
  assert.equal(r.dataCoverage.acrSource, 'local-cache');
  assert.equal(r.dataCoverage.acrAsOf, '2026-07-14T00:00:00Z');
  assert.ok(r.notes.some((n) => /local cache/i.test(n) && /2026-07-14/.test(n)),
    'expected an honest "as of" cache note');
  // The ACR momentum signals still compute from the cached payload.
  assert.equal(r.signals.acr.latestMonth, 'FY26-Sep');
});

test('computeCustomerInsights: live ACR sets acrSource live with no cache note', () => {
  const r = computeCustomerInsights({ customer: { name: 'Contoso' }, acr, acrMeta: { source: 'live', asOf: null } });
  assert.equal(r.dataCoverage.acrSource, 'live');
  assert.equal(r.dataCoverage.acrAsOf, null);
  assert.ok(!r.notes.some((n) => /local cache/i.test(n)), 'live data should carry no cache note');
});


test('computeCustomerInsights: overdue open opportunity is flagged in the 90-day window', () => {
  const r = computeCustomerInsights({
    customer: { name: 'Acme' },
    opportunities: [{ name: 'Renewal', sales_play: 'Retain', estimated_close_date: '2020-01-01', state_code: 0 }],
  });
  const soon = r.suggestions.find((s) => /Prioritize/i.test(s.title));
  assert.ok(soon, 'expected a prioritize suggestion for the overdue opp');
  assert.match(soon.detail, /overdue/i);
});
