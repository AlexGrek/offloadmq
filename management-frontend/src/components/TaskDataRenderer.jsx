import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import ColorDot from './ColorDot';

const STATUS_CONFIG = {
  completed:   { label: 'Completed',   color: '#22c55e', bg: 'rgba(34,197,94,0.12)'   },
  failed:      { label: 'Failed',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)'   },
  in_progress: { label: 'In Progress', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)'  },
  pending:     { label: 'Pending',     color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function shortId(id) {
  if (!id) return '—';
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || { label: status || 'unknown', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' };
  return (
    <span style={{
      fontSize: '0.70rem', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: '999px',
      color: cfg.color, background: cfg.bg,
      border: `1px solid ${cfg.color}55`,
      flexShrink: 0,
    }}>
      {cfg.label}
    </span>
  );
}

function PayloadPreview({ payload }) {
  const [open, setOpen] = useState(false);
  if (!payload) return null;

  // LLM chat format — render messages nicely
  if (payload.messages && Array.isArray(payload.messages)) {
    const lastUser = [...payload.messages].reverse().find(m => m.role === 'user');
    const previewText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser?.content);

    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Payload</span>
          <button className="btn" style={{ padding: '1px 8px', fontSize: '0.74rem', borderRadius: '8px' }}
            onClick={() => setOpen(s => !s)}>
            {open ? 'Hide' : `${payload.messages.length} messages`}
          </button>
        </div>
        {!open && (
          <div style={{ fontSize: '0.82rem', color: 'var(--muted)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '480px' }}>
            {previewText?.slice(0, 140) || '(no content)'}
          </div>
        )}
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {payload.messages.map((msg, i) => {
              const roleColor = msg.role === 'user' ? '#3b82f6' : msg.role === 'assistant' ? '#22c55e' : '#94a3b8';
              return (
                <div key={i} style={{
                  padding: '8px 10px', borderRadius: '10px', fontSize: '0.82rem',
                  background: `${roleColor}0f`,
                  borderLeft: `3px solid ${roleColor}`,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.70rem', textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)' }}>
                    {msg.role}
                    {msg.images?.length > 0 && <span style={{ marginLeft: '8px', fontWeight: 400 }}>📎 {msg.images.length} image(s)</span>}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Generic payload
  const str = JSON.stringify(payload, null, 2);
  const isLong = str.length > 300;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Payload</span>
        {isLong && (
          <button className="btn" style={{ padding: '1px 8px', fontSize: '0.74rem', borderRadius: '8px' }}
            onClick={() => setOpen(s => !s)}>
            {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {(!isLong || open) && (
        <pre style={{ margin: 0, fontSize: '0.78rem', background: 'var(--code-bg)', padding: '8px 10px', borderRadius: '8px', overflowX: 'auto' }}>
          {str}
        </pre>
      )}
    </div>
  );
}

function ResultSection({ result }) {
  if (!result) return null;
  const hasError = result.error && result.error !== 'null' && result.error !== '';
  const hasResponse = result.response_text && result.response_text !== 'null' && result.response_text !== '' && result.response_text !== 'No response from server';
  if (!hasError && !hasResponse) return null;

  return (
    <div>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '6px' }}>Result</div>
      {hasError && (
        <div style={{
          padding: '8px 10px', borderRadius: '8px', fontSize: '0.82rem',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          color: 'var(--danger)', marginBottom: '6px', wordBreak: 'break-word',
        }}>
          <span style={{ fontWeight: 700 }}>Error: </span>{result.error}
        </div>
      )}
      {hasResponse && (
        <div style={{
          padding: '8px 10px', borderRadius: '8px', background: 'var(--code-bg)',
          fontSize: '0.82rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: '220px', overflowY: 'auto',
        }}>
          {result.response_text}
        </div>
      )}
    </div>
  );
}

function HistorySection({ history }) {
  if (!history || history.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '6px' }}>History</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {history.map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', fontSize: '0.80rem', alignItems: 'baseline' }}>
            <span className="mono" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', flexShrink: 0, fontSize: '0.75rem' }}>{fmtTs(h.timestamp)}</span>
            <span>{h.description}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, isAssigned }) {
  const [expanded, setExpanded] = useState(false);
  const { id, agentId, assignedAt, createdAt, data, status, stage, log, result, history } = task;

  return (
    <li className="card">
      <button className="row" onClick={() => setExpanded(s => !s)}>
        <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
        <span className="row-main">
          <span className="row-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <ColorDot seed={id?.id} size={10} variant="flag-triangle-right"/>
              <span className="mono" style={{ fontSize: '0.84rem' }}>{shortId(id?.id)}</span>
            </span>
            <StatusBadge status={status} />
            {stage && <span className="chip" style={{ fontSize: '0.70rem' }}>{stage}</span>}
          </span>
          <span className="row-sub">
            <span className="chip">{data?.capability || id?.cap}</span>
            {isAssigned && agentId && (
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '0.75rem', color: 'var(--muted)' }}>
                →
                <ColorDot seed={agentId} size={10} title={agentId} />
                <span className="mono">{shortId(agentId)}</span>
              </span>
            )}
            <span style={{ fontSize: '0.76rem', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: '3px' }}>
              <Clock size={10} />
              {fmtTs(createdAt)}
            </span>
          </span>
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: '14px', borderTop: '1px solid var(--border)' }}>
          {/* Metadata grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
            {[
              { label: 'Task ID',    value: id?.id,         mono: true  },
              { label: 'Capability', value: data?.capability || id?.cap, mono: true },
              { label: 'Created',    value: fmtTs(createdAt)             },
              ...(isAssigned && assignedAt ? [{ label: 'Assigned At', value: fmtTs(assignedAt) }] : []),
              ...(agentId ? [{ label: 'Agent', value: agentId, mono: true }] : []),
            ].map(({ label, value, mono }) => (
              <div key={label} style={{ fontSize: '0.78rem' }}>
                <div style={{ color: 'var(--muted)', fontWeight: 700, marginBottom: '2px', fontSize: '0.70rem', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
                <div className={mono ? 'mono' : ''} style={{ wordBreak: 'break-all', fontSize: mono ? '0.76rem' : undefined }}>{value || '—'}</div>
              </div>
            ))}
            <div style={{ fontSize: '0.78rem' }}>
              <div style={{ color: 'var(--muted)', fontWeight: 700, marginBottom: '4px', fontSize: '0.70rem', textTransform: 'uppercase', letterSpacing: '.4px' }}>Flags</div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {data?.urgent && <span className="chip">urgent</span>}
                {data?.restartable && <span className="chip">restartable</span>}
                {!data?.urgent && !data?.restartable && <span style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>none</span>}
              </div>
            </div>
          </div>

          <PayloadPreview payload={data?.payload} />
          <ResultSection result={result} />

          {log && (
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '6px' }}>Log</div>
              <pre style={{ margin: 0, fontSize: '0.78rem', background: 'var(--code-bg)', padding: '8px 10px', borderRadius: '8px', maxHeight: '150px', overflowY: 'auto' }}>{log}</pre>
            </div>
          )}

          <HistorySection history={history} />
        </div>
      )}
    </li>
  );
}

function TaskGroup({ title, tasks, isAssigned }) {
  if (!tasks || tasks.length === 0) return null;
  return (
    <div style={{ marginBottom: '4px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '8px' }}>
        {title} <span style={{ fontWeight: 400 }}>({tasks.length})</span>
      </div>
      <ul className="list">
        {tasks.map(task => <TaskCard key={task.id?.id} task={task} isAssigned={isAssigned} />)}
      </ul>
    </div>
  );
}

function CategorySection({ name, category }) {
  const total = (category?.assigned?.length || 0) + (category?.unassigned?.length || 0);
  if (total === 0) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ fontSize: '1rem', fontWeight: 700, textTransform: 'capitalize' }}>{name}</span>
        <span className="chip">{total} task{total !== 1 ? 's' : ''}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <TaskGroup title="Assigned" tasks={category?.assigned} isAssigned={true} />
        <TaskGroup title="Unassigned" tasks={category?.unassigned} isAssigned={false} />
      </div>
    </div>
  );
}

const TaskDataRenderer = ({ data }) => {
  if (!data) return <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>No data.</div>;

  const total = Object.values(data).reduce((sum, cat) =>
    sum + (cat?.assigned?.length || 0) + (cat?.unassigned?.length || 0), 0);

  if (total === 0) return <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>No tasks found.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      {Object.keys(data).map(cat => (
        <CategorySection key={cat} name={cat} category={data[cat]} />
      ))}
    </div>
  );
};

export default TaskDataRenderer;
