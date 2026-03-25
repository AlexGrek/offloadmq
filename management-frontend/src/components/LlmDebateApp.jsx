import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, RotateCcw } from 'lucide-react';
import { stripCapabilityAttrs, extractSandboxModelText } from '../utils';
import SandboxMarkdown from './SandboxMarkdown';
import { useCapabilities } from '../hooks/useCapabilities';
import ModelSelector from './ModelSelector';
import { useTaskPolling } from '../hooks/useTaskPolling';

const LlmDebateApp = ({ apiKey, addDevEntry }) => {
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [systemA, setSystemA] = useState('You are a helpful AI assistant.');
  const [systemB, setSystemB] = useState('You are a helpful AI assistant.');
  const [initialPrompt, setInitialPrompt] = useState("Hello! Let's have a conversation.");

  const [messages, setMessages] = useState([]); // { side: 'A'|'B', content }
  const [isRunning, setIsRunning] = useState(false);
  const [currentTask, setCurrentTask] = useState(null);
  const [streamingLog, setStreamingLog] = useState('');
  const [pollingStatus, setPollingStatus] = useState('');
  const [error, setError] = useState(null);
  const [currentTurn, setCurrentTurn] = useState('A');

  // Refs to avoid stale closures in async callbacks
  const isRunningRef = useRef(false);
  const modelARef = useRef('');
  const modelBRef = useRef('');
  const systemARef = useRef('');
  const systemBRef = useRef('');
  const messagesRef = useRef([]);
  const currentTurnRef = useRef('A');
  const chatEndRef = useRef(null);

  useEffect(() => { modelARef.current = modelA; }, [modelA]);
  useEffect(() => { modelBRef.current = modelB; }, [modelB]);
  useEffect(() => { systemARef.current = systemA; }, [systemA]);
  useEffect(() => { systemBRef.current = systemB; }, [systemB]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const [capabilities] = useCapabilities('llm.', { setModel: setModelA });

  // Auto-set model B to first capability once loaded
  const modelBInitialized = useRef(false);
  useEffect(() => {
    if (capabilities.length > 0 && !modelBInitialized.current) {
      modelBInitialized.current = true;
      const base = stripCapabilityAttrs(capabilities[0]).replace(/^llm\./, '');
      setModelB(base);
    }
  }, [capabilities]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingLog]);

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

  const submitTurn = useCallback(async (side, userContent, msgsSnapshot) => {
    if (!isRunningRef.current) return;

    const model = side === 'A' ? modelARef.current : modelBRef.current;
    const system = side === 'A' ? systemARef.current : systemBRef.current;

    const ollamaMessages = [{ role: 'system', content: system }];
    for (const msg of msgsSnapshot) {
      ollamaMessages.push({
        role: msg.side === side ? 'assistant' : 'user',
        content: msg.content,
      });
    }
    ollamaMessages.push({ role: 'user', content: userContent });

    const payload = {
      capability: stripCapabilityAttrs(`llm.${model}`),
      urgent: false,
      payload: { model, messages: ollamaMessages, stream: true },
      apiKey,
    };

    try {
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      addDevEntry?.({ label: `Submit turn ${side}`, method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.id?.id && data.id?.cap) {
        currentTurnRef.current = side;
        setCurrentTurn(side);
        setCurrentTask({ id: data.id.id, capability: data.id.cap });
      } else {
        setError(data.error?.message || 'Unexpected submit response');
        setIsRunning(false);
        isRunningRef.current = false;
      }
    } catch (err) {
      setError(`Submit failed: ${err.message}`);
      setIsRunning(false);
      isRunningRef.current = false;
    }
  }, [apiKey, addDevEntry]);

  useTaskPolling({
    currentTask,
    apiKey,
    addDevEntry,
    onResult: (data) => {
      const content = extractContent(data.output);
      const side = currentTurnRef.current;
      const newMessages = [...messagesRef.current, { side, content }];
      setMessages(newMessages);
      messagesRef.current = newMessages;
      setStreamingLog('');
      setPollingStatus('');
      setCurrentTask(null);

      if (isRunningRef.current) {
        const nextSide = side === 'A' ? 'B' : 'A';
        submitTurn(nextSide, content, newMessages);
      }
    },
    onError: (msg) => {
      setError(msg);
      setStreamingLog('');
      setPollingStatus('');
      setCurrentTask(null);
      setIsRunning(false);
      isRunningRef.current = false;
    },
    onLog: setStreamingLog,
    onStatus: (status) => setPollingStatus(status),
  });

  const handleStart = async () => {
    if (!modelA || !modelB || !initialPrompt.trim()) return;
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    setStreamingLog('');
    setIsRunning(true);
    isRunningRef.current = true;
    await submitTurn('A', initialPrompt.trim(), []);
  };

  const handleStop = () => {
    setIsRunning(false);
    isRunningRef.current = false;
    setCurrentTask(null);
    setStreamingLog('');
    setPollingStatus('');
  };

  const handleReset = () => {
    handleStop();
    setMessages([]);
    messagesRef.current = [];
    setError(null);
  };

  const sideColor = { A: '#3b82f6', B: '#10b981' };
  const sideName = (side) => side === 'A' ? (modelA || 'Model A') : (modelB || 'Model B');
  const canStart = modelA && modelB && initialPrompt.trim();

  return (
    <div style={styles.root}>
      <style>{`@keyframes debate-breathe { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>

      {/* Config panel */}
      <div style={styles.configPanel}>
        {['A', 'B'].map((side) => (
          <div key={side} style={{ ...styles.agentConfig, borderColor: sideColor[side] + '60' }}>
            <div style={styles.agentHeader}>
              <div style={{ ...styles.sideTag, background: sideColor[side] }}>{side}</div>
              <div style={{ flex: 1 }}>
                <ModelSelector
                  model={side === 'A' ? modelA : modelB}
                  setModel={side === 'A' ? setModelA : setModelB}
                  capabilities={capabilities}
                />
              </div>
            </div>
            <textarea
              value={side === 'A' ? systemA : systemB}
              onChange={e => side === 'A' ? setSystemA(e.target.value) : setSystemB(e.target.value)}
              placeholder={`System prompt for ${side}`}
              style={styles.systemInput}
              rows={2}
              disabled={isRunning}
            />
          </div>
        ))}
      </div>

      {/* Initial prompt — only when idle and no messages yet */}
      {!isRunning && messages.length === 0 && (
        <div style={styles.initialRow}>
          <label style={styles.label}>Initial prompt:</label>
          <textarea
            value={initialPrompt}
            onChange={e => setInitialPrompt(e.target.value)}
            placeholder="First message sent to Model A to kick things off"
            style={{ ...styles.systemInput, flex: 1 }}
            rows={2}
          />
        </div>
      )}

      {/* Controls */}
      <div style={styles.controls}>
        {!isRunning ? (
          <button
            onClick={handleStart}
            disabled={!canStart}
            style={{ ...styles.btn, background: '#3b82f6', opacity: canStart ? 1 : 0.45 }}
          >
            <Play size={13} />
            Start
          </button>
        ) : (
          <button onClick={handleStop} style={{ ...styles.btn, background: '#ef4444' }}>
            <Square size={13} />
            Stop
          </button>
        )}
        {messages.length > 0 && !isRunning && (
          <button onClick={handleReset} style={styles.resetBtn}>
            <RotateCcw size={13} />
            Reset
          </button>
        )}
        {isRunning && (
          <span style={styles.statusText}>
            {pollingStatus ? `${sideName(currentTurn)}: ${pollingStatus}` : `Waiting for ${sideName(currentTurn)}…`}
          </span>
        )}
      </div>

      {/* Chat area */}
      <div style={styles.chatArea}>
        {messages.length === 0 && !isRunning && (
          <div style={styles.emptyState}>Configure both models and click Start</div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ ...styles.msgWrapper, justifyContent: msg.side === 'A' ? 'flex-start' : 'flex-end' }}>
            <div style={{ maxWidth: '76%' }}>
              <div style={{ ...styles.msgLabel, color: sideColor[msg.side] }}>
                {sideName(msg.side)}
              </div>
              <div style={{ ...styles.bubble, borderColor: sideColor[msg.side] + '50', background: msg.side === 'A' ? 'var(--chip-bg)' : 'rgba(16,185,129,0.07)' }}>
                <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{msg.content}</SandboxMarkdown>
              </div>
            </div>
          </div>
        ))}

        {isRunning && currentTask && (
          <div style={{ ...styles.msgWrapper, justifyContent: currentTurn === 'A' ? 'flex-start' : 'flex-end' }}>
            <div style={{ maxWidth: '76%' }}>
              <div style={{ ...styles.msgLabel, color: sideColor[currentTurn] }}>
                {sideName(currentTurn)}
              </div>
              <div style={{ ...styles.bubble, borderColor: sideColor[currentTurn] + '50', background: currentTurn === 'A' ? 'var(--chip-bg)' : 'rgba(16,185,129,0.07)' }}>
                {streamingLog
                  ? <SandboxMarkdown tone="light" style={{ fontSize: '13px', animation: 'debate-breathe 1.8s ease-in-out infinite' }}>{streamingLog}</SandboxMarkdown>
                  : <span style={styles.thinking}>Thinking…</span>
                }
              </div>
            </div>
          </div>
        )}

        {error && <div style={styles.errorMsg}>{error}</div>}
        <div ref={chatEndRef} />
      </div>
    </div>
  );
};

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '70vh',
    gap: '10px',
    fontFamily: 'system-ui, sans-serif',
    color: 'var(--text)',
  },
  configPanel: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
  },
  agentConfig: {
    background: 'var(--glass)',
    border: '1px solid',
    borderRadius: '8px',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  agentHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  sideTag: {
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
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
  initialRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
  },
  label: {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
    paddingTop: '7px',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  btn: {
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
  statusText: {
    fontSize: '12px',
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '4px 2px',
  },
  emptyState: {
    textAlign: 'center',
    color: 'var(--muted)',
    fontSize: '14px',
    marginTop: '40px',
  },
  msgWrapper: {
    display: 'flex',
  },
  msgLabel: {
    fontSize: '11px',
    fontWeight: 600,
    marginBottom: '3px',
    paddingLeft: '4px',
    letterSpacing: '0.2px',
  },
  bubble: {
    padding: '10px 14px',
    borderRadius: '10px',
    fontSize: '13px',
    lineHeight: 1.5,
    border: '1px solid',
  },
  thinking: {
    color: 'var(--muted)',
    fontStyle: 'italic',
    fontSize: '13px',
  },
  errorMsg: {
    alignSelf: 'center',
    color: 'var(--danger)',
    fontSize: '13px',
    padding: '8px 12px',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderRadius: '6px',
    border: '1px solid rgba(239, 68, 68, 0.3)',
  },
};

export default LlmDebateApp;
