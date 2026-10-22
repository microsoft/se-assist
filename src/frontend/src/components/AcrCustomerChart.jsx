import { useState, useEffect, useMemo, useCallback } from 'react';
import { PeopleTeamRegular } from '@fluentui/react-icons';
import { acrQuery } from '../electronBridge';
import MultiLineAcrChart from './AcrMultiLineChart';
import { fiscalMonthCompare } from '../lib/acrFormat';
import { consumeReloadGeneration } from '../lib/reloadGeneration';

// Blank/placeholder member label → a readable "(Unassigned)".
const memberLabel = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? '(Unassigned)' : s;
};

/**
 * "ACR by Customer" — a portfolio-only monthly line chart grouped by account
 * (customer TPID). Because every fact row already belongs to a customer, this
 * view carries no (Unassigned)/N/A buckets (those are enrollment-name artifacts
 * that get absorbed back into their parent customer here). Top 10 customers are
 * drawn; the rest fold behind the chart's "+N more" expander. Self-fetching so
 * it can drop in as a standalone chart; errors are surfaced explicitly.
 *
 * @param {object} props
 * @param {string[]} props.tpids
 * @param {string[]} props.fiscalYears
 * @param {number} [props.reloadKey]  Bump to force a live refetch.
 * @param {(loading:boolean) => void} [props.onLoadingChange]
 */
export default function AcrCustomerChart({
  tpids,
  fiscalYears,
  reloadKey = 0,
  onLoadingChange,
}) {
  const [res, setRes] = useState(null); // { ok, rows, error, code }
  const [loading, setLoading] = useState(false);
  const tpidKey = (tpids || []).join('|');
  const fyKey = (fiscalYears || []).join('|');

  const load = useCallback(async () => {
    if (!tpids?.length || !fiscalYears?.length) return;
    const force = consumeReloadGeneration('acr-customer', `${tpidKey}|${fyKey}`, reloadKey);
    setLoading(true);
    onLoadingChange?.(true);
    try {
      const r = await acrQuery({
        tpids,
        groupBy: ['account', 'fiscalMonth'],
        measures: ['acr'],
        fiscalYears,
        topN: 5000,
        force,
      });
      setRes(r?.ok
        ? { ok: true, rows: r.rows || [], cache: r.cache }
        : { ok: false, rows: [], error: r?.error || null, code: r?.code || null });
    } catch (e) {
      setRes({ ok: false, rows: [], error: e.message || 'Query failed.' });
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpidKey, fyKey, reloadKey, onLoadingChange]);

  useEffect(() => { load(); }, [load]);

  // Pivot rows → monthly series (customer keys sorted by total desc).
  const pivot = useMemo(() => {
    const rows = res?.rows || [];
    const totals = new Map();
    const months = new Set();
    for (const r of rows) {
      const name = memberLabel(r.account);
      const v = Number(r.acr) || 0;
      if (v === 0) continue;
      totals.set(name, (totals.get(name) || 0) + v);
      if (r.fiscalMonth) months.add(r.fiscalMonth);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const keys = ranked.map((e) => e[0]);
    const monthList = [...months].sort(fiscalMonthCompare);
    const byMonth = new Map(monthList.map((m) => [m, { fiscalMonth: m }]));
    for (const r of rows) {
      const name = memberLabel(r.account);
      if (!totals.has(name)) continue;
      const row = byMonth.get(r.fiscalMonth);
      if (row) row[name] = (row[name] || 0) + (Number(r.acr) || 0);
    }
    const grandTotal = ranked.reduce((s, e) => s + e[1], 0);
    return { data: monthList.map((m) => byMonth.get(m)), keys, grandTotal };
  }, [res]);

  const emptyText = loading
    ? 'Loading customer consumption…'
    : res && res.ok === false && res.code === 'NO_ACCOUNT'
      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load customer consumption.'
      : res && res.ok === false && res.error
        ? `Could not load customer consumption: ${res.error}`
        : `No customer consumption found for the selected accounts in ${(fiscalYears || []).join(' + ')}.`;

  return (
    <MultiLineAcrChart
      title="ACR by Customer"
      icon={<PeopleTeamRegular style={{ fontSize: 16 }} />}
      series={{ data: pivot.data, keys: pivot.keys }}
      grandTotal={pivot.grandTotal}
      loading={loading}
      cache={res?.cache}
      emptyText={emptyText}
    />
  );
}
