'use strict';

// Derive only additive ACR from a complete, same-account/same-identity superset.
// Percentages and averages cannot be summed, and account names are not TPID keys.
function projectCachedAcr(rows, stored, requested) {
  const sameSet = (a, b) => JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());
  const years = value => (Array.isArray(value) ? value : [value]).filter(year => typeof year === 'string' && /^FY\d{2}$/.test(year));
  const storedYears = years(stored.fy);
  const requestedYears = years(requested.fy);
  if (!Array.isArray(stored.cols) || !Array.isArray(requested.cols)
    || stored.identity !== requested.identity || !Array.isArray(stored.tpids) || !sameSet(stored.tpids, requested.tpids)
    || (stored.adjustmentScope || 'actuals') !== (requested.adjustmentScope || 'actuals')
    || stored.month !== '' || requested.month !== ''
    || !requestedYears.length || !requestedYears.every(year => storedYears.includes(year))) return null;
  const columns = new Set(stored.cols);
  if (!requested.cols.every(column => columns.has(column)) || !columns.has('fiscalMonth')) return null;
  const measures = stored.cols.filter(column => ![
    'account', 'tpid', 'fiscalMonth', 'fiscalQuarter', 'serviceLevel1', 'serviceLevel2', 'serviceLevel3',
    'serviceLevel4', 'serviceLevel5', 'serviceGroup', 'serviceInfluencer', 'subscription',
    'enrollmentName', 'strategicPillar', 'subStrategicPillar', 'superStrategicPillar',
  ].includes(column));
  if (measures.length !== 1 || measures[0] !== 'acr' || !requested.cols.includes('acr')) return null;
  const filter = requested.sf;
  const sourceFilter = stored.sf;
  if (sourceFilter?.values?.length && (!filter?.values?.length
    || sourceFilter.level !== filter.level
    || !filter.values.every(value => sourceFilter.values.includes(value)))) return null;
  const sameFilter = (!filter?.values?.length && !sourceFilter?.values?.length)
    || (filter?.level === sourceFilter?.level && sameSet(filter?.values || [], sourceFilter?.values || []));
  const filterColumn = filter?.values?.length ? `serviceLevel${filter.level}` : null;
  if (!sameFilter && filterColumn && !columns.has(filterColumn)) return null;

  const dims = requested.cols.filter(column => column !== 'acr');
  const result = new Map();
  for (const row of rows) {
    if (!requestedYears.includes(String(row.fiscalMonth || '').slice(0, 4))) continue;
    if (!sameFilter && filterColumn && !filter.values.includes(row[filterColumn])) continue;
    if (dims.some(column => !Object.hasOwn(row, column)) || !Number.isFinite(Number(row.acr))) return null;
    const key = JSON.stringify(dims.map(column => row[column]));
    if (!result.has(key)) result.set(key, { ...Object.fromEntries(dims.map(column => [column, row[column]])), acr: 0 });
    result.get(key).acr += Number(row.acr);
  }
  return [...result.values()];
}

module.exports = { projectCachedAcr };
