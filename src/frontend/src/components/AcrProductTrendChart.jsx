import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Field, Select } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular, DataTrendingRegular } from '@fluentui/react-icons';
import { acrServiceHierarchy } from '../electronBridge';
import { fmtUsd } from '../lib/acrFormat';
import { usePersistedState } from '../hooks/usePersistedState';
import MultiLineAcrChart from './AcrMultiLineChart';
import { consumeReloadGeneration } from '../lib/reloadGeneration';

// How many products a user may plot at once. Mirrors the chart's LEGEND_LIMIT so
// every selected product is always drawn (no "+N more" truncation here).
const MAX_SELECTED = 10;
// Default number of products pre-selected (top-N by total) after a fresh load.
const DEFAULT_SELECTED = 6;
const LEVELS = [1, 2, 3, 4, 5];

// Depth-first collect of every node at exactly `targetLevel`, carrying the
// immediate parent name so we can disambiguate duplicate leaf names.
function collectLevel(nodes, targetLevel, parentName, out) {
  for (const n of nodes) {
    if (n.level === targetLevel) {
      out.push({ path: n.path, name: n.name, parentName, total: n.total || 0, monthly: n.monthly || {} });
    } else if (n.children && n.children.length) {
      collectLevel(n.children, targetLevel, n.name, out);
    }
  }
  return out;
}

/**
 * Dynamic multi-line product trend chart for the Service Hierarchy section.
 *
 * The user picks a "top-level service level" (L1..L5); the selectable product
 * list refreshes to the services at that level (mirroring how the hierarchy
 * matrix responds to its own level selector). Up to MAX_SELECTED products can
 * be plotted as monthly ACR lines at once.
 *
 * @param {object} props
 * @param {string[]} props.tpids
 * @param {string[]} props.fiscalYears
 * @param {{level:number, services:string[]}} [props.productFilter]  Optional product scope.
 * @param {number} [props.reloadKey]      Bump to force a live refetch.
 * @param {string} [props.accountName]    For the empty-state copy.
 * @param {string} [props.storagePrefix]  localStorage namespace for the level selector.
 */
export default function AcrProductTrendChart({
  tpids,
  fiscalYears,
  productFilter,
  reloadKey = 0,
  accountName,
  storagePrefix = 'acr.productTrend',
  onLoadingChange,
}) {
  const [chartLevel, setChartLevel] = usePersistedState(`${storagePrefix}.level`, 2);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const services = productFilter?.services || [];
  const serviceKey = services.join('|');
  const fyKey = (fiscalYears || []).join('|');
  const tpidKey = (tpids || []).join('|');

  const load = useCallback(async (forceOverride) => {
    if (!tpids || tpids.length === 0 || !fiscalYears || fiscalYears.length === 0) return;
    const force = typeof forceOverride === 'boolean' ? forceOverride : consumeReloadGeneration(
      'acr-product-trend',
      `${tpidKey}|${fyKey}|${chartLevel}|${serviceKey}|${productFilter?.level || 2}`,
      reloadKey,
    );
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await acrServiceHierarchy({
        tpids,
        level: chartLevel,
        fiscalYears,
        services: services.length ? services : undefined,
        serviceFilterLevel: productFilter?.level || 2,
        force,
      });
      if (res?.ok) {
        setData(res);
      } else if (res?.code === 'NO_ACCOUNT') {
        setData(null);
        setError('Sign in with Microsoft (Settings) and connect to corpnet/VPN to load product trends.');
      } else {
        setData(null);
        setError(res?.error || 'Failed to load product trends.');
      }
    } catch (e) {
      setData(null);
      setError(e.message || 'Failed to load product trends.');
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tpidKey,
    chartLevel,
    fyKey,
    serviceKey,
    productFilter?.level,
    reloadKey,
    onLoadingChange,
  ]);

  useEffect(() => { load(); }, [load]);

  const months = data?.months || [];

  // Products at the chosen level, sorted by total desc, with unique display labels.
  const products = useMemo(() => {
    const raw = collectLevel(data?.tree || [], chartLevel, null, [])
      .filter((p) => p.total !== 0)
      .sort((a, b) => b.total - a.total);
    const nameCounts = {};
    for (const p of raw) nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
    const seen = new Map();
    return raw.map((p) => {
      let label = nameCounts[p.name] > 1 && p.parentName ? `${p.parentName} › ${p.name}` : p.name;
      // Guarantee uniqueness even if parent › name still collides.
      const count = (seen.get(label) || 0) + 1;
      seen.set(label, count);
      if (count > 1) label = `${label} (${count})`;
      return { ...p, label };
    });
  }, [data, chartLevel]);

  const productSig = products.map((p) => p.path).join('|');

  // Keep the selection valid as the product list changes (level/tpids/FYs).
  // Preserve any still-valid picks, otherwise fall back to the top-N by total.
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set([...prev].filter((path) => products.some((p) => p.path === path)));
      if (valid.size > 0) return valid;
      return new Set(products.slice(0, DEFAULT_SELECTED).map((p) => p.path));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productSig]);

  const toggleProduct = useCallback((path) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else if (next.size < MAX_SELECTED) {
        next.add(path);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const series = useMemo(() => {
    const chosen = products.filter((p) => selected.has(p.path));
    const keys = chosen.map((p) => p.label);
    const dataRows = months.map((m) => {
      const row = { fiscalMonth: m };
      for (const p of chosen) row[p.label] = p.monthly[m] || 0;
      return row;
    });
    return { data: chosen.length ? dataRows : [], keys };
  }, [products, selected, months]);

  const grandTotal = useMemo(
    () => products.filter((p) => selected.has(p.path)).reduce((sum, p) => sum + (p.total || 0), 0),
    [products, selected],
  );

  const controls = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Field label="Service level" style={{ minWidth: 120 }}>
        <Select
          value={String(chartLevel)}
          onChange={(_e, d) => setChartLevel(Number(d.value))}
          size="small"
          disabled={loading}
        >
          {LEVELS.map((l) => <option key={l} value={l}>{`Level ${l}`}</option>)}
        </Select>
      </Field>
      <ProductPicker
        products={products}
        selected={selected}
        onToggle={toggleProduct}
        onClear={clearSelection}
        disabled={loading || products.length === 0}
      />
    </span>
  );

  const emptyText = loading
    ? 'Loading product trends…'
    : error
      ? error
      : products.length === 0
        ? `No service consumption found${accountName ? ` for ${accountName}` : ''} in ${(fiscalYears || []).join(' + ')}.`
        : 'Select up to 10 products above to plot their monthly trend.';

  return (
    <MultiLineAcrChart
      title={`Product trend (L${chartLevel})`}
      icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
      series={series}
      grandTotal={series.keys.length ? grandTotal : 0}
      loading={loading}
      cache={data?.cache}
      onRefresh={load}
      controls={controls}
      emptyText={emptyText}
    />
  );
}

// Compact multi-select dropdown for the plotted products, capped at MAX_SELECTED.
// Unchecked rows are disabled once the cap is reached so the limit is explicit.
function ProductPicker({ products, selected, onToggle, onClear, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => { if (open) setQuery(''); }, [open]);

  const atCap = selected.size >= MAX_SELECTED;
  const q = query.trim().toLowerCase();
  const visible = q ? products.filter((p) => p.label.toLowerCase().includes(q)) : products;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={`diag-filter-btn${selected.size > 0 ? ' active' : ''}`}
        title="Choose products to plot"
      >
        <span className="diag-filter-btn-label">Products</span>
        <span className="diag-filter-btn-value">{`(${selected.size}/${MAX_SELECTED})`}</span>
        {open
          ? <ChevronDownRegular style={{ fontSize: 12, flex: '0 0 auto' }} />
          : <ChevronRightRegular style={{ fontSize: 12, flex: '0 0 auto' }} />}
      </button>
      {open && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 100,
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6,
            padding: 8, minWidth: 260, maxHeight: 340, overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box', marginBottom: 8,
              background: 'var(--canvas)', border: '1px solid var(--border)', borderRadius: 4,
              padding: '5px 8px', color: 'var(--text)', fontSize: 12, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{`${selected.size} of ${MAX_SELECTED} selected`}</span>
            <button type="button" onClick={onClear} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0 }}>Clear</button>
          </div>
          {visible.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No matches</div>
          ) : (
            visible.map((p) => {
              const checked = selected.has(p.path);
              const blocked = !checked && atCap;
              return (
                <label
                  key={p.path}
                  title={blocked ? `Max ${MAX_SELECTED} products` : p.path}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: blocked ? 'not-allowed' : 'pointer', fontSize: 13, color: blocked ? 'var(--text-faint)' : 'var(--text)', opacity: blocked ? 0.6 : 1 }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={blocked}
                    onChange={() => onToggle(p.path)}
                    style={{ accentColor: 'var(--accent)', flex: '0 0 auto' }}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                  <span style={{ flex: '0 0 auto', color: 'var(--text-muted)', fontSize: 11 }}>{fmtUsd(p.total)}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
