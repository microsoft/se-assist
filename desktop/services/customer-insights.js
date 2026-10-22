'use strict';

// Deterministic customer analysis engine. Pure functions that synthesize ONE
// account's signals into three seller-facing outputs:
//   1. priorities      — what matters to this customer (their imperatives)
//   2. opportunityAreas — where Microsoft can lean in (expand / defend / whitespace)
//   3. suggestions      — tailored, prioritized next-best-actions that JOIN signals
//
// Signals consumed (all optional, tolerated when absent):
//   - dossierTopics : parsed research-dossier topics [{ num, title, synthesis }]
//   - opportunities : MSX opportunities [{ name, sales_play, estimated_close_date, state_code }]
//   - milestones    : MSX milestones   [{ name, workload, status_label, monthly_use }]
//   - acr           : getAccountMonthlyServiceAcr shape { services, months, grandTotal, ... }
//   - engagement    : { openQuestions[], actionItems[], recentCount }
//
// No network, no AI: this is the factual, unit-tested substrate the AI narration
// layer (se-customer-analysis) cites. Every claim is derived from provided data;
// when a signal is missing we say so (repo policy: no silent fallback).

const { entityMomentum } = require('./acr-insights');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${Math.abs(round(n)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const clip = (s, n = 180) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const AI_SERVICE_RE = /\b(open\s?ai|foundry|cognitive|machine learning|azure ai|ai services|ai search|document intelligence)\b/i;

// --- ACR momentum summary -------------------------------------------------

/**
 * Summarize per-account Azure consumption momentum from the
 * getAccountMonthlyServiceAcr shape. Returns rising/eroding/new services and a
 * portfolio roll-up, reusing the same entityMomentum math as the ACR engine.
 */
function acrMomentumSummary(acr, { topN = 5 } = {}) {
  const services = Array.isArray(acr?.services) ? acr.services : [];
  const months = Array.isArray(acr?.months) ? acr.months : [];
  if (!services.length || !months.length) {
    return { hasData: false };
  }
  const enriched = services.map((s) => entityMomentum({ key: s.service, monthly: s.monthly || {}, total: s.total || 0 }, months));
  const latestMonth = months[months.length - 1];
  const totalLatest = round(enriched.reduce((a, s) => a + s.latest, 0));
  const totalPrev = round(enriched.reduce((a, s) => a + s.previous, 0));

  const byLatest = [...enriched].sort((a, b) => b.latest - a.latest);
  const rising = enriched.filter((s) => s.momDollar > 0).sort((a, b) => b.momDollar - a.momDollar).slice(0, topN);
  const eroding = enriched.filter((s) => s.momDollar < 0).sort((a, b) => a.momDollar - b.momDollar).slice(0, topN);

  // Newly-active: spend in latest month, none across the first half of the window.
  const midIdx = Math.max(1, Math.floor(months.length / 2));
  const earlyMonths = months.slice(0, midIdx);
  const byService = new Map(services.map((s) => [s.service, s.monthly || {}]));
  const newWorkloads = enriched
    .filter((s) => s.latest > 0 && earlyMonths.every((m) => !(byService.get(s.name)?.[m])))
    .sort((a, b) => b.latest - a.latest)
    .slice(0, topN);

  return {
    hasData: true,
    latestMonth,
    monthCount: months.length,
    fiscalYear: acr.fiscalYear || null,
    grandTotal: round(acr.grandTotal ?? enriched.reduce((a, s) => a + s.total, 0)),
    totalLatest,
    totalPrev,
    momDollar: round(totalLatest - totalPrev),
    topServices: byLatest.slice(0, topN),
    rising,
    eroding,
    newWorkloads,
    allServiceNames: enriched.map((s) => s.name),
    hasAiSpend: enriched.some((s) => AI_SERVICE_RE.test(s.name) && s.total > 0),
  };
}

// --- Dossier priority extraction -----------------------------------------

// The research-dossier topics we treat as priority/opportunity sources.
const DOSSIER_TOPIC_ROLES = {
  0: 'snapshot',
  2: 'financial-priorities',
  4: 'ai-data',
  6: 'regulatory',
  7: 'triggers',
  9: 'pitch-mapping',
};

/** Pull the useful synthesis lines out of parsed dossier topics. */
function extractDossierSignals(dossierTopics) {
  const topics = Array.isArray(dossierTopics) ? dossierTopics : [];
  const byRole = {};
  for (const t of topics) {
    const role = DOSSIER_TOPIC_ROLES[t.num];
    if (role && t.synthesis) byRole[role] = { num: t.num, title: t.title, synthesis: t.synthesis };
  }
  return { hasDossier: topics.length > 0, topicCount: topics.length, byRole };
}

// --- Normalizers ----------------------------------------------------------

function normalizeOpportunities(opportunities) {
  return (Array.isArray(opportunities) ? opportunities : []).map((o) => ({
    name: o.name || o.opportunity_number || 'Unnamed opportunity',
    salesPlay: o.sales_play || null,
    closeDate: o.estimated_close_date || null,
    // state_code: 0 = open/active in MSX; treat missing as open.
    isOpen: o.state_code == null ? true : Number(o.state_code) === 0,
    owner: o.owner_name || null,
  }));
}

function normalizeMilestones(milestones) {
  return (Array.isArray(milestones) ? milestones : []).map((m) => ({
    name: m.name || m.milestone_number || 'Milestone',
    workload: m.workload || null,
    status: m.status_label || null,
    monthlyUse: Number(m.monthly_use) || 0,
  }));
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

function topCounts(items, keyFn, n = 3) {
  const counts = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

// --- The engine -----------------------------------------------------------

/**
 * Synthesize a single customer's signals into priorities, opportunity areas,
 * and tailored suggestions.
 *
 * @returns {object} { ok, generatedAt, confidence, dataCoverage,
 *   priorities[], opportunityAreas[], suggestions[], signals, notes[] }
 */
function computeCustomerInsights({
  customer = {},
  dossierTopics = [],
  opportunities = [],
  milestones = [],
  acr = null,
  acrMeta = null,
  engagement = null,
} = {}) {
  const dossier = extractDossierSignals(dossierTopics);
  const opps = normalizeOpportunities(opportunities);
  const openOpps = opps.filter((o) => o.isOpen);
  const ms = normalizeMilestones(milestones);
  const acrSum = acrMomentumSummary(acr);
  const eng = engagement && typeof engagement === 'object' ? engagement : null;
  const openThreads = [
    ...((eng?.openQuestions) || []),
    ...((eng?.actionItems) || []),
  ].filter(Boolean).map((x) => (typeof x === 'string' ? x : (x.text || x.title || ''))).filter(Boolean);

  const priorities = [];
  const opportunityAreas = [];
  const suggestions = [];
  const notes = [];

  // ---- Priorities -------------------------------------------------------
  // 1) Dossier-sourced (highest confidence — human-researched business truth).
  if (dossier.byRole['financial-priorities']) {
    const t = dossier.byRole['financial-priorities'];
    priorities.push({ title: 'Financial & strategic priorities', detail: clip(t.synthesis, 320), source: `Research dossier §${t.num}`, confidence: 'high' });
  }
  if (dossier.byRole['ai-data']) {
    const t = dossier.byRole['ai-data'];
    priorities.push({ title: 'AI & data initiatives', detail: clip(t.synthesis, 320), source: `Research dossier §${t.num}`, confidence: 'high' });
  }
  if (dossier.byRole['regulatory']) {
    const t = dossier.byRole['regulatory'];
    priorities.push({ title: 'Regulatory & compliance posture', detail: clip(t.synthesis, 320), source: `Research dossier §${t.num}`, confidence: 'high' });
  }
  // 2) Activity-derived priorities (complement / fallback when dossier is thin).
  const playCounts = topCounts(openOpps, (o) => o.salesPlay, 3);
  if (playCounts.length) {
    priorities.push({
      title: 'Active pursuits (from CRM)',
      detail: playCounts.map((p) => `${p.key} (${p.count} open opp${p.count > 1 ? 's' : ''})`).join('; '),
      source: 'MSX opportunities',
      confidence: 'medium',
    });
  }
  const workloadCounts = topCounts(ms, (m) => m.workload, 3);
  if (workloadCounts.length) {
    priorities.push({
      title: 'In-flight delivery focus',
      detail: workloadCounts.map((w) => `${w.key} (${w.count} milestone${w.count > 1 ? 's' : ''})`).join('; '),
      source: 'MSX milestones',
      confidence: 'medium',
    });
  }
  if (acrSum.hasData && acrSum.topServices.length) {
    priorities.push({
      title: 'Established Azure footprint',
      detail: `Largest run-rate in ${acrSum.topServices.slice(0, 3).map((s) => `${s.name} (${money(s.latest)})`).join(', ')} as of ${acrSum.latestMonth}.`,
      source: 'Azure consumption',
      confidence: 'medium',
    });
  }

  // ---- Opportunity areas ------------------------------------------------
  if (acrSum.hasData) {
    for (const s of acrSum.rising) {
      opportunityAreas.push({ title: `Expand ${s.name}`, detail: `Up ${money(s.momDollar)} MoM (${s.momPct ?? '—'}%), now ${money(s.latest)} in ${acrSum.latestMonth}.`, signal: 'acr-rising', severity: 'positive' });
    }
    for (const s of acrSum.newWorkloads) {
      if (acrSum.rising.some((r) => r.name === s.name)) continue;
      opportunityAreas.push({ title: `Reinforce new landing: ${s.name}`, detail: `Newly active — ${money(s.latest)} in ${acrSum.latestMonth}, absent earlier in the window.`, signal: 'acr-new', severity: 'positive' });
    }
    for (const s of acrSum.eroding) {
      opportunityAreas.push({ title: `Defend ${s.name}`, detail: `Down ${money(s.momDollar)} MoM (${s.momPct ?? '—'}%) — protect the run-rate.`, signal: 'acr-erosion', severity: 'warning' });
    }
  }
  // Whitespace: dossier flags AI/data intent but there is no Azure AI spend.
  if (dossier.byRole['ai-data'] && acrSum.hasData && !acrSum.hasAiSpend) {
    opportunityAreas.push({ title: 'AI whitespace', detail: 'The dossier flags AI & data initiatives, but no Azure AI/OpenAI consumption is recorded yet — a clear landing zone.', signal: 'whitespace-ai', severity: 'positive' });
  } else if (dossier.byRole['ai-data'] && !acrSum.hasData) {
    opportunityAreas.push({ title: 'AI initiatives (consumption unknown)', detail: clip(dossier.byRole['ai-data'].synthesis, 220), signal: 'whitespace-ai', severity: 'info' });
  }
  // Open opportunities as opportunity areas.
  for (const o of openOpps.slice(0, 6)) {
    const d = daysUntil(o.closeDate);
    const when = o.closeDate ? `closes ${o.closeDate}${d != null ? ` (${d < 0 ? `${Math.abs(d)}d overdue` : `${d}d`})` : ''}` : 'no close date';
    opportunityAreas.push({ title: `Advance: ${clip(o.name, 80)}`, detail: [o.salesPlay, when].filter(Boolean).join(' · '), signal: 'open-opp', severity: 'positive' });
  }
  // Dossier pitch mapping (Microsoft plays already synthesized by research).
  if (dossier.byRole['pitch-mapping']) {
    opportunityAreas.push({ title: 'Microsoft pitch mapping', detail: clip(dossier.byRole['pitch-mapping'].synthesis, 260), signal: 'dossier-pitch', severity: 'info' });
  }

  // ---- Tailored suggestions (joins) -------------------------------------
  const push = (priority, title, detail, rationale) => suggestions.push({ priority, title, detail, rationale });

  // Trigger + open opp → time-boxed advance.
  if (dossier.byRole['triggers'] && openOpps.length) {
    const o = openOpps[0];
    push('high', `Use the current trigger to advance “${clip(o.name, 60)}”`,
      clip(dossier.byRole['triggers'].synthesis, 240),
      'Dossier §7 timing signal intersects an open MSX opportunity.');
  } else if (dossier.byRole['triggers']) {
    push('high', 'Act on the current buying trigger', clip(dossier.byRole['triggers'].synthesis, 240), 'Dossier §7 flags a "why now" window.');
  }
  // Rising service → expansion motion.
  if (acrSum.hasData && acrSum.rising.length) {
    const s = acrSum.rising[0];
    push('high', `Propose a scale plan for ${s.name}`,
      `${s.name} is up ${money(s.momDollar)} MoM (now ${money(s.latest)}). Package an expansion/architecture review while the workload is accelerating.`,
      'Azure consumption momentum (rising service).');
  }
  // Eroding service → defend/optimize.
  if (acrSum.hasData && acrSum.eroding.length) {
    const s = acrSum.eroding[0];
    push('high', `Run a health review for ${s.name}`,
      `${s.name} fell ${money(s.momDollar)} MoM. Book an optimization/health check to protect the run-rate before it churns.`,
      'Azure consumption momentum (eroding service).');
  }
  // AI whitespace → PoC.
  if (dossier.byRole['ai-data'] && acrSum.hasData && !acrSum.hasAiSpend) {
    push('high', 'Pitch an Azure AI Foundry / OpenAI PoC',
      'The account has documented AI ambitions but no Azure AI consumption yet — scope a governed PoC (Foundry, Azure OpenAI, or AI Search) against a named initiative.',
      'Dossier AI intent × zero Azure AI spend (whitespace).');
  }
  // Open opp near close → prioritize.
  const soon = openOpps
    .map((o) => ({ o, d: daysUntil(o.closeDate) }))
    .filter((x) => x.d != null && x.d <= 90)
    .sort((a, b) => a.d - b.d)[0];
  if (soon) {
    push('high', `Prioritize “${clip(soon.o.name, 60)}”`,
      `Estimated close ${soon.o.closeDate} (${soon.d < 0 ? `${Math.abs(soon.d)} days overdue` : `${soon.d} days out`})${soon.o.salesPlay ? ` · ${soon.o.salesPlay}` : ''}.`,
      'Open opportunity inside the 90-day close window.');
  }
  // At-risk / in-flight milestone with real $ → unblock.
  const bigMs = ms.filter((m) => m.monthlyUse > 0).sort((a, b) => b.monthlyUse - a.monthlyUse)[0];
  if (bigMs) {
    push('medium', `Progress milestone “${clip(bigMs.name, 60)}”`,
      `${bigMs.workload ? `${bigMs.workload} · ` : ''}${money(bigMs.monthlyUse)}/mo projected${bigMs.status ? ` · status ${bigMs.status}` : ''}. Confirm the next technical step and owner.`,
      'Highest-value in-flight milestone.');
  }
  // Open engagement threads → close the loop.
  if (openThreads.length) {
    push('medium', 'Close out an open thread',
      clip(openThreads[0], 200),
      'Unresolved question/action item from recent Teams/email signal.');
  }
  // Honest fallback when the dossier is missing — generate one.
  if (!dossier.hasDossier) {
    push('medium', 'Generate a research dossier for this account',
      'No research dossier matched this customer. A dossier unlocks priority-based recommendations (financial priorities, AI initiatives, triggers, buying committee).',
      'Missing the highest-signal input.');
  }

  suggestions.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));

  // ---- Coverage, confidence, notes --------------------------------------
  const dataCoverage = {
    hasDossier: dossier.hasDossier,
    hasAcr: acrSum.hasData,
    acrSource: acrSum.hasData ? (acrMeta?.source || 'live') : null,
    acrAsOf: acrSum.hasData && acrMeta?.source === 'local-cache' ? (acrMeta.asOf || null) : null,
    openOpportunities: openOpps.length,
    milestones: ms.length,
    hasEngagement: openThreads.length > 0,
  };
  const sourceCount = [dossier.hasDossier, acrSum.hasData, openOpps.length > 0, ms.length > 0].filter(Boolean).length;
  const confidence = dossier.hasDossier && acrSum.hasData && (openOpps.length || ms.length)
    ? 'high'
    : sourceCount >= 2 ? 'medium' : 'low';

  if (!dossier.hasDossier) notes.push('No research dossier matched; priorities are inferred from CRM and consumption only.');
  if (!acrSum.hasData) notes.push('No Azure consumption snapshot for this account (needs Microsoft sign-in + VPN); expansion/erosion signals are unavailable.');
  else if (acrMeta?.source === 'local-cache') {
    const asOf = String(acrMeta.asOf || '').slice(0, 10) || 'an earlier session';
    notes.push(`Azure consumption is from a local cache (last successful online fetch on ${asOf}), not a live query; reconnect + sign in for current numbers.`);
  }
  if (!openOpps.length) notes.push('No open opportunities found in CRM for this account.');
  if (!ms.length) notes.push('No milestones found in CRM for this account.');

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    customer: { name: customer.name || null, tpid: customer.tpid || null, segment: customer.segment || customer.industry_segment || null },
    confidence,
    dataCoverage,
    priorities,
    opportunityAreas,
    suggestions,
    signals: {
      acr: acrSum.hasData ? {
        latestMonth: acrSum.latestMonth,
        grandTotal: acrSum.grandTotal,
        momDollar: acrSum.momDollar,
        rising: acrSum.rising.map((s) => ({ name: s.name, momDollar: s.momDollar, latest: s.latest })),
        eroding: acrSum.eroding.map((s) => ({ name: s.name, momDollar: s.momDollar, latest: s.latest })),
        newWorkloads: acrSum.newWorkloads.map((s) => ({ name: s.name, latest: s.latest })),
      } : { hasData: false },
      dossierTopics: (Array.isArray(dossierTopics) ? dossierTopics : []).map((t) => ({ num: t.num, title: t.title })),
      openOpportunities: openOpps.length,
      milestones: ms.length,
    },
    notes,
  };
}

function priorityRank(p) {
  return p === 'high' ? 3 : p === 'medium' ? 2 : 1;
}

module.exports = {
  computeCustomerInsights,
  acrMomentumSummary,
  extractDossierSignals,
  normalizeOpportunities,
  normalizeMilestones,
};
