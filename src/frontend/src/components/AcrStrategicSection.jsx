import { useState, useEffect, useMemo, useCallback } from 'react';
import { Field, Select } from '@fluentui/react-components';
import {
  OrganizationRegular, LayerRegular, DataBarHorizontalRegular,
  TagRegular, DataPieRegular,
} from '@fluentui/react-icons';
import { acrQuery } from '../electronBridge';
import CollapsibleSection from './CollapsibleSection';
import MultiLineAcrChart from './AcrMultiLineChart';
import { fiscalMonthCompare } from '../lib/acrFormat';
import { consumeReloadGeneration } from '../lib/reloadGeneration';

// Combined "Strategic Pillar" chart: a single monthly line chart whose grouping
// dimension is chosen from a dropdown (mirrors the Foundry Models L4/L5 selector).
// Super › Strategic › Sub form a hierarchy, so one selector covers all levels.
const PILLAR_DIMS = [
  {
    key: 'superStrategicPillar', label: 'Super-Strategic Pillar',
    icon: <OrganizationRegular style={{ fontSize: 16 }} />,
  },
  {
    key: 'strategicPillar', label: 'Strategic Pillar',
    icon: <LayerRegular style={{ fontSize: 16 }} />,
  },
  {
    key: 'subStrategicPillar', label: 'Sub-Strategic Pillar',
    icon: <DataBarHorizontalRegular style={{ fontSize: 16 }} />,
  },
];

// Service comp grouping — a single-dimension monthly breakdown (no selector).
const SERVICE_GROUP_DIM = {
  key: 'serviceGroup', label: 'Service Comp Grouping',
  icon: <DataPieRegular style={{ fontSize: 16 }} />,
};

// Subscriptions — moved out of the Strategic section to the bottom of the
// per-customer page. Kept here so the shared fetch/pivot logic is reused.
const SUBSCRIPTION_DIM = {
  key: 'subscription', label: 'Subscriptions',
  icon: <TagRegular style={{ fontSize: 16 }} />,
};

// Blank/placeholder member label → a readable "(Unassigned)".
const memberLabel = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? '(Unassigned)' : s;
};

/**
 * A monthly strategic breakdown. `dims` is a list of one or more dimensions;
 * when more than one is supplied a dropdown selector (like the Foundry Models
 * L4/L5 picker) chooses which one drives the chart. Renders a monthly
 * multi-line chart (top 10 + expand) when >1 month of data exists, otherwise a
 * ranked top-10 table with a "Show all" expander. Fetches independently so one
 * failing never blocks the others; errors are surfaced explicitly (no silent
 * fallback).
 *
 * @param {object} props
 * @param {Array}  props.dims        [{ key, label, icon }]
 * @param {string[]} props.tpids
 * @param {string[]} props.fiscalYears
 * @param {string} [props.accountName]
 * @param {number} [props.reloadKey]
 */
function StrategicBreakdown({
  dims,
  tpids,
  fiscalYears,
  accountName,
  reloadKey = 0,
  onLoadingChange,
}) {
  const [activeKey, setActiveKey] = useState(dims[0].key);
  const [res, setRes] = useState(null); // { ok, rows, error, code }
  const [loading, setLoading] = useState(false);
  const dim = dims.find((d) => d.key === activeKey) || dims[0];
  const hasSelector = dims.length > 1;

  const tpidKey = (tpids || []).join('|');
  const fyKey = (fiscalYears || []).join('|');

  const load = useCallback(async (forceOverride) => {
    if (!tpids?.length || !fiscalYears?.length) return;
    const force = typeof forceOverride === 'boolean' ? forceOverride : consumeReloadGeneration(
      'acr-strategic',
      `${dim.key}|${tpidKey}|${fyKey}`,
      reloadKey,
    );
    setLoading(true);
    onLoadingChange?.(true);
    try {
      const r = await acrQuery({
        tpids,
        groupBy: [dim.key, 'fiscalMonth'],
        measures: ['acr'],
        fiscalYears,
        topN: 5000,
        force,
      });
      setRes(r?.ok
        ? { ok: true, rows: r.rows || [], cache: r.cache }
        : { ...r, ok: false, rows: [], error: r?.error || 'No chart response.' });
    } catch (e) {
      setRes({ ok: false, rows: [], error: e.message || 'Query failed.' });
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim.key, tpidKey, fyKey, reloadKey, onLoadingChange]);

  useEffect(() => { load(); }, [load]);

  // Pivot rows → monthly series (keys sorted by total desc).
  const pivot = useMemo(() => {
    const rows = res?.rows || [];
    const totals = new Map();
    const months = new Set();
    for (const r of rows) {
      const name = memberLabel(r[dim.key]);
      const v = Number(r.acr) || 0;
      if (v === 0) continue;
      totals.set(name, (totals.get(name) || 0) + v);
      if (r.fiscalMonth) months.add(r.fiscalMonth);
    }
    const rankedAll = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const keys = rankedAll.map((e) => e[0]);
    const monthList = [...months].sort(fiscalMonthCompare);
    const byMonth = new Map(monthList.map((m) => [m, { fiscalMonth: m }]));
    for (const r of rows) {
      const name = memberLabel(r[dim.key]);
      if (!totals.has(name)) continue;
      const row = byMonth.get(r.fiscalMonth);
      if (row) row[name] = (row[name] || 0) + (Number(r.acr) || 0);
    }
    const grandTotal = rankedAll.reduce((s, e) => s + e[1], 0);
    return {
      data: monthList.map((m) => byMonth.get(m)),
      keys,
      grandTotal,
    };
  }, [res, dim.key]);

  const emptyText = loading
    ? 'Loading…'
    : res && res.ok === false && res.code === 'NO_ACCOUNT'
      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load this breakdown.'
      : res && res.ok === false && res.error
        ? `Could not load ${dim.label.toLowerCase()}: ${res.error}`
        : `No ${dim.label.toLowerCase()} data recorded for ${accountName || 'the selected accounts'} in ${(fiscalYears || []).join(' + ')}.`;

  const selector = hasSelector ? (
    <Field label="Pillar level" style={{ minWidth: 150 }}>
      <Select
        value={activeKey}
        onChange={(_e, d) => setActiveKey(d.value)}
        size="small"
        disabled={loading}
      >
        {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </Select>
    </Field>
  ) : null;

  return (
    <div style={{ marginBottom: 4 }}>
      <MultiLineAcrChart
        title={dim.label}
        icon={dim.icon}
        series={{ data: pivot.data, keys: pivot.keys }}
        grandTotal={pivot.grandTotal}
        loading={loading}
        cache={res?.cache}
        onRefresh={load} retryAt={res?.retryAt}
        emptyText={emptyText}
        controls={selector}
      />
    </div>
  );
}

/**
 * "Strategic" section — combined strategic-pillar trend (Super › Strategic ›
 * Sub via a dropdown) and service comp grouping, placed above the
 * Infra/Data/Apps containers on both the portfolio and per-customer ACR pages.
 * Wrapped in a collapsed CollapsibleSection so its live Power BI queries only
 * fire on expand.
 *
 * @param {object} props
 * @param {string[]} props.tpids
 * @param {string[]} props.fiscalYears
 * @param {string} [props.accountName]
 * @param {number} [props.reloadKey]  Bump to force a live refetch.
 */
export default function AcrStrategicSection({
  tpids,
  fiscalYears,
  accountName,
  reloadKey = 0,
  onLoadingChange,
}) {
  return (
    <CollapsibleSection
      title="Strategic"
      subtitle="Strategic pillars & service comp grouping"
      icon={<OrganizationRegular style={{ fontSize: 16 }} />}
    >
      <StrategicBreakdown
        dims={PILLAR_DIMS}
        tpids={tpids}
        fiscalYears={fiscalYears}
        accountName={accountName}
        reloadKey={reloadKey}
        onLoadingChange={onLoadingChange}
      />
      <StrategicBreakdown
        dims={[SERVICE_GROUP_DIM]}
        tpids={tpids}
        fiscalYears={fiscalYears}
        accountName={accountName}
        reloadKey={reloadKey}
        onLoadingChange={onLoadingChange}
      />
    </CollapsibleSection>
  );
}

/**
 * Standalone "Subscriptions" section — a monthly subscription-level spend
 * breakdown. Rendered at the bottom of the per-customer ACR page (moved out of
 * the Strategic section). Collapsed by default so it loads live on expand.
 *
 * @param {object} props
 * @param {string[]} props.tpids
 * @param {string[]} props.fiscalYears
 * @param {string} [props.accountName]
 * @param {number} [props.reloadKey]
 */
export function AcrSubscriptionsSection({
  tpids,
  fiscalYears,
  accountName,
  reloadKey = 0,
  onLoadingChange,
}) {
  return (
    <CollapsibleSection
      title="Subscriptions"
      subtitle="Subscription-level spend, month over month"
      icon={<TagRegular style={{ fontSize: 16 }} />}
    >
      <StrategicBreakdown
        dims={[SUBSCRIPTION_DIM]}
        tpids={tpids}
        fiscalYears={fiscalYears}
        accountName={accountName}
        reloadKey={reloadKey}
        onLoadingChange={onLoadingChange}
      />
    </CollapsibleSection>
  );
}
