import { useState } from 'react';
import { Button, Input, Spinner } from '@fluentui/react-components';
import {
  TaskListSquareLtrRegular, DismissRegular, AddRegular, CheckmarkCircleRegular,
} from '@fluentui/react-icons';
import { saveCustomerTodo, inElectron } from '../electronBridge';
import { TaskAssignmentStatus, TaskCustomerPicker, TaskWorkloadPicker, useTaskAssignmentOptions } from './TaskAssignments';

const DAY_SHORTCUTS = [
  { label: '+1', days: 1 },
  { label: '+2', days: 2 },
  { label: '+3', days: 3 },
  { label: '+7', days: 7 },
];

// Local-time YYYY-MM-DD (avoids the UTC off-by-one from toISOString()).
function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

const EMPTY = { action: '', profileId: null, workloadId: null, dueAt: '' };

export default function TaskBubble() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const assignments = useTaskAssignmentOptions(open);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(null);

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const canSave = form.action.trim() && !saving && inElectron();

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setFlash(null);
    try {
      const result = await saveCustomerTodo({
        profileId: form.profileId,
        workloadId: form.workloadId,
        title: form.action.trim(),
        status: 'open',
        dueAt: form.dueAt || null,
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not save the Task.');
      const name = assignments.customers.find(customer => customer.id === form.profileId)?.displayName;
      setForm(previous => ({ ...EMPTY, profileId: previous.profileId, workloadId: previous.workloadId }));
      setFlash({ type: 'success', msg: name ? `Task added for ${name}.` : 'Task added with customer Unselected.' });
    } catch (err) {
      setFlash({ type: 'error', msg: err?.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Quick task"
        style={fabStyle}
      >
        <TaskListSquareLtrRegular style={{ fontSize: 22 }} />
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <TaskListSquareLtrRegular style={{ fontSize: 18 }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>Quick Task</span>
        <button type="button" onClick={() => setOpen(false)} title="Close" style={iconBtnStyle}>
          <DismissRegular style={{ fontSize: 16 }} />
        </button>
      </div>

      <div style={bodyStyle}>
        {!inElectron() && (
          <div style={{ fontSize: 11, color: 'var(--warning-text)' }}>
            Desktop app only — tasks are saved to the local customer workspace.
          </div>
        )}

        <label style={labelStyle}>Action</label>
        <Input
          value={form.action}
          onChange={(_e, d) => set('action', d.value)}
          onKeyDown={onKeyDown}
          placeholder="Follow up on architecture review"
          appearance="filled-darker"
          disabled={saving}
        />

        <TaskAssignmentStatus state={assignments} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <TaskCustomerPicker state={assignments} profileId={form.profileId} disabled={saving} onChange={value => set('profileId', value)} />
          <TaskWorkloadPicker state={assignments} workloadId={form.workloadId} disabled={saving} onChange={value => set('workloadId', value)} />
        </div>

        <label style={labelStyle}>Due date</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input
            type="date"
            value={form.dueAt}
            onChange={(_e, d) => set('dueAt', d.value)}
            appearance="filled-darker"
            disabled={saving}
            style={{ flex: 1 }}
          />
          {form.dueAt && (
            <button type="button" onClick={() => set('dueAt', '')} disabled={saving} title="Clear date" style={clearBtnStyle}>
              <DismissRegular style={{ fontSize: 13 }} />
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {DAY_SHORTCUTS.map((s) => {
            const value = plusDays(s.days);
            const active = form.dueAt === value;
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => set('dueAt', value)}
                disabled={saving}
                style={active ? { ...shortcutStyle, ...shortcutActiveStyle } : shortcutStyle}
                title={value}
              >
                {s.label}d
              </button>
            );
          })}
        </div>

        {flash && (
          <div style={flash.type === 'success' ? successStyle : errorStyle}>
            {flash.type === 'success' && <CheckmarkCircleRegular style={{ fontSize: 14 }} />}
            <span>{flash.msg}</span>
          </div>
        )}

        <Button
          appearance="primary"
          icon={saving ? <Spinner size="tiny" /> : <AddRegular />}
          onClick={save}
          disabled={!canSave}
          style={{ marginTop: 2 }}
        >
          Add task
        </Button>
      </div>
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────────────────── */

const fabStyle = {
  position: 'fixed', right: 24, bottom: 88, zIndex: 1000,
  width: 56, height: 56, borderRadius: '50%', border: 'none', cursor: 'pointer',
  background: 'linear-gradient(135deg, var(--accent), var(--accent))', color: 'var(--accent-tint)',
  boxShadow: '0 6px 20px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const panelStyle = {
  position: 'fixed', right: 24, bottom: 88, zIndex: 1000,
  width: 320, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 112px)',
  display: 'flex', flexDirection: 'column',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
  boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
};

const headerStyle = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px',
  background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', color: 'var(--text)',
};

const iconBtnStyle = {
  background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', padding: 4, borderRadius: 4,
};

const bodyStyle = {
  padding: 14, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto',
};

const labelStyle = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.3,
};

const shortcutStyle = {
  flex: 1, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  background: 'var(--hairline)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6,
};

const shortcutActiveStyle = {
  background: 'var(--accent)', color: 'var(--card)', borderColor: 'var(--accent)',
};

const clearBtnStyle = {
  background: 'var(--hairline)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 6, borderRadius: 6, height: 32,
};

const successStyle = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 27%, transparent)', borderRadius: 6, padding: '6px 8px', marginTop: 4,
};

const errorStyle = {
  fontSize: 12, color: 'var(--pink)',
  background: 'color-mix(in srgb, var(--pink) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--pink) 27%, transparent)', borderRadius: 6, padding: '6px 8px', marginTop: 4,
};
