// Shared formatting + small helpers for the ACR (Azure Consumption) surfaces.

// Compact USD, e.g. $1.2M / $840.0K / $512. Handles negatives.
export function fmtUsd(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// Full USD with thousands separators (used for titles/tooltips).
export function fmtUsdFull(n) {
  return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Signed percent, e.g. +12.3% / -8.0% / — (null).
export function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// "FY26-Jul" → "Jul".
export function monthAbbr(fm) {
  const m = String(fm || '').match(/-([A-Za-z]{3})$/);
  return m ? m[1] : String(fm || '');
}

// "FY26-Jul" → "Jul FY26" for tooltips / labels where duplicate month names
// would otherwise be ambiguous across multiple fiscal years.
export function formatFiscalMonth(fm) {
  const s = String(fm || '');
  const m = s.match(/^(FY\d+)-([A-Za-z]{3})$/);
  if (!m) return s;
  return `${m[2]} ${m[1]}`;
}

// Trend/MoM color: green up, red/pink down, muted flat.
export function trendColor(v) {
  const n = Number(v) || 0;
  if (n > 0) return 'var(--success-text)';
  if (n < 0) return 'var(--pink)';
  return 'var(--text-muted)';
}

// Chronological sort for fiscal months. The fiscal year starts in July, so
// "FY26-Jul" precedes "FY26-Aug" … "FY26-Jun". Use as an Array#sort comparator.
const FISCAL_MONTH_ORDER = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
function fiscalMonthSortKey(fm) {
  const m = String(fm || '').match(/^FY(\d+)-([A-Za-z]{3})$/);
  if (!m) return [9999, 99];
  return [Number(m[1]), FISCAL_MONTH_ORDER.indexOf(m[2])];
}
export function fiscalMonthCompare(a, b) {
  const ka = fiscalMonthSortKey(a);
  const kb = fiscalMonthSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1];
}

// Normalize an account/customer name for cross-source matching (ACR model's
// TPAccountName vs the local customers table name).
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|corp|corporation|company|co|ltd|llc|plc|group|holdings|sa|ag|nv)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Default fiscal year for every ACR surface. Pinned to FY26 for now — the latest FY
// with complete actuals (the period list otherwise leads with the upcoming FY, which
// has little/no data). The year pickers still let the user choose any available year.
export const DEFAULT_ACR_FY = 'FY26';

// Resolve which fiscal year to preselect: the pinned default when it's in the available
// list, else the first (most recent) option, else ''.
export function defaultFiscalYear(fiscalYears) {
  const list = Array.isArray(fiscalYears) ? fiscalYears : [];
  if (list.includes(DEFAULT_ACR_FY)) return DEFAULT_ACR_FY;
  return list[0] || '';
}
