import { useState } from 'react';
import { ChevronRightRegular, ChevronDownRegular } from '@fluentui/react-icons';

/**
 * Lightweight collapsible container used to group ACR product charts under a
 * category header (Infra / Data / Apps). Defaults to collapsed so the account
 * and portfolio pages open compact, with each category expanded on demand.
 *
 * @param {object} props
 * @param {React.ReactNode} props.title      Category label (e.g. "Apps").
 * @param {React.ReactNode} [props.icon]     Optional leading icon.
 * @param {string} [props.subtitle]          Muted helper text after the title.
 * @param {boolean} [props.defaultOpen]      Start expanded (default false).
 * @param {(open:boolean) => void} [props.onOpenChange] Called after toggling.
 * @param {React.ReactNode} props.children   Charts rendered when expanded.
 */
export default function CollapsibleSection({
  title,
  icon,
  subtitle,
  defaultOpen = false,
  onOpenChange,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div style={{ marginBottom: 20 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: open ? '10px 10px 0 0' : 10,
          padding: '12px 16px', cursor: 'pointer', textAlign: 'left', font: 'inherit',
          color: 'var(--text)',
        }}
      >
        {open
          ? <ChevronDownRegular style={{ fontSize: 16, flexShrink: 0, color: 'var(--text-muted)' }} />
          : <ChevronRightRegular style={{ fontSize: 16, flexShrink: 0, color: 'var(--text-muted)' }} />}
        {icon}
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
        {subtitle ? <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 400 }}>{subtitle}</span> : null}
      </button>
      {open ? (
        <div style={{ border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: '16px 16px 0', background: 'var(--accent-tint)' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
