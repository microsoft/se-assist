import { useEffect, useRef, useState } from 'react';
import { onAcrProgress } from '../electronBridge';

/**
 * AcrProgressBanner — a compact, live status line for in-flight ACR (Azure
 * Consumed Revenue) Power BI pulls. It subscribes to the main process's
 * `acr-progress` stream and renders only while at least one live query is
 * running, so a slow pull reads as *progressing* rather than *hung*.
 *
 * The metrics shown are the ones that keep moving even when no data is
 * arriving — which is exactly when a plain spinner looks frozen:
 *   • active query count + rows fetched so far (proves forward progress)
 *   • elapsed time (always ticking)
 *   • a throttle/backoff countdown: "Power BI rate-limited — retrying in Ns
 *     (attempt k/5)". During a 429/503 backoff the app is deliberately idle for
 *     up to two minutes; the countdown is the only honest signal that it is
 *     waiting on Power BI, not stuck.
 *
 * Purely presentational + additive: it issues no queries of its own and, off
 * Electron, onAcrProgress is a no-op so the banner simply never appears.
 */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function AcrProgressBanner() {
  // id -> { startedAt, rows, retryUntil, attempt, maxAttempts, phase, status }
  const active = useRef(new Map());
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => (n + 1) % 1_000_000);

  useEffect(() => {
    const unsub = onAcrProgress((evt) => {
      if (!evt || evt.id == null) return;
      const m = active.current;
      const id = evt.id;
      if (evt.phase === 'start') {
        m.set(id, { startedAt: Date.now(), rows: 0, retryUntil: 0, attempt: 0, maxAttempts: 0, phase: 'start', status: null });
      } else if (evt.phase === 'window') {
        const e = m.get(id) || { startedAt: Date.now(), rows: 0 };
        e.rows = evt.rows || 0;
        e.retryUntil = 0; // data moved again — clear any stale countdown
        e.phase = 'window';
        m.set(id, e);
      } else if (evt.phase === 'throttle' || evt.phase === 'retry') {
        const e = m.get(id) || { startedAt: Date.now(), rows: 0 };
        const waitMs = evt.retryInMs != null ? evt.retryInMs : (evt.waitMs || 0);
        e.retryUntil = Date.now() + waitMs;
        e.attempt = evt.attempt || 0;
        e.maxAttempts = evt.maxAttempts || 0;
        e.phase = evt.phase;
        e.status = evt.status || null;
        e.code = evt.code || null;
        m.set(id, e);
      } else if (evt.phase === 'done' || evt.phase === 'error') {
        m.delete(id);
      }
      rerender();
    });
    return unsub;
  }, []);

  // Tick once a second while anything is active so elapsed + countdown advance
  // even between engine events (a backoff sleep emits nothing for up to 120s).
  useEffect(() => {
    const t = setInterval(() => { if (active.current.size > 0) rerender(); }, 1000);
    return () => clearInterval(t);
  }, []);

  const entries = [...active.current.values()];
  if (entries.length === 0) return null;

  const now = Date.now();
  const totalRows = entries.reduce((sum, e) => sum + (e.rows || 0), 0);
  const startedAt = Math.min(...entries.map((e) => e.startedAt || now));
  const elapsed = now - startedAt;
  // The most-severe active wait drives the countdown reassurance.
  const waiting = entries
    .filter((e) => e.retryUntil > now)
    .sort((a, b) => b.retryUntil - a.retryUntil)[0];
  const countdown = waiting ? Math.ceil((waiting.retryUntil - now) / 1000) : 0;

  return (
    <div className={`acr-progress${waiting ? ' is-waiting' : ''}`} role="status" aria-live="polite">
      <span className="acr-progress-dot" aria-hidden="true" />
      <span className="acr-progress-main">
        Loading ACR — {entries.length} active {entries.length === 1 ? 'query' : 'queries'}
        {' · '}{totalRows.toLocaleString()} rows
        {' · '}{fmtDuration(elapsed)}
      </span>
      {waiting ? (
        <span className="acr-progress-wait">
          {waiting.code === 'ACR_CAPACITY_LIMIT'
            ? `Power BI capacity is busy — shared recovery in ${countdown}s`
            : waiting.status
            ? `Power BI rate-limited (HTTP ${waiting.status}) — retrying in ${countdown}s`
            : `Transient error — retrying in ${countdown}s`}
          {waiting.maxAttempts ? ` (attempt ${waiting.attempt}/${waiting.maxAttempts})` : ''}
        </span>
      ) : null}
    </div>
  );
}
