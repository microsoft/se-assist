import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { acrAnthropicSpend } from '../electronBridge';
import { formatFiscalMonth } from '../lib/acrFormat';
import MultiLineAcrChart from './AcrMultiLineChart';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatSpend = (value) => usd.format(value);

export default function AcrAnthropicSpend({
  tpids,
  fiscalYears,
  reloadKey = 0,
  onLoadingChange,
}) {
  const tpidKey = JSON.stringify([...new Set((tpids || []).map(String))].sort());
  const fyKey = JSON.stringify([...new Set(fiscalYears || [])].sort());
  const scopeKey = `${tpidKey}|${fyKey}`;
  const sequence = useRef(0);
  const consumedReload = useRef(reloadKey);
  const [state, setState] = useState(null);
  const enabled = tpidKey !== '[]' && fyKey !== '[]';

  const load = useCallback(async (forceOverride) => {
    if (!enabled) return;
    const request = ++sequence.current;
    const force = typeof forceOverride === 'boolean' ? forceOverride : reloadKey > consumedReload.current;
    if (typeof forceOverride !== 'boolean') consumedReload.current = reloadKey;
    setState((previous) => ({
      scopeKey,
      loading: true,
      result: previous?.scopeKey === scopeKey ? previous.result : null,
    }));
    onLoadingChange?.(true);
    try {
      const result = await acrAnthropicSpend({
        tpids: JSON.parse(tpidKey),
        fiscalYears: JSON.parse(fyKey),
        force,
      });
      if (request !== sequence.current) return;
      setState({
        scopeKey,
        loading: false,
        result: result?.ok ? result : { ...result, ok: false, error: result?.error || 'No Anthropic spend response was returned.' },
      });
    } catch (error) {
      if (request === sequence.current) setState({
        scopeKey,
        loading: false,
        result: { ok: false, error: error.message || 'Failed to load Anthropic spend.' },
      });
    } finally {
      onLoadingChange?.(false);
    }
  }, [enabled, scopeKey, tpidKey, fyKey, reloadKey, onLoadingChange]);

  useEffect(() => {
    load();
    return () => { sequence.current += 1; };
  }, [load]);

  if (!enabled) return null;
  const current = state?.scopeKey === scopeKey ? state : null;
  const result = current?.result;
  const loading = current?.loading ?? true;
  const available = result?.ok && result.cache?.status !== 'missing';
  const series = available && result.accounts.length ? {
    data: result.months.map((fiscalMonth) => ({ fiscalMonth, Anthropic: result.monthly[fiscalMonth] })),
    keys: ['Anthropic'],
  } : { data: [], keys: [] };
  const emptyText = loading ? 'Loading native Anthropic spend from Power BI...'
    : result?.ok === false
      ? <span role="alert">Could not load Anthropic spend: {result.error}</span>
      : 'No Anthropic spend was returned for the selected accounts and completed fiscal months.';

  return (
    <section aria-label="Anthropic consumption" data-anthropic-spend>
      <MultiLineAcrChart
        title="Anthropic consumption (XCR)"
        series={series}
        loading={loading}
        cache={result?.cache}
        onRefresh={load}
        retryAt={result?.retryAt}
        height={220}
        valueFormatter={formatSpend}
        emptyText={emptyText}
        controls={available ? (
          <span style={{ fontSize: 13 }}>
            Selected-period total: <strong data-anthropic-total>{formatSpend(result.grandTotal)}</strong>
          </span>
        ) : null}
        description={(
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Native <code>XCR - Anthropic</code> (USD), completed months only.
            {' '}Separate from Azure ACR totals; product filters do not apply. No per-model breakdown.
            {available && result.latestMonth && (
              <span>
                {' '}Latest: {formatFiscalMonth(result.latestMonth)} - {formatSpend(result.latest)}.
              </span>
            )}
          </div>
        )}
      >
        {available && JSON.parse(tpidKey).length > 1 && result.accounts.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 13 }}>
              Spend by customer ({result.accounts.length})
            </summary>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th style={{ textAlign: 'right' }}>Latest completed month (USD)</th>
                    <th style={{ textAlign: 'right' }}>Selected-period total (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {result.accounts.map((account) => (
                    <tr key={account.tpid}>
                      <td>
                        <Link to={`/consumption/${account.tpid}`}>{account.account}</Link>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> (TPID {account.tpid})</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{account.latest == null ? '-' : formatSpend(account.latest)}</td>
                      <td style={{ textAlign: 'right' }}>{formatSpend(account.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </MultiLineAcrChart>
    </section>
  );
}
