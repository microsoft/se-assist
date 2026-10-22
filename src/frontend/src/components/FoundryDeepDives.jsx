import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Select, Spinner } from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  DismissRegular,
  OpenRegular,
} from '@fluentui/react-icons';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  foundryUsageCustomer,
  foundryUsagePortfolio,
  openExternal,
} from '../electronBridge';
import { formatLocalDateTime } from '../lib/datetime';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
  'var(--chart-9)',
  'var(--chart-10)',
];

const EMPTY_FILTERS = {
  week: '',
  subscriptionId: '',
  region: '',
  providerType: '',
  model: '',
  modelVersion: '',
  offeringName: '',
  engagementLevel: '',
};

const FILTER_FIELDS = [
  ['week', 'Week'],
  ['subscriptionId', 'Subscription'],
  ['region', 'Region'],
  ['providerType', 'Provider type'],
  ['model', 'Model'],
  ['modelVersion', 'Model version'],
  ['offeringName', 'Offering'],
  ['engagementLevel', 'Engagement level'],
];

const ENGAGEMENT_RANK = {
  Free: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

function formatTokens(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(number >= 100e9 ? 1 : 2)}bn`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(number >= 100e6 ? 1 : 2)}m`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(number >= 100e3 ? 1 : 2)}k`;
  return Math.round(number).toLocaleString();
}

function formatWeek(value) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatMonth(value) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function monthKey(value) {
  return value ? value.slice(0, 7) : '';
}

function ErrorCard({ message, onRetry }) {
  return (
    <div className="card">
      <div className="card-body-custom">
        <div className="foundry-error" role="alert">{message}</div>
        <div className="foundry-help">
          Sign in with Microsoft in User Home, confirm the source report opens, and connect to corpnet/VPN.
        </div>
        <Button style={{ marginTop: 12 }} onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat-card foundry-stat">
      <div className="foundry-stat-label">{label}</div>
      <div className="foundry-stat-value">{value}</div>
      {sub ? <div className="foundry-stat-sub">{sub}</div> : null}
    </div>
  );
}

function optionsFor(rows, key, { descending = false } = {}) {
  const values = [...new Set(rows.map((row) => row[key]).filter(Boolean))];
  return values.sort((left, right) => (
    descending ? right.localeCompare(left) : left.localeCompare(right)
  ));
}

function enrichWithEngagement(rows, engagement) {
  const monthlyByCustomer = new Map();
  for (const entry of engagement || []) {
    const key = entry.cloudCustomerGuid;
    if (!key) continue;
    if (!monthlyByCustomer.has(key)) monthlyByCustomer.set(key, new Map());
    const monthly = monthlyByCustomer.get(key);
    const month = monthKey(entry.month);
    const existing = monthly.get(month);
    const existingRank = ENGAGEMENT_RANK[existing?.level] ?? -1;
    const nextRank = ENGAGEMENT_RANK[entry.level] ?? -1;
    if (!existing || nextRank > existingRank || (nextRank === existingRank && entry.customerUnits > existing.customerUnits)) {
      monthly.set(month, entry);
    }
  }

  const timelines = new Map();
  for (const [guid, monthly] of monthlyByCustomer) {
    timelines.set(guid, [...monthly.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  return (rows || []).map((row) => {
    const rowMonth = monthKey(row.month || row.week);
    const timeline = timelines.get(row.cloudCustomerGuid) || [];
    let match = null;
    for (const [month, entry] of timeline) {
      if (month > rowMonth) break;
      match = entry;
    }
    return {
      ...row,
      engagementLevel: match?.level || 'Unclassified',
      customerUnits: match?.customerUnits || 0,
    };
  });
}

function filteredUsage(rows, filters) {
  return rows.filter((row) => (
    (!filters.week || row.week === filters.week)
    && (!filters.subscriptionId || row.subscriptionId === filters.subscriptionId)
    && (!filters.region || row.region === filters.region)
    && (!filters.providerType || row.providerType === filters.providerType)
    && (!filters.model || row.model === filters.model)
    && (!filters.modelVersion || row.modelVersion === filters.modelVersion)
    && (!filters.offeringName || row.offeringName === filters.offeringName)
    && (!filters.engagementLevel || row.engagementLevel === filters.engagementLevel)
  ));
}

function aggregateDimension(rows, key) {
  const totals = new Map();
  for (const row of rows) {
    const name = row[key] || 'Unspecified';
    totals.set(name, (totals.get(name) || 0) + row.tokens);
  }
  return [...totals.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
}

function weeklySeries(rows, key, limit) {
  const dimensions = aggregateDimension(rows, key);
  const top = new Set(dimensions.slice(0, limit).map((row) => row.name));
  const series = dimensions.length > limit
    ? [...dimensions.slice(0, limit).map((row) => row.name), 'Other']
    : dimensions.map((row) => row.name);
  const weeks = new Map();
  for (const row of rows) {
    const week = row.week;
    if (!week) continue;
    if (!weeks.has(week)) weeks.set(week, { week, label: formatWeek(week), total: 0 });
    const bucket = weeks.get(week);
    const name = top.has(row[key]) || dimensions.length <= limit ? (row[key] || 'Unspecified') : 'Other';
    bucket[name] = (bucket[name] || 0) + row.tokens;
    bucket.total += row.tokens;
  }
  return {
    data: [...weeks.values()].sort((left, right) => left.week.localeCompare(right.week)),
    series,
  };
}

function monthlyEngagement(rows) {
  const months = new Map();
  for (const row of rows) {
    const month = monthKey(row.month || row.week);
    if (!month) continue;
    if (!months.has(month)) {
      months.set(month, {
        month,
        label: formatMonth(`${month}-01T00:00:00.000Z`),
      });
    }
    const bucket = months.get(month);
    const level = row.engagementLevel || 'Unclassified';
    bucket[level] = (bucket[level] || 0) + row.tokens;
  }
  const data = [...months.values()].sort((left, right) => left.month.localeCompare(right.month));
  const levels = [...new Set(rows.map((row) => row.engagementLevel || 'Unclassified'))]
    .sort((left, right) => (
      (ENGAGEMENT_RANK[left] ?? 99) - (ENGAGEMENT_RANK[right] ?? 99)
      || left.localeCompare(right)
    ));
  return { data, levels };
}

function usageMatrix(rows) {
  const weeks = optionsFor(rows, 'week');
  const groups = new Map();
  for (const row of rows) {
    const key = [row.subscriptionId, row.offeringName, row.model, row.modelVersion].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        subscriptionId: row.subscriptionId,
        offeringName: row.offeringName,
        model: row.model,
        modelVersion: row.modelVersion,
        total: 0,
        weeks: {},
      });
    }
    const group = groups.get(key);
    group.total += row.tokens;
    group.weeks[row.week] = (group.weeks[row.week] || 0) + row.tokens;
  }
  return {
    weeks,
    rows: [...groups.values()]
      .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key))
      .slice(0, 60),
    totalRows: groups.size,
  };
}

function StackedWeeklyChart({ title, rows, dimension, limit = 8 }) {
  const chart = useMemo(() => weeklySeries(rows, dimension, limit), [rows, dimension, limit]);
  return (
    <div className="card foundry-chart-card">
      <div className="card-header-custom">{title}</div>
      <div className="card-body-custom foundry-chart-body" aria-label={title}>
        {chart.data.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart.data} margin={{ top: 10, right: 12, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} />
              <YAxis tickFormatter={formatTokens} stroke="var(--text-muted)" fontSize={11} width={58} />
              <Tooltip formatter={(value, name) => [formatTokens(value), name]} />
              <Legend />
              {chart.series.map((name, index) => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="tokens"
                  fill={CHART_COLORS[index % CHART_COLORS.length]}
                  maxBarSize={52}
                />
              ))}
              <Line
                type="monotone"
                dataKey="total"
                name="Total"
                stroke="var(--pink)"
                strokeWidth={3}
                dot={{ r: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : <div className="foundry-empty">No token usage matches these filters.</div>}
      </div>
    </div>
  );
}

export default function FoundryDeepDives() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTpid = (searchParams.get('tpid') || '').trim();
  const [portfolio, setPortfolio] = useState(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [actionError, setActionError] = useState('');
  const [openingReport, setOpeningReport] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const portfolioRequest = useRef(0);
  const detailRequest = useRef(0);

  const loadPortfolio = useCallback(async (force = false) => {
    const requestId = ++portfolioRequest.current;
    setPortfolioLoading(true);
    setPortfolioError('');
    try {
      const result = await foundryUsagePortfolio({ force });
      if (requestId !== portfolioRequest.current) return null;
      if (!result?.ok) throw new Error(result?.error || 'Foundry Deep-Dives is unavailable.');
      setPortfolio(result);
      return result;
    } catch (error) {
      if (requestId === portfolioRequest.current) {
        setPortfolioError(error.message || String(error));
      }
      return null;
    } finally {
      if (requestId === portfolioRequest.current) setPortfolioLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (tpid, force = false) => {
    if (!tpid) return null;
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError('');
    if (!force) setDetail(null);
    try {
      const result = await foundryUsageCustomer({ tpid, force });
      if (requestId !== detailRequest.current) return null;
      if (!result?.ok) throw new Error(result?.error || 'Customer token usage is unavailable.');
      setDetail(result);
      return result;
    } catch (error) {
      if (requestId === detailRequest.current) {
        setDetailError(error.message || String(error));
      }
      return null;
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPortfolio(false);
    return () => { portfolioRequest.current += 1; };
  }, [loadPortfolio]);

  useEffect(() => {
    const customers = portfolio?.customers || [];
    if (customers.length && !customers.some((customer) => customer.tpid === selectedTpid)) {
      const next = new URLSearchParams(searchParams);
      next.set('tpid', customers[0].tpid);
      setSearchParams(next, { replace: true });
    }
  }, [portfolio?.customers, searchParams, selectedTpid, setSearchParams]);

  useEffect(() => {
    setFilters(EMPTY_FILTERS);
    if (selectedTpid) loadDetail(selectedTpid, false);
    return () => { detailRequest.current += 1; };
  }, [selectedTpid, loadDetail]);

  const selectedCustomer = portfolio?.customers?.find((row) => row.tpid === selectedTpid);
  const enrichedRows = useMemo(
    () => enrichWithEngagement(detail?.rows || [], detail?.engagement || []),
    [detail?.rows, detail?.engagement],
  );
  const filteredRows = useMemo(
    () => filteredUsage(enrichedRows, filters),
    [enrichedRows, filters],
  );
  const weeklyTotals = useMemo(
    () => weeklySeries(filteredRows, 'offeringName', 6).data,
    [filteredRows],
  );
  const offeringMix = useMemo(
    () => aggregateDimension(filteredRows, 'offeringName'),
    [filteredRows],
  );
  const regionChart = useMemo(
    () => weeklySeries(filteredRows, 'region', 8),
    [filteredRows],
  );
  const engagementChart = useMemo(
    () => monthlyEngagement(filteredRows),
    [filteredRows],
  );
  const matrix = useMemo(() => usageMatrix(filteredRows), [filteredRows]);

  const totalTokens = filteredRows.reduce((sum, row) => sum + row.tokens, 0);
  const latestWeek = weeklyTotals.at(-1);
  const peakWeek = weeklyTotals.reduce(
    (peak, row) => (!peak || row.total > peak.total ? row : peak),
    null,
  );
  const activeFilters = Object.values(filters).filter(Boolean).length;

  const filterOptions = useMemo(() => ({
    week: optionsFor(enrichedRows, 'week', { descending: true }),
    subscriptionId: optionsFor(enrichedRows, 'subscriptionId'),
    region: optionsFor(enrichedRows, 'region'),
    providerType: optionsFor(enrichedRows, 'providerType'),
    model: optionsFor(enrichedRows, 'model'),
    modelVersion: optionsFor(enrichedRows, 'modelVersion'),
    offeringName: optionsFor(enrichedRows, 'offeringName'),
    engagementLevel: optionsFor(enrichedRows, 'engagementLevel'),
  }), [enrichedRows]);

  const refresh = async () => {
    const portfolioResult = await loadPortfolio(true);
    if (selectedTpid && portfolioResult) await loadDetail(selectedTpid, true);
  };

  const selectCustomer = (tpid) => {
    const next = new URLSearchParams(searchParams);
    next.set('tpid', tpid);
    setSearchParams(next);
  };

  const openReport = async () => {
    const reportUrl = detail?.reportUrl || portfolio?.reportUrl;
    if (!reportUrl) {
      setActionError('The source Power BI report URL is unavailable.');
      return;
    }
    setOpeningReport(true);
    setActionError('');
    try {
      await openExternal(reportUrl);
    } catch (error) {
      setActionError(`Could not open the source report: ${error.message || String(error)}`);
    } finally {
      setOpeningReport(false);
    }
  };

  const freshness = detail || portfolio;
  const loading = portfolioLoading || detailLoading;

  return (
    <div className="foundry-page">
      <div className="page-header foundry-header">
        <div>
          <h2>Foundry Deep-Dives</h2>
          <p>3P Weekly Tokens · rolling 90-day usage for your configured customer roster.</p>
        </div>
        <div className="foundry-header-actions">
          <Button icon={<ArrowSyncRegular />} onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            appearance="primary"
            icon={openingReport ? <Spinner size="tiny" /> : <OpenRegular />}
            onClick={openReport}
            disabled={openingReport || !freshness?.reportUrl}
          >
            Open source report
          </Button>
        </div>
      </div>

      {actionError ? <div className="flash-message flash-error" role="alert">{actionError}</div> : null}
      {freshness?.sourceRefreshError ? (
        <div className="flash-message flash-warning" role="alert">
          Usage loaded, but Power BI freshness could not be verified: {freshness.sourceRefreshError}
        </div>
      ) : null}
      {portfolioError && portfolio ? (
        <div className="flash-message flash-error" role="alert">
          Refresh failed. Existing data remains visible. {portfolioError}
        </div>
      ) : null}

      {portfolioError && !portfolio ? (
        <ErrorCard message={portfolioError} onRetry={() => loadPortfolio(true)} />
      ) : (
        <>
          <div className="card foundry-filter-card">
            <div className="card-header-custom foundry-filter-heading">
              <span>Filters</span>
              {activeFilters ? (
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DismissRegular />}
                  onClick={() => setFilters(EMPTY_FILTERS)}
                >
                  Clear {activeFilters}
                </Button>
              ) : null}
            </div>
            <div className="card-body-custom foundry-filter-grid">
              <label className="foundry-filter foundry-filter-customer">
                <span>Customer</span>
                <Select
                  value={selectedTpid}
                  onChange={(event) => selectCustomer(event.target.value)}
                  disabled={!portfolio?.customers?.length}
                >
                  {(portfolio?.customers || []).map((customer) => (
                    <option key={customer.tpid} value={customer.tpid}>
                      {customer.customerName} · {formatTokens(customer.tokens)}
                    </option>
                  ))}
                </Select>
              </label>
              {FILTER_FIELDS.map(([key, label]) => (
                <label className="foundry-filter" key={key}>
                  <span>{label}</span>
                  <Select
                    value={filters[key]}
                    onChange={(event) => setFilters((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))}
                    disabled={!detail || detailLoading}
                  >
                    <option value="">All</option>
                    {(filterOptions[key] || []).map((value) => (
                      <option key={value} value={value}>
                        {key === 'week' ? formatWeek(value) : value}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          </div>

          {detailError ? (
            <ErrorCard message={detailError} onRetry={() => loadDetail(selectedTpid, true)} />
          ) : detailLoading && !detail ? (
            <div className="card">
              <div className="card-body-custom foundry-loading">
                <Spinner size="small" /> Loading 90-day token usage…
              </div>
            </div>
          ) : detail ? (
            <>
              <div className="foundry-stats">
                <Stat
                  label={activeFilters ? 'Filtered tokens' : '90-day tokens'}
                  value={formatTokens(totalTokens)}
                  sub={`${filteredRows.length.toLocaleString()} aggregated rows`}
                />
                <Stat
                  label="Latest week"
                  value={formatTokens(latestWeek?.total || 0)}
                  sub={latestWeek ? `Week ending ${latestWeek.label}` : 'No usage'}
                />
                <Stat
                  label="Peak week"
                  value={formatTokens(peakWeek?.total || 0)}
                  sub={peakWeek ? `Week ending ${peakWeek.label}` : 'No usage'}
                />
                <Stat
                  label="Subscriptions"
                  value={new Set(filteredRows.map((row) => row.subscriptionId).filter(Boolean)).size}
                  sub={`${new Set(filteredRows.map((row) => row.model).filter(Boolean)).size} models`}
                />
                <Stat
                  label="Regions"
                  value={new Set(filteredRows.map((row) => row.region).filter(Boolean)).size}
                  sub={selectedCustomer?.lastUsageAt ? `Last usage ${formatWeek(selectedCustomer.lastUsageAt)}` : ''}
                />
              </div>

              <div className="foundry-chart-grid foundry-chart-grid-top">
                <div className="card foundry-chart-card">
                  <div className="card-header-custom">Tokens by offering</div>
                  <div className="card-body-custom foundry-chart-body" aria-label="Tokens by offering">
                    {offeringMix.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={offeringMix}
                            dataKey="tokens"
                            nameKey="name"
                            innerRadius={55}
                            outerRadius={95}
                            paddingAngle={2}
                          >
                            {offeringMix.map((row, index) => (
                              <Cell key={row.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(value, name) => [formatTokens(value), name]} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : <div className="foundry-empty">No offering data matches these filters.</div>}
                  </div>
                </div>

                <div className="card foundry-chart-card">
                  <div className="card-header-custom">Tokens by week</div>
                  <div className="card-body-custom foundry-week-table-wrap">
                    <table className="data-table foundry-week-table">
                      <thead>
                        <tr><th>Week ending</th><th>Tokens</th></tr>
                      </thead>
                      <tbody>
                        {[...weeklyTotals].reverse().map((row) => (
                          <tr key={row.week}>
                            <td>{row.label}</td>
                            <td className="foundry-number">{formatTokens(row.total)}</td>
                          </tr>
                        ))}
                        {!weeklyTotals.length ? (
                          <tr><td colSpan={2} className="foundry-empty-cell">No weekly usage.</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <StackedWeeklyChart
                title="Tokens by week and offering"
                rows={filteredRows}
                dimension="offeringName"
                limit={6}
              />

              <StackedWeeklyChart
                title="Tokens by week and model"
                rows={filteredRows}
                dimension="model"
                limit={10}
              />

              <div className="foundry-chart-grid">
                <div className="card foundry-chart-card">
                  <div className="card-header-custom">Tokens by week and region</div>
                  <div className="card-body-custom foundry-chart-body" aria-label="Tokens by week and region">
                    {regionChart.data.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={regionChart.data} margin={{ top: 10, right: 12, bottom: 8, left: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} />
                          <YAxis tickFormatter={formatTokens} stroke="var(--text-muted)" fontSize={11} width={58} />
                          <Tooltip formatter={(value, name) => [formatTokens(value), name]} />
                          <Legend />
                          {regionChart.series.map((name, index) => (
                            <Line
                              key={name}
                              type="monotone"
                              dataKey={name}
                              stroke={CHART_COLORS[index % CHART_COLORS.length]}
                              strokeWidth={2}
                              dot={false}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    ) : <div className="foundry-empty">No region data matches these filters.</div>}
                  </div>
                </div>

                <div className="card foundry-chart-card">
                  <div className="card-header-custom">Tokens by engagement level</div>
                  <div className="card-body-custom foundry-chart-body" aria-label="Tokens by engagement level">
                    {engagementChart.data.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={engagementChart.data} margin={{ top: 10, right: 12, bottom: 8, left: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} />
                          <YAxis tickFormatter={formatTokens} stroke="var(--text-muted)" fontSize={11} width={58} />
                          <Tooltip formatter={(value, name) => [formatTokens(value), name]} />
                          <Legend />
                          {engagementChart.levels.map((level, index) => (
                            <Line
                              key={level}
                              type="monotone"
                              dataKey={level}
                              stroke={CHART_COLORS[index % CHART_COLORS.length]}
                              strokeWidth={3}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    ) : <div className="foundry-empty">No engagement data matches these filters.</div>}
                  </div>
                  <div className="foundry-engagement-legend">
                    <strong>Engagement levels (CU)</strong>
                    <span>Free: $0</span>
                    <span>L1: $0.01–$50</span>
                    <span>L2: $50–$10k</span>
                    <span>L3: $10k–$100k</span>
                    <span>L4: $100k–$1M</span>
                    <span>L5: Over $1M</span>
                  </div>
                </div>
              </div>

              <div className="card foundry-matrix-card">
                <div className="card-header-custom foundry-matrix-heading">
                  <span>Customer / subscription / offering / model</span>
                  <span>
                    Top {matrix.rows.length.toLocaleString()} of {matrix.totalRows.toLocaleString()} rows by tokens
                  </span>
                </div>
                <div className="card-body-custom foundry-matrix-wrap">
                  <table className="data-table foundry-matrix">
                    <thead>
                      <tr>
                        <th>Subscription</th>
                        <th>Offering</th>
                        <th>Model</th>
                        {matrix.weeks.map((week) => <th key={week}>{formatWeek(week)}</th>)}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.rows.map((row) => (
                        <tr key={row.key}>
                          <td className="foundry-mono">{row.subscriptionId || 'Unspecified'}</td>
                          <td>{row.offeringName}</td>
                          <td>
                            {row.model}
                            {row.modelVersion && row.modelVersion !== 'Unspecified'
                              ? <span className="foundry-model-version"> · {row.modelVersion}</span>
                              : null}
                          </td>
                          {matrix.weeks.map((week) => (
                            <td key={week} className="foundry-number">
                              {row.weeks[week] ? formatTokens(row.weeks[week]) : '—'}
                            </td>
                          ))}
                          <td className="foundry-number foundry-total">{formatTokens(row.total)}</td>
                        </tr>
                      ))}
                      {!matrix.rows.length ? (
                        <tr>
                          <td colSpan={matrix.weeks.length + 4} className="foundry-empty-cell">
                            No detail rows match these filters.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="foundry-source-line">
                <span>Source: {detail.source}</span>
                <span>Queried {formatLocalDateTime(detail.fetchedAt)}</span>
                {detail.sourceRefreshedAt ? (
                  <span>Semantic model refreshed {formatLocalDateTime(detail.sourceRefreshedAt)}</span>
                ) : null}
                <span>Cache: up to 15 minutes · Refresh bypasses it</span>
              </div>
              <div className="foundry-source-note">
                Engagement uses the highest band returned for each cloud customer and month, carrying the latest published band forward until a newer month is available.
              </div>
            </>
          ) : portfolioLoading ? (
            <div className="card">
              <div className="card-body-custom foundry-loading">
                <Spinner size="small" /> Loading Foundry customer usage…
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-body-custom foundry-empty">
                No rolling 90-day token usage was found for the configured customer roster.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
