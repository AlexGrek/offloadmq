import React from 'react';
import { AlertCircle } from 'lucide-react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.container}>
          <div style={styles.content}>
            <AlertCircle size={32} style={styles.icon} />
            <h3 style={styles.title}>Something went wrong</h3>
            <p style={styles.message}>{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button
              style={styles.button}
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles = {
  container: {
    padding: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '200px',
  },
  content: {
    textAlign: 'center',
    padding: '20px',
    background: 'var(--glass)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    maxWidth: '400px',
  },
  icon: {
    color: 'var(--danger)',
    marginBottom: '12px',
  },
  title: {
    fontSize: '16px',
    fontWeight: '600',
    color: 'var(--text)',
    margin: '0 0 8px 0',
  },
  message: {
    fontSize: '13px',
    color: 'var(--muted)',
    margin: '0 0 16px 0',
    wordBreak: 'break-word',
  },
  button: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: '600',
    backgroundColor: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
};

export default ErrorBoundary;
