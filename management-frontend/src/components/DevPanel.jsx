import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

function formatJson(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2); } catch { return val; }
  }
  return JSON.stringify(val, null, 2);
}

const s = {
  root: { display: 'flex', flexDirection: 'column', gap: '6px' },
  empty: { color: 'var(--muted, #6b7280)', fontStyle: 'italic', textAlign: 'center', padding: '48px 0', fontSize: '14px' },
  entry: { border: '1px solid var(--border, #e5e7eb)', borderRadius: '8px', overflow: 'hidden' },
  entryHeader: {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
    padding: '8px 12px', background: 'var(--glass, #f9fafb)', border: 'none',
    cursor: 'pointer', textAlign: 'left', fontSize: '13px', color: 'var(--text, #1f2937)',
  },
  method: { fontWeight: 700, fontSize: '11px', letterSpacing: '0.5px', minWidth: '42px', flexShrink: 0 },
  url: { flex: 1, fontFamily: 'monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text, #1f2937)' },
  label: { fontSize: '11px', color: 'var(--muted, #6b7280)', flexShrink: 0 },
  ts: { fontSize: '11px', color: 'var(--muted, #6b7280)', flexShrink: 0 },
  chevron: { fontSize: '12px', color: 'var(--muted, #6b7280)', flexShrink: 0 },
  entryBody: { borderTop: '1px solid var(--border, #e5e7eb)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'var(--code-bg, #f3f4f6)' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' },
  sectionTitle: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted, #6b7280)' },
  copyBtn: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '2px 8px', fontSize: '11px', borderRadius: '6px',
    border: '1px solid var(--border, #e5e7eb)', background: 'var(--glass, #fff)',
    cursor: 'pointer', color: 'var(--text, #1f2937)', flexShrink: 0,
  },
  pre: { margin: 0, fontSize: '12px', fontFamily: 'Consolas, Monaco, "Courier New", monospace', color: 'var(--text, #1f2937)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflowY: 'auto' },
};

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };
  return (
    <button type="button" onClick={handleCopy} style={s.copyBtn} title={`Copy ${label.toLowerCase()}`}>
      {copied ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

const METHOD_COLORS = {
  GET: '#22c55e', POST: '#3b82f6', DELETE: '#ef4444', PUT: '#f59e0b', PATCH: '#a78bfa',
};

const EntryRow = ({ entry, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen);
  const requestJson = entry.request !== undefined ? formatJson(entry.request) : null;
  const responseJson = entry.response !== undefined ? formatJson(entry.response) : null;

  return (
    <div style={s.entry}>
      <button style={s.entryHeader} onClick={() => setOpen(o => !o)}>
        <span style={{ ...s.method, color: METHOD_COLORS[entry.method] || '#888' }}>{entry.method}</span>
        <span style={s.url}>{entry.url}</span>
        {entry.label && <span style={s.label}>{entry.label}</span>}
        <span style={s.ts}>{entry.ts}</span>
        <span style={s.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={s.entryBody}>
          {requestJson !== null && (
            <section>
              <div style={s.sectionHeader}>
                <div style={s.sectionTitle}>Request</div>
                <CopyButton text={requestJson} label="Copy request" />
              </div>
              <pre style={s.pre}>{requestJson}</pre>
            </section>
          )}
          {responseJson !== null && (
            <section>
              <div style={s.sectionHeader}>
                <div style={s.sectionTitle}>Response</div>
                <CopyButton text={responseJson} label="Copy response" />
              </div>
              <pre style={s.pre}>{responseJson}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

const DevPanel = ({ entries }) => {
  if (!entries || entries.length === 0) {
    return <div style={s.empty}>No API calls yet — use the App tab to make a request.</div>;
  }
  return (
    <div style={s.root}>
      {entries.map((entry, i) => (
        <EntryRow key={entry.key != null ? entry.key : i} entry={entry} defaultOpen={i === 0} />
      ))}
    </div>
  );
};

export default DevPanel;
