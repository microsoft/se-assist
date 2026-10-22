import { Component } from 'react';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';

/**
 * App-wide render guard. A render exception in any page previously took down the ENTIRE app
 * (React 18 unmounts the whole tree on an uncaught render error), leaving a blank, unrecoverable
 * screen. This boundary catches such errors, keeps the app shell (nav/sidebar) alive, and shows
 * the actual error with a way to recover — surfacing the failure honestly rather than a blank.
 *
 * `resetKey` (e.g. the current route path) clears the error automatically when it changes, so
 * navigating away from a broken page recovers without a manual reload.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep a console trail for diagnosis; the UI shows the message below.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 640 }}>
        <h2 style={{ marginTop: 0, color: 'var(--text)' }}>Something went wrong on this page</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.55 }}>
          This section hit an error and couldn’t render. The rest of the app is still working — use
          the navigation to switch pages, or reload to try again.
        </p>
        <pre style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '10px 12px', fontSize: 12, color: 'var(--danger)', whiteSpace: 'pre-wrap',
          overflowX: 'auto', marginBottom: 16,
        }}>
          {String(error?.message || error)}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="btn btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <ArrowClockwiseRegular /> Try again
        </button>
      </div>
    );
  }
}
