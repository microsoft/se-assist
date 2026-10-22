import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button, Field, Select, Spinner } from '@fluentui/react-components';
import { ChevronRightRegular, ChevronDownRegular } from '@fluentui/react-icons';
import { acrServiceHierarchy } from '../electronBridge';
import { fmtUsd, fmtUsdFull, monthAbbr } from '../lib/acrFormat';
import AcrFreshness from './AcrFreshness';
import { consumeReloadGeneration } from '../lib/reloadGeneration';
import { useAcrRefresh } from '../hooks/useAcrRefresh';
import { usePersistedState } from '../hooks/usePersistedState';

const LEVELS = [1, 2, 3, 4, 5];
// Shared by the portfolio and account pages, so a chosen depth carries across both.
const LEVEL_STORAGE_KEY = 'acr.serviceLevel';

// Collect every node path that has children — used to expand/collapse the
// whole tree at once (default is fully expanded to mirror the Power BI matrix).
function collectExpandable(nodes, out) {
  for (const n of nodes) {
    if (n.children && n.children.length) {
      out.add(n.path);
      collectExpandable(n.children, out);
    }
  }
  return out;
}

// Depth-first flatten of the visible rows given the current expanded set.
function flattenVisible(nodes, expanded, out) {
  for (const n of nodes) {
    out.push(n);
    if (n.children && n.children.length && expanded.has(n.path)) {
      flattenVisible(n.children, expanded, out);
    }
  }
  return out;
}

/**
 * Expandable Service-Level hierarchy matrix (L1 › … › Ln) with a monthly
 * series + subtotal at every level and a grand-total footer. Selecting level N
 * shows the entire hierarchy above it, grouped — not just the flat level.
 *
 * @param {object} props
 * @param {string[]} props.tpids
 * @param {number} [props.defaultLevel] Depth (1..5) until the user picks one in
 *                                      the card's Service level selector.
 * @param {string[]} props.fiscalYears
 * @param {{level:number, services:string[]}} [props.productFilter]  Optional product scope.
 * @param {number} [props.reloadKey]    Bump to force a live refetch.
 * @param {string} [props.accountName]  For the empty-state copy.
 */
export default function AcrServiceHierarchy({
  tpids,
  defaultLevel = 2,
  fiscalYears,
  productFilter,
  reloadKey = 0,
  accountName,
  onLoadingChange,
}) {
  const [level, setLevel] = usePersistedState(LEVEL_STORAGE_KEY, defaultLevel);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const requestSeq = useRef(0);
  const services = productFilter?.services || [];
  const serviceKey = services.join('|');
  const fyKey = (fiscalYears || []).join('|');
  const tpidKey = (tpids || []).join('|');

  const load = useCallback(async (forceOverride) => {
    if (!tpids || tpids.length === 0 || !fiscalYears || fiscalYears.length === 0) return;
    const force = typeof forceOverride === 'boolean' ? forceOverride : consumeReloadGeneration(
      'acr-service-hierarchy',
      `${tpidKey}|${fyKey}|${level}|${serviceKey}|${productFilter?.level || 2}`,
      reloadKey,
    );
    // Only the newest request may update the matrix, so a slow response for a
    // level the user has already changed away from cannot overwrite it.
    const seq = ++requestSeq.current;
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await acrServiceHierarchy({
        tpids,
        level,
        fiscalYears,
        services: services.length ? services : undefined,
        serviceFilterLevel: productFilter?.level || 2,
        force,
      });
      if (seq !== requestSeq.current) return;
      if (res?.ok) {
        setData(res);
        // Default: fully expanded so the entire hierarchy is visible at a glance.
        setExpanded(collectExpandable(res.tree || [], new Set()));
      } else if (res?.code === 'NO_ACCOUNT') {
        setData(null);
        setError('Sign in with Microsoft (Settings) and connect to corpnet/VPN to load the service hierarchy.');
      } else {
        setData(null);
        setError(res?.error || 'Failed to load the service hierarchy.');
      }
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setData(null);
      setError(e.message || 'Failed to load the service hierarchy.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
      onLoadingChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tpidKey,
    level,
    fyKey,
    serviceKey,
    productFilter?.level,
    reloadKey,
    onLoadingChange,
  ]);

  useEffect(() => { load(); }, [load]);
  useAcrRefresh(data?.cache, load);

  const months = data?.months || [];
  const rows = useMemo(() => flattenVisible(data?.tree || [], expanded, []), [data, expanded]);

  const footer = useMemo(() => {
    const roots = data?.tree || [];
    const perMonth = {};
    for (const m of months) perMonth[m] = roots.reduce((sum, n) => sum + (n.monthly?.[m] || 0), 0);
    return perMonth;
  }, [data, months]);

  const toggle = (path) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const expandAll = () => setExpanded(collectExpandable(data?.tree || [], new Set()));
  const collapseAll = () => setExpanded(new Set());

  const hasData = data && (data.tree || []).length > 0;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          Service hierarchy (L1{level > 1 ? `–L${level}` : ''}){hasData && data.grandTotal ? ` · ${fmtUsd(data.grandTotal)}` : ''}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <Field label="Service level" style={{ minWidth: 120 }}>
            <Select value={String(level)} onChange={(_e, d) => setLevel(Number(d.value))} size="small">
              {LEVELS.map((l) => <option key={l} value={l}>{`Level ${l}`}</option>)}
            </Select>
          </Field>
          <Button size="small" disabled={loading} onClick={() => load(true)}>Refresh hierarchy</Button>
          {loading && <Spinner size="tiny" />}
          {hasData && level > 1 && (
            <>
              <button type="button" onClick={expandAll} style={linkBtn}>Expand all</button>
              <button type="button" onClick={collapseAll} style={linkBtn}>Collapse all</button>
            </>
          )}
        </span>
      </div>
      <div className="card-body-custom" style={{ overflowX: 'auto' }}>
        {hasData ? (
          <table className="data-table" style={{ fontSize: 12, minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--card)', minWidth: 240 }}>Service</th>
                {months.map((m) => (
                  <th key={m} style={{ textAlign: 'right', whiteSpace: 'nowrap' }} title={m}>{monthAbbr(m)}</th>
                ))}
                <th style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => {
                const depth = n.level - 1;
                const canExpand = !!(n.children && n.children.length);
                const isOpen = expanded.has(n.path);
                return (
                  <tr key={n.path}>
                    <td
                      style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--card)', whiteSpace: 'nowrap', fontWeight: depth === 0 ? 700 : 400 }}
                      title={n.path}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: depth * 16 }}>
                        {canExpand ? (
                          <button type="button" onClick={() => toggle(n.path)} style={caretBtn} aria-label={isOpen ? 'Collapse' : 'Expand'}>
                            {isOpen ? <ChevronDownRegular style={{ fontSize: 12 }} /> : <ChevronRightRegular style={{ fontSize: 12 }} />}
                          </button>
                        ) : (
                          <span style={{ display: 'inline-block', width: 16 }} />
                        )}
                        <span style={{ color: depth === 0 ? 'var(--text)' : 'var(--text-secondary)' }}>{n.name}</span>
                      </span>
                    </td>
                    {months.map((m) => {
                      const v = n.monthly?.[m] || 0;
                      return (
                        <td key={m} style={{ textAlign: 'right', color: v ? 'var(--text)' : 'var(--border-strong)' }} title={v ? fmtUsdFull(v) : '—'}>{v ? fmtUsd(v) : '—'}</td>
                      );
                    })}
                    <td style={{ textAlign: 'right', fontWeight: 700 }} title={fmtUsdFull(n.total)}>{fmtUsd(n.total)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--card)', fontWeight: 700 }}>Total</td>
                {months.map((m) => (
                  <td key={m} style={{ textAlign: 'right', fontWeight: 700 }} title={fmtUsdFull(footer[m])}>{footer[m] ? fmtUsd(footer[m]) : '—'}</td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }} title={fmtUsdFull(data.grandTotal)}>{fmtUsd(data.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>
            {loading
              ? 'Loading service hierarchy…'
              : error
                ? error
                : data?.cache?.status === 'missing'
                  ? data.cache.error?.message
                    ? data.cache.error.message
                    : 'Loading service hierarchy data…'
                : `No service consumption found${accountName ? ` for ${accountName}` : ''} in ${(fiscalYears || []).join(' + ')}.`}
          </div>
        )}
        {data?.cache?.status !== 'missing' && <AcrFreshness cache={data?.cache} />}
      </div>
    </div>
  );
}

const linkBtn = { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 400, padding: 0 };
const caretBtn = { background: 'none', border: 'none', padding: 0, marginRight: 4, cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' };
