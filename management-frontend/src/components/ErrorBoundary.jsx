import React from 'react';
import { Home, RefreshCw } from 'lucide-react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={s.backdrop}>
        <div style={s.card}>
          <div style={s.header}>
            <span style={s.iconBadge}>✕</span>
            <div>
              <h2 style={s.title}>Something went wrong</h2>
              <p style={s.subtitle}>An unhandled error occurred in this page.</p>
            </div>
          </div>

          <div style={s.errorBox}>
            <p style={s.errorText}>{error.name}: {error.message}</p>
          </div>

          {info?.componentStack && (
            <details style={{ marginBottom: '1.5rem' }}>
              <summary style={s.stackSummary}>Component stack</summary>
              <pre style={s.stackPre}>{info.componentStack.trim()}</pre>
            </details>
          )}

          <div style={s.actions}>
            <a href="/ui" style={s.homeBtn}>
              <Home size={15} /> Home
            </a>
            <button
              onClick={() => this.setState({ error: null, info: null })}
              style={s.retryBtn}
            >
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const s = {
  backdrop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '2rem',
    backgroundColor: 'var(--bg, #f9fafb)',
  },
  card: {
    maxWidth: '640px',
    width: '100%',
    backgroundColor: 'var(--surface, #fff)',
    border: '1px solid var(--border, #e5e7eb)',
    borderRadius: '0.75rem',
    padding: '2rem',
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  iconBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: '50%',
    backgroundColor: '#fee2e2',
    color: '#dc2626',
    fontSize: '1rem',
    fontWeight: '700',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: '1.1rem',
    fontWeight: '700',
    color: 'var(--text, #111827)',
  },
  subtitle: {
    margin: 0,
    fontSize: '0.8rem',
    color: 'var(--muted, #6b7280)',
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '0.5rem',
    padding: '0.875rem 1rem',
    marginBottom: '1rem',
  },
  errorText: {
    margin: 0,
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#991b1b',
    wordBreak: 'break-word',
  },
  stackSummary: {
    fontSize: '0.75rem',
    fontWeight: '600',
    color: 'var(--muted, #6b7280)',
    cursor: 'pointer',
    userSelect: 'none',
    marginBottom: '0.5rem',
  },
  stackPre: {
    margin: 0,
    padding: '0.75rem',
    backgroundColor: 'var(--bg, #f9fafb)',
    border: '1px solid var(--border, #e5e7eb)',
    borderRadius: '0.4rem',
    fontSize: '0.72rem',
    fontFamily: 'monospace',
    color: 'var(--text, #374151)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '1.5rem',
  },
  homeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.5rem 1rem',
    backgroundColor: 'var(--primary, #3b82f6)',
    color: '#fff',
    fontWeight: '600',
    fontSize: '0.875rem',
    borderRadius: '0.4rem',
    textDecoration: 'none',
  },
  retryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.5rem 1rem',
    backgroundColor: 'transparent',
    color: 'var(--text, #374151)',
    fontWeight: '600',
    fontSize: '0.875rem',
    borderRadius: '0.4rem',
    border: '1px solid var(--border, #d1d5db)',
    cursor: 'pointer',
  },
};

export default ErrorBoundary;
