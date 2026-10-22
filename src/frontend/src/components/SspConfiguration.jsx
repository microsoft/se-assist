import { useState, useMemo, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Spinner } from '@fluentui/react-components';
import { OpenRegular, EditRegular, SaveRegular, DismissRegular, ContactCardRegular } from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import { getMsxSettings, openExternal, dbRun, resolvePersonByEmail } from '../electronBridge';
import { SSP_UPDATED_EVENT } from '../territoryContext';
import { AccountGlanceModal } from './CustomerActivity';

// SSP Configuration table — one row per top-parent account (TPID). Edits ONE role, the SSP
// (Cloud and AI Specialist): the SE enters the EMAIL and the NAME is derived from it via a
// directory lookup (never typed). Both persist on the same customer_account_team_roles row
// (keyed by tpid + role). Lives inside the User Home "SSP Configuration" section. Child accounts
// are intentionally not shown — the SSP is set at the top-parent (TPID) level.
const SSP_ROLE = 'Cloud and AI Specialist';

export default function SspConfiguration() {
  const navigate = useNavigate();
  const { data: customers, loading } = useDbQuery('SELECT * FROM active_customers ORDER BY name');
  const { data: roleRows, refresh: refreshRoles } = useDbQuery(
    'SELECT tpid, role, person_name, person_email FROM active_customer_account_team_roles',
  );
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState({}); // { [tpid]: { name?, email? } } — only touched fields
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState({}); // { [tpid]: true } while auto-filling name from email
  const [sortBy, setSortBy] = useState('name'); // 'name' | 'ssp'
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'
  const [glance, setGlance] = useState(null); // { tpid, name, ssp } | null — account glance popup

  useEffect(() => {
    getMsxSettings().then((s) => setCrmBaseUrl(s.crmUrl || '')).catch(() => {});
  }, []);

  // rolesByTpid[tpid] = { name, email } for the SSP role, resolved from the persisted rows.
  const rolesByTpid = useMemo(() => {
    const map = {};
    for (const r of roleRows || []) {
      if (r.role !== SSP_ROLE) continue;
      map[r.tpid] = { name: r.person_name || '', email: r.person_email || '' };
    }
    return map;
  }, [roleRows]);

  const roleValue = (tpid, field) => {
    const e = edits[tpid];
    if (editing && e && e[field] !== undefined) return e[field];
    return rolesByTpid[tpid]?.[field] || '';
  };

  const setRoleValue = (tpid, field, value) => {
    setEdits((prev) => ({ ...prev, [tpid]: { ...prev[tpid], [field]: value } }));
  };

  // The SSP name is DERIVED from the email — never typed. On email blur, resolve the display name
  // from the directory (cache-first, then live). Empty email clears the name; a valid email with
  // no match clears it; a lookup outage leaves the current name untouched.
  async function resolveNameFromEmail(tpid) {
    const email = String(roleValue(tpid, 'email') || '').trim();
    if (!email) { setRoleValue(tpid, 'name', ''); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    const baseEmail = String(rolesByTpid[tpid]?.email || '').trim();
    const currentName = String(roleValue(tpid, 'name') || '').trim();
    if (email === baseEmail && currentName) return;
    setResolving((r) => ({ ...r, [tpid]: true }));
    try {
      const res = await resolvePersonByEmail({ email });
      if (res?.ok && res.resolved && res.name) {
        setRoleValue(tpid, 'name', res.name);
      } else if (res?.ok && !res.resolved) {
        setRoleValue(tpid, 'name', '');
      }
    } catch { /* leave the name untouched */ } finally {
      setResolving((r) => { const n = { ...r }; delete n[tpid]; return n; });
    }
  }

  function cancelEdit() {
    setEdits({});
    setEditing(false);
  }

  async function saveEdits() {
    setSaving(true);
    try {
      for (const [tpid, changed] of Object.entries(edits)) {
        if (!tpid) continue;
        const base = rolesByTpid[tpid] || { name: '', email: '' };
        const name = String(('name' in changed ? changed.name : base.name) || '').trim();
        const email = String(('email' in changed ? changed.email : base.email) || '').trim();
        if (name === (base.name || '').trim() && email === (base.email || '').trim()) continue;
        if (!name && !email) {
          await dbRun('DELETE FROM customer_account_team_roles WHERE tpid = ? AND role = ?', [tpid, SSP_ROLE]);
        } else {
          await dbRun(
            `INSERT INTO customer_account_team_roles (tpid, role, person_name, person_email)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(tpid, role) DO UPDATE SET
               person_name = excluded.person_name,
               person_email = excluded.person_email,
               updated_at = CURRENT_TIMESTAMP`,
            [tpid, SSP_ROLE, name, email],
          );
        }
      }
      await refreshRoles();
      setEdits({});
      setEditing(false);
      // Notify the territory context so Discover mode reflects the new SSP set live.
      try { window.dispatchEvent(new CustomEvent(SSP_UPDATED_EVENT)); } catch { /* ignore */ }
    } finally {
      setSaving(false);
    }
  }

  // One row per TPID: pick the top-parent account for each group. Child accounts are not shown.
  const rows = useMemo(() => {
    const groups = {};
    for (const c of customers || []) {
      if (!c.tpid) continue;
      (groups[c.tpid] || (groups[c.tpid] = [])).push(c);
    }
    const list = Object.entries(groups).map(([tpid, accounts]) => {
      const topParent = accounts.find((a) => a.parenting_level === 861980000)
        || accounts.find((a) => !a.parent_crm_account_id)
        || accounts[0];
      return { tpid, topParent, name: topParent.name };
    });
    const dir = sortDir === 'desc' ? -1 : 1;
    if (sortBy === 'ssp') {
      list.sort((a, b) => {
        const an = (rolesByTpid[a.tpid]?.name || '').trim().toLowerCase();
        const bn = (rolesByTpid[b.tpid]?.name || '').trim().toLowerCase();
        if (an && !bn) return -1;
        if (!an && bn) return 1;
        if (!an && !bn) return a.name.localeCompare(b.name);
        return an.localeCompare(bn) * dir;
      });
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name) * dir);
    }
    return list;
  }, [customers, rolesByTpid, sortBy, sortDir]);

  function toggleSort(key) {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir('asc'); }
  }
  const sortArrow = (key) => (
    <span style={{ fontSize: 11, opacity: sortBy === key ? 1 : 0.3 }}>
      {sortBy === key ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}
    </span>
  );

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner label="Loading customers…" /></div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          Assign the Cloud and AI Specialist (SSP) for each account — enter the SSP’s email and the name fills
          in automatically from the directory.
        </p>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {editing ? (
            <>
              <Button appearance="primary" size="small" icon={<SaveRegular />} onClick={saveEdits} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button appearance="subtle" size="small" icon={<DismissRegular />} onClick={cancelEdit} disabled={saving}>Cancel</Button>
            </>
          ) : (
            <Button appearance="subtle" size="small" icon={<EditRegular />} onClick={() => setEditing(true)} title="Edit the SSP (name + email) across accounts">
              Edit SSPs
            </Button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 32 }}>
          No customers yet. Run “Sync from CRM” above to get started.
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort('name')} title="Click to sort by customer name." style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                  Customer Name {sortArrow('name')}
                </th>
                <th>TPID</th>
                <th onClick={() => toggleSort('ssp')} title="Cloud and AI Specialist (SSP) — auto-filled from the email. Click to sort by SSP name." style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                  SSP Name {sortArrow('ssp')}
                </th>
                <th>SSP Email</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ tpid, topParent, name }) => {
                const crmLink = topParent.crm_account_id && crmBaseUrl
                  ? `${crmBaseUrl}/main.aspx?etn=account&id=${topParent.crm_account_id}&pagetype=entityrecord` : null;
                const sspName = roleValue(tpid, 'name');
                return (
                  <tr key={tpid} onClick={() => navigate(`/customers/${topParent.id}`)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 600 }}>
                      <Link to={`/customers/${topParent.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                        {name}
                      </Link>
                    </td>
                    <td><span className="badge badge-secondary">{tpid}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {editing ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          {resolving[tpid] ? (
                            <><Spinner size="tiny" /> <span style={{ color: 'var(--text-muted)' }}>Looking up…</span></>
                          ) : sspName ? (
                            <span>{sspName}</span>
                          ) : (
                            <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>Auto-fills from email</span>
                          )}
                        </span>
                      ) : (sspName || '—')}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {editing ? (
                        <input
                          className="role-cell-input"
                          type="email"
                          value={roleValue(tpid, 'email')}
                          placeholder="email@microsoft.com"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRoleValue(tpid, 'email', e.target.value)}
                          onBlur={() => resolveNameFromEmail(tpid)}
                        />
                      ) : (roleValue(tpid, 'email') || '—')}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<ContactCardRegular />}
                          onClick={(e) => { e.stopPropagation(); setGlance({ tpid: String(tpid), name, ssp: sspName || '' }); }}
                          title="Account glance"
                        />
                        {crmLink && (
                          <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={(e) => { e.stopPropagation(); openExternal(crmLink); }} title="Open in CRM" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AccountGlanceModal selected={glance} onClose={() => setGlance(null)} />
    </div>
  );
}
