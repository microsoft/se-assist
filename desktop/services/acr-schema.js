/**
 * acr-schema.js — Power BI ACR semantic-model schema, query builder, DSR decoder
 * and fiscal-period helpers. The pure (no db, no network) core shared by
 * acr-querydata.js and the unit tests.
 *
 * Ported from mcaps-microsoft/frontier-solution-engineer
 * (src/main/services/acr-schema.ts), which in turn ports the Go implementation
 * in github.com/mcaps-microsoft/msxi-snap (src/features/acr/sync). The ACR
 * Power BI model (see ACR_MODEL_ID) exposes:
 *
 *   Measures   $ ACR, $ ACR MoM, $ Average Daily ACR, $ Avg Daily ACR MoM,
 *              % Avg Daily ACR MoM
 *   Dimensions account, fiscal quarter/month, Service Levels 1-5, Service
 *              Influencer, Service Comp Grouping, Subscription, Enrollment Name,
 *              and the Strategic / Sub-Strategic / Super-Strategic pillars
 *   History    any fiscal month within the FY-3..FY+1 window; omit the month
 *              filter to return every month of the anchor fiscal year
 *
 * This is a faithful CommonJS port limited to the primitives SE Assist needs:
 * the query builder, DSR decoder, and fiscal/calendar helpers.
 */

// ─── Model constant ──────────────────────────────────────────────
// Power BI modelId for the MSXI SL5 semantic model that serves Azure Consumed
// Revenue. This ID rotates whenever MSXI republishes the SL5 model, which orphans
// the old one — so the value below periodically needs re-deriving (see below).
//
// History:
//   • 6307665 (WWBI_Azure_SL5, dataset c4a39206) — until 18 Aug 2026; then MSXI
//     migrated and revoked access → every query failed 401 RLSNotAuthorizedForModel.
//   • 6670867 (report 7e5e1652, dataset 6b73b79c) — until ~4 Sep 2026; then MSXI
//     decommissioned the whole report → every query failed 404 PowerBIEntityNotFound.
//   • 6692492 (report "AzureSL5" 56980a76-0c5f-4207-a65d-1ce5d55f1a5c, dataset
//     0ff8c844-4e3e-47f5-a7ef-c23cd350b7a9) — current. Verified live 14 Sep 2026:
//     the app's exact F_ACR/M_ACR/DimCustomer/ACRFields query returns real monthly
//     $ACR per account and an 88-row serviceLevel2 service mix.
//
// To re-derive after a future migration: list the Power BI reports you can access
// (`GET https://api.powerbi.com/v1.0/myorg/reports` + `/apps/{id}/reports`), find
// the current "SL5"/"AzureSL5" report, then GET
// `.../explore/reports/{reportId}/modelsAndExploration` and take `models[0].id` —
// confirm it returns rows for a real TPID before updating this constant. Changing
// it auto-clears the stale row cache on next launch (invalidateCacheOnModelChange).
const ACR_MODEL_ID = 6692492;

// Keep native Anthropic XCR separate from organic Azure ACR. Including arbitrary
// adjustment rows in ordinary actuals would overstate consumption.
const ACR_ADJUSTMENT_SCOPES = {
  actuals: ['N/A'],
  anthropic: ['XCR - Anthropic'],
};

// A single querydata request is capped at 30,000 intersections; larger result
// sets page via the DataReduction window + restart tokens.
const WINDOW_SIZE = 30000;

// ─── Column definitions ──────────────────────────────────────────
// A ColDef is a plain object:
//   { source, prop, qname, name, isColumn, acrField?, subParamField?,
//     measureField?, pct?, label }

/** Build a ColDef for an F_ACR-sourced dimension (needs an ACRFields literal). */
function fAcrDim(key, prop, label) {
  return { source: 'f', prop, qname: `F_ACR.${prop}`, name: key, isColumn: true, acrField: `'''F_ACR''[${prop}]'`, label };
}

const DIMENSIONS = {
  account: { source: 'd1', prop: 'TPAccountName', qname: 'DimCustomer.TPAccountName', name: 'account', isColumn: true, label: 'Account' },
  tpid: { source: 'd1', prop: 'TPIDTxt', qname: 'DimCustomer.TPIDTxt', name: 'tpid', isColumn: true, label: 'TPID' },
  fiscalQuarter: { source: 'd', prop: 'FiscalQuarter', qname: 'DimDate.FiscalQuarter', name: 'fiscalQuarter', isColumn: true, label: 'Fiscal Quarter' },
  fiscalMonth: { source: 'd', prop: 'FiscalMonth', qname: 'DimDate.FiscalMonth', name: 'fiscalMonth', isColumn: true, label: 'Fiscal Month' },
  serviceLevel1: fAcrDim('serviceLevel1', 'ServiceLevel1', 'Service Level 1'),
  serviceLevel2: fAcrDim('serviceLevel2', 'ServiceLevel2', 'Service Level 2'),
  serviceLevel3: fAcrDim('serviceLevel3', 'ServiceLevel3', 'Service Level 3'),
  serviceLevel4: fAcrDim('serviceLevel4', 'ServiceLevel4', 'Service Level 4'),
  serviceLevel5: fAcrDim('serviceLevel5', 'ServiceLevel5', 'Service Level 5'),
  serviceInfluencer: fAcrDim('serviceInfluencer', 'ServiceInfluencer', 'Service Influencer'),
  serviceGroup: fAcrDim('serviceGroup', 'ServiceCompGrouping', 'Service Comp Grouping'),
  subscription: fAcrDim('subscription', 'SubscriptionName', 'Subscription'),
  // Enrollment attribute: activated via the AccountSubscriptionParameter field
  // parameter (not ACRFields), mirroring the msxi-snap enrollment report.
  enrollmentName: {
    source: 'f', prop: 'EnrollmentCustomerName', qname: 'F_ACR.EnrollmentCustomerName',
    name: 'enrollmentName', isColumn: true,
    subParamField: "'''F_ACR''[EnrollmentCustomerName]'", label: 'Enrollment Name',
  },
  strategicPillar: fAcrDim('strategicPillar', 'StrategicPillar', 'Strategic Pillar'),
  subStrategicPillar: fAcrDim('subStrategicPillar', 'SubStrategicPillar', 'Sub-Strategic Pillar'),
  superStrategicPillar: fAcrDim('superStrategicPillar', 'SuperStrategicPillar', 'Super-Strategic Pillar'),
};

function measure(key, prop, label, pct = false) {
  return [key, {
    source: 'm', prop, qname: `M_ACR.${prop}`, name: key, isColumn: false,
    measureField: `'''M_ACR''[${prop}]'`, pct, label,
  }];
}

const MEASURES = Object.fromEntries([
  measure('acr', '$ ACR', 'ACR ($)'),
  measure('acrMom', '$ ACR MoM Change', 'ACR MoM ($)'),
  measure('avgDailyAcr', '$ Average Daily ACR', 'Avg Daily ACR ($/day)'),
  measure('avgDailyAcrMom', '$ Avg Daily ACR MoM Change', 'Avg Daily ACR MoM ($/day)'),
  measure('avgDailyAcrMomPct', '% Avg Daily ACR MoM', 'Avg Daily ACR MoM (%)', true),
]);

const DIMENSION_KEYS = Object.keys(DIMENSIONS);
const MEASURE_KEYS = Object.keys(MEASURES);

function isDimensionKey(k) {
  return Object.prototype.hasOwnProperty.call(DIMENSIONS, k);
}
function isMeasureKey(k) {
  return Object.prototype.hasOwnProperty.call(MEASURES, k);
}

// ─── Semantic-query builders (port of query.go) ──────────────────
const src = (name, entity) => ({ Name: name, Entity: entity, Type: 0 });
const colExpr = (s, p) => ({ Column: { Expression: { SourceRef: { Source: s } }, Property: p } });
const colN = (c) => ({ Column: { Expression: { SourceRef: { Source: c.source } }, Property: c.prop }, Name: c.qname, NativeReferenceName: c.name });
const measureN = (c) => ({ Measure: { Expression: { SourceRef: { Source: c.source } }, Property: c.prop }, Name: c.qname, NativeReferenceName: c.name });
const lit = (v) => [{ Literal: { Value: v } }];
const inFilter = (s, p, ...vals) => ({ Condition: { In: { Expressions: [colExpr(s, p)], Values: vals } } });
const notInFilter = (s, p, ...vals) => ({ Condition: { Not: { Expression: { In: { Expressions: [colExpr(s, p)], Values: vals } } } } });

/** Power BI string literals wrap in single quotes; embedded quotes are doubled. */
function sqlLit(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * Build the ACR semantic query for an arbitrary projection. `cols` is the
 * ordered list of dimensions + measures to select (the DSR decoder maps results
 * back through this exact order). Accounts are filtered by the stable
 * `DimCustomer.TPIDTxt` key (the display name often does not byte-match the
 * dataset). When `month` is empty the FiscalMonth filter is omitted, so the
 * query returns every available month of `fiscalYear` (a time series).
 *
 * `fiscalYear` may be a single "FYnn" string or an array of them (e.g.
 * ["FY26","FY27"]) — the model retains FY-3..FY+1, so several years can be
 * projected together as one continuous monthly series.
 *
 * `opts.serviceFilter` (optional) narrows the fact rows to specific service
 * values at a given service level: `{ level: 2, values: ["Azure OpenAI", ...] }`.
 * This scopes every measure (the whole ACR calculation) to those products.
 * `opts.adjustmentScope` is "actuals" by default. The separate Anthropic spend
 * query uses "anthropic"; it must never be combined with ordinary actuals.
 */
function buildAcrQuery(cols, tpids, fiscalYear, month, opts = {}) {
  const adjustmentScope = opts.adjustmentScope ?? 'actuals';
  if (!Object.hasOwn(ACR_ADJUSTMENT_SCOPES, adjustmentScope)) {
    throw new Error(`Unknown ACR adjustment scope "${adjustmentScope}".`);
  }
  const entityMap = {
    d1: 'DimCustomer', d: 'DimDate', m: 'M_ACR', f: 'F_ACR',
    a: 'ACR_Measures', a1: 'AccountSubscriptionParameter',
    d2: 'DimViewType', a2: 'ACRFields',
  };
  const from = Object.entries(entityMap).map(([a, e]) => src(a, e));
  const select = cols.map((c) => (c.isColumn ? colN(c) : measureN(c)));

  // Normalize the fiscal-year filter to a list so one or several years can be
  // projected together (e.g. FY26 + FY27).
  const fyList = (Array.isArray(fiscalYear) ? fiscalYear : [fiscalYear])
    .map((y) => String(y || '').trim())
    .filter(Boolean);

  const measureFields = cols.filter((c) => !c.isColumn && c.measureField).map((c) => c.measureField);
  const acrFields = cols.filter((c) => c.isColumn && c.acrField).map((c) => c.acrField);
  // AccountSubscriptionParameter members default to just SubscriptionName so the
  // fact queries stay narrow; projecting a subscription-attribute dimension
  // (e.g. enrollmentName → EnrollmentCustomerName) widens the parameter so the
  // cube surfaces that attribute. Mirrors msxi-snap's SubParamFields handling.
  const subParamFields = [
    ...new Set([
      "'''F_ACR''[SubscriptionName]'",
      ...cols.filter((c) => c.subParamField).map((c) => c.subParamField),
    ]),
  ];

  const where = [
    inFilter('d1', 'TPIDTxt', ...tpids.map((t) => lit("'" + t + "'"))),
    inFilter('d', 'FiscalYear', ...fyList.map((y) => lit(sqlLit(y)))),
    inFilter('f', 'AdjustmentFlag', ...ACR_ADJUSTMENT_SCOPES[adjustmentScope].map((v) => lit(sqlLit(v)))),
    inFilter('a', 'ACR_Measures Fields', ...measureFields.map((v) => lit(v))),
    inFilter('a1', 'AccountSubscriptionParameter Fields', ...subParamFields.map((v) => lit(v))),
  ];

  // The ACRFields field-parameter activates the F_ACR dimensions being
  // projected. Only emit it when at least one such dimension is selected.
  if (acrFields.length > 0) {
    where.push({
      Condition: { In: { Expressions: [colExpr('a2', 'ACRFields Fields')], Values: acrFields.map((v) => lit(v)) } },
    });
  }

  where.push(
    inFilter('d2', 'ViewType', lit("'Curated'")),
    inFilter('d', 'FY_Rel', lit("'FY'"), lit("'FY+1'"), lit("'FY-1'"), lit("'FY-2'"), lit("'FY-3'")),
  );

  if (adjustmentScope === 'actuals') where.push(
    notInFilter('f', 'DIM_SubSegmentHierarchy_SubSegmentId',
      lit('0L'), lit('200L'), lit('222L'), lit('250L'), lit('295L'),
      lit('346L'), lit('352L'), lit('365L'), lit('400L'), lit('404L'), lit('405L')),
    notInFilter('f', 'ServiceCompGrouping', lit("'XCR - W365'")),
  );

  if (month) {
    where.push(inFilter('d', 'FiscalMonth', lit("'" + month + "'")));
  }

  // Optional product scope: narrow every measure to specific ServiceLevelN
  // values (the "apply selected products" filter). Uses the F_ACR service
  // column, and — like the projected service dims — activates it via ACRFields.
  const sf = opts.serviceFilter;
  if (sf && Number.isInteger(sf.level) && Array.isArray(sf.values) && sf.values.length > 0) {
    const prop = `ServiceLevel${sf.level}`;
    where.push(inFilter('f', prop, ...sf.values.map((v) => lit(sqlLit(v)))));
    // Ensure the ACRFields field-parameter includes this service dimension so
    // the filter binds even when it isn't among the projected columns.
    const acrFieldLit = `'''F_ACR''[${prop}]'`;
    const acrCond = where.find((w) => w?.Condition?.In?.Expressions?.[0]?.Column?.Property === 'ACRFields Fields');
    if (acrCond) {
      const vals = acrCond.Condition.In.Values;
      if (!vals.some((v) => v?.[0]?.Literal?.Value === acrFieldLit)) vals.push(lit(acrFieldLit));
    } else {
      where.push({
        Condition: { In: { Expressions: [colExpr('a2', 'ACRFields Fields')], Values: [lit(acrFieldLit)] } },
      });
    }
  }

  return { Version: 2, From: from, Select: select, Where: where };
}

function buildRequestBody(query, nCols, restartTokens) {
  const projections = Array.from({ length: nCols }, (_, i) => i);
  const window = { Count: WINDOW_SIZE };
  if (restartTokens != null) window.RestartTokens = restartTokens;
  return {
    version: '1.0.0',
    queries: [{
      Query: { Commands: [{
        SemanticQueryDataShapeCommand: {
          Query: query,
          Binding: {
            Primary: { Groupings: [{ Projections: projections, Subtotal: 0 }] },
            DataReduction: { Primary: { Window: window } },
            Version: 1,
          },
        },
      }] },
      QueryId: '',
    }],
    cancelQueries: [],
    modelId: ACR_MODEL_ID,
    userPreferredLocale: 'en-US',
  };
}

// ─── DSR decode (port of dsr.go) ─────────────────────────────────
function decodeDSRPage(ds, cols) {
  const dm0 = ds?.PH?.[0]?.DM0 ?? [];
  if (dm0.length === 0) return [];

  const schema = dm0[0].S ?? [];
  const n = schema.length;
  if (n === 0 || n !== cols.length) {
    throw new Error(`dsr: schema has ${n} columns, report defines ${cols.length}`);
  }

  const dims = cols.filter((c) => c.isColumn);
  const measures = cols.filter((c) => !c.isColumn);
  const colByPos = schema.map((sc, i) => {
    const kind = sc.N[0];
    const idx = parseInt(sc.N.slice(1), 10);
    if (kind === 'G') {
      if (idx < 0 || idx >= dims.length) throw new Error(`dsr: dimension index ${idx} out of range at position ${i}`);
      return dims[idx];
    }
    if (kind === 'M') {
      if (idx < 0 || idx >= measures.length) throw new Error(`dsr: measure index ${idx} out of range at position ${i}`);
      return measures[idx];
    }
    throw new Error(`dsr: unrecognized schema name ${sc.N} at position ${i}`);
  });

  const dicts = ds.ValueDicts ?? {};
  let prev = new Array(n).fill('');
  const rows = [];

  for (const r of dm0) {
    const rbits = BigInt(r.R ?? 0);
    const obits = BigInt(r['Ø'] ?? 0);
    const c = r.C ?? [];
    const cur = new Array(n).fill('');
    let ci = 0;
    for (let i = 0; i < n; i++) {
      const bit = 1n << BigInt(i);
      if ((obits & bit) !== 0n) {
        cur[i] = '';
      } else if ((rbits & bit) !== 0n) {
        cur[i] = prev[i];
      } else {
        if (ci >= c.length) throw new Error(`dsr: C exhausted at column ${i}`);
        cur[i] = formatValue(c[ci], schema[i], colByPos[i], dicts);
        ci++;
      }
    }
    if (ci !== c.length) throw new Error(`dsr: ${c.length} C values supplied, ${ci} consumed`);
    prev = cur;
    const row = {};
    for (let i = 0; i < n; i++) row[colByPos[i].name] = cur[i];
    rows.push(row);
  }
  return rows;
}

function formatValue(raw, sc, col, dicts) {
  if (raw == null) return '';
  if (sc.DN) {
    if (typeof raw === 'number') {
      const d = dicts[sc.DN];
      if (!d) throw new Error(`dsr: missing value dictionary ${sc.DN}`);
      if (raw < 0 || raw >= d.length) throw new Error(`dsr: dictionary ${sc.DN} index ${raw} out of range`);
      raw = d[raw];
    }
  }
  if (raw == null) return '';
  if (!col.isColumn) {
    const f = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (typeof f !== 'number' || Number.isNaN(f)) throw new Error(`dsr: measure value ${String(raw)} is not numeric`);
    return String(col.pct ? f * 100 : f);
  }
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number') return String(raw);
  throw new Error(`dsr: unexpected dimension value type ${typeof raw}`);
}

// ─── Fiscal-period helpers (port of reports.go) ──────────────────
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_INDEX = (() => {
  const m = {};
  MONTH_SHORT.forEach((s, i) => { m[s.toLowerCase()] = i; });
  MONTH_LONG.forEach((s, i) => { m[s.toLowerCase()] = i; });
  return m;
})();

/** Fiscal year for a date, e.g. "FY26" (MS FY starts July 1). */
function fyOf(d) {
  let year = d.getFullYear();
  if (d.getMonth() >= 6) year++; // Jul–Dec roll into next FY
  return 'FY' + String(year % 100).padStart(2, '0');
}

/** Fiscal-month string for a date, e.g. "FY26-Apr". */
function fyMonthOf(d) {
  return fyOf(d) + '-' + MONTH_SHORT[d.getMonth()];
}

/** Current Microsoft fiscal year string for a date, e.g. "FY26". */
function currentFiscalYear(now = new Date()) {
  return fyOf(now);
}

/**
 * The previous calendar month — the latest month with complete ACR actuals.
 * Returns both the fiscal year and the fiscal-month string the model filters on.
 */
function previousFiscalMonth(now = new Date()) {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { fiscalYear: fyOf(prev), fiscalMonth: fyMonthOf(prev) };
}

/** The current (in-progress) calendar month as a fiscal-year + fiscal-month pair. */
function currentFiscalMonth(now = new Date()) {
  return { fiscalYear: fyOf(now), fiscalMonth: fyMonthOf(now) };
}

const FY_RE = /^FY(\d{2})$/i;
const FY_MONTH_RE = /^FY(\d{2})-([A-Za-z]{3})$/i;
const YEAR_MONTH_RE = /^(\d{4})-(\d{1,2})$/;
const MONTH_YEAR_RE = /^([A-Za-z]+)\s+(\d{4})$/;

/**
 * Resolve a friendly period string into a fiscal-year anchor plus optional
 * fiscal month. Accepts "", "latest"/"previous"/"current" (latest complete
 * month), "FY26-Mar" (that fiscal month), "FY26" (whole year time series),
 * "March 2026"/"Mar 2026" and "2026-03" (calendar month). Throws on anything
 * else or a period outside the model's FY-3..FY+1 window.
 */
function resolvePeriod(input, now = new Date()) {
  const raw = (input ?? '').trim();
  if (raw === '' || /^(latest|previous|prev|current|last)$/i.test(raw)) {
    const { fiscalYear, fiscalMonth } = previousFiscalMonth(now);
    return { fiscalYear, fiscalMonth, label: fiscalMonth };
  }

  // FY26-Mar
  let m = raw.match(FY_MONTH_RE);
  if (m) {
    const fiscalYear = 'FY' + m[1];
    const mon = normalizeMonthShort(m[2]);
    if (!mon) throw periodError(raw, now);
    const fiscalMonth = `${fiscalYear}-${mon}`;
    assertFiscalYearInWindow(fiscalYear, raw, now);
    return { fiscalYear, fiscalMonth, label: fiscalMonth };
  }

  // FY26 (whole year)
  m = raw.match(FY_RE);
  if (m) {
    const fiscalYear = 'FY' + m[1];
    assertFiscalYearInWindow(fiscalYear, raw, now);
    return { fiscalYear, label: `${fiscalYear} (all months)` };
  }

  // 2026-03 or March 2026 / Mar 2026
  let calYear;
  let calMonth; // 0-based
  m = raw.match(YEAR_MONTH_RE);
  if (m) {
    calYear = parseInt(m[1], 10);
    calMonth = parseInt(m[2], 10) - 1;
  } else {
    m = raw.match(MONTH_YEAR_RE);
    if (m) {
      const idx = MONTH_INDEX[m[1].toLowerCase()];
      if (idx !== undefined) {
        calMonth = idx;
        calYear = parseInt(m[2], 10);
      }
    }
  }
  if (calYear !== undefined && calMonth !== undefined && calMonth >= 0 && calMonth <= 11) {
    const d = new Date(calYear, calMonth, 1);
    const fiscalYear = fyOf(d);
    const fiscalMonth = fyMonthOf(d);
    assertFiscalYearInWindow(fiscalYear, raw, now);
    return { fiscalYear, fiscalMonth, label: fiscalMonth };
  }

  throw periodError(raw, now);
}

function normalizeMonthShort(s) {
  const idx = MONTH_INDEX[s.toLowerCase()];
  return idx === undefined ? undefined : MONTH_SHORT[idx];
}

/** The model only retains FY-3 .. FY+1 relative to the current fiscal year. */
function assertFiscalYearInWindow(fiscalYear, raw, now) {
  const cur = parseInt(currentFiscalYear(now).slice(2), 10);
  const got = parseInt(fiscalYear.slice(2), 10);
  if (Number.isNaN(got) || got < cur - 3 || got > cur + 1) {
    throw periodError(raw, now);
  }
}

function periodError(raw, now) {
  const cur = parseInt(currentFiscalYear(now).slice(2), 10);
  const window = `FY${cur - 3}..FY${cur + 1}`;
  return new Error(
    `Unrecognized or out-of-range ACR period "${raw}". Use "latest", a fiscal month ` +
    `like "FY26-Mar", a whole fiscal year like "FY26", a calendar month like ` +
    `"March 2026" or "2026-03". The model retains ${window}.`,
  );
}

/**
 * Past + current fiscal months from the start of (currentFY-3) up to the latest
 * complete month — handy for period dropdowns / error guidance.
 */
function availableFiscalMonths(now = new Date()) {
  const latest = previousFiscalMonth(now).fiscalMonth;
  const start = new Date(now.getFullYear() - 4, now.getMonth(), 1);
  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  while (cursor <= end) {
    out.push(fyMonthOf(cursor));
    if (out[out.length - 1] === latest) break;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

/** Fiscal years available in the model's FY-3..FY+1 window, newest first. */
function availableFiscalYears(now = new Date()) {
  const cur = parseInt(currentFiscalYear(now).slice(2), 10);
  const out = [];
  // Ascending, oldest first (FY24 leftmost). Exclude the next/future fiscal
  // year — it is too far out to have meaningful ACR actuals.
  for (let y = cur - 3; y <= cur; y++) out.push('FY' + String(y).padStart(2, '0'));
  return out;
}

// ─── Pure numeric helpers + row shaping ──────────────────────────
function toNum(v) {
  const n = parseFloat(v ?? '');
  return Number.isNaN(n) ? 0 : n;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Convert decoded string rows to objects with numeric measures. */
function shapeRows(rows, dims, measures) {
  return rows.map((r) => {
    const out = {};
    for (const d of dims) out[d.name] = r[d.name] ?? '';
    for (const m of measures) out[m.name] = round(toNum(r[m.name]), 2);
    return out;
  });
}

/**
 * Nest flat service rows into a full Service-Level hierarchy tree.
 *
 * Given shaped rows keyed by serviceLevel1..N + a fiscal-month + a measure,
 * builds a tree where each node accumulates its (and its descendants') monthly
 * series + total — so selecting level 5 shows L1 › L2 › … › L5 grouped, with a
 * subtotal at every level (mirrors the Power BI matrix visual).
 *
 * @param {object[]} rows        Shaped rows (from shapeRows).
 * @param {string[]} levelKeys   Ordered dim names, e.g. ['serviceLevel1',…,'serviceLevel5'].
 * @param {object} [opts]
 * @param {string} [opts.monthKey='fiscalMonth']
 * @param {string} [opts.valueKey='acr']
 * @returns {{ tree: object[], months: string[], grandTotal: number }}
 */
function nestServiceHierarchy(rows, levelKeys, opts = {}) {
  const monthKey = opts.monthKey || 'fiscalMonth';
  const valueKey = opts.valueKey || 'acr';
  const roots = new Map();
  const monthSet = new Set();
  let grandTotal = 0;

  for (const r of rows || []) {
    const fm = String(r[monthKey] ?? '').trim();
    if (!fm) continue;
    const amount = Number(r[valueKey]) || 0;
    monthSet.add(fm);
    grandTotal += amount;

    let levelMap = roots;
    const pathParts = [];
    for (let i = 0; i < levelKeys.length; i += 1) {
      const name = String(r[levelKeys[i]] ?? '').trim() || '(Unassigned)';
      pathParts.push(name);
      if (!levelMap.has(name)) {
        levelMap.set(name, { level: i + 1, name, path: pathParts.join(' \u203a '), monthly: {}, total: 0, _children: new Map() });
      }
      const node = levelMap.get(name);
      node.monthly[fm] = (node.monthly[fm] || 0) + amount;
      node.total += amount;
      levelMap = node._children;
    }
  }

  const finalize = (map) => [...map.values()]
    .map((n) => {
      const children = finalize(n._children);
      const node = { level: n.level, name: n.name, path: n.path, monthly: n.monthly, total: round(n.total, 2) };
      if (children.length) node.children = children;
      return node;
    })
    .sort((a, b) => b.total - a.total);

  return { tree: finalize(roots), months: orderFiscalMonths([...monthSet]), grandTotal: round(grandTotal, 2) };
}

// ─── Calendar helpers ────────────────────────────────────────────
const FY_MONTH_PARSE = /^FY(\d{2})-([A-Za-z]{3})$/;

/** Map a fiscal-month string ("FY26-May") to its calendar year + 0-based month. */
function fiscalMonthToCalendar(fiscalMonth) {
  const m = String(fiscalMonth).trim().match(FY_MONTH_PARSE);
  if (!m) throw new Error(`fiscalMonthToCalendar: cannot parse "${fiscalMonth}"`);
  const fyYear = 2000 + parseInt(m[1], 10);
  const monthIdx = MONTH_INDEX[m[2].toLowerCase()];
  if (monthIdx === undefined) throw new Error(`fiscalMonthToCalendar: bad month in "${fiscalMonth}"`);
  // Jul–Dec belong to the prior calendar year of a Microsoft fiscal year.
  const year = monthIdx >= 6 ? fyYear - 1 : fyYear;
  return { year, monthIdx };
}

/** "FY26-May" → "May 2026". Falls back to the raw value when unparseable. */
function fiscalToCalendarLabel(fm) {
  try {
    const { year, monthIdx } = fiscalMonthToCalendar(fm);
    return `${MONTH_LONG[monthIdx]} ${year}`;
  } catch {
    return fm;
  }
}

/** Chronological comparator for fiscal-month strings. */
function compareFiscalMonths(a, b) {
  const ca = fiscalMonthToCalendar(a);
  const cb = fiscalMonthToCalendar(b);
  return (ca.year - cb.year) || (ca.monthIdx - cb.monthIdx);
}

/** Sort fiscal-month strings oldest → newest. */
function orderFiscalMonths(months) {
  return [...months].sort(compareFiscalMonths);
}

/** Calendar days in the month a fiscal-month maps to (handles Feb/leap years). */
function daysInFiscalMonth(fiscalMonth) {
  const { year, monthIdx } = fiscalMonthToCalendar(fiscalMonth);
  return new Date(year, monthIdx + 1, 0).getDate();
}

module.exports = {
  ACR_MODEL_ID,
  WINDOW_SIZE,
  DIMENSIONS,
  MEASURES,
  DIMENSION_KEYS,
  MEASURE_KEYS,
  isDimensionKey,
  isMeasureKey,
  buildAcrQuery,
  buildRequestBody,
  decodeDSRPage,
  formatValue,
  MONTH_SHORT,
  MONTH_LONG,
  MONTH_INDEX,
  fyOf,
  fyMonthOf,
  currentFiscalYear,
  previousFiscalMonth,
  currentFiscalMonth,
  resolvePeriod,
  availableFiscalMonths,
  availableFiscalYears,
  toNum,
  round,
  shapeRows,
  nestServiceHierarchy,
  fiscalMonthToCalendar,
  fiscalToCalendarLabel,
  compareFiscalMonths,
  orderFiscalMonths,
  daysInFiscalMonth,
};
