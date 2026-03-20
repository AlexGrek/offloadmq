import React from 'react';

/**
 * Renders command output in a terminal-style box.
 * Handles JSON with stdout/stderr, plain JSON, and raw text.
 */
const TerminalOutput = ({ response, style, contentColor }) => {
  if (!response) return null;

  const baseContent = contentColor ? { ...styles.streamContent, color: contentColor } : styles.streamContent;

  const renderContent = () => {
    try {
      const parsed = typeof response === 'string' ? JSON.parse(response) : response;
      if (parsed && typeof parsed === 'object' && ('stderr' in parsed || 'stdout' in parsed)) {
        return (
          <>
            {parsed.stderr && (
              <div style={styles.stream}>
                <div style={styles.streamLabel}>stderr:</div>
                <pre style={{ ...baseContent, color: '#FF6B6B' }}>{parsed.stderr}</pre>
              </div>
            )}
            {parsed.stdout && (
              <div style={styles.stream}>
                <div style={styles.streamLabel}>stdout:</div>
                <pre style={baseContent}>{parsed.stdout}</pre>
              </div>
            )}
            {!parsed.stderr && !parsed.stdout && (
              <pre style={baseContent}>{JSON.stringify(parsed, null, 2)}</pre>
            )}
          </>
        );
      }
      return <pre style={baseContent}>{JSON.stringify(parsed, null, 2)}</pre>;
    } catch {
      return (
        <pre style={baseContent}>
          {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
        </pre>
      );
    }
  };

  return (
    <div style={{ ...styles.terminal, ...style }}>
      {renderContent()}
    </div>
  );
};

const styles = {
  terminal: {
    backgroundColor: '#000000',
    padding: '12px',
    borderRadius: '4px',
    border: '1px solid #333',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  stream: {
    marginBottom: '8px',
  },
  streamLabel: {
    color: '#888',
    fontSize: '11px',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  streamContent: {
    margin: '0',
    padding: '0',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    color: '#FFFFFF',
  },
};

export default TerminalOutput;
