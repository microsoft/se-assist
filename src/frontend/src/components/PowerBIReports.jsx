import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Input, Select, Spinner } from '@fluentui/react-components';
import {
  ArrowLeftRegular,
  ArrowSyncRegular,
  OpenRegular,
} from '@fluentui/react-icons';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  capacityPortfolio,
  customerCapacity,
  customerCapacitySubscriptions,
  openExternal,
} from '../electronBridge';
import { useDbQuery } from '../hooks/useDb';
import { useRosterTpids } from '../hooks/useRosterTpids';
import { fmtPct, fmtUsd } from '../lib/acrFormat';
import { formatLocalDateTime } from '../lib/datetime';

const MODEL_CHART_LIMIT = 15;

function compactCapacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number);
}

function CapacityKpi({ label, value, sub, color }) {
  return (
    <div className="stat-card" style={{ flex: 1, minWidth: 160 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 25, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      {sub != null && sub !== '' && (
        <div style={{ fontSize: 12, color: color || 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function ErrorState({ message, retry }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-body-custom">
        <div style={{ color: 'var(--danger-text)', fontSize: 13 }}>{message}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 5 }}>
          Sign in with Microsoft in User Home and connect to corpnet/VPN, then retry.
        </div>
        <Button style={{ marginTop: 12 }} onClick={retry}>Retry</Button>
      </div>
    </div>
  );
}

function aggregateCustomersForModel(rows, model, unit) {
  if (!model) return null;
  const customers = new Map();
  for (const row of rows || []) {
    if (row.model !== model || row.unit !== unit) continue;
    const key = row.tpid || row.customerName;
    if (!customers.has(key)) {
      customers.set(key, {
        tpid: row.tpid,
        customerName: row.customerName,
        approved: 0,
        deployed: 0,
        available: 0,
        models: new Set(),
      });
    }
    const customer = customers.get(key);
    customer.approved += Number(row.approved) || 0;
    customer.deployed += Number(row.deployed) || 0;
    customer.available += Number(row.available) || 0;
    customer.models.add(row.model);
  }
  return [...customers.values()]
    .map((row) => ({
      ...row,
      modelCount: row.models.size,
      deployedPct: row.approved > 0 ? row.deployed / row.approved : 0,
    }))
    .sort((left, right) => (
      right.approved - left.approved
      || left.customerName.localeCompare(right.customerName)
    ));
}

function PortfolioView({
  data,
  loading,
  onRefresh,
  onSelectCustomer,
}) {
  const [modelFilter, setModelFilter] = useState('');
  const [quotaUnit, setQuotaUnit] = useState('TPM');
  const [search, setSearch] = useState('');
  const unitModels = (data?.models || []).filter((row) => row.unit === quotaUnit);
  const chartData = unitModels.slice(0, MODEL_CHART_LIMIT);
  const modelCustomers = useMemo(
    () => aggregateCustomersForModel(data?.rows, modelFilter, quotaUnit),
    [data?.rows, modelFilter, quotaUnit],
  );
  const customers = (modelCustomers || (data?.customers || []).filter((row) => row.unit === quotaUnit)).filter((customer) => {
    const query = search.trim().toLowerCase();
    return !query
      || customer.customerName.toLowerCase().includes(query)
      || String(customer.tpid).includes(query);
  });
  const summary = data?.summary?.units?.[quotaUnit];
  useEffect(() => {
    setModelFilter('');
  }, [quotaUnit]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1>Model Quotas</h1>
          <p>Portfolio intelligence sourced from internal Power BI semantic models.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Button
            icon={<ArrowSyncRegular />}
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            appearance="primary"
            icon={<OpenRegular />}
            onClick={() => data?.reportUrl && openExternal(data.reportUrl)}
            disabled={!data?.reportUrl}
          >
            Open source report
          </Button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header-custom" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>
            AI Capacity Allocation · Total customer quota per model
            <span style={{ color: 'var(--text-faint)', fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
              Top {Math.min(MODEL_CHART_LIMIT, chartData.length)} by approved quota
            </span>
          </span>
          <Select
            value={quotaUnit}
            onChange={(event) => setQuotaUnit(event.target.value)}
            aria-label="Quota unit"
          >
            <option value="TPM">TPM · tokens per minute</option>
            <option value="PTU">PTU · provisioned throughput units</option>
          </Select>
        </div>
        <div className="card-body-custom">
          {loading && !data ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)' }}>
              <Spinner size="tiny" /> Loading portfolio capacity…
            </div>
          ) : (
            <>
              {summary && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                  <CapacityKpi label="Customers with quota" value={summary.customerCount} />
                  <CapacityKpi label="Models" value={summary.modelCount} />
                  <CapacityKpi label={`Quota approved (${quotaUnit})`} value={compactCapacity(summary.totalApproved)} />
                  <CapacityKpi label={`Quota deployed (${quotaUnit})`} value={compactCapacity(summary.totalDeployed)} />
                  <CapacityKpi label={`Available headroom (${quotaUnit})`} value={compactCapacity(summary.totalAvailable)} color="var(--success-text)" />
                </div>
              )}
              {chartData.length > 0 ? (
                <div style={{ height: Math.max(360, chartData.length * 34) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={chartData}
                      layout="vertical"
                      margin={{ top: 8, right: 20, bottom: 8, left: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis
                        type="number"
                        tickFormatter={compactCapacity}
                        stroke="var(--text-muted)"
                        fontSize={11}
                      />
                      <YAxis
                        type="category"
                        dataKey="model"
                        width={150}
                        stroke="var(--text-muted)"
                        fontSize={11}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          compactCapacity(value),
                          name === 'deployed' ? 'Deployed' : 'Available',
                        ]}
                      />
                      <Legend formatter={(value) => (value === 'deployed' ? 'Deployed' : 'Available')} />
                      <Bar dataKey="deployed" stackId="quota" fill="var(--accent)" />
                      <Bar dataKey="available" stackId="quota" fill="var(--success)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No quota data for the current account roster.</div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header-custom" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <span>Customers</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              aria-label="Filter customers by model"
            >
              <option value="">All models</option>
              {unitModels.map((model) => (
                <option key={model.model} value={model.model}>{model.model}</option>
              ))}
            </Select>
            <Input
              value={search}
              onChange={(_event, value) => setSearch(value.value)}
              placeholder="Search customers"
              aria-label="Search customers"
            />
          </div>
        </div>
        <div className="card-body-custom" style={{ padding: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>TPID</th>
                  <th>Models</th>
                  <th>Approved</th>
                  <th>Deployed</th>
                  <th>Utilization</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.tpid || customer.customerName}>
                    <td>
                      <button
                        type="button"
                        onClick={() => onSelectCustomer(customer.tpid)}
                        style={{
                          border: 0,
                          padding: 0,
                          background: 'none',
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          font: 'inherit',
                          fontWeight: 600,
                          textAlign: 'left',
                        }}
                      >
                        {customer.customerName}
                      </button>
                    </td>
                    <td>{customer.tpid}</td>
                    <td>{customer.modelCount}</td>
                    <td>{compactCapacity(customer.approved)}</td>
                    <td>{compactCapacity(customer.deployed)}</td>
                    <td>{fmtPct(customer.deployedPct * 100)}</td>
                    <td style={{ color: 'var(--success-text)', fontWeight: 600 }}>
                      {compactCapacity(customer.available)}
                    </td>
                  </tr>
                ))}
                {customers.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No matching customers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {data?.fetchedAt && (
            <div style={{ color: 'var(--text-faint)', fontSize: 11, padding: '10px 16px' }}>
              Source: {data.source} · Updated {formatLocalDateTime(data.fetchedAt)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function CustomerDetailView({
  customer,
  capacity,
  subscriptions,
  loading,
  onBack,
  onRefresh,
}) {
  const [selectedSubscription, setSelectedSubscription] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [quotaUnit, setQuotaUnit] = useState('TPM');
  useEffect(() => {
    setSelectedSubscription('');
    setModelFilter('');
    setQuotaUnit('TPM');
  }, [customer?.tpid]);

  const models = useMemo(
    () => [...new Set(
      (subscriptions?.rows || [])
        .filter((row) => row.unit === quotaUnit)
        .map((row) => row.model),
    )].sort(),
    [subscriptions?.rows, quotaUnit],
  );
  const detailRows = (subscriptions?.rows || []).filter((row) => (
    row.unit === quotaUnit
    && (!selectedSubscription || row.subscriptionId === selectedSubscription)
    && (!modelFilter || row.model === modelFilter)
  ));
  const subscriptionRows = (subscriptions?.subscriptions || [])
    .filter((row) => row.unit === quotaUnit);
  const summary = capacity?.summary;
  const quotaSummary = summary?.units?.[quotaUnit];
  useEffect(() => {
    setSelectedSubscription('');
    setModelFilter('');
  }, [quotaUnit]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <Button
            appearance="subtle"
            icon={<ArrowLeftRegular />}
            onClick={onBack}
            style={{ marginLeft: -10, marginBottom: 6 }}
          >
            All customers
          </Button>
          <h1>{customer?.customerName || `TPID ${customer?.tpid}`}</h1>
          <p>AI capacity allocation by Azure subscription, model, quota type, and region.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Select
            value={quotaUnit}
            onChange={(event) => setQuotaUnit(event.target.value)}
            aria-label="Customer quota unit"
          >
            <option value="TPM">TPM · tokens per minute</option>
            <option value="PTU">PTU · provisioned throughput units</option>
          </Select>
          <Button icon={<ArrowSyncRegular />} onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            appearance="primary"
            icon={<OpenRegular />}
            onClick={() => capacity?.reportUrl && openExternal(capacity.reportUrl)}
            disabled={!capacity?.reportUrl}
          >
            Open filtered report
          </Button>
        </div>
      </div>

      {loading && !capacity ? (
        <div className="card"><div className="card-body-custom"><Spinner size="tiny" /> Loading customer capacity…</div></div>
      ) : summary && quotaSummary ? (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <CapacityKpi label={`Quota approved (${quotaUnit})`} value={compactCapacity(quotaSummary.approved)} />
            <CapacityKpi label={`Quota deployed (${quotaUnit})`} value={compactCapacity(quotaSummary.deployed)} sub={fmtPct(quotaSummary.deployedPct * 100)} />
            <CapacityKpi label={`Available headroom (${quotaUnit})`} value={compactCapacity(quotaSummary.available)} color="var(--success-text)" />
            <CapacityKpi label="Open requests" value={summary.openRequestCount} color={summary.openRequestCount ? 'var(--warning-text)' : 'var(--success-text)'} />
            <CapacityKpi
              label="Capacity-blocked pipeline"
              value={fmtUsd(summary.blockedPipeline)}
              sub={`${summary.blockedMilestoneCount} milestone${summary.blockedMilestoneCount === 1 ? '' : 's'}`}
              color={summary.blockedMilestoneCount ? 'var(--danger-text)' : 'var(--success-text)'}
            />
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header-custom">Subscription summary</div>
            <div className="card-body-custom" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Subscription ID</th>
                    <th>Models</th>
                    <th>Regions</th>
                    <th>Approved</th>
                    <th>Deployed</th>
                    <th>Utilization</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptionRows.map((subscription) => (
                    <tr
                      key={subscription.subscriptionId}
                      style={{
                        background: selectedSubscription === subscription.subscriptionId ? 'var(--accent-tint)' : undefined,
                      }}
                    >
                      <td>
                        <button
                          type="button"
                          onClick={() => setSelectedSubscription((current) => (
                            current === subscription.subscriptionId ? '' : subscription.subscriptionId
                          ))}
                          style={{
                            border: 0,
                            padding: 0,
                            background: 'none',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            font: 'inherit',
                            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                          }}
                        >
                          {subscription.subscriptionId}
                        </button>
                      </td>
                      <td>{subscription.modelCount}</td>
                      <td>{subscription.regionCount}</td>
                      <td>{compactCapacity(subscription.approved)}</td>
                      <td>{compactCapacity(subscription.deployed)}</td>
                      <td>{fmtPct(subscription.deployedPct * 100)}</td>
                      <td style={{ color: 'var(--success-text)', fontWeight: 600 }}>
                        {compactCapacity(subscription.available)}
                      </td>
                    </tr>
                  ))}
                  {subscriptionRows.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No subscription-level quota found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header-custom" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <span>
                Model and region detail
                {selectedSubscription ? ` · ${selectedSubscription}` : ''}
              </span>
              <Select
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                aria-label="Filter subscription details by model"
              >
                <option value="">All models</option>
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </Select>
            </div>
            <div className="card-body-custom" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Subscription</th>
                    <th>Model</th>
                    <th>Quota type</th>
                    <th>Region</th>
                    <th>Approved</th>
                    <th>Deployed</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row, index) => (
                    <tr key={`${row.subscriptionId}-${row.model}-${row.quotaType}-${row.location}-${index}`}>
                      <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}>{row.subscriptionId}</td>
                      <td>{row.model}</td>
                      <td>{row.quotaType}</td>
                      <td>{row.location}</td>
                      <td>{compactCapacity(row.approved)}</td>
                      <td>{compactCapacity(row.deployed)}</td>
                      <td style={{ color: 'var(--success-text)', fontWeight: 600 }}>{compactCapacity(row.available)}</td>
                    </tr>
                  ))}
                  {detailRows.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No matching subscription detail.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
            <div className="card">
              <div className="card-header-custom">Open capacity requests</div>
              <div className="card-body-custom">
                {(capacity.openRequests || []).length === 0 ? (
                  <div style={{ color: 'var(--success-text)', fontSize: 13 }}>No open capacity requests.</div>
                ) : (
                  capacity.openRequests.slice(0, 20).map((request, index) => (
                    <div key={`${request.model}-${request.requestedDate}-${index}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <strong>{request.model || 'Model not specified'}</strong>
                        <span style={{ color: 'var(--warning-text)' }}>{request.state || 'Unknown state'}</span>
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                        {compactCapacity(request.requestedAmount)} requested
                        {request.requestedRegion ? ` · ${request.requestedRegion}` : ''}
                        {request.priority ? ` · ${request.priority}` : ''}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-header-custom">Capacity-blocked milestones</div>
              <div className="card-body-custom">
                {(capacity.milestones || []).filter((row) => row.blockedCount > 0).length === 0 ? (
                  <div style={{ color: 'var(--success-text)', fontSize: 13 }}>No milestones blocked by capacity.</div>
                ) : (
                  capacity.milestones
                    .filter((row) => row.blockedCount > 0)
                    .slice(0, 20)
                    .map((milestone) => (
                      <div key={milestone.milestoneId} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                        <strong>{milestone.name || milestone.milestoneId}</strong>
                        <div style={{ color: 'var(--danger-text)', marginTop: 2 }}>
                          {fmtUsd(milestone.blockedPipe)} blocked
                          {milestone.statusReason ? ` · ${milestone.statusReason}` : ''}
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function PowerBIReports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTpid = (searchParams.get('tpid') || '').trim();
  const { data: customerRows } = useDbQuery(
    "SELECT id, name, tpid, parenting_level FROM active_customers WHERE tpid IS NOT NULL AND tpid <> ''",
  );
  const { rosterTpids, loading: rosterLoading } = useRosterTpids();
  const allTpids = useMemo(
    () => [...new Set(rosterTpids.map((tpid) => String(tpid).trim()).filter(Boolean))],
    [rosterTpids],
  );

  const [portfolio, setPortfolio] = useState(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [capacity, setCapacity] = useState(null);
  const [subscriptions, setSubscriptions] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const portfolioRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const selectedCustomer = useMemo(() => {
    const fromPortfolio = portfolio?.customers?.find((row) => row.tpid === selectedTpid);
    if (fromPortfolio) return fromPortfolio;
    const local = (customerRows || [])
      .filter((row) => String(row.tpid).trim() === selectedTpid)
      .sort((left, right) => (
        Number(right.parenting_level === 861980000) - Number(left.parenting_level === 861980000)
        || String(left.name || '').length - String(right.name || '').length
      ))[0];
    return local ? { tpid: selectedTpid, customerName: local.name } : { tpid: selectedTpid };
  }, [portfolio?.customers, customerRows, selectedTpid]);

  const loadPortfolio = useCallback(async (force = false) => {
    if (allTpids.length === 0) return;
    const requestId = ++portfolioRequestRef.current;
    setPortfolioLoading(true);
    setPortfolioError('');
    try {
      const result = await capacityPortfolio({ tpids: allTpids, force });
      if (requestId !== portfolioRequestRef.current) return;
      if (!result?.ok) {
        setPortfolioError(result?.error || 'Power BI capacity portfolio is unavailable.');
        return;
      }
      setPortfolio(result);
    } catch (error) {
      if (requestId === portfolioRequestRef.current) {
        setPortfolioError(error.message || String(error));
      }
    } finally {
      if (requestId === portfolioRequestRef.current) setPortfolioLoading(false);
    }
  }, [allTpids]);

  const loadDetail = useCallback(async (force = false) => {
    if (!selectedTpid) return;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError('');
    if (!force) {
      setCapacity(null);
      setSubscriptions(null);
    }
    try {
      let capacityResult;
      let subscriptionResult;
      if (force) {
        capacityResult = await customerCapacity({
          tpid: selectedTpid,
          force: true,
          includeQuotas: false,
        });
        subscriptionResult = await customerCapacitySubscriptions({
          tpid: selectedTpid,
          force: false,
        });
      } else {
        [capacityResult, subscriptionResult] = await Promise.all([
          customerCapacity({ tpid: selectedTpid, force: false, includeQuotas: false }),
          customerCapacitySubscriptions({ tpid: selectedTpid, force: false }),
        ]);
      }
      if (requestId !== detailRequestRef.current) return;
      if (!capacityResult?.ok) throw new Error(capacityResult?.error || 'Customer capacity is unavailable.');
      if (!subscriptionResult?.ok) throw new Error(subscriptionResult?.error || 'Subscription capacity is unavailable.');
      setCapacity(capacityResult);
      setSubscriptions(subscriptionResult);
    } catch (error) {
      if (requestId === detailRequestRef.current) {
        setDetailError(error.message || String(error));
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, [selectedTpid]);

  useEffect(() => {
    if (!selectedTpid && !rosterLoading) loadPortfolio(false);
    return () => { portfolioRequestRef.current += 1; };
  }, [selectedTpid, rosterLoading, loadPortfolio]);

  useEffect(() => {
    if (selectedTpid && allTpids.includes(selectedTpid)) loadDetail(false);
    return () => { detailRequestRef.current += 1; };
  }, [selectedTpid, allTpids, loadDetail]);

  const selectCustomer = (tpid) => {
    detailRequestRef.current += 1;
    setCapacity(null);
    setSubscriptions(null);
    setDetailError('');
    const next = new URLSearchParams(searchParams);
    next.set('tpid', tpid);
    setSearchParams(next);
  };
  const clearCustomer = () => {
    detailRequestRef.current += 1;
    setCapacity(null);
    setSubscriptions(null);
    setDetailError('');
    const next = new URLSearchParams(searchParams);
    next.delete('tpid');
    setSearchParams(next);
  };

  if (selectedTpid) {
    if (!rosterLoading && !allTpids.includes(selectedTpid)) {
      return (
        <div>
          <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={clearCustomer}>All customers</Button>
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-body-custom">
              <div style={{ color: 'var(--danger-text)', fontSize: 13 }}>
                This customer is not in the configured account roster.
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 5 }}>
                Add the TPID in User Home before loading its Power BI capacity data.
              </div>
            </div>
          </div>
        </div>
      );
    }
    const capacityForCustomer = capacity?.summary?.tpid === selectedTpid ? capacity : null;
    const subscriptionsForCustomer = subscriptions?.tpid === selectedTpid ? subscriptions : null;
    return (
      <div>
        {detailError ? (
          <>
            <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={clearCustomer}>All customers</Button>
            <ErrorState message={detailError} retry={() => loadDetail(true)} />
          </>
        ) : (
          <CustomerDetailView
            customer={selectedCustomer}
            capacity={capacityForCustomer}
            subscriptions={subscriptionsForCustomer}
            loading={detailLoading || !capacityForCustomer || !subscriptionsForCustomer}
            onBack={clearCustomer}
            onRefresh={() => loadDetail(true)}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      {portfolioError ? (
        <ErrorState message={portfolioError} retry={() => loadPortfolio(true)} />
      ) : (
        <PortfolioView
          data={portfolio}
          loading={portfolioLoading || rosterLoading}
          onRefresh={() => loadPortfolio(true)}
          onSelectCustomer={selectCustomer}
        />
      )}
    </div>
  );
}
