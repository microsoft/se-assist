import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { crmRequest } from '../electronBridge';
import {
  MILESTONE_CATEGORY,
  CUSTOMER_COMMITMENT,
  DELIVERED_BY,
  MILESTONE_STATUS,
  MILESTONE_STATUS_REASON,
  HELP_NEEDED,
  PREFERRED_AZURE_REGION,
  AZURE_CAPACITY_TYPE,
} from './milestoneOptions';

// ── Column model ─────────────────────────────────────────────────────
// Mirrors the MSX milestone grid column order. `key` matches the field keys the
// useTeamApi addMilestone/updateMilestone helpers understand.
const NON_RECURRING_ON = 861980000; // msp_nonrecurring single option = "Yes"

const COLUMNS = [
  { key: 'name', label: 'Name', type: 'text', required: true, width: 200 },
  { key: 'workload', label: 'Workload', type: 'lookup', entity: 'msp_workloads', required: true, width: 230 },
  { key: 'commitment', label: 'Customer Commitment', type: 'select', options: CUSTOMER_COMMITMENT, width: 150 },
  { key: 'deliveredBy', label: 'Delivered By', type: 'select', options: DELIVERED_BY, width: 150 },
  { key: 'partner', label: 'Partner', type: 'text', width: 150 },
  { key: 'category', label: 'Milestone Category', type: 'select', options: MILESTONE_CATEGORY, required: true, width: 170 },
  { key: 'milestoneDate', label: 'Est. Date', type: 'date', required: true, width: 150 },
  { key: 'estChange', label: 'Est. Change (ACR)', type: 'number', required: true, width: 130 },
  { key: 'nonRecurring', label: 'Non-Recurring?', type: 'checkbox', width: 110 },
  { key: 'status', label: 'Milestone Status', type: 'select', options: MILESTONE_STATUS, required: true, width: 150 },
  { key: 'statusReason', label: 'Milestone Status Reason', type: 'select', options: MILESTONE_STATUS_REASON, width: 200 },
  { key: 'helpNeeded', label: 'Help Needed', type: 'select', options: HELP_NEEDED, width: 200 },
  { key: 'riskDetails', label: 'Risk/Blocker Details', type: 'textarea', width: 220 },
  { key: 'capacityType', label: 'Azure Capacity Type', type: 'multiselect', options: AZURE_CAPACITY_TYPE, width: 200 },
  { key: 'region', label: 'Preferred Azure Region', type: 'select', options: PREFERRED_AZURE_REGION, width: 180 },
  { key: 'owner', label: 'Owner', type: 'lookup', entity: 'systemusers', required: true, width: 190 },
];

// Keys that must be filled before a row can be saved (per the plan / MSX asterisks + Dataverse).
const REQUIRED_KEYS = ['name', 'workloadId', 'category', 'milestoneDate', 'estChange', 'status', 'ownerId'];
const REQUIRED_LABEL = { name: 'Name', workloadId: 'Workload', category: 'Category', milestoneDate: 'Est. Date', estChange: 'Est. Change', status: 'Status', ownerId: 'Owner' };

const optMap = (arr) => Object.fromEntries(arr.map(o => [String(o.value), o.label]));
const CAT_MAP = optMap(MILESTONE_CATEGORY);
const COMMIT_MAP = optMap(CUSTOMER_COMMITMENT);
const DELIV_MAP = optMap(DELIVERED_BY);
const STATUS_MAP = optMap(MILESTONE_STATUS);
const REASON_MAP = optMap(MILESTONE_STATUS_REASON);
const HELP_MAP = optMap(HELP_NEEDED);
const REGION_MAP = optMap(PREFERRED_AZURE_REGION);
const CAP_MAP = optMap(AZURE_CAPACITY_TYPE);

const FMT = '@OData.Community.Display.V1.FormattedValue';

function fmtDate(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(v);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtAcr(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return isFinite(n) ? n.toLocaleString('en-US') : String(v);
}

// CRM record → editable draft (UI field keys the API helpers expect).
function recordToDraft(rec) {
  const capRaw = rec.msp_milestoneazurecapacitytype;
  const capacityType = capRaw ? String(capRaw).split(',').map(s => Number(s.trim())).filter(n => isFinite(n)) : [];
  return {
    id: rec.msp_engagementmilestoneid,
    name: rec.msp_name || '',
    workloadId: rec._msp_workloadlkid_value || '',
    workloadName: rec[`_msp_workloadlkid_value${FMT}`] || '',
    commitment: rec.msp_commitmentrecommendation ?? '',
    deliveredBy: rec.msp_deliveryspecifiedfield ?? '',
    partner: rec.msp_partneroption || '',
    category: rec.msp_milestonecategory ?? '',
    milestoneDate: rec.msp_milestonedate ? String(rec.msp_milestonedate).slice(0, 10) : '',
    estChange: rec.msp_monthlyuse ?? '',
    nonRecurring: Number(rec.msp_nonrecurring) === NON_RECURRING_ON,
    status: rec.msp_milestonestatus ?? '',
    statusReason: rec.msp_milestonestatusreason ?? '',
    helpNeeded: rec.msp_helpneeded ?? '',
    riskDetails: rec.msp_milestonecomments || '',
    capacityType,
    region: rec.msp_milestonepreferredazureregion ?? '',
    ownerId: rec._ownerid_value || '',
    ownerName: rec[`_ownerid_value${FMT}`] || '',
  };
}

function blankDraft(currentUserId, currentUserName) {
  return {
    id: '__new__',
    name: '', workloadId: '', workloadName: '',
    commitment: 861980000,           // Uncommitted
    deliveredBy: '', partner: '', category: '', milestoneDate: '', estChange: '',
    nonRecurring: false,
    status: 861980000,               // On Track
    statusReason: '', helpNeeded: '', riskDetails: '', capacityType: [], region: '',
    ownerId: currentUserId || '', ownerName: currentUserName || '',
  };
}

const normStr = (v) => (v ?? '').toString().trim();
const normNum = (v) => (v === '' || v == null || !isFinite(Number(v)) ? '' : String(Number(v)));
const capKey = (arr) => (Array.isArray(arr) ? [...arr].map(Number).sort((a, b) => a - b).join(',') : '');

// Compute the changed field payload between an original draft and an edited draft.
function computeChanged(orig, draft) {
  const changed = {};
  const scal = { name: 'str', commitment: 'num', deliveredBy: 'num', partner: 'str', category: 'num', milestoneDate: 'date', estChange: 'num', status: 'num', statusReason: 'num', helpNeeded: 'num', riskDetails: 'str', region: 'num' };
  for (const [k, t] of Object.entries(scal)) {
    const a = t === 'num' ? normNum(orig[k]) : t === 'date' ? String(orig[k] || '').slice(0, 10) : normStr(orig[k]);
    const b = t === 'num' ? normNum(draft[k]) : t === 'date' ? String(draft[k] || '').slice(0, 10) : normStr(draft[k]);
    if (a !== b) changed[k] = draft[k];
  }
  if (!!orig.nonRecurring !== !!draft.nonRecurring) changed.nonRecurring = !!draft.nonRecurring;
  if (capKey(orig.capacityType) !== capKey(draft.capacityType)) changed.capacityType = draft.capacityType;
  if (normStr(orig.workloadId) !== normStr(draft.workloadId)) { changed.workloadId = draft.workloadId; changed.workloadName = draft.workloadName; }
  if (normStr(orig.ownerId) !== normStr(draft.ownerId)) { changed.ownerId = draft.ownerId; changed.ownerName = draft.ownerName; }
  return changed;
}

function missingRequired(draft) {
  return REQUIRED_KEYS.filter(k => {
    const v = draft[k];
    return v === '' || v == null;
  }).map(k => REQUIRED_LABEL[k]);
}

// ── Live CRM lookup search ───────────────────────────────────────────
async function lookupSearch(entity, term) {
  const esc = term.replace(/'/g, "''");
  let query;
  if (entity === 'msp_workloads') {
    query = { $select: 'msp_name', $filter: `contains(msp_name,'${esc}')`, $orderby: 'msp_name', $top: 25 };
  } else {
    query = { $select: 'fullname,internalemailaddress', $filter: `isdisabled eq false and contains(fullname,'${esc}')`, $orderby: 'fullname', $top: 25 };
  }
  const res = await crmRequest({ path: `/api/data/v9.2/${entity}`, method: 'GET', query });
  if (!res?.ok) throw new Error(res?.data?.error?.message || res?.data?.message || `HTTP ${res?.status}`);
  const rows = res.data?.value || [];
  if (entity === 'msp_workloads') return rows.map(r => ({ id: r.msp_workloadid, label: r.msp_name, sub: '' }));
  return rows.map(r => ({ id: r.systemuserid, label: r.fullname, sub: r.internalemailaddress || '' }));
}

// Fixed-position dropdown anchored to a trigger element, so it escapes the grid's
// horizontal scroll container without clipping.
function AnchoredPanel({ anchorRef, onClose, children }) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [anchorRef]);
  useEffect(() => {
    const onDoc = (e) => { if (anchorRef.current && !anchorRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [anchorRef, onClose]);
  if (!rect) return null;
  const style = { position: 'fixed', top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 220), zIndex: 6000 };
  return createPortal(<div className="msg-pop" style={style}>{children}</div>, document.body);
}

function CrmLookup({ entity, valueId, valueLabel, onChange, disabled, placeholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setResults([]); setErr(''); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setErr('');
    const t = setTimeout(async () => {
      try {
        const r = await lookupSearch(entity, term);
        if (!cancelled) setResults(r);
      } catch (e) {
        if (!cancelled) { setErr(e.message || String(e)); setResults([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, open, entity]);

  if (disabled) return <span className="msg-ro">{valueLabel || '—'}</span>;

  return (
    <div className="msg-lookup" ref={boxRef}>
      <input
        className="msg-input"
        value={open ? q : (valueLabel || '')}
        placeholder={placeholder || 'Search…'}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={e => setQ(e.target.value)}
      />
      {open && (
        <AnchoredPanel anchorRef={boxRef} onClose={() => setOpen(false)}>
          {loading && <div className="msg-pop-note">Searching…</div>}
          {err && <div className="msg-pop-err">{err}</div>}
          {!loading && !err && q.trim().length < 2 && <div className="msg-pop-note">Type 2+ characters…</div>}
          {!loading && !err && q.trim().length >= 2 && results.length === 0 && <div className="msg-pop-note">No matches</div>}
          {results.map(r => (
            <button
              type="button"
              key={r.id}
              className="msg-pop-item"
              onClick={() => { onChange({ id: r.id, label: r.label }); setOpen(false); }}
            >
              <span className="msg-pop-item-label">{r.label}</span>
              {r.sub && <span className="msg-pop-item-sub">{r.sub}</span>}
            </button>
          ))}
        </AnchoredPanel>
      )}
    </div>
  );
}

function MultiSelect({ options, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef(null);
  const selected = Array.isArray(value) ? value : [];
  const selSet = useMemo(() => new Set(selected.map(Number)), [selected]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return options.slice(0, 60);
    return options.filter(o => o.label.toLowerCase().includes(term)).slice(0, 60);
  }, [q, options]);
  const label = selected.length === 0 ? '' : selected.length === 1 ? (CAP_MAP[String(selected[0])] || '1 selected') : `${selected.length} selected`;

  if (disabled) return <span className="msg-ro">{label || '—'}</span>;

  const toggle = (val) => {
    const n = Number(val);
    const next = selSet.has(n) ? selected.filter(x => Number(x) !== n) : [...selected, n];
    onChange(next);
  };

  return (
    <div className="msg-lookup" ref={boxRef}>
      <button type="button" className="msg-input msg-input-btn" onClick={() => setOpen(o => !o)}>
        {label || <span className="msg-ph">Select…</span>}
      </button>
      {open && (
        <AnchoredPanel anchorRef={boxRef} onClose={() => setOpen(false)}>
          <input className="msg-pop-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…" autoFocus />
          <div className="msg-pop-scroll">
            {filtered.map(o => (
              <label key={o.value} className="msg-pop-check">
                <input type="checkbox" checked={selSet.has(Number(o.value))} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
            {filtered.length === 0 && <div className="msg-pop-note">No matches</div>}
          </div>
        </AnchoredPanel>
      )}
    </div>
  );
}

// ── Cell renderers ───────────────────────────────────────────────────
function displayCell(col, draft) {
  const v = draft[col.key];
  switch (col.type) {
    case 'lookup': return col.key === 'workload' ? (draft.workloadName || '—') : (draft.ownerName || '—');
    case 'select': {
      const map = { commitment: COMMIT_MAP, deliveredBy: DELIV_MAP, category: CAT_MAP, status: STATUS_MAP, statusReason: REASON_MAP, helpNeeded: HELP_MAP, region: REGION_MAP }[col.key];
      return (map && map[String(v)]) || '—';
    }
    case 'date': return fmtDate(v) || '—';
    case 'number': return fmtAcr(v) || '—';
    case 'checkbox': return draft.nonRecurring ? 'Yes' : '—';
    case 'multiselect': return (draft.capacityType && draft.capacityType.length) ? (draft.capacityType.length === 1 ? (CAP_MAP[String(draft.capacityType[0])] || '1 selected') : `${draft.capacityType.length} selected`) : '—';
    default: return v ? String(v) : '—';
  }
}

function EditCell({ col, draft, setField }) {
  const v = draft[col.key];
  switch (col.type) {
    case 'text':
      return <input className="msg-input" value={v || ''} onChange={e => setField(col.key, e.target.value)} />;
    case 'textarea':
      return <textarea className="msg-input msg-textarea" value={v || ''} onChange={e => setField(col.key, e.target.value)} rows={1} />;
    case 'number':
      return <input className="msg-input" type="number" step="any" value={v ?? ''} onChange={e => setField(col.key, e.target.value)} />;
    case 'date':
      return <input className="msg-input" type="date" value={v || ''} onChange={e => setField(col.key, e.target.value)} />;
    case 'checkbox':
      return <input type="checkbox" checked={!!draft.nonRecurring} onChange={e => setField('nonRecurring', e.target.checked)} />;
    case 'select':
      return (
        <select className="msg-input" value={v === '' || v == null ? '' : String(v)} onChange={e => setField(col.key, e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">—</option>
          {col.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'multiselect':
      return <MultiSelect options={col.options} value={draft.capacityType} onChange={arr => setField('capacityType', arr)} />;
    case 'lookup':
      if (col.key === 'workload') {
        return <CrmLookup entity="msp_workloads" valueId={draft.workloadId} valueLabel={draft.workloadName} placeholder="Search workload…"
          onChange={sel => setField('__lookup_workload', sel)} />;
      }
      return <CrmLookup entity="systemusers" valueId={draft.ownerId} valueLabel={draft.ownerName} placeholder="Search owner…"
        onChange={sel => setField('__lookup_owner', sel)} />;
    default:
      return null;
  }
}

// ── Main grid ────────────────────────────────────────────────────────
export default function MilestoneGrid({ opportunityId, oppName, accountName, teamApi, onClose, onChanged, onOpenMilestone }) {
  const { addMilestone, updateMilestone, currentUserId, currentUserName } = teamApi || {};
  const [rows, setRows] = useState(null);   // array of { original, draft, error, saving } | null=loading
  const [loadErr, setLoadErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState(null);
  const [newError, setNewError] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [banner, setBanner] = useState('');

  const oppId = String(opportunityId || '').replace(/[{}]/g, '');

  const load = useCallback(async () => {
    setRows(null); setLoadErr('');
    try {
      const res = await crmRequest({
        path: '/api/data/v9.2/msp_engagementmilestones',
        method: 'GET',
        query: {
          $filter: `_msp_opportunityid_value eq '${oppId}'`,
          $select: 'msp_engagementmilestoneid,msp_name,msp_milestonedate,msp_monthlyuse,msp_nonrecurring,msp_milestonestatus,msp_milestonestatusreason,msp_commitmentrecommendation,msp_deliveryspecifiedfield,msp_partneroption,msp_milestonecategory,msp_helpneeded,msp_milestonecomments,msp_milestoneazurecapacitytype,msp_milestonepreferredazureregion,_msp_workloadlkid_value,_ownerid_value,createdon',
          $orderby: 'createdon desc',
          $top: 200,
        },
      });
      if (!res?.ok) throw new Error(res?.data?.error?.message || res?.data?.message || `HTTP ${res?.status}`);
      const drafts = (res.data?.value || []).map(recordToDraft);
      setRows(drafts.map(d => ({ original: d, draft: { ...d, capacityType: [...d.capacityType] }, error: '', saving: false })));
    } catch (e) {
      setLoadErr(e.message || String(e));
      setRows([]);
    }
  }, [oppId]);

  useEffect(() => { if (oppId) load(); }, [oppId, load]);

  const setRowField = (idx, key, val) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      return { ...r, draft: applyField(r.draft, key, val) };
    }));
  };
  const setNewField = (key, val) => setNewDraft(prev => applyField(prev, key, val));

  const dirtyRows = useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => ({ i, changed: computeChanged(r.original, r.draft) })).filter(x => Object.keys(x.changed).length > 0);
  }, [rows]);

  const startCreate = () => { setCreating(true); setNewDraft(blankDraft(currentUserId, currentUserName)); setNewError(''); setBanner(''); };
  const cancelCreate = () => { setCreating(false); setNewDraft(null); setNewError(''); };

  const saveNew = async () => {
    if (savingNew || !newDraft) return;
    const missing = missingRequired(newDraft);
    if (missing.length) { setNewError(`Required: ${missing.join(', ')}`); return; }
    setSavingNew(true); setNewError('');
    try {
      const created = await addMilestone(oppId, newDraft);
      setCreating(false); setNewDraft(null);
      setBanner(`Created "${created.name}".`);
      await load();
      onChanged?.();
    } catch (e) {
      setNewError(e.message || String(e));
    } finally {
      setSavingNew(false);
    }
  };

  const saveAll = async () => {
    if (savingAll || dirtyRows.length === 0) return;
    // Validate every dirty row first — block the batch only for rows that fail.
    let anyInvalid = false;
    setRows(prev => prev.map((r, i) => {
      const isDirty = dirtyRows.some(d => d.i === i);
      if (!isDirty) return r;
      const missing = missingRequired(r.draft);
      if (missing.length) { anyInvalid = true; return { ...r, error: `Required: ${missing.join(', ')}` }; }
      return { ...r, error: '' };
    }));
    if (anyInvalid) { setBanner('Fix the highlighted rows before saving.'); return; }

    setSavingAll(true); setBanner('');
    let ok = 0; const failed = [];
    // Re-read dirty set from current state snapshot.
    const snapshot = dirtyRows;
    for (const { i, changed } of snapshot) {
      try {
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, saving: true, error: '' } : r));
        await updateMilestone(rows[i].original.id, changed);
        ok += 1;
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, saving: false, error: '', original: { ...r.draft, capacityType: [...r.draft.capacityType] } } : r));
      } catch (e) {
        failed.push(rows[i].draft.name || rows[i].original.id);
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, saving: false, error: e.message || String(e) } : r));
      }
    }
    setSavingAll(false);
    setBanner(failed.length ? `Saved ${ok}. ${failed.length} failed — see row errors.` : `Saved ${ok} milestone${ok === 1 ? '' : 's'}.`);
    onChanged?.();
  };

  const minWidth = COLUMNS.reduce((s, c) => s + c.width, 0) + 40;

  return createPortal(
    <div className="msg-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !creating && !savingAll) onClose(); }}>
      <div className="msg-modal" role="dialog" aria-label="Add or edit milestones">
        <div className="msg-head">
          <div className="msg-title">
            <span className="msg-title-main">Add / Edit Milestones</span>
            <span className="msg-title-sub">{[oppName, accountName].filter(Boolean).join(' · ')}</span>
          </div>
          <button className="msg-x" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="msg-toolbar">
          {!creating ? (
            <>
              <button className="msg-btn msg-btn-primary" onClick={startCreate} disabled={savingAll}>+ Create new</button>
              <button className="msg-btn" onClick={saveAll} disabled={savingAll || dirtyRows.length === 0}>
                {savingAll ? 'Saving…' : `Save changes${dirtyRows.length ? ` (${dirtyRows.length})` : ''}`}
              </button>
            </>
          ) : (
            <>
              <button className="msg-btn msg-btn-primary" onClick={saveNew} disabled={savingNew}>{savingNew ? 'Creating…' : 'Save new milestone'}</button>
              <button className="msg-btn" onClick={cancelCreate} disabled={savingNew}>Cancel</button>
              <span className="msg-hint">Other rows are read-only while creating.</span>
            </>
          )}
          {banner && <span className="msg-banner">{banner}</span>}
        </div>

        <div className="msg-scroll">
          {rows === null ? (
            <div className="msg-loading">Loading milestones…</div>
          ) : (
            <table className="msg-table" style={{ minWidth }}>
              <thead>
                <tr>
                  {COLUMNS.map(c => (
                    <th key={c.key} style={{ width: c.width, minWidth: c.width }}>
                      {c.label}{c.required && <span className="msg-req">*</span>}
                    </th>
                  ))}
                  <th style={{ width: 90, minWidth: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {creating && newDraft && (
                  <tr className="msg-row-new">
                    {COLUMNS.map(c => (
                      <td key={c.key} style={{ width: c.width, minWidth: c.width }}>
                        <EditCell col={c} draft={newDraft} setField={setNewField} />
                      </td>
                    ))}
                    <td className="msg-rowmsg">{newError && <span className="msg-rowerr">{newError}</span>}</td>
                  </tr>
                )}
                {loadErr && (
                  <tr><td colSpan={COLUMNS.length + 1}><div className="msg-loaderr">Could not load milestones: {loadErr}</div></td></tr>
                )}
                {rows.map((r, i) => {
                  const readOnly = creating;
                  const isDirty = dirtyRows.some(d => d.i === i);
                  return (
                    <tr key={r.original.id} className={`${readOnly ? 'msg-row-ro' : ''} ${isDirty ? 'msg-row-dirty' : ''}`}>
                      {COLUMNS.map(c => (
                        <td key={c.key} style={{ width: c.width, minWidth: c.width }}>
                          {readOnly
                            ? <span className="msg-ro">{displayCell(c, r.draft)}</span>
                            : <EditCell col={c} draft={r.draft} setField={(k, v) => setRowField(i, k, v)} />}
                        </td>
                      ))}
                      <td className="msg-rowmsg">
                        {r.saving && <span className="msg-rowsaving">Saving…</span>}
                        {r.error && <span className="msg-rowerr">{r.error}</span>}
                        {!r.saving && !r.error && r.original.id !== '__new__' && onOpenMilestone && (
                          <button className="msg-open" title="Open milestone" onClick={() => onOpenMilestone(r.original)}>Open</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!loadErr && rows.length === 0 && !creating && (
                  <tr><td colSpan={COLUMNS.length + 1}><div className="msg-empty">No milestones yet. Click “+ Create new”.</div></td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Apply a field change to a draft, handling the two lookup sentinels.
function applyField(draft, key, val) {
  if (key === '__lookup_workload') return { ...draft, workloadId: val?.id || '', workloadName: val?.label || '' };
  if (key === '__lookup_owner') return { ...draft, ownerId: val?.id || '', ownerName: val?.label || '' };
  return { ...draft, [key]: val };
}
