import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, RotateCcw, Copy, Check, Clock, Zap, Plus, Minus,
  ChevronDown, ChevronUp, Loader, CircleX, CheckCircle2, AlertCircle,
  Columns2, Rows2, ArrowDownWideNarrow, Timer, Sparkles, Send,
} from 'lucide-react';
import { cancelTask } from '../sandboxUtils';
import { stripCapabilityAttrs, extractSandboxModelText } from '../utils';
import SandboxMarkdown from './SandboxMarkdown';
import { useCapabilities } from '../hooks/useCapabilities';
import ModelSelector from './ModelSelector';
import CircularProgress from './CircularProgress';

/* ── helpers ─────────────────────────────────────────────── */

const extractContent = (output) => {
  const t = extractSandboxModelText(output);
  if (t != null) return t;
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return typeof output === 'string' ? output : JSON.stringify(output);
  }
};

const fmtMs = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/* ── component ───────────────────────────────────────────── */

const LlmCompareApp = ({ apiKey, addDevEntry }) => {
  // Model slots
  const [slots, setSlots] = useState([{ model: '' }, { model: '' }]);
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful AI assistant.');
  const [userPrompt, setUserPrompt] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [layout, setLayout] = useState('columns'); // 'columns' | 'rows'

  // Per-slot runtime state: { status, task, content, log, error, startTime, endTime, copiedTimeout }
  const [results, setResults] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  const resultsRef = useRef([]);
  const isRunningRef = useRef(false);
  const pollIntervalsRef = useRef([]);
  const chatEndRef = useRef(null);

  const [capabilities] = useCapabilities('llm.', { setError: () => {} });

  // Auto-select first model for first slot
  const initDone = useRef(false);
  useEffect(() => {
    if (capabilities.length > 0 && !initDone.current) {
      initDone.current = true;
      const base = stripCapabilityAttrs(capabilities[0]).replace(/^llm\./, '');
      setSlots((prev) => {
        const next = [...prev];
        if (!next[0].model) next[0] = { model: base };
        if (capabilities.length > 1 && !next[1].model) {
          const base2 = stripCapabilityAttrs(capabilities[1]).replace(/^llm\./, '');
          next[1] = { model: base2 };
        } else if (!next[1].model) {
          next[1] = { model: base };
        }
        return next;
      });
    }
  }, [capabilities]);

  const addSlot = () => {
    if (slots.length >= 6) return;
    const base = capabilities.length > 0
      ? stripCapabilityAttrs(capabilities[0]).replace(/^llm\./, '')
      : '';
    setSlots((prev) => [...prev, { model: base }]);
  };

  const removeSlot = (idx) => {
    if (slots.length <= 2) return;
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  const setSlotModel = (idx, model) => {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, model } : s)));
  };

  /* ── polling logic (manual, per-slot) ────────────────── */

  const updateResult = useCallback((idx, patch) => {
    setResults((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      resultsRef.current = next;
      return next;
    });
  }, []);

  const pollTask = useCallback(async (idx, task) => {
    try {
      const url = `/api/task/poll/${task.capability}/${task.id}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      addDevEntry?.({
        key: `poll-${idx}-${Date.now()}`,
        label: `Poll slot ${idx + 1}`,
        method: 'POST',
        url,
        request: { apiKey },
        response: data,
      });

      if (data.output) {
        const content = extractContent(data.output);
        updateResult(idx, {
          status: 'done',
          content,
          log: '',
          endTime: Date.now(),
        });
        return 'done';
      }
      if (data.error) {
        updateResult(idx, {
          status: 'error',
          error: typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error),
          endTime: Date.now(),
        });
        return 'done';
      }
      if (data.log) {
        updateResult(idx, { log: data.log });
      }
      if (data.status) {
        updateResult(idx, { pollingStatus: data.status });
      }
      const hPatch = {};
      if (data.createdAt) hPatch.createdAt = data.createdAt;
      if (data.typicalRuntimeSeconds?.secs != null) hPatch.typicalRuntimeSeconds = data.typicalRuntimeSeconds.secs;
      if (Object.keys(hPatch).length) updateResult(idx, hPatch);
      return 'polling';
    } catch (err) {
      updateResult(idx, {
        status: 'error',
        error: `Poll failed: ${err.message}`,
        endTime: Date.now(),
      });
      return 'done';
    }
  }, [apiKey, addDevEntry, updateResult]);

  const startPolling = useCallback((idx, task) => {
    const id = setInterval(async () => {
      const result = await pollTask(idx, task);
      if (result === 'done') {
        clearInterval(id);
        pollIntervalsRef.current[idx] = null;
        // Check if all done
        const allDone = resultsRef.current.every(
          (r) => r.status === 'done' || r.status === 'error' || r.status === 'cancelled'
        );
        if (allDone) {
          setIsRunning(false);
          isRunningRef.current = false;
        }
      }
    }, 2000);
    pollIntervalsRef.current[idx] = id;
  }, [pollTask]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pollIntervalsRef.current.forEach((id) => id && clearInterval(id));
    };
  }, []);

  /* ── submit ──────────────────────────────────────────── */

  const handleSubmit = async () => {
    if (!userPrompt.trim() || slots.every((s) => !s.model)) return;

    setIsRunning(true);
    isRunningRef.current = true;

    const initResults = slots.map(() => ({
      status: 'submitting',
      task: null,
      content: null,
      log: '',
      error: null,
      startTime: Date.now(),
      endTime: null,
      copiedTimeout: null,
      pollingStatus: '',
      createdAt: null,
      typicalRuntimeSeconds: null,
    }));
    setResults(initResults);
    resultsRef.current = initResults;
    pollIntervalsRef.current = slots.map(() => null);

    const messages = [];
    if (systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: userPrompt.trim() });

    await Promise.all(
      slots.map(async (slot, idx) => {
        if (!slot.model) {
          updateResult(idx, { status: 'error', error: 'No model selected', endTime: Date.now() });
          return;
        }

        const payload = {
          capability: stripCapabilityAttrs(`llm.${slot.model}`),
          urgent: false,
          payload: { model: slot.model, messages, stream: true },
          apiKey,
        };

        try {
          const res = await fetch('/api/task/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          addDevEntry?.({
            label: `Submit slot ${idx + 1}`,
            method: 'POST',
            url: '/api/task/submit',
            request: payload,
            response: data,
          });

          if (data.id?.id && data.id?.cap) {
            const task = { id: data.id.id, capability: data.id.cap };
            updateResult(idx, { status: 'polling', task });
            startPolling(idx, task);
          } else {
            updateResult(idx, {
              status: 'error',
              error: data.error?.message || 'Unexpected response',
              endTime: Date.now(),
            });
          }
        } catch (err) {
          updateResult(idx, {
            status: 'error',
            error: `Submit failed: ${err.message}`,
            endTime: Date.now(),
          });
        }
      })
    );

    // Check if all already failed
    const allDone = resultsRef.current.every(
      (r) => r.status === 'done' || r.status === 'error' || r.status === 'cancelled'
    );
    if (allDone) {
      setIsRunning(false);
      isRunningRef.current = false;
    }
  };

  /* ── cancel ──────────────────────────────────────────── */

  const cancelSlot = (idx) => {
    const r = results[idx];
    if (pollIntervalsRef.current[idx]) {
      clearInterval(pollIntervalsRef.current[idx]);
      pollIntervalsRef.current[idx] = null;
    }
    if (r?.task) {
      cancelTask(r.task.capability, r.task.id, apiKey, addDevEntry);
    }
    updateResult(idx, { status: 'cancelled', endTime: Date.now(), log: '' });

    // Check if all done now
    setTimeout(() => {
      const allDone = resultsRef.current.every(
        (r) => r.status === 'done' || r.status === 'error' || r.status === 'cancelled'
      );
      if (allDone) {
        setIsRunning(false);
        isRunningRef.current = false;
      }
    }, 0);
  };

  const cancelAll = () => {
    results.forEach((r, idx) => {
      if (r?.status === 'polling' || r?.status === 'submitting') {
        cancelSlot(idx);
      }
    });
  };

  const handleReset = () => {
    cancelAll();
    setResults([]);
    resultsRef.current = [];
    setIsRunning(false);
    isRunningRef.current = false;
  };

  /* ── copy ────────────────────────────────────────────── */

  const copyContent = (idx) => {
    const r = results[idx];
    if (!r?.content) return;
    navigator.clipboard.writeText(r.content);
    updateResult(idx, { copiedTimeout: true });
    setTimeout(() => updateResult(idx, { copiedTimeout: false }), 2000);
  };

  /* ── status helpers ──────────────────────────────────── */

  const statusIcon = (status) => {
    switch (status) {
      case 'submitting':
      case 'polling':
        return <Loader size={13} style={{ animation: 'compare-spin 1s linear infinite' }} />;
      case 'done':
        return <CheckCircle2 size={13} color="#22c55e" />;
      case 'error':
        return <AlertCircle size={13} color="#ef4444" />;
      case 'cancelled':
        return <CircleX size={13} color="#9ca3af" />;
      default:
        return null;
    }
  };

  const statusColor = (status) => {
    switch (status) {
      case 'done': return '#22c55e';
      case 'error': return '#ef4444';
      case 'cancelled': return '#9ca3af';
      default: return 'var(--muted)';
    }
  };

  const canSubmit = userPrompt.trim() && slots.some((s) => s.model) && !isRunning;
  const hasResults = results.length > 0;

  const slotColors = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4'];

  return (
    <div style={styles.root}>
      <style>{`
        @keyframes compare-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes compare-breathe { 0%,100%{opacity:1} 50%{opacity:0.45} }
      `}</style>

      {/* ── Model Slots ──────────────────────────────────── */}
      <div style={styles.slotsHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Columns2 size={14} color="var(--muted)" />
          <span style={styles.sectionLabel}>Models</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            onClick={() => setLayout(layout === 'columns' ? 'rows' : 'columns')}
            style={styles.iconBtn}
            title={layout === 'columns' ? 'Switch to rows' : 'Switch to columns'}
          >
            {layout === 'columns' ? <Rows2 size={14} /> : <Columns2 size={14} />}
          </button>
          <button
            onClick={addSlot}
            disabled={slots.length >= 6 || isRunning}
            style={{ ...styles.iconBtn, opacity: slots.length >= 6 || isRunning ? 0.3 : 1 }}
            title="Add model"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div style={styles.slotsGrid}>
        {slots.map((slot, idx) => (
          <div key={idx} style={{ ...styles.slotCard, borderColor: slotColors[idx] + '50' }}>
            <div style={styles.slotHeader}>
              <div style={{ ...styles.slotBadge, background: slotColors[idx] }}>{idx + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ModelSelector
                  model={slot.model}
                  setModel={(m) => setSlotModel(idx, m)}
                  capabilities={capabilities}
                />
              </div>
              {slots.length > 2 && !isRunning && (
                <button onClick={() => removeSlot(idx)} style={styles.removeBtn} title="Remove">
                  <Minus size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Prompt ───────────────────────────────────────── */}
      <div style={styles.promptSection}>
        <button
          onClick={() => setShowSystem(!showSystem)}
          style={styles.systemToggle}
        >
          <Sparkles size={12} />
          System prompt
          {showSystem ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {showSystem && (
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="System prompt (shared across all models)"
            style={styles.systemInput}
            rows={2}
            disabled={isRunning}
          />
        )}
        <div style={styles.promptRow}>
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="Enter your prompt — it will be sent to all selected models simultaneously"
            style={{ ...styles.promptInput, flex: 1 }}
            rows={3}
            disabled={isRunning}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>
      </div>

      {/* ── Controls ─────────────────────────────────────── */}
      <div style={styles.controls}>
        {!isRunning ? (
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{ ...styles.actionBtn, background: '#3b82f6', opacity: canSubmit ? 1 : 0.45 }}
          >
            <Send size={13} />
            Compare
          </button>
        ) : (
          <button onClick={cancelAll} style={{ ...styles.actionBtn, background: '#ef4444' }}>
            <Square size={13} />
            Cancel All
          </button>
        )}
        {hasResults && !isRunning && (
          <button onClick={handleReset} style={styles.resetBtn}>
            <RotateCcw size={13} />
            Reset
          </button>
        )}
        {isRunning && (
          <span style={styles.statusText}>
            <Zap size={12} />
            {results.filter((r) => r.status === 'polling' || r.status === 'submitting').length} running
            {results.filter((r) => r.status === 'done').length > 0 &&
              ` · ${results.filter((r) => r.status === 'done').length} done`}
          </span>
        )}
      </div>

      {/* ── Results ──────────────────────────────────────── */}
      {hasResults && (
        <div
          style={{
            ...(layout === 'columns' ? styles.resultsColumns : styles.resultsRows),
            gridTemplateColumns: layout === 'columns' ? `repeat(${slots.length}, 1fr)` : undefined,
          }}
          ref={chatEndRef}
        >
          {results.map((r, idx) => {
            if (!r) return null;
            const elapsed = r.endTime
              ? fmtMs(r.endTime - r.startTime)
              : r.startTime
                ? fmtMs(Date.now() - r.startTime)
                : null;

            return (
              <div key={idx} style={{ ...styles.resultCard, borderColor: slotColors[idx] + '40' }}>
                {/* Result header */}
                <div style={styles.resultHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <div style={{ ...styles.slotBadge, background: slotColors[idx], width: '18px', height: '18px', fontSize: '10px' }}>
                      {idx + 1}
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: slotColors[idx], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {slots[idx]?.model || `Slot ${idx + 1}`}
                    </span>
                    {statusIcon(r.status)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {elapsed && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px', color: statusColor(r.status) }}>
                        <Timer size={10} />
                        {elapsed}
                      </span>
                    )}
                    {r.content && (
                      <button onClick={() => copyContent(idx)} style={styles.iconBtn} title="Copy response">
                        {r.copiedTimeout ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
                      </button>
                    )}
                    {(r.status === 'polling' || r.status === 'submitting') && (
                      <button onClick={() => cancelSlot(idx)} style={{ ...styles.iconBtn, color: '#ef4444' }} title="Cancel">
                        <CircleX size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Result body */}
                <div style={styles.resultBody}>
                  {r.status === 'submitting' && (
                    <span style={styles.thinking}>
                      <Loader size={12} style={{ animation: 'compare-spin 1s linear infinite' }} />
                      Submitting…
                    </span>
                  )}

                  {r.status === 'polling' && !r.log && !r.content && (
                    <span style={{ ...styles.thinking, alignItems: 'center', gap: '8px' }}>
                      <CircularProgress
                        typicalRuntimeSeconds={r.typicalRuntimeSeconds}
                        createdAt={r.createdAt}
                        size={28}
                        strokeWidth={3}
                        color={slotColors[idx]}
                      />
                      {r.pollingStatus ? `Status: ${r.pollingStatus}` : 'Waiting for response…'}
                    </span>
                  )}

                  {r.log && r.status === 'polling' && (
                    <div style={{ animation: 'compare-breathe 1.8s ease-in-out infinite' }}>
                      <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{r.log}</SandboxMarkdown>
                    </div>
                  )}

                  {r.content && (
                    <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{r.content}</SandboxMarkdown>
                  )}

                  {r.status === 'error' && (
                    <div style={styles.errorBox}>
                      <AlertCircle size={13} />
                      <span>{r.error}</span>
                    </div>
                  )}

                  {r.status === 'cancelled' && !r.content && (
                    <span style={{ ...styles.thinking, color: '#9ca3af' }}>
                      <CircleX size={12} />
                      Cancelled
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────── */}
      {!hasResults && (
        <div style={styles.emptyState}>
          <ArrowDownWideNarrow size={24} color="var(--muted)" style={{ opacity: 0.5 }} />
          <span>Select models, enter a prompt, and click Compare</span>
        </div>
      )}
    </div>
  );
};

/* ── styles ────────────────────────────────────────────── */

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '72vh',
    gap: '8px',
    fontFamily: 'var(--font-sans)',
    color: 'var(--text)',
  },
  slotsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  slotsGrid: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  },
  slotCard: {
    flex: '1 1 140px',
    minWidth: '140px',
    background: 'var(--glass)',
    border: '1px solid',
    borderRadius: '8px',
    padding: '8px',
  },
  slotHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  slotBadge: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
  },
  removeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'none',
    cursor: 'pointer',
    color: 'var(--muted)',
    flexShrink: 0,
  },
  promptSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  systemToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    color: 'var(--muted)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  systemInput: {
    width: '100%',
    padding: '6px 8px',
    fontSize: '12px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    boxSizing: 'border-box',
  },
  promptRow: {
    display: 'flex',
    gap: '8px',
  },
  promptInput: {
    width: '100%',
    padding: '8px 10px',
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    boxSizing: 'border-box',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '7px 14px',
    fontSize: '13px',
    fontWeight: 500,
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    color: '#fff',
  },
  resetBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '7px 12px',
    fontSize: '13px',
    fontWeight: 500,
    borderRadius: '6px',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    background: 'none',
    color: 'var(--muted)',
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px',
    borderRadius: '4px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    color: 'var(--muted)',
  },
  statusText: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  resultsColumns: {
    display: 'grid',
    gap: '8px',
    flex: 1,
    overflowY: 'auto',
    alignItems: 'start',
    alignContent: 'start',
  },
  resultsRows: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1,
    overflowY: 'auto',
  },
  resultCard: {
    background: 'var(--glass)',
    border: '1px solid',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  resultHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
    gap: '8px',
  },
  resultBody: {
    padding: '10px 12px',
    fontSize: '13px',
    lineHeight: 1.6,
    overflowY: 'auto',
    maxHeight: '50vh',
  },
  thinking: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'var(--muted)',
    fontStyle: 'italic',
    fontSize: '13px',
  },
  errorBox: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    color: '#ef4444',
    fontSize: '13px',
    padding: '8px',
    background: 'rgba(239,68,68,0.06)',
    borderRadius: '6px',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: 'var(--muted)',
    fontSize: '14px',
  },
};

export default LlmCompareApp;
