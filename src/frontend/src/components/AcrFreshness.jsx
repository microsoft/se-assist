export default function AcrFreshness({ cache }) {
  if (!cache) return null;
  const dataAsOf = cache.dataAsOf
    ? new Date(cache.dataAsOf).toLocaleString()
    : null;
  const errMsg = cache.error?.message || null;
  // When the live model has denied access there is no point promising an update
  // — the background refresh cannot succeed. Disclose the access problem plainly
  // and make clear the page is showing the most recent cached data.
  const accessDenied = ['ACR_RLS_UNAUTHORIZED', 'ACR_UNAUTHORIZED', 'NO_ACCOUNT']
    .includes(cache.error?.code);

  let text;
  if (cache.status === 'missing') {
    text = errMsg || (cache.refreshing ? 'Loading data…' : 'No data is available.');
  } else if (accessDenied) {
    text = `Data as of ${dataAsOf || 'unknown'}. Live refresh is unavailable — ${errMsg} Showing the most recent cached data.`;
  } else {
    text = `Data as of ${dataAsOf || 'unknown'}.`;
    if (cache.status === 'partial') {
      text += ` Some data is still being prepared.${cache.incompleteMonths?.length ? ` Missing complete data for: ${cache.incompleteMonths.join(', ')}.` : ''}`;
    }
    if (cache.refreshing) {
      text += ' A background refresh is running; this view updates when it finishes.';
    }
    if (errMsg) {
      text += ` Last background refresh failed: ${errMsg}`;
    }
  }

  return (
    <div
      style={{
        color: (cache.status === 'missing' || accessDenied) ? 'var(--warning-text)' : 'var(--text-muted)',
        fontSize: 12,
        marginTop: 6,
      }}
    >
      {text}
    </div>
  );
}
