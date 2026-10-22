import { useEffect, useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { useAcrRefresh } from '../hooks/useAcrRefresh';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { fmtUsd, fmtUsdFull, monthAbbr, formatFiscalMonth } from '../lib/acrFormat';
import AcrFreshness from './AcrFreshness';

// Legend/line cap so a busy series (e.g. 100+ L5 models, or every subscription)
// doesn't overflow the chart. The top LEGEND_LIMIT keys are drawn until the user
// expands to reveal the rest.
export const LEGEND_LIMIT = 10;
export const LINE_COLORS = ['var(--accent)', 'var(--violet)', 'var(--success-text)', 'var(--warning-text)', 'var(--pink)', 'var(--accent)', 'var(--warning)', 'var(--accent)', 'var(--pink)', 'var(--accent)', 'var(--danger)', 'var(--accent)'];
const legendBtn = { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0, fontWeight: 600 };

// Shared money tooltip: sorts series by value desc and formats each as full USD.
export function MoneyTooltip({ active, payload, label, valueFormatter = fmtUsdFull }) {
  if (!active || !payload || !payload.length) return null;
  const rows = payload
    .filter((p) => p.value != null)
    .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}>{formatFiscalMonth(label)}</div>
      {rows.map((p) => (
        <div key={p.dataKey || p.name} style={{ color: p.color || 'var(--text)', fontWeight: 600, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span><span>{valueFormatter(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Reusable multi-line ACR chart with a capped, expandable custom legend so a
 * busy series never overflows into the plot. Only the top `LEGEND_LIMIT` series
 * (by their order in `series.keys`, which callers sort by total desc) are drawn
 * until the user expands to show the rest.
 *
 * @param {object} props
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.icon]
 * @param {{data:object[], keys:string[]}} props.series
 * @param {number} [props.grandTotal]
 * @param {boolean} [props.loading]
 * @param {object} [props.cache]
 * @param {React.ReactNode} props.emptyText
 * @param {React.ReactNode} [props.controls]
 * @param {number} [props.height]
 */
export default function MultiLineAcrChart({
  title,
  icon,
  series,
  grandTotal,
  loading,
  cache,
  emptyText,
  controls = null,
  onRefresh,
  retryAt,
  height = 300,
  description,
  valueFormatter = fmtUsdFull,
  children,
}) {
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(Date.now);
  const cooldown = Math.max(retryAt || 0, cache?.error?.retryAt || 0);
  useAcrRefresh(cache, onRefresh);
  useEffect(() => {
    setNow(Date.now());
    if (cooldown <= Date.now()) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldown) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);
  const keys = series.keys || [];
  const visible = showAll ? keys : keys.slice(0, LEGEND_LIMIT);
  const hidden = keys.length - visible.length;
  const colorFor = (k) => LINE_COLORS[keys.indexOf(k) % LINE_COLORS.length];
  const resolvedEmptyText = cache?.status === 'missing'
    ? cache.error?.message
      ? cache.error.message
      : 'Loading data…'
    : emptyText;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {icon} {title}{grandTotal ? ` · ${fmtUsd(grandTotal)}` : ''}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {controls}
          {onRefresh && <Button size="small" disabled={loading || cooldown > now}
            onClick={() => onRefresh(true)}
            title={cooldown > now ? `Power BI cooldown ends at ${new Date(cooldown).toLocaleString()}` : 'Retry or refresh this chart without refreshing the other sections'}>
            {cooldown > now ? `Retry in ${Math.ceil((cooldown - now) / 1000)}s` : 'Refresh chart'}
          </Button>}
          {loading && <Spinner size="tiny" />}
        </span>
      </div>
      <div className="card-body-custom">
        {description}
        {series.data.length > 0 ? (
          <>
            <div style={{ height }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series.data} margin={{ top: 6, right: 16, bottom: 0, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="fiscalMonth" stroke="var(--text-muted)" fontSize={11} tickLine={false} tickFormatter={monthAbbr} />
                  <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} width={54} tickFormatter={(v) => fmtUsd(v)} />
                  <Tooltip content={<MoneyTooltip valueFormatter={valueFormatter} />} cursor={{ stroke: 'var(--border-strong)' }} />
                  {visible.map((k) => (
                    <Line key={k} type="monotone" dataKey={k} name={k} stroke={colorFor(k)} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px', marginTop: 10, fontSize: 11 }}>
              {visible.map((k) => (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(k), flexShrink: 0 }} />
                  <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k}>{k}</span>
                </span>
              ))}
              {hidden > 0 && (
                <button type="button" onClick={() => setShowAll(true)} style={legendBtn}>+{hidden} more</button>
              )}
              {showAll && keys.length > LEGEND_LIMIT && (
                <button type="button" onClick={() => setShowAll(false)} style={legendBtn}>Show top {LEGEND_LIMIT}</button>
              )}
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>{resolvedEmptyText}</div>
        )}
        {cache?.status !== 'missing' && <AcrFreshness cache={cache} />}
        {children}
      </div>
    </div>
  );
}
