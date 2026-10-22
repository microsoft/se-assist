import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@fluentui/react-components';
import { FilterRegular, DismissRegular, ChevronRightRegular, ChevronDownRegular } from '@fluentui/react-icons';
import { acrServiceValues } from '../electronBridge';
import { useAcrProductFilter } from '../hooks/useAcrProductFilter';
import { fmtUsd } from '../lib/acrFormat';

/**
 * Shared, persistent Products (Service Level 2) filter. Renders a "Products"
 * button, a collapsible picker, and an active-filter badge. The selection is
 * saved in app_settings and applies app-wide (Azure Consumption page + every
 * per-account ACR subpage) — the picker options are the GLOBAL product catalog
 * (all tracked accounts), not just one account's.
 *
 * The picker is TIERED: every Service Level 1 category is a collapsible group
 * with its Service Level 2 products nested beneath. Selection is still stored as
 * a flat list of L2 product names (the app-wide filter is L2), so the grouping
 * is purely an ergonomic layer over the same saved shape.
 *
 * @param {object} props
 * @param {string[]} props.optionTpids   All tracked TPIDs — the global product catalog source.
 * @param {string[]} props.fiscalYears   FYs to scope the option ranking.
 * @param {boolean} [props.disabled]
 */
export default function AcrProductFilter({ optionTpids, fiscalYears, disabled }) {
  const { filter, setFilter, clear } = useAcrProductFilter();

  const [options, setOptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [optError, setOptError] = useState(null);
  const [optLoading, setOptLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [collapsed, setCollapsed] = useState({});
  const filterRef = useRef(filter);
  const requestIdRef = useRef(0);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const tpidKey = (optionTpids || []).join('|');
  const fyKey = (fiscalYears || []).join('|');

  const loadOptions = useCallback(async () => {
    if (!optionTpids || optionTpids.length === 0 || !fiscalYears || fiscalYears.length === 0) return;
    const requestId = ++requestIdRef.current;
    setOptLoading(true);
    setOptError(null);
    try {
      // parentLevel:1 → each Service Level 1 with its Service Level 2 children.
      const res = await acrServiceValues({ tpids: optionTpids, level: 2, parentLevel: 1, fiscalYears });
      if (requestId !== requestIdRef.current) return;
      if (res?.ok) {
        const nextOptions = res.values || [];
        setOptions(nextOptions);
        setGroups(res.groups || []);
        if (filterRef.current.services.length === 0) {
          setDraft(nextOptions.map((option) => option.name));
        } else {
          setDraft(filterRef.current.services);
        }
        if (res.cache?.status === 'missing') {
          setOptError(
            res.cache.error?.message
              ? res.cache.error.message
              : 'Product options are still loading.',
          );
        }
      } else if (res?.code === 'NO_ACCOUNT') {
        setOptions([]);
        setGroups([]);
        setOptError('Sign in with Microsoft + corpnet/VPN to list products.');
      } else {
        setOptions([]);
        setGroups([]);
        setOptError(res?.error || 'Failed to load products.');
      }
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setOptions([]);
      setGroups([]);
      setOptError(e.message || 'Failed to load products.');
    } finally {
      if (requestId === requestIdRef.current) setOptLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpidKey, fyKey]);

  useEffect(() => {
    requestIdRef.current += 1;
    setOptLoading(false);
    setOptions([]);
    setGroups([]);
    setOptError(null);
    setDraft([]);
    setOpen(false);
  }, [loadOptions]);

  const optionNames = useMemo(() => options.map((o) => o.name), [options]);
  const selectedCount = filter.services.length;
  const draftSet = useMemo(() => new Set(draft), [draft]);

  const openPicker = () => {
    if (!optLoading) loadOptions();
    setDraft(selectedCount ? filter.services : optionNames);
    setOpen((o) => !o);
  };
  const toggle = (name) => setDraft((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  const toggleGroup = (group) => {
    const childNames = group.children.map((c) => c.name);
    const allSelected = childNames.every((n) => draftSet.has(n));
    setDraft((cur) => {
      if (allSelected) return cur.filter((n) => !childNames.includes(n));
      const merged = new Set(cur);
      childNames.forEach((n) => merged.add(n));
      return [...merged];
    });
  };
  const toggleCollapse = (parent) => setCollapsed((c) => ({ ...c, [parent]: !c[parent] }));
  const apply = async () => {
    // Applying "all" (or none) clears the filter; otherwise scope to the subset.
    const all = optionNames.length > 0 && draft.length === optionNames.length;
    await setFilter({ level: 2, services: all ? [] : draft });
    setOpen(false);
  };
  const reset = async () => { await clear(); setDraft([]); setOpen(false); };

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g.parent]);
  const setAllCollapsed = (value) => {
    const next = {};
    if (value) groups.forEach((g) => { next[g.parent] = true; });
    setCollapsed(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button
          appearance="secondary"
          size="small"
          icon={<FilterRegular />}
          onClick={openPicker}
          disabled={disabled || optLoading}
          title="Scope ordinary Azure ACR to selected Service Level 2 products (saved across pages). Anthropic spend is shown separately."
        >
          Products{selectedCount ? ` (${selectedCount})` : ''}
        </Button>
        {selectedCount > 0 && (
          <span className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Saved products (L2): {selectedCount}
            <DismissRegular style={{ fontSize: 12, cursor: 'pointer' }} onClick={reset} title="Clear saved product filter" />
          </span>
        )}
        {selectedCount > 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {filter.services.slice(0, 4).join(', ')}{filter.services.length > 4 ? ` +${filter.services.length - 4} more` : ''}
          </span>
        )}
        {optError && !optLoading && <span style={{ color: 'var(--warning-text)', fontSize: 12 }}>{optError}</span>}
      </div>

      {open && (
        <div className="card" style={{ marginBottom: 4 }}>
          <div className="card-header-custom" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Filter by products — Service Level 1 › Service Level 2 (saved &amp; applied app-wide)</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {groups.length > 0 && (
                <button type="button" onClick={() => setAllCollapsed(!allCollapsed)} style={linkBtn}>
                  {allCollapsed ? 'Expand all' : 'Collapse all'}
                </button>
              )}
              <button type="button" onClick={() => setDraft(optionNames)} style={linkBtn}>Select all</button>
              <button type="button" onClick={() => setDraft([])} style={linkBtn}>Clear</button>
            </div>
          </div>
          <div className="card-body-custom">
            {optionNames.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{optLoading ? 'Loading products…' : (optError || 'No products available.')}</div>
            ) : groups.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                {groups.map((g) => {
                  const childNames = g.children.map((c) => c.name);
                  const selectedInGroup = childNames.filter((n) => draftSet.has(n)).length;
                  const allSel = selectedInGroup === childNames.length;
                  const someSel = selectedInGroup > 0 && !allSel;
                  const isCollapsed = !!collapsed[g.parent];
                  return (
                    <div key={g.parent} style={{ borderBottom: '1px solid var(--hairline)', paddingBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                        <button
                          type="button"
                          onClick={() => toggleCollapse(g.parent)}
                          style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)' }}
                          title={isCollapsed ? 'Expand' : 'Collapse'}
                        >
                          {isCollapsed ? <ChevronRightRegular /> : <ChevronDownRegular />}
                        </button>
                        <input
                          type="checkbox"
                          checked={allSel}
                          ref={(el) => { if (el) el.indeterminate = someSel; }}
                          onChange={() => toggleGroup(g)}
                          title={`Select all in ${g.parent}`}
                        />
                        <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.parent}>
                          {g.parent}
                          <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                            ({selectedInGroup}/{childNames.length})
                          </span>
                        </span>
                        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{fmtUsd(g.total)}</span>
                      </div>
                      {!isCollapsed && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 4, paddingLeft: 26 }}>
                          {g.children.map((c) => (
                            <label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                              <input type="checkbox" checked={draftSet.has(c.name)} onChange={() => toggle(c.name)} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={c.name}>{c.name}</span>
                              <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{fmtUsd(c.total)}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                {options.map((o) => (
                  <label key={o.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={draftSet.has(o.name)} onChange={() => toggle(o.name)} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={o.name}>{o.name}</span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{fmtUsd(o.total)}</span>
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button appearance="primary" size="small" onClick={apply} disabled={optLoading}>Apply</Button>
              <Button appearance="secondary" size="small" onClick={reset} disabled={optLoading}>Reset</Button>
              <Button appearance="subtle" size="small" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const linkBtn = { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0 };
