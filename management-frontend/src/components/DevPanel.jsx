import React, { useState } from 'react';

function formatJson(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2); } catch { return val; }
  }
  return JSON.stringify(val, null, 2);
}

const METHOD_COLORS = {
  GET: '#22c55e', POST: '#3b82f6', DELETE: '#ef4444', PUT: '#f59e0b', PATCH: '#a78bfa',
};

const EntryRow = ({ entry, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen);
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
          {entry.request !== undefined && (
            <section>
              <div style={s.sectionTitle}>Request</div>
              <pre style={s.pre}>{formatJson(entry.request)}</pre>
            </section>
          )}
          {entry.response !== undefined && (
            <section>
              <div style={s.sectionTitle}>Response</div>
              <pre style={s.pre}>{formatJson(entry.response)}</pre>
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
  sectionTitle: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted, #6b7280)', marginBottom: '6px' },
  pre: { margin: 0, fontSize: '12px', fontFamily: 'Consolas, Monaco, "Courier New", monospace', color: 'var(--text, #1f2937)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflowY: 'auto' },
};

export default DevPanel;
