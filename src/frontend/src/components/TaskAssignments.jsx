import { useCallback, useEffect, useState } from 'react';
import { Button, Combobox, Field, Option, Spinner } from '@fluentui/react-components';
import { getTaskAssignmentOptions } from '../electronBridge';

export function useTaskAssignmentOptions(enabled = true) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ loading: true, error: '', customers: [], workloads: [] });
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setState(previous => ({ ...previous, loading: true, error: '' }));
    getTaskAssignmentOptions().then(result => {
      if (!result?.ok || !Array.isArray(result.customers) || !Array.isArray(result.workloads)) {
        throw new Error(result?.error || 'Could not load Task assignment options.');
      }
      if (alive) setState({ ...result, loading: false, error: '' });
    }).catch(error => {
      if (alive) setState(previous => ({ ...previous, loading: false, error: error.message || String(error) }));
    });
    return () => { alive = false; };
  }, [enabled, revision]);
  return { ...state, reload };
}

export function TaskAssignmentStatus({ state }) {
  if (state.loading) return <Spinner size="tiny" label="Loading customers and workloads..." />;
  if (!state.error) return null;
  return (
    <div role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
      {state.error}{' '}
      <Button size="small" appearance="subtle" onClick={state.reload}>Retry options</Button>
    </div>
  );
}

function AssignmentPicker({ label, taskTitle, value, selectedLabel, emptyLabel, options, disabled, onChange }) {
  const [query, setQuery] = useState(null);
  const [open, setOpen] = useState(false);
  const selectedValue = value == null ? '' : String(value);
  const selected = options.find(option => String(option.value) === selectedValue);
  const display = selectedValue ? (selected?.label || selectedLabel || `${label} unavailable`) : emptyLabel;
  const visible = query == null ? options : options.filter(option => option.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <Field label={label} size="small" style={{ flex: '1 1 220px', minWidth: 0 }}>
      <Combobox
        size="small"
        aria-label={taskTitle ? `${label} for ${taskTitle}` : label}
        value={query == null ? display : query}
        selectedOptions={[selectedValue]}
        placeholder={`Search ${label.toLowerCase()}...`}
        disabled={disabled}
        open={open}
        inlinePopup
        onOpenChange={(_event, data) => {
          setOpen(data.open);
          if (!data.open) setQuery(null);
        }}
        onFocus={() => setQuery('')}
        onBlur={() => setQuery(null)}
        onChange={event => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onOptionSelect={(_event, data) => {
          setOpen(false);
          setQuery(null);
          if (data.optionValue !== undefined) onChange(data.optionValue || null);
        }}
        style={{ width: '100%', minWidth: 0 }}
        listbox={{ style: { maxHeight: 240 } }}
      >
        <Option value="" text={emptyLabel}>{emptyLabel}</Option>
        {visible.map(option => (
          <Option key={option.value} value={String(option.value)} text={option.label}>{option.label}</Option>
        ))}
        {!visible.length && <Option disabled value="no-matches">No matching {label.toLowerCase()}s</Option>}
      </Combobox>
    </Field>
  );
}

export function TaskCustomerPicker({ state, profileId, customerName, ...props }) {
  return (
    <AssignmentPicker
      {...props}
      label="Customer" value={profileId} selectedLabel={customerName} emptyLabel="Unselected"
      disabled={props.disabled || state.loading || !!state.error}
      options={state.customers.map(customer => ({
        value: customer.id,
        label: `${customer.displayName}${customer.tpid ? ` (${customer.tpid})` : ''}`,
      }))}
    />
  );
}

export function TaskWorkloadPicker({ state, workloadId, workloadName, ...props }) {
  return (
    <AssignmentPicker
      {...props}
      label="Workload" value={workloadId} selectedLabel={workloadName} emptyLabel="None"
      disabled={props.disabled || state.loading || !!state.error}
      options={state.workloads.map(workload => ({
        value: workload.id,
        label: `${workload.title}${workload.accountName ? ` - ${workload.accountName}` : ''}${workload.status !== 'active' ? ` (${workload.status})` : ''}`,
      }))}
    />
  );
}
