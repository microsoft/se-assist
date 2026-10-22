import { Link } from 'react-router-dom';
import { OpenRegular } from '@fluentui/react-icons';

// Shared "refined" account metric panel used by both the Customer profile page and the
// Customer glance popup. Shows a large primary number (e.g. your active + uncommitted
// pipeline, or FY HoK), a label, and an optional smaller "N total" line beneath it.
// Renders as a Link (when `to` is set), a button (when `onClick` is set), or a plain card.
// `tone="danger"` colors the number when it is non-zero (used for overdue / blocked).
export default function AccountMetricStat({
  label, primary, total, totalLabel = 'total',
  to, onClick, hint, tone = 'default',
}) {
  const danger = tone === 'danger' && Number(primary) > 0;
  const clickable = !!(to || onClick);
  const inner = (
    <>
      <span className="ams-head">
        <span className="ams-label">{label}</span>
        {clickable ? <OpenRegular className="ams-open" /> : null}
      </span>
      <span className={`ams-value${danger ? ' danger' : ''}`}>{primary}</span>
      {total != null ? <span className="ams-total">{total} {totalLabel}</span> : null}
    </>
  );
  const className = `ams-card${clickable ? ' clickable' : ''}`;
  if (to) return <Link to={to} className={className} title={hint}>{inner}</Link>;
  if (onClick) return <button type="button" className={className} onClick={onClick} title={hint}>{inner}</button>;
  return <div className={className}>{inner}</div>;
}
