import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Select, Field, Spinner } from '@fluentui/react-components';
import {
  MoneyRegular, ArrowTrendingRegular, ArrowTrendingLinesRegular, ArrowTrendingDownRegular, DataTrendingRegular,
  DismissRegular, ArrowDownloadRegular, SparkleRegular,
} from '@fluentui/react-icons';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell,
} from 'recharts';
import { useDbQuery } from '../hooks/useDb';
import { acrPortfolio, acrPeriods, acrSnapshot, acrSnapshotStatus, acrInsights, acrModels, openExternal } from '../electronBridge';
import { useAcrProductFilter } from '../hooks/useAcrProductFilter';
import { useRosterTpids } from '../hooks/useRosterTpids';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAcrRefresh } from '../hooks/useAcrRefresh';
import AcrProductFilter from './AcrProductFilter';
import AcrServiceHierarchy from './AcrServiceHierarchy';
import AcrProductTrendChart from './AcrProductTrendChart';
import CollapsibleSection from './CollapsibleSection';
import AcrStrategicSection from './AcrStrategicSection';
import AcrCustomerChart from './AcrCustomerChart';
import AcrFreshness from './AcrFreshness';
import AcrProgressBanner from './AcrProgressBanner';
import AcrAnthropicSpend from './AcrAnthropicSpend';
import MultiLineAcrChart from './AcrMultiLineChart';
import { fmtUsd, fmtUsdFull, fmtPct, monthAbbr, formatFiscalMonth, trendColor, normalizeName, defaultFiscalYear } from '../lib/acrFormat';

const FOUNDRY_LEVELS = [4, 5];
// Top services always uses Service Level 2. The Service level selector lives in
// the Service hierarchy card and sets only that matrix's depth.
const SERVICE_MIX_LEVEL = 2;
const COMPUTE_L2 = ['Azure App Service', 'Azure Container Apps', 'Azure Kubernetes Service', 'Functions'];
const VM_L2 = ['Virtual Machines', 'Virtual Machines Licenses', 'Azure Arc', 'Azure App Service', 'Functions', 'Azure Kubernetes Service', 'Azure Container Apps'];
const FOUNDRY_TOOLS_L2 = ['Foundry Tools'];
const DEVELOPER_TOOLS_L2 = ['GitHub', 'API Management', 'Azure DevOps', 'Azure Monitor', 'Log Analytics'];
// L2 service categories are matched against the ACR cube (Analysis Services
// Tabular, case-sensitive collation) with an exact `In` filter, so these must
// match the curated member names' casing exactly — e.g. 'SQL Database', not
// 'SQL database', otherwise the product silently returns no rows.
const DATABASES_L2 = ['Databases', 'Microsoft Fabric', 'Azure Arc Enabled Databases', 'SQL Database', 'SQL Managed Instance', 'Redis Cache', 'Azure Database for PostgreSQL', 'Azure Cosmos DB', 'Azure Database for MySQL', 'Azure Database for MariaDB'];
// Best-effort Service Level 2 supersets for the Data (Analytics) and Infra
// (Networking, Storage) containers — same exact-match caveat as DATABASES_L2.
const ANALYTICS_L2 = ['Analytics', 'Microsoft Fabric', 'Azure Synapse Analytics', 'Azure Databricks', 'Azure Data Factory', 'Azure Data Factory v2', 'Azure Data Explorer', 'Azure Stream Analytics', 'Stream Analytics', 'Azure HDInsight', 'HDInsight', 'Power BI', 'Power BI Embedded', 'Azure Analysis Services', 'Azure Data Lake Analytics', 'Event Hubs', 'Azure Data Share', 'Microsoft Purview', 'Azure Purview'];
const NETWORKING_L2 = ['Networking', 'Virtual Network', 'Azure Virtual Network', 'Load Balancer', 'Azure Load Balancer', 'Application Gateway', 'Azure Application Gateway', 'Azure Firewall', 'ExpressRoute', 'Azure ExpressRoute', 'Azure Front Door', 'VPN Gateway', 'Azure VPN Gateway', 'Azure DNS', 'Azure Bastion', 'Content Delivery Network', 'Azure CDN', 'Traffic Manager', 'Azure Virtual WAN', 'Network Watcher', 'Azure Private Link'];
const STORAGE_L2 = ['Storage', 'Azure Storage', 'Storage Accounts', 'Azure Blob Storage', 'Blob Storage', 'Azure Files', 'Azure NetApp Files', 'Azure Data Lake Storage', 'Managed Disks', 'Azure Managed Disks', 'Backup', 'Azure Backup', 'Azure Site Recovery', 'Azure Container Storage', 'Azure Elastic SAN', 'StorSimple'];
const BAR_COLORS = ['var(--accent)', 'var(--violet)', 'var(--success-text)', 'var(--warning-text)', 'var(--pink)', 'var(--accent)', 'var(--warning)', 'var(--accent)', 'var(--pink)', 'var(--accent)', 'var(--danger)', 'var(--accent)'];

// Lightweight pure-SVG sparkline (cheap enough for many leaderboard rows).
function Sparkline({ values, width = 96, height = 24, color = 'var(--accent)' }) {
  const nums = (values || []).map((v) => Number(v) || 0);
  if (nums.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const step = width / (nums.length - 1);
  const pts = nums.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`);
  const last = nums[nums.length - 1];
  const [lx, ly] = pts[pts.length - 1].split(',');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2" fill={color} />
      <title>{`${nums.length} months · latest ${fmtUsd(last)}`}</title>
    </svg>
  );
}

function Kpi({ icon, label, value, sub, color }) {
  return (
    <div className="stat-card" style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {icon}
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      {sub != null && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}>{formatFiscalMonth(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color || 'var(--text)', fontWeight: 600 }}>{fmtUsdFull(p.value)}</div>
      ))}
    </div>
  );
}

export default function Consumption() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Optional ?tpid= deep-link (from a customer profile's "Azure Consumption" button)
  // scopes the whole portfolio view to that single account.
  const focusTpid = (searchParams.get('tpid') || '').trim();
  const { data: customerRows } = useDbQuery(
    "SELECT id, name, tpid, parenting_level FROM active_customers WHERE tpid IS NOT NULL AND tpid <> ''",
  );
  // The account roster (Settings → Default Accounts) is the authoritative account
  // set. The customers table only holds accounts already synced from MSX, so the
  // roster is unioned in to ensure every account the user configured is shown.
  const { rosterTpids } = useRosterTpids();

  const [fyOptions, setFyOptions] = useState([]);
  const [selectedFys, setSelectedFys] = usePersistedState('acr.fiscalYears', []);
  const [foundryLevel, setFoundryLevel] = useState(4);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [models, setModels] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [compute, setCompute] = useState(null);
  const [computeLoading, setComputeLoading] = useState(false);
  const [foundryTools, setFoundryTools] = useState(null);
  const [foundryToolsLoading, setFoundryToolsLoading] = useState(false);
  const [developerTools, setDeveloperTools] = useState(null);
  const [developerToolsLoading, setDeveloperToolsLoading] = useState(false);
  const [databases, setDatabases] = useState(null);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [networking, setNetworking] = useState(null);
  const [networkingLoading, setNetworkingLoading] = useState(false);
  const [vm, setVm] = useState(null);
  const [vmLoading, setVmLoading] = useState(false);
  const [storage, setStorage] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [sort, setSort] = useState({ key: 'latest', dir: 'desc' });
  const [reloadKey, setReloadKey] = useState(0);
  const [openedSections, setOpenedSections] = useState({
    infra: 0,
    data: 0,
    apps: 0,
  });
  const [visibleSections, setVisibleSections] = useState({
    infra: false,
    data: false,
    apps: false,
  });
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [childLoadCount, setChildLoadCount] = useState(0);
  const onChildLoadingChange = useCallback((isLoading) => {
    setChildLoadCount((count) => Math.max(0, count + (isLoading ? 1 : -1)));
  }, []);

  // Service Level 2 product filter (item 3) — now a persistent, app-wide saved
  // filter (survives restarts, shared with per-account pages) via app_settings.
  const { filter: productFilter } = useAcrProductFilter();
  const productServices = productFilter.services;

  // Local analytics snapshot (item 2).
  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState(null);

  // Deterministic analysis-engine insights from the local store (item 7).
  const [insights, setInsights] = useState(null);

  // Distinct TPIDs to query, and normalized-name → customer id / tpid maps for drill-in.
  // When a ?tpid= focus is present, the query set narrows to just that account.
  const { tpids, allTpids, nameToTpid, focusName } = useMemo(() => {
    const rows = customerRows || [];
    const allT = [...rosterTpids];
    const tmap = new Map();
    // Prefer top-parent accounts (parenting_level 861980000) when names collide.
    for (const r of rows) {
      const key = normalizeName(r.name);
      if (!key) continue;
      if (!tmap.has(key) || r.parenting_level === 861980000) tmap.set(key, String(r.tpid).trim());
    }
    let name = '';
    if (focusTpid) {
      const named = rows
        .filter((r) => String(r.tpid).trim() === focusTpid)
        .map((r) => r.name)
        .filter(Boolean)
        .sort((a, b) => a.length - b.length);
      name = named[0] || `TPID ${focusTpid}`;
    }
    return { tpids: focusTpid ? allT.filter((tpid) => tpid === focusTpid) : allT, allTpids: allT, nameToTpid: tmap, focusName: name };
  }, [customerRows, rosterTpids, focusTpid]);

  const clearCustomer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('tpid');
    setSearchParams(next);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await acrPeriods();
        if (cancelled || !p?.ok) return;
        setFyOptions(p.fiscalYears || []);
        setSelectedFys((cur) => {
          const opts = p.fiscalYears || [];
          const valid = cur.filter((y) => opts.includes(y));
          if (valid.length) return valid;
          return [defaultFiscalYear(opts)].filter(Boolean);
        });
      } catch { /* non-fatal */ }
      try {
        const s = await acrSnapshotStatus();
        if (!cancelled && s?.ok) setSnapshotStatus(s.last);
      } catch { /* non-fatal */ }
      try {
        const ins = await acrInsights({ fiscalYears: ['FY26', 'FY27'] });
        if (!cancelled && ins?.ok) setInsights(ins);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await acrPortfolio({
        tpids,
        fiscalYears: selectedFys,
        level: SERVICE_MIX_LEVEL,
        services: productServices.length ? productServices : undefined,
        serviceFilterLevel: productFilter.level || 2,
        force,
      });
      if (res?.ok) {
        setData(res);
        if (res.cache?.status !== 'missing' && (!res.accounts || res.accounts.length === 0)) {
          if (tpids.length > 0) {
            setMessage({ type: 'warning', text: `The ACR model returned no rows for any of your ${tpids.length} accounts in ${res.fiscalYear}. This usually means the Power BI dataset is refreshing or your access to it has changed — not that consumption is truly $0. Try another fiscal year or check your access to the ACR semantic model.` });
          } else {
            setMessage({ type: 'info', text: `No Azure consumption recorded across your accounts in ${res.fiscalYear}.` });
          }
        }
      } else if (res?.code === 'NO_ACCOUNT') {
        setMessage({ type: 'warning', text: 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load consumption data.' });
      } else if (res?.code === 'ACR_OFFLINE') {
        setMessage({ type: 'warning', text: res.error || 'Cannot reach the ACR Power BI model. Connect to corpnet/VPN and try again.' });
      } else if (['ACR_RLS_UNAUTHORIZED', 'ACR_UNAUTHORIZED'].includes(res?.code)) {
        setMessage({ type: 'error', code: res.code, text: res.error });
      } else {
        setMessage({ type: 'error', text: res?.error || 'Failed to load consumption data.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Failed to load consumption data.' });
    } finally {
      setLoading(false);
    }
  }, [selectedFys, tpids, productServices, productFilter.level]);

  useEffect(() => { load(false); }, [load]);
  useAcrRefresh(data?.cache, load);

  const loadModels = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setModelsLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: foundryLevel, force });
      if (res?.ok) setModels(res);
      else setModels({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setModels({ ok: false, error: e.message || 'Failed to load model consumption.', models: [] });
    } finally {
      setModelsLoading(false);
    }
  }, [selectedFys, tpids, foundryLevel]);

  useEffect(() => {
    if (visibleSections.apps) loadModels(false);
  }, [visibleSections.apps, openedSections.apps, loadModels]);

  const loadCompute = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setComputeLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: COMPUTE_L2, force });
      if (res?.ok) setCompute(res);
      else setCompute({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setCompute({ ok: false, error: e.message || 'Failed to load compute consumption.', models: [] });
    } finally {
      setComputeLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.apps) loadCompute(false);
  }, [visibleSections.apps, openedSections.apps, loadCompute]);

  const loadFoundryTools = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setFoundryToolsLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 4, categories: FOUNDRY_TOOLS_L2, force });
      if (res?.ok) setFoundryTools(res);
      else setFoundryTools({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setFoundryTools({ ok: false, error: e.message || 'Failed to load Foundry Tools consumption.', models: [] });
    } finally {
      setFoundryToolsLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.apps) loadFoundryTools(false);
  }, [visibleSections.apps, openedSections.apps, loadFoundryTools]);

  const loadDeveloperTools = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setDeveloperToolsLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: DEVELOPER_TOOLS_L2, force });
      if (res?.ok) setDeveloperTools(res);
      else setDeveloperTools({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setDeveloperTools({ ok: false, error: e.message || 'Failed to load developer tools consumption.', models: [] });
    } finally {
      setDeveloperToolsLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.apps) loadDeveloperTools(false);
  }, [visibleSections.apps, openedSections.apps, loadDeveloperTools]);

  const loadDatabases = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setDatabasesLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: DATABASES_L2, force });
      if (res?.ok) setDatabases(res);
      else setDatabases({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setDatabases({ ok: false, error: e.message || 'Failed to load database consumption.', models: [] });
    } finally {
      setDatabasesLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.data) loadDatabases(false);
  }, [visibleSections.data, openedSections.data, loadDatabases]);

  const loadAnalytics = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setAnalyticsLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: ANALYTICS_L2, force });
      if (res?.ok) setAnalytics(res);
      else setAnalytics({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setAnalytics({ ok: false, error: e.message || 'Failed to load analytics consumption.', models: [] });
    } finally {
      setAnalyticsLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.data) loadAnalytics(false);
  }, [visibleSections.data, openedSections.data, loadAnalytics]);

  const loadNetworking = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setNetworkingLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: NETWORKING_L2, force });
      if (res?.ok) setNetworking(res);
      else setNetworking({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setNetworking({ ok: false, error: e.message || 'Failed to load networking consumption.', models: [] });
    } finally {
      setNetworkingLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.infra) loadNetworking(false);
  }, [visibleSections.infra, openedSections.infra, loadNetworking]);

  const loadVm = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setVmLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: VM_L2, force });
      if (res?.ok) setVm(res);
      else setVm({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setVm({ ok: false, error: e.message || 'Failed to load VM consumption.', models: [] });
    } finally {
      setVmLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.infra) loadVm(false);
  }, [visibleSections.infra, openedSections.infra, loadVm]);

  const loadStorage = useCallback(async (force = false) => {
    if (selectedFys.length === 0 || tpids.length === 0) return;
    setStorageLoading(true);
    try {
      const res = await acrModels({ tpids, fiscalYears: selectedFys, modelLevel: 2, categories: STORAGE_L2, force });
      if (res?.ok) setStorage(res);
      else setStorage({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setStorage({ ok: false, error: e.message || 'Failed to load storage consumption.', models: [] });
    } finally {
      setStorageLoading(false);
    }
  }, [selectedFys, tpids]);

  useEffect(() => {
    if (visibleSections.infra) loadStorage(false);
  }, [visibleSections.infra, openedSections.infra, loadStorage]);

  const markSectionOpened = (section, open) => {
    setVisibleSections((current) => ({ ...current, [section]: open }));
    if (!open) return;
    setOpenedSections((current) => ({
      ...current,
      [section]: current[section] + 1,
    }));
  };

  const refreshVisible = useCallback(async () => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    setReloadKey((key) => key + 1);
    const tasks = [load(true)];
    if (visibleSections.apps) {
      tasks.push(
        loadModels(true),
        loadCompute(true),
        loadFoundryTools(true),
        loadDeveloperTools(true),
      );
    }
    if (visibleSections.data) tasks.push(loadDatabases(true), loadAnalytics(true));
    if (visibleSections.infra) {
      tasks.push(loadNetworking(true), loadVm(true), loadStorage(true));
    }
    try {
      await Promise.allSettled(tasks);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      setManualRefreshing(false);
    }
  }, [
    load,
    loadModels,
    loadCompute,
    loadFoundryTools,
    loadDeveloperTools,
    loadDatabases,
    loadAnalytics,
    loadNetworking,
    loadVm,
    loadStorage,
    visibleSections,
    manualRefreshing,
  ]);

  // FY toggle: keep at least one year selected; sort by the fyOptions order.
  const toggleFy = (year) => {
    setSelectedFys((cur) => {
      const has = cur.includes(year);
      let next = has ? cur.filter((y) => y !== year) : [...cur, year];
      if (next.length === 0) next = [year]; // never allow an empty selection
      return fyOptions.filter((y) => next.includes(y));
    });
  };

  const runSnapshot = async () => {
    if (snapshotting || tpids.length === 0) return;
    setSnapshotting(true);
    setMessage(null);
    try {
      const res = await acrSnapshot({ tpids, fiscalYears: ['FY26', 'FY27'], level: 2 });
      if (res?.ok) {
        setSnapshotStatus({
          fiscal_years: res.fiscalYears.join(','), service_level: res.level, tpid_count: res.tpidCount,
          account_rows: res.accountRows, service_rows: res.serviceRows, ran_at: res.ranAt,
        });
        setMessage({ type: 'success', text: `Saved FY26 + FY27 locally: ${res.accountRows} account rows, ${res.serviceRows} service rows.` });
        try {
          const ins = await acrInsights({ fiscalYears: ['FY26', 'FY27'] });
          if (ins?.ok) setInsights(ins);
        } catch { /* non-fatal */ }
      } else if (res?.code === 'NO_ACCOUNT') {
        setMessage({ type: 'warning', text: 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to download consumption.' });
      } else {
        setMessage({ type: 'error', text: res?.error || 'Failed to download metrics.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Failed to download metrics.' });
    } finally {
      setSnapshotting(false);
    }
  };

  const trendData = useMemo(() => {
    if (!data) return [];
    return data.months.map((m) => ({ fiscalMonth: m, total: data.totals.monthly[m] || 0 }));
  }, [data]);

  const serviceData = useMemo(() => {
    if (!data) return [];
    return (data.serviceMix || []).slice(0, 12).map((s) => ({ service: s.service, total: s.total }));
  }, [data]);

  const modelSeries = useMemo(() => {
    if (!models?.ok || !models.months?.length) return { data: [], keys: [] };
    const keys = (models.models || []).map((m) => m.model);
    const dataRows = models.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const mdl of models.models) row[mdl.model] = mdl.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [models]);

  const computeSeries = useMemo(() => {
    if (!compute?.ok || !compute.months?.length) return { data: [], keys: [] };
    const keys = (compute.models || []).map((m) => m.model);
    const dataRows = compute.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const svc of compute.models) row[svc.model] = svc.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [compute]);

  const foundryToolsSeries = useMemo(() => {
    if (!foundryTools?.ok || !foundryTools.months?.length) return { data: [], keys: [] };
    const keys = (foundryTools.models || []).map((m) => m.model);
    const dataRows = foundryTools.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of foundryTools.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [foundryTools]);

  const developerToolsSeries = useMemo(() => {
    if (!developerTools?.ok || !developerTools.months?.length) return { data: [], keys: [] };
    const keys = (developerTools.models || []).map((m) => m.model);
    const dataRows = developerTools.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of developerTools.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [developerTools]);

  const databasesSeries = useMemo(() => {
    if (!databases?.ok || !databases.months?.length) return { data: [], keys: [] };
    const keys = (databases.models || []).map((m) => m.model);
    const dataRows = databases.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of databases.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [databases]);

  const analyticsSeries = useMemo(() => {
    if (!analytics?.ok || !analytics.months?.length) return { data: [], keys: [] };
    const keys = (analytics.models || []).map((m) => m.model);
    const dataRows = analytics.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of analytics.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [analytics]);

  const networkingSeries = useMemo(() => {
    if (!networking?.ok || !networking.months?.length) return { data: [], keys: [] };
    const keys = (networking.models || []).map((m) => m.model);
    const dataRows = networking.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of networking.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [networking]);

  const storageSeries = useMemo(() => {
    if (!storage?.ok || !storage.months?.length) return { data: [], keys: [] };
    const keys = (storage.models || []).map((m) => m.model);
    const dataRows = storage.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of storage.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [storage]);

  const vmSeries = useMemo(() => {
    if (!vm?.ok || !vm.months?.length) return { data: [], keys: [] };
    const keys = (vm.models || []).map((m) => m.model);
    const dataRows = vm.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of vm.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data: dataRows, keys };
  }, [vm]);

  const sortedAccounts = useMemo(() => {
    if (!data) return [];
    const rows = [...data.accounts];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = key === 'account' ? String(a.account).toLowerCase() : (Number(a[key]) || 0);
      const bv = key === 'account' ? String(b.account).toLowerCase() : (Number(b[key]) || 0);
      if (av < bv) return -1 * mul;
      if (av > bv) return 1 * mul;
      return 0;
    });
    return rows;
  }, [data, sort]);

  const setSortKey = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const tpidFor = (account) => nameToTpid.get(normalizeName(account)) || null;

  const totals = data?.totals;
  const th = (key, label, align = 'right') => (
    <th
      onClick={() => setSortKey(key)}
      style={{ textAlign: align, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}
      title="Sort"
    >
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </th>
  );

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Azure Consumption</h2>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <Field label="Fiscal years">
            <div style={{ display: 'flex', gap: 4 }}>
              {fyOptions.map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => toggleFy(y)}
                  disabled={loading}
                  className={`diag-toggle${selectedFys.includes(y) ? ' active' : ''}`}
                  style={{ padding: '4px 10px', fontSize: 12, cursor: loading ? 'default' : 'pointer' }}
                  title={selectedFys.includes(y) ? `Showing ${y}` : `Add ${y}`}
                >
                  {y}
                </button>
              ))}
            </div>
          </Field>
          <Button
            appearance="secondary"
            size="small"
            onClick={refreshVisible}
            disabled={loading || manualRefreshing || childLoadCount > 0 || tpids.length === 0}
          >
            {loading || manualRefreshing || childLoadCount > 0 ? 'Refreshing…' : 'Refresh'}
          </Button>
          {!focusTpid && (
            <Button appearance="secondary" size="small" icon={<ArrowDownloadRegular />} onClick={runSnapshot} disabled={snapshotting || loading || tpids.length === 0} title="Download FY26 + FY27 metrics to the local analytics store">
              {snapshotting ? 'Downloading…' : 'Download FY26+FY27'}
            </Button>
          )}
          {(loading || snapshotting) && <Spinner size="tiny" />}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <AcrProductFilter optionTpids={allTpids} fiscalYears={selectedFys} disabled={loading} />
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
        {focusTpid
          ? `Monthly Azure Consumed Revenue for ${focusName}, from the MSX-I Power BI model. Requires Microsoft sign-in + corpnet/VPN.`
          : `Monthly Azure Consumed Revenue across your ${tpids.length} tracked account${tpids.length !== 1 ? 's' : ''}, from the MSX-I Power BI model. Spot growth opportunities and consumption risks. Requires Microsoft sign-in + corpnet/VPN.`}
        {snapshotStatus?.ran_at && !focusTpid && (
          <span> · Local store: {snapshotStatus.fiscal_years} ({snapshotStatus.account_rows} rows) saved {new Date(snapshotStatus.ran_at).toLocaleString()}.</span>
        )}
      </p>
      <AcrFreshness cache={data?.cache} />
      <AcrProgressBanner />

      {focusTpid && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Customer: {focusName}
            <DismissRegular style={{ fontSize: 12, cursor: 'pointer' }} onClick={clearCustomer} title="Clear customer filter" />
          </span>
          <button
            type="button"
            onClick={clearCustomer}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: 13 }}
          >
            Show all accounts
          </button>
        </div>
      )}

      {message && (
        <div className={`flash-message flash-${message.type}`} style={{ marginBottom: 16 }}>
          <div>{message.text}</div>
          {['ACR_RLS_UNAUTHORIZED', 'ACR_UNAUTHORIZED'].includes(message.code) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Button size="small" onClick={() => navigate('/')}>Open User Home sign-in</Button>
              <Button size="small" onClick={() => openExternal('https://msit.powerbi.com/')}>Open Power BI</Button>
            </div>
          )}
        </div>
      )}

      {tpids.length === 0 && !loading && (
        <div className="card"><div className="card-body-custom" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>
          No accounts with a TPID yet. Sync customers from MSX (Settings) to populate consumption.
        </div></div>
      )}

      {loading && !data && tpids.length > 0 && (
        <div className="card" data-acr-loading><div className="card-body-custom" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32, textAlign: 'center' }}>
          <Spinner size="small" label="Loading Azure consumption…" />
          <div style={{ fontSize: 12, maxWidth: 460 }}>
            Pulling live from the Power BI model. First load can take a moment — this requires you to be signed in with Microsoft and on corpnet/VPN.
          </div>
        </div></div>
      )}

      {!focusTpid && insights?.ok && !insights.insufficientData && insights.insights?.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <DataTrendingRegular style={{ fontSize: 16 }} /> Portfolio insights
              <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>· from local {insights.fiscalYears?.join(' + ') || 'snapshot'}</span>
            </span>
          </div>
          <div className="card-body-custom">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {insights.insights.map((ins, i) => {
                const bar = ins.severity === 'critical' ? 'var(--pink)'
                  : ins.severity === 'warning' ? 'var(--warning-text)'
                    : ins.severity === 'positive' ? 'var(--success-text)' : 'var(--accent)';
                return (
                  <div key={`${ins.kind}-${i}`} style={{ borderLeft: `3px solid ${bar}`, background: 'var(--surface-3)', borderRadius: 6, padding: '8px 12px' }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 3 }}>{ins.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ins.detail}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {data && data.cache?.status !== 'missing' && totals && (
        <>
          {/* KPI row */}
          <div data-acr-ready style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
            <Kpi icon={<MoneyRegular style={{ fontSize: 22, color: 'var(--accent)' }} />} label={`${focusTpid ? 'Account' : 'Territory'} ACR · ${data.latestMonth ? monthAbbr(data.latestMonth) : ''}`} value={fmtUsd(totals.latest)} sub={`${data.fiscalYear} · ${totals.accountCount} account${totals.accountCount === 1 ? '' : 's'}`} />
            <Kpi icon={<ArrowTrendingRegular style={{ fontSize: 22, color: trendColor(totals.momDollar) }} />} label="MoM change" value={fmtUsd(totals.momDollar)} sub={fmtPct(totals.momPct)} color={trendColor(totals.momDollar)} />
            <Kpi icon={<ArrowTrendingLinesRegular style={{ fontSize: 22, color: 'var(--success-text)' }} />} label="Growing accounts" value={totals.growing} sub="expansion opportunities" color="var(--success-text)" />
            <Kpi icon={<ArrowTrendingDownRegular style={{ fontSize: 22, color: 'var(--pink)' }} />} label="Declining accounts" value={totals.declining} sub="consumption risks" color="var(--pink)" />
          </div>

          {/* Territory trend */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <DataTrendingRegular /> {focusTpid ? 'Account' : 'Territory'} consumption trend · {data.fiscalYear}
            </div>
            <div className="card-body-custom" style={{ height: 260 }}>
              {trendData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <defs>
                      <linearGradient id="acrArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="fiscalMonth" stroke="var(--text-muted)" fontSize={12} tickLine={false} tickFormatter={monthAbbr} />
                    <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} width={54} tickFormatter={(v) => fmtUsd(v)} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />
                    <Area type="monotone" dataKey="total" stroke="var(--accent)" strokeWidth={2} fill="url(#acrArea)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div style={{ color: 'var(--text-muted)', textAlign: 'center', paddingTop: 90 }}>No trend data.</div>}
            </div>
          </div>

          {/* ACR by Customer — portfolio-only monthly line chart. Grouping by
              customer absorbs the enrollment (Unassigned)/N/A tags back into
              their parent accounts, so this view is fully clean. */}
          {!focusTpid && (
            <CollapsibleSection title="Customer trends" subtitle="Monthly ACR by customer">
              <AcrCustomerChart
                tpids={tpids}
                fiscalYears={selectedFys}
                reloadKey={reloadKey}
                onLoadingChange={onChildLoadingChange}
              />
            </CollapsibleSection>
          )}

          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Account leaderboard */}
            <div className="card" data-tour="acr-leaderboard" style={{ flex: '2 1 520px', minWidth: 0 }}>
              <div className="card-header-custom">Account leaderboard</div>
              <div className="card-body-custom" style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      {th('account', 'Account', 'left')}
                      <th style={{ textAlign: 'center' }}>Trend</th>
                      {th('latest', `ACR (${data.latestMonth ? monthAbbr(data.latestMonth) : 'latest'})`)}
                      {th('momDollar', 'MoM $')}
                      {th('momPct', 'MoM %')}
                      {th('total', `${data.fiscalYear} total`)}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAccounts.map((a) => {
                      const acctTpid = tpidFor(a.account);
                      const spark = data.months.map((m) => a.monthly[m] || 0);
                      return (
                        <tr key={a.account} style={{ cursor: acctTpid ? 'pointer' : 'default' }} onClick={() => acctTpid && navigate(`/consumption/${acctTpid}`)}>
                          <td style={{ textAlign: 'left', fontWeight: 600, color: acctTpid ? 'var(--accent)' : 'var(--text)', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={acctTpid ? `${a.account} — open account consumption` : a.account}>{a.account}</td>
                          <td style={{ textAlign: 'center' }}><Sparkline values={spark} color={trendColor(a.momDollar)} /></td>
                          <td style={{ textAlign: 'right' }} title={fmtUsdFull(a.latest)}>{fmtUsd(a.latest)}</td>
                          <td style={{ textAlign: 'right', color: trendColor(a.momDollar) }} title={fmtUsdFull(a.momDollar)}>{fmtUsd(a.momDollar)}</td>
                          <td style={{ textAlign: 'right', color: trendColor(a.momDollar) }}>{fmtPct(a.momPct)}</td>
                          <td style={{ textAlign: 'right' }} title={fmtUsdFull(a.total)}>{fmtUsd(a.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Service mix */}
            <div className="card" style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div className="card-header-custom">Top services · {data.latestMonth ? monthAbbr(data.latestMonth) : 'latest'} (L{data.level})</div>
              <div className="card-body-custom" style={{ height: Math.max(220, serviceData.length * 30) }}>
                {serviceData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={serviceData} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" stroke="var(--text-muted)" fontSize={11} tickLine={false} tickFormatter={(v) => fmtUsd(v)} />
                      <YAxis type="category" dataKey="service" stroke="var(--text-muted)" fontSize={11} tickLine={false} width={110} tickFormatter={(s) => (s.length > 16 ? `${s.slice(0, 15)}…` : s)} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'color-mix(in srgb, var(--border) 20%, transparent)' }} />
                      <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                        {serviceData.map((s, i) => <Cell key={s.service} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div style={{ color: 'var(--text-muted)', textAlign: 'center', paddingTop: 80 }}>No service data.</div>}
              </div>
            </div>
          </div>

          {/* Strategic pillars & service comp grouping — collapsed, loads on expand.
              Shown on both the portfolio and per-customer ACR views. */}
          <div style={{ marginTop: 20 }}>
            <AcrStrategicSection
              tpids={tpids}
              fiscalYears={selectedFys}
              accountName={focusTpid ? focusName : null}
              reloadKey={reloadKey}
              onLoadingChange={onChildLoadingChange}
            />
          </div>

          {/* Product-category containers — collapsed by default (Infra / Data / Apps). */}
          <div style={{ marginTop: 20 }}>
            <CollapsibleSection
              title="Infra"
              subtitle="VM, storage & networking (L2)"
              onOpenChange={(open) => markSectionOpened('infra', open)}
            >
              <MultiLineAcrChart
                title="VM by product (L2)"
                icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
                series={vmSeries}
                grandTotal={vm?.ok ? vm.grandTotal : 0}
                loading={vmLoading}
                cache={vm?.cache}
                onRefresh={loadVm} retryAt={vm?.retryAt}
                emptyText={
                  vmLoading
                    ? 'Loading VM consumption…'
                    : vm && vm.ok === false && vm.code === 'NO_ACCOUNT'
                      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load VM consumption.'
                      : vm && vm.ok === false && vm.error
                        ? `Could not load VM consumption: ${vm.error}`
                        : `No VM consumption found in ${selectedFys.join(' + ')}.`
                }
              />

              <MultiLineAcrChart
                title="Storage by product (L2)"
                icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
                series={storageSeries}
                grandTotal={storage?.ok ? storage.grandTotal : 0}
                loading={storageLoading}
                cache={storage?.cache}
                onRefresh={loadStorage} retryAt={storage?.retryAt}
                emptyText={
                  storageLoading
                    ? 'Loading storage consumption…'
                    : storage && storage.ok === false && storage.code === 'NO_ACCOUNT'
                      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load storage consumption.'
                      : storage && storage.ok === false && storage.error
                        ? `Could not load storage consumption: ${storage.error}`
                        : `No storage consumption found in ${selectedFys.join(' + ')}.`
                }
              />

              <MultiLineAcrChart
                title="Networking by product (L2)"
                icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
                series={networkingSeries}
                grandTotal={networking?.ok ? networking.grandTotal : 0}
                loading={networkingLoading}
                cache={networking?.cache}
                onRefresh={loadNetworking} retryAt={networking?.retryAt}
                emptyText={
                  networkingLoading
                    ? 'Loading networking consumption…'
                    : networking && networking.ok === false && networking.code === 'NO_ACCOUNT'
                      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load networking consumption.'
                      : networking && networking.ok === false && networking.error
                        ? `Could not load networking consumption: ${networking.error}`
                        : `No networking consumption found in ${selectedFys.join(' + ')}.`
                }
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Data"
              subtitle="Databases & analytics (L2)"
              onOpenChange={(open) => markSectionOpened('data', open)}
            >
              <MultiLineAcrChart
                title="Databases by product (L2)"
                icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
                series={databasesSeries}
                grandTotal={databases?.ok ? databases.grandTotal : 0}
                loading={databasesLoading}
                cache={databases?.cache}
                onRefresh={loadDatabases} retryAt={databases?.retryAt}
                emptyText={
                  databasesLoading
                    ? 'Loading database consumption…'
                    : databases && databases.ok === false && databases.code === 'NO_ACCOUNT'
                      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load database consumption.'
                      : databases && databases.ok === false && databases.error
                        ? `Could not load database consumption: ${databases.error}`
                        : `No database consumption found in ${selectedFys.join(' + ')}.`
                }
              />

              <MultiLineAcrChart
                title="Analytics by product (L2)"
                icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
                series={analyticsSeries}
                grandTotal={analytics?.ok ? analytics.grandTotal : 0}
                loading={analyticsLoading}
                cache={analytics?.cache}
                onRefresh={loadAnalytics} retryAt={analytics?.retryAt}
                emptyText={
                  analyticsLoading
                    ? 'Loading analytics consumption…'
                    : analytics && analytics.ok === false && analytics.code === 'NO_ACCOUNT'
                      ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load analytics consumption.'
                      : analytics && analytics.ok === false && analytics.error
                        ? `Could not load analytics consumption: ${analytics.error}`
                        : `No analytics consumption found in ${selectedFys.join(' + ')}.`
                }
              />
            </CollapsibleSection>

          </div>
        </>
      )}

      <CollapsibleSection
        title="Apps"
        subtitle="Foundry models & tools, compute, developer tools"
        onOpenChange={(open) => markSectionOpened('apps', open)}
      >
        <MultiLineAcrChart
          title={`Foundry Models by ${foundryLevel >= 5 ? 'model' : `Service Level ${foundryLevel}`} (L${foundryLevel})`}
          icon={<SparkleRegular style={{ fontSize: 16 }} />}
          series={modelSeries}
          grandTotal={models?.ok ? models.grandTotal : 0}
          loading={modelsLoading}
          cache={models?.cache}
          onRefresh={loadModels} retryAt={models?.retryAt}
          controls={(
            <Field label="Foundry level" style={{ minWidth: 120 }}>
              <Select
                value={String(foundryLevel)}
                onChange={(_e, d) => setFoundryLevel(Number(d.value))}
                size="small"
                disabled={modelsLoading}
              >
                {FOUNDRY_LEVELS.map((l) => <option key={l} value={l}>{`Level ${l}`}</option>)}
              </Select>
            </Field>
          )}
          emptyText={
            modelsLoading
              ? 'Loading model consumption…'
              : models && models.ok === false && models.code === 'NO_ACCOUNT'
                ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load model consumption.'
                : models && models.ok === false && models.error
                  ? `Could not load model consumption: ${models.error}`
                  : `No Foundry Models consumption found in ${selectedFys.join(' + ')}.`
          }
        />

        <AcrAnthropicSpend
          tpids={tpids}
          fiscalYears={selectedFys}
          reloadKey={reloadKey}
          onLoadingChange={onChildLoadingChange}
        />

        <MultiLineAcrChart
          title="Foundry Tools by Service Level 4 (L4)"
          icon={<SparkleRegular style={{ fontSize: 16 }} />}
          series={foundryToolsSeries}
          grandTotal={foundryTools?.ok ? foundryTools.grandTotal : 0}
          loading={foundryToolsLoading}
          cache={foundryTools?.cache}
          onRefresh={loadFoundryTools} retryAt={foundryTools?.retryAt}
          emptyText={
            foundryToolsLoading
              ? 'Loading Foundry Tools consumption…'
              : foundryTools && foundryTools.ok === false && foundryTools.code === 'NO_ACCOUNT'
                ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load Foundry Tools consumption.'
                : foundryTools && foundryTools.ok === false && foundryTools.error
                  ? `Could not load Foundry Tools consumption: ${foundryTools.error}`
                  : `No Foundry Tools consumption found in ${selectedFys.join(' + ')}.`
          }
        />

        <MultiLineAcrChart
          title="Compute services by product (L2)"
          icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
          series={computeSeries}
          grandTotal={compute?.ok ? compute.grandTotal : 0}
          loading={computeLoading}
          cache={compute?.cache}
          onRefresh={loadCompute} retryAt={compute?.retryAt}
          emptyText={
            computeLoading
              ? 'Loading compute consumption…'
              : compute && compute.ok === false && compute.code === 'NO_ACCOUNT'
                ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load compute consumption.'
                : compute && compute.ok === false && compute.error
                  ? `Could not load compute consumption: ${compute.error}`
                  : `No App Service, Container Apps, Kubernetes Service, or Functions consumption found in ${selectedFys.join(' + ')}.`
          }
        />

        <MultiLineAcrChart
          title="Developer Tools by product (L2)"
          icon={<DataTrendingRegular style={{ fontSize: 16 }} />}
          series={developerToolsSeries}
          grandTotal={developerTools?.ok ? developerTools.grandTotal : 0}
          loading={developerToolsLoading}
          cache={developerTools?.cache}
          onRefresh={loadDeveloperTools} retryAt={developerTools?.retryAt}
          emptyText={
            developerToolsLoading
              ? 'Loading developer tools consumption…'
              : developerTools && developerTools.ok === false && developerTools.code === 'NO_ACCOUNT'
                ? 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load developer tools consumption.'
                : developerTools && developerTools.ok === false && developerTools.error
                  ? `Could not load developer tools consumption: ${developerTools.error}`
                  : `No GitHub, API Management, Azure DevOps, Azure Monitor, or Log Analytics consumption found in ${selectedFys.join(' + ')}.`
          }
        />
      </CollapsibleSection>

      {/* Full Service-Level hierarchy (item A): L1 › … › Ln grouped, with its
          own Service level selector. Collapsible like Infra/Data/Apps — loads
          live on expand. */}
      {data && data.cache?.status !== 'missing' && totals && (
        <CollapsibleSection title="Service hierarchy" subtitle="Full L1 › … › Ln matrix">
          <AcrProductTrendChart
            tpids={tpids}
            fiscalYears={selectedFys}
            productFilter={productFilter}
            reloadKey={reloadKey}
            accountName={focusTpid ? focusName : null}
            storagePrefix="acr.productTrend.portfolio"
            onLoadingChange={onChildLoadingChange}
          />
          <AcrServiceHierarchy
            tpids={tpids}
            defaultLevel={2}
            fiscalYears={selectedFys}
            productFilter={productFilter}
            reloadKey={reloadKey}
            accountName={focusTpid ? focusName : null}
            onLoadingChange={onChildLoadingChange}
          />
        </CollapsibleSection>
      )}
    </div>
  );
}
