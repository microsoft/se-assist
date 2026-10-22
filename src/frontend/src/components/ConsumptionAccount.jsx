import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Select, Field, Spinner } from '@fluentui/react-components';
import {
  MoneyRegular, ArrowTrendingRegular, DataTrendingRegular, ArrowLeftRegular, OpenRegular, SparkleRegular,
} from '@fluentui/react-icons';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { useDbQuery } from '../hooks/useDb';
import { acrPortfolio, acrModels, acrPeriods, openExternal } from '../electronBridge';
import { useAcrProductFilter } from '../hooks/useAcrProductFilter';
import { useRosterTpids } from '../hooks/useRosterTpids';
import { usePersistedState } from '../hooks/usePersistedState';
import { useAcrRefresh } from '../hooks/useAcrRefresh';
import AcrProductFilter from './AcrProductFilter';
import AcrServiceHierarchy from './AcrServiceHierarchy';
import AcrProductTrendChart from './AcrProductTrendChart';

import AcrStrategicSection, { AcrSubscriptionsSection } from './AcrStrategicSection';
import MultiLineAcrChart, { MoneyTooltip } from './AcrMultiLineChart';
import CollapsibleSection from './CollapsibleSection';
import AcrFreshness from './AcrFreshness';
import AcrProgressBanner from './AcrProgressBanner';
import AcrAnthropicSpend from './AcrAnthropicSpend';
import { fmtUsd, fmtPct, monthAbbr, trendColor, defaultFiscalYear } from '../lib/acrFormat';

const FOUNDRY_LEVELS = [4, 5];
// Top service always uses Service Level 2. The Service level selector lives in
// the Service hierarchy card and sets only that matrix's depth.
const SERVICE_MIX_LEVEL = 2;
// Fixed Service Level 2 compute products for the dedicated compute-services chart.
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

function Kpi({ icon, label, value, sub, color }) {
  return (
    <div className="stat-card" style={{ flex: 1, minWidth: 160 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {icon}
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
      {sub != null && sub !== '' && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function ConsumptionAccount() {
  const { tpid: rawTpid } = useParams();
  const navigate = useNavigate();
  const tpid = (rawTpid || '').trim();

  // Resolve the account's display name + customer id (for the profile link).
  const { data: custRows } = useDbQuery(
    'SELECT id, name, parenting_level FROM active_customers WHERE tpid = ?',
    [tpid],
    [tpid],
  );
  const customer = useMemo(() => {
    const rows = custRows || [];
    if (!rows.length) return null;
    // Prefer the top-parent record when multiple share a TPID.
    const sorted = [...rows].sort((a, b) => (b.parenting_level === 861980000 ? 1 : 0) - (a.parenting_level === 861980000 ? 1 : 0));
    return sorted[0];
  }, [custRows]);
  const accountName = customer?.name || `TPID ${tpid}`;

  // Only the saved active roster supplies the product catalog scope.
  const { rosterTpids } = useRosterTpids();
  const allTpids = rosterTpids;

  // App-wide saved Service Level 2 product filter (shared with the Consumption page).
  const { filter: productFilter } = useAcrProductFilter();
  const productServices = productFilter.services;

  const [fyOptions, setFyOptions] = useState([]);
  const [selectedFys, setSelectedFys] = usePersistedState('acr.fiscalYears', []);
  const [foundryLevel, setFoundryLevel] = useState(4);
  const [loading, setLoading] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
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
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setLoading(true);
    setMessage(null);
    try {
      const pf = await acrPortfolio({
        tpids: [tpid],
        fiscalYears: selectedFys,
        level: SERVICE_MIX_LEVEL,
        services: productServices.length ? productServices : undefined,
        serviceFilterLevel: productFilter.level || 2,
        force,
      });
      if (pf?.ok) setPortfolio(pf);
      else if (pf?.code === 'NO_ACCOUNT') setMessage({ type: 'warning', text: 'Sign in with Microsoft (Settings) and connect to corpnet/VPN to load consumption data.' });
      else if (pf?.code === 'ACR_OFFLINE') setMessage({ type: 'warning', text: pf.error || 'Cannot reach the ACR Power BI model. Connect to corpnet/VPN and try again.' });
      else if (['ACR_RLS_UNAUTHORIZED', 'ACR_UNAUTHORIZED'].includes(pf?.code)) setMessage({ type: 'error', code: pf.code, text: pf.error });
      else if (pf) setMessage({ type: 'error', text: pf.error || 'Failed to load consumption data.' });

      if (pf?.ok && pf.cache?.status !== 'missing' && (!pf.accounts || pf.accounts.length === 0)) {
        setMessage({ type: 'info', text: `No consumption rows returned for ${accountName} in ${pf.fiscalYear}. If you expect data, the ACR Power BI dataset may be refreshing or your access to it may have changed.` });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Failed to load consumption data.' });
    } finally {
      setLoading(false);
    }
  }, [tpid, selectedFys, accountName, productServices, productFilter.level]);

  useEffect(() => { load(false); }, [load]);
  useAcrRefresh(portfolio?.cache, load);

  // Foundry Models per-model series — loaded independently so a failure here
  // never blocks the rest of the page. Granularity is controlled by the
  // chart-local selector (L4/L5 only).
  const loadModels = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setModelsLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: foundryLevel, force });
      if (res?.ok) setModels(res);
      else setModels({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setModels({ ok: false, error: e.message || 'Failed to load model consumption.', models: [] });
    } finally {
      setModelsLoading(false);
    }
  }, [tpid, selectedFys, foundryLevel]);

  useEffect(() => {
    if (visibleSections.apps) loadModels(false);
  }, [visibleSections.apps, openedSections.apps, loadModels]);

  // Fixed Service Level 2 compute-services series (Azure App Service, Container
  // Apps, Kubernetes Service, Functions) — independent of the model-level
  // selector. Reuses the model query with modelLevel=2 scoped to those L2s.
  const loadCompute = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setComputeLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: COMPUTE_L2, force });
      if (res?.ok) setCompute(res);
      else setCompute({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setCompute({ ok: false, error: e.message || 'Failed to load compute consumption.', models: [] });
    } finally {
      setComputeLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.apps) loadCompute(false);
  }, [visibleSections.apps, openedSections.apps, loadCompute]);

  const loadFoundryTools = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setFoundryToolsLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 4, categories: FOUNDRY_TOOLS_L2, force });
      if (res?.ok) setFoundryTools(res);
      else setFoundryTools({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setFoundryTools({ ok: false, error: e.message || 'Failed to load Foundry Tools consumption.', models: [] });
    } finally {
      setFoundryToolsLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.apps) loadFoundryTools(false);
  }, [visibleSections.apps, openedSections.apps, loadFoundryTools]);

  const loadDeveloperTools = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setDeveloperToolsLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: DEVELOPER_TOOLS_L2, force });
      if (res?.ok) setDeveloperTools(res);
      else setDeveloperTools({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setDeveloperTools({ ok: false, error: e.message || 'Failed to load developer tools consumption.', models: [] });
    } finally {
      setDeveloperToolsLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.apps) loadDeveloperTools(false);
  }, [visibleSections.apps, openedSections.apps, loadDeveloperTools]);

  const loadDatabases = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setDatabasesLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: DATABASES_L2, force });
      if (res?.ok) setDatabases(res);
      else setDatabases({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setDatabases({ ok: false, error: e.message || 'Failed to load database consumption.', models: [] });
    } finally {
      setDatabasesLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.data) loadDatabases(false);
  }, [visibleSections.data, openedSections.data, loadDatabases]);

  const loadAnalytics = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setAnalyticsLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: ANALYTICS_L2, force });
      if (res?.ok) setAnalytics(res);
      else setAnalytics({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setAnalytics({ ok: false, error: e.message || 'Failed to load analytics consumption.', models: [] });
    } finally {
      setAnalyticsLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.data) loadAnalytics(false);
  }, [visibleSections.data, openedSections.data, loadAnalytics]);

  const loadNetworking = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setNetworkingLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: NETWORKING_L2, force });
      if (res?.ok) setNetworking(res);
      else setNetworking({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setNetworking({ ok: false, error: e.message || 'Failed to load networking consumption.', models: [] });
    } finally {
      setNetworkingLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.infra) loadNetworking(false);
  }, [visibleSections.infra, openedSections.infra, loadNetworking]);

  const loadVm = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setVmLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: VM_L2, force });
      if (res?.ok) setVm(res);
      else setVm({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setVm({ ok: false, error: e.message || 'Failed to load VM consumption.', models: [] });
    } finally {
      setVmLoading(false);
    }
  }, [tpid, selectedFys]);

  useEffect(() => {
    if (visibleSections.infra) loadVm(false);
  }, [visibleSections.infra, openedSections.infra, loadVm]);

  const loadStorage = useCallback(async (force = false) => {
    if (!tpid || selectedFys.length === 0) return;
    setStorageLoading(true);
    try {
      const res = await acrModels({ tpids: [tpid], fiscalYears: selectedFys, modelLevel: 2, categories: STORAGE_L2, force });
      if (res?.ok) setStorage(res);
      else setStorage({ ...res, ok: false, error: res?.error || 'No chart response.', models: [] });
    } catch (e) {
      setStorage({ ok: false, error: e.message || 'Failed to load storage consumption.', models: [] });
    } finally {
      setStorageLoading(false);
    }
  }, [tpid, selectedFys]);

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

  const toggleFy = (year) => {
    setSelectedFys((cur) => {
      const has = cur.includes(year);
      let next = has ? cur.filter((y) => y !== year) : [...cur, year];
      if (next.length === 0) next = [year];
      return fyOptions.filter((y) => next.includes(y));
    });
  };

  const totals = portfolio?.totals;
  const topService = portfolio?.serviceMix?.[0] || null;

  // Monthly trend for this account (sum across services per month).
  const trend = useMemo(() => {
    const months = portfolio?.months || [];
    const acct = portfolio?.accounts?.[0];
    if (!acct) return [];
    return months.map((m) => ({ fiscalMonth: m, total: acct.monthly?.[m] || 0 }));
  }, [portfolio]);

  // Per-model multi-line series: one datum per month, one key per model.
  const modelSeries = useMemo(() => {
    if (!models?.ok || !models.months?.length) return { data: [], keys: [] };
    const keys = (models.models || []).map((m) => m.model);
    const data = models.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const mdl of models.models) row[mdl.model] = mdl.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [models]);

  // Compute-services (L2) multi-line series: one line per compute product.
  const computeSeries = useMemo(() => {
    if (!compute?.ok || !compute.months?.length) return { data: [], keys: [] };
    const keys = (compute.models || []).map((m) => m.model);
    const data = compute.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const svc of compute.models) row[svc.model] = svc.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [compute]);

  const foundryToolsSeries = useMemo(() => {
    if (!foundryTools?.ok || !foundryTools.months?.length) return { data: [], keys: [] };
    const keys = (foundryTools.models || []).map((m) => m.model);
    const data = foundryTools.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of foundryTools.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [foundryTools]);

  const developerToolsSeries = useMemo(() => {
    if (!developerTools?.ok || !developerTools.months?.length) return { data: [], keys: [] };
    const keys = (developerTools.models || []).map((m) => m.model);
    const data = developerTools.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of developerTools.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [developerTools]);

  const databasesSeries = useMemo(() => {
    if (!databases?.ok || !databases.months?.length) return { data: [], keys: [] };
    const keys = (databases.models || []).map((m) => m.model);
    const data = databases.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of databases.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [databases]);

  const analyticsSeries = useMemo(() => {
    if (!analytics?.ok || !analytics.months?.length) return { data: [], keys: [] };
    const keys = (analytics.models || []).map((m) => m.model);
    const data = analytics.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of analytics.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [analytics]);

  const networkingSeries = useMemo(() => {
    if (!networking?.ok || !networking.months?.length) return { data: [], keys: [] };
    const keys = (networking.models || []).map((m) => m.model);
    const data = networking.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of networking.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [networking]);

  const storageSeries = useMemo(() => {
    if (!storage?.ok || !storage.months?.length) return { data: [], keys: [] };
    const keys = (storage.models || []).map((m) => m.model);
    const data = storage.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of storage.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [storage]);

  const vmSeries = useMemo(() => {
    if (!vm?.ok || !vm.months?.length) return { data: [], keys: [] };
    const keys = (vm.models || []).map((m) => m.model);
    const data = vm.months.map((m) => {
      const row = { fiscalMonth: m };
      for (const item of vm.models) row[item.model] = item.monthly?.[m] || 0;
      return row;
    });
    return { data, keys };
  }, [vm]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button
          type="button"
          onClick={() => navigate('/consumption')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, padding: 0 }}
        >
          <ArrowLeftRegular style={{ fontSize: 14 }} /> Azure Consumption
        </button>
      </div>

      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>{accountName}</h2>
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
            disabled={loading || manualRefreshing || childLoadCount > 0 || !tpid}
          >
            {loading || manualRefreshing || childLoadCount > 0 ? 'Refreshing…' : 'Refresh'}
          </Button>
          {customer?.id && (
            <Button appearance="secondary" size="small" icon={<OpenRegular />} onClick={() => navigate(`/customers/${customer.id}`)} title="Open this account's customer profile">
              Profile
            </Button>
          )}
          {loading && <Spinner size="tiny" />}
        </div>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
        Expanded Azure Consumed Revenue for {accountName} (TPID {tpid}), from the MSX-I Power BI model.
        Requires Microsoft sign-in + corpnet/VPN.
      </p>
      <AcrFreshness cache={portfolio?.cache} />
      <AcrProgressBanner />

      <div style={{ marginBottom: 12 }}>
        <AcrProductFilter optionTpids={allTpids} fiscalYears={selectedFys} disabled={loading} />
      </div>

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

      {loading && !portfolio && tpid && (
        <div className="card"><div className="card-body-custom" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32, textAlign: 'center' }}>
          <Spinner size="small" label="Loading Azure consumption…" />
          <div style={{ fontSize: 12, maxWidth: 460 }}>
            No cached data is available yet, so this page is waiting for the live Power BI pull. This requires Microsoft sign-in and corpnet/VPN.
          </div>
        </div></div>
      )}

      {/* KPIs */}
      {portfolio?.cache?.status !== 'missing' && totals && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <Kpi icon={<MoneyRegular style={{ fontSize: 20, color: 'var(--accent)' }} />} label={`Latest ACR${portfolio.latestMonth ? ` · ${monthAbbr(portfolio.latestMonth)}` : ''}`} value={fmtUsd(totals.latest)} />
          <Kpi icon={<ArrowTrendingRegular style={{ fontSize: 20, color: trendColor(totals.momDollar) }} />} label="MoM change" value={fmtUsd(totals.momDollar)} sub={fmtPct(totals.momPct)} color={trendColor(totals.momDollar)} />
          <Kpi icon={<DataTrendingRegular style={{ fontSize: 20, color: 'var(--violet)' }} />} label={`${portfolio.fiscalYear} total`} value={fmtUsd(totals.grandTotal)} />
          <Kpi icon={<SparkleRegular style={{ fontSize: 20, color: 'var(--warning-text)' }} />} label={`Top service (L${portfolio.level})`} value={topService ? (topService.service.length > 18 ? `${topService.service.slice(0, 17)}…` : topService.service) : '—'} sub={topService ? fmtUsd(topService.total) : ''} />
        </div>
      )}

      {/* Monthly trend */}
      {trend.length > 1 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header-custom">Monthly ACR trend · {portfolio.fiscalYear}</div>
          <div className="card-body-custom" style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="acctAcrArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="fiscalMonth" stroke="var(--text-muted)" fontSize={11} tickLine={false} tickFormatter={monthAbbr} />
                <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} width={54} tickFormatter={(v) => fmtUsd(v)} />
                <Tooltip content={<MoneyTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />
                <Area type="monotone" name="ACR" dataKey="total" stroke="var(--accent)" strokeWidth={2} fill="url(#acctAcrArea)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Strategic dimensions (item B): subscriptions & service comp grouping —
          collapsed; loads live on expand. Placed above the L2 containers. */}
      <AcrStrategicSection
        tpids={[tpid]}
        fiscalYears={selectedFys}
        accountName={accountName}
        reloadKey={reloadKey}
        onLoadingChange={onChildLoadingChange}
      />

      {/* Product-category containers — collapsed by default (Infra / Data / Apps). */}
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
                  : `No VM consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
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
                  : `No storage consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
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
                  : `No networking consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
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
                  : `No database consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
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
                  : `No analytics consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
          }
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Apps"
        subtitle="Foundry models & tools, compute, developer tools"
        onOpenChange={(open) => markSectionOpened('apps', open)}
      >
        {/* Foundry Models multi-line — granularity uses its own L4/L5 selector. */}
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
                  : `No Foundry Models consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
          }
        />

        <AcrAnthropicSpend
          tpids={tpid ? [tpid] : []}
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
                  : `No Foundry Tools consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
          }
        />

        {/* Compute services (L2): App Service, Container Apps, Kubernetes Service, Functions */}
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
                  : `No App Service, Container Apps, Kubernetes Service, or Functions consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
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
                  : `No GitHub, API Management, Azure DevOps, Azure Monitor, or Log Analytics consumption found for ${accountName} in ${selectedFys.join(' + ')}.`
          }
        />
      </CollapsibleSection>

      {/* Full Service-Level hierarchy (item A): L1 › … › Ln grouped, with its
          own Service level selector. Collapsible like Infra/Data/Apps — loads
          live on expand. */}
      <CollapsibleSection title="Service hierarchy" subtitle="Full L1 › … › Ln matrix">
        <AcrProductTrendChart
          tpids={[tpid]}
          fiscalYears={selectedFys}
          productFilter={productFilter}
          reloadKey={reloadKey}
          accountName={accountName}
          storagePrefix="acr.productTrend.account"
          onLoadingChange={onChildLoadingChange}
        />
        <AcrServiceHierarchy
          tpids={[tpid]}
          defaultLevel={4}
          fiscalYears={selectedFys}
          productFilter={productFilter}
          reloadKey={reloadKey}
          accountName={accountName}
          onLoadingChange={onChildLoadingChange}
        />
      </CollapsibleSection>

      {/* Subscription-level spend (moved out of the Strategic section) — bottom
          of the per-customer page; collapsed, loads live on expand. */}
      <AcrSubscriptionsSection
        tpids={[tpid]}
        fiscalYears={selectedFys}
        accountName={accountName}
        reloadKey={reloadKey}
        onLoadingChange={onChildLoadingChange}
      />
    </div>
  );
}
