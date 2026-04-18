import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, RotateCcw, Gavel } from 'lucide-react';
import { cancelTask } from '../sandboxUtils';
import { stripCapabilityAttrs, extractSandboxModelText } from '../utils';
import SandboxMarkdown from './SandboxMarkdown';
import { useCapabilities } from '../hooks/useCapabilities';
import ModelSelector from './ModelSelector';
import { useTaskPolling } from '../hooks/useTaskPolling';
import SpeechWidget from './SpeechWidget';

const DEFAULT_REFEREE_SYSTEM = `You are an impartial debate referee. You will be given a transcript of a debate between two participants labeled "Model A" and "Model B". Analyze the quality of their arguments, reasoning, and overall performance. Declare a winner with a brief justification.`;
const DEFAULT_REFEREE_COMMAND = `The debate has concluded. Review the full transcript above and declare a winner. Be concise: state who won (Model A or Model B, or a draw) and why in 2–3 sentences.`;

const LlmDebateApp = ({ apiKey, addDevEntry }) => {
  // Debaters
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [systemA, setSystemA] = useState('You are a helpful AI assistant.');
  const [systemB, setSystemB] = useState('You are a helpful AI assistant.');
  const [initialPrompt, setInitialPrompt] = useState("Hello! Let's have a conversation.");

  // Referee
  const [refereeEnabled, setRefereeEnabled] = useState(false);
  const [modelRef, setModelRef] = useState('');
  const [systemRef, setSystemRef] = useState(DEFAULT_REFEREE_SYSTEM);
  const [commandRef, setCommandRef] = useState(DEFAULT_REFEREE_COMMAND);
  const [refereeTurns, setRefereeTurns] = useState(6);

  // Runtime state
  const [messages, setMessages] = useState([]); // { side: 'A'|'B'|'REF', content }
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState('debate'); // 'debate' | 'referee' | 'done'
  const [currentTask, setCurrentTask] = useState(null);
  const [streamingLog, setStreamingLog] = useState('');
  const [pollingStatus, setPollingStatus] = useState('');
  const [error, setError] = useState(null);
  const [currentTurn, setCurrentTurn] = useState('A'); // 'A' | 'B' | 'REF'

  // Refs to avoid stale closures
  const isRunningRef = useRef(false);
  const modelARef = useRef('');
  const modelBRef = useRef('');
  const systemARef = useRef('');
  const systemBRef = useRef('');
  const modelRefRef = useRef('');
  const systemRefRef = useRef('');
  const commandRefRef = useRef('');
  const refereeTurnsRef = useRef(6);
  const refereeEnabledRef = useRef(false);
  const messagesRef = useRef([]);
  const currentTurnRef = useRef('A');
  const phaseRef = useRef('debate');
  const chatEndRef = useRef(null);

  useEffect(() => { modelARef.current = modelA; }, [modelA]);
  useEffect(() => { modelBRef.current = modelB; }, [modelB]);
  useEffect(() => { systemARef.current = systemA; }, [systemA]);
  useEffect(() => { systemBRef.current = systemB; }, [systemB]);
  useEffect(() => { modelRefRef.current = modelRef; }, [modelRef]);
  useEffect(() => { systemRefRef.current = systemRef; }, [systemRef]);
  useEffect(() => { commandRefRef.current = commandRef; }, [commandRef]);
  useEffect(() => { refereeTurnsRef.current = refereeTurns; }, [refereeTurns]);
  useEffect(() => { refereeEnabledRef.current = refereeEnabled; }, [refereeEnabled]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const [capabilities] = useCapabilities('llm.', { setModel: setModelA });

  const modelBInitialized = useRef(false);
  useEffect(() => {
    if (capabilities.length > 0 && !modelBInitialized.current) {
      modelBInitialized.current = true;
      const base = stripCapabilityAttrs(capabilities[0]).replace(/^llm\./, '');
      setModelB(base);
      setModelRef(base);
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

  // Submit a turn for debater A or B
  const submitDebateTurn = useCallback(async (side, userContent, msgsSnapshot) => {
    if (!isRunningRef.current) return;

    const model = side === 'A' ? modelARef.current : modelBRef.current;
    const system = side === 'A' ? systemARef.current : systemBRef.current;

    const ollamaMessages = [{ role: 'system', content: system }];
    for (const msg of msgsSnapshot) {
      if (msg.side === 'REF') continue; // exclude referee from debate context
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

  // Submit the referee turn using the full debate transcript
  const submitRefereeTurn = useCallback(async (msgsSnapshot) => {
    const model = modelRefRef.current;
    const system = systemRefRef.current;
    const command = commandRefRef.current;

    // Build transcript
    const transcript = msgsSnapshot
      .filter(m => m.side !== 'REF')
      .map(m => `Model ${m.side}: ${m.content}`)
      .join('\n\n');

    const ollamaMessages = [
      { role: 'system', content: system },
      { role: 'user', content: `Here is the debate transcript:\n\n${transcript}\n\n${command}` },
    ];

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
      addDevEntry?.({ label: 'Submit referee', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.id?.id && data.id?.cap) {
        currentTurnRef.current = 'REF';
        setCurrentTurn('REF');
        setCurrentTask({ id: data.id.id, capability: data.id.cap });
      } else {
        setError(data.error?.message || 'Unexpected referee submit response');
        setIsRunning(false);
        isRunningRef.current = false;
        phaseRef.current = 'done';
        setPhase('done');
      }
    } catch (err) {
      setError(`Referee submit failed: ${err.message}`);
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

      if (!isRunningRef.current) return;

      if (side === 'REF') {
        // Referee has spoken — done
        setIsRunning(false);
        isRunningRef.current = false;
        phaseRef.current = 'done';
        setPhase('done');
        return;
      }

      // Count debate messages (excluding REF)
      const debateMsgs = newMessages.filter(m => m.side !== 'REF');
      const shouldCallReferee =
        refereeEnabledRef.current &&
        modelRefRef.current &&
        debateMsgs.length >= refereeTurnsRef.current;

      if (shouldCallReferee) {
        phaseRef.current = 'referee';
        setPhase('referee');
        submitRefereeTurn(newMessages);
      } else {
        const nextSide = side === 'A' ? 'B' : 'A';
        submitDebateTurn(nextSide, content, newMessages);
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
    phaseRef.current = 'debate';
    setPhase('debate');
    setIsRunning(true);
    isRunningRef.current = true;
    await submitDebateTurn('A', initialPrompt.trim(), []);
  };

  const handleStop = () => {
    const task = currentTask;
    setIsRunning(false);
    isRunningRef.current = false;
    setCurrentTask(null);
    setStreamingLog('');
    setPollingStatus('');
    if (task) cancelTask(task.capability, task.id, apiKey, addDevEntry);
  };

  const handleReset = () => {
    handleStop();
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    phaseRef.current = 'debate';
    setPhase('debate');
  };

  const sideColor = { A: '#3b82f6', B: '#10b981', REF: '#a855f7' };
  const sideName = (side) => {
    if (side === 'A') return modelA || 'Model A';
    if (side === 'B') return modelB || 'Model B';
    return modelRef || 'Referee';
  };
  const canStart = modelA && modelB && initialPrompt.trim() && (!refereeEnabled || modelRef);

  const debateCount = messages.filter(m => m.side !== 'REF').length;

  return (
    <div style={styles.root}>
      <style>{`@keyframes debate-breathe { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>

      {/* Debater config */}
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

      {/* Referee config */}
      <div style={{ ...styles.agentConfig, borderColor: refereeEnabled ? sideColor.REF + '60' : 'var(--border)', opacity: 1 }}>
        <div style={styles.agentHeader}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={refereeEnabled}
              onChange={e => setRefereeEnabled(e.target.checked)}
              disabled={isRunning}
              style={{ accentColor: sideColor.REF, width: '14px', height: '14px' }}
            />
            <div style={{ ...styles.sideTag, background: refereeEnabled ? sideColor.REF : '#9ca3af', flexShrink: 0 }}>
              <Gavel size={11} />
            </div>
            <span style={{ fontSize: '12px', fontWeight: 600, color: refereeEnabled ? sideColor.REF : 'var(--muted)' }}>
              Referee
            </span>
          </label>
          <div style={{ flex: 1, opacity: refereeEnabled ? 1 : 0.4, pointerEvents: refereeEnabled ? 'auto' : 'none' }}>
            <ModelSelector model={modelRef} setModel={setModelRef} capabilities={capabilities} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--muted)', opacity: refereeEnabled ? 1 : 0.4, whiteSpace: 'nowrap' }}>
            after
            <input
              type="number"
              min={2}
              max={100}
              value={refereeTurns}
              onChange={e => setRefereeTurns(Math.max(2, parseInt(e.target.value) || 2))}
              disabled={isRunning || !refereeEnabled}
              style={{ ...styles.systemInput, width: '52px', padding: '3px 6px', resize: 'none' }}
            />
            turns
          </label>
        </div>
        {refereeEnabled && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <textarea
              value={systemRef}
              onChange={e => setSystemRef(e.target.value)}
              placeholder="Referee system prompt"
              style={{ ...styles.systemInput, flex: 1 }}
              rows={2}
              disabled={isRunning}
            />
            <textarea
              value={commandRef}
              onChange={e => setCommandRef(e.target.value)}
              placeholder="Command sent to referee after debate ends"
              style={{ ...styles.systemInput, flex: 1 }}
              rows={2}
              disabled={isRunning}
            />
          </div>
        )}
      </div>

      {/* Initial prompt */}
      {!isRunning && messages.length === 0 && (
        <div style={styles.initialRow}>
          <label style={styles.label}>Initial prompt:</label>
          <textarea
            value={initialPrompt}
            onChange={e => setInitialPrompt(e.target.value)}
            placeholder="First message sent to Model A"
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
            {phase === 'referee'
              ? `Referee deliberating…${pollingStatus ? ` (${pollingStatus})` : ''}`
              : pollingStatus
                ? `${sideName(currentTurn)}: ${pollingStatus}`
                : `Waiting for ${sideName(currentTurn)}… (turn ${debateCount + 1}${refereeEnabled ? `/${refereeTurns}` : ''})`
            }
          </span>
        )}
        {phase === 'done' && !isRunning && messages.length > 0 && (
          <span style={{ fontSize: '12px', color: sideColor.REF, fontWeight: 600 }}>
            ⚖ Debate concluded
          </span>
        )}
      </div>

      {/* Chat area */}
      <div style={styles.chatArea}>
        {messages.length === 0 && !isRunning && (
          <div style={styles.emptyState}>Configure models and click Start</div>
        )}

        {messages.map((msg, i) => {
          const isRef = msg.side === 'REF';
          return isRef ? (
            // Referee verdict — centered full-width card
            <div key={i} style={styles.refCard}>
              <div style={styles.refHeader}>
                <Gavel size={13} color={sideColor.REF} />
                <span style={{ color: sideColor.REF, fontWeight: 700, fontSize: '12px' }}>
                  {sideName('REF')} — Verdict
                </span>
                <div style={{ marginLeft: 'auto' }}>
                  <SpeechWidget text={msg.content} apiKey={apiKey} addDevEntry={addDevEntry} />
                </div>
              </div>
              <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{msg.content}</SandboxMarkdown>
            </div>
          ) : (
            <div key={i} style={{ ...styles.msgWrapper, justifyContent: msg.side === 'A' ? 'flex-start' : 'flex-end' }}>
              <div style={{ maxWidth: '76%' }}>
                <div style={{ ...styles.msgLabel, color: sideColor[msg.side], display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                  <span>{sideName(msg.side)}</span>
                  <SpeechWidget text={msg.content} apiKey={apiKey} addDevEntry={addDevEntry} />
                </div>
                <div style={{ ...styles.bubble, borderColor: sideColor[msg.side] + '50', background: msg.side === 'A' ? 'var(--chip-bg)' : 'rgba(16,185,129,0.07)' }}>
                  <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{msg.content}</SandboxMarkdown>
                </div>
              </div>
            </div>
          );
        })}

        {/* In-flight bubble */}
        {isRunning && currentTask && (
          <div style={
            currentTurn === 'REF'
              ? { display: 'contents' }
              : { ...styles.msgWrapper, justifyContent: currentTurn === 'A' ? 'flex-start' : 'flex-end' }
          }>
            {currentTurn === 'REF' ? (
              <div style={{ ...styles.refCard, opacity: 0.8, animation: 'debate-breathe 1.8s ease-in-out infinite' }}>
                <div style={styles.refHeader}>
                  <Gavel size={13} color={sideColor.REF} />
                  <span style={{ color: sideColor.REF, fontWeight: 700, fontSize: '12px' }}>
                    {sideName('REF')} — deliberating…
                  </span>
                </div>
                {streamingLog
                  ? <SandboxMarkdown tone="light" style={{ fontSize: '13px' }}>{streamingLog}</SandboxMarkdown>
                  : <span style={styles.thinking}>Analyzing transcript…</span>
                }
              </div>
            ) : (
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
            )}
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
    height: '72vh',
    gap: '8px',
    fontFamily: 'var(--font-sans)',
    color: 'var(--text)',
  },
  configPanel: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px',
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
  refCard: {
    background: 'rgba(168,85,247,0.06)',
    border: '1px solid rgba(168,85,247,0.35)',
    borderRadius: '10px',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  refHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
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
