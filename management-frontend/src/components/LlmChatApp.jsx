import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Send } from 'lucide-react';

const LlmChatApp = ({ apiKey }) => {
  const [messages, setMessages] = useState([]); // { role: 'user' | 'assistant', content }
  const [input, setInput] = useState('');
  const [model, setModel] = useState('dolphin-mistral');
  const [systemMessage, setSystemMessage] = useState('You are a helpful AI assistant.');
  const [capabilities, setCapabilities] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pollingStatus, setPollingStatus] = useState('');
  const [currentTask, setCurrentTask] = useState(null);
  const [streamingLog, setStreamingLog] = useState('');
  const chatEndRef = useRef(null);
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const fetchCapabilities = async () => {
      try {
        const res = await fetch('/api/capabilities/online', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        });
        const data = await res.json();
        if (Array.isArray(data)) {
          setCapabilities(data.filter(cap => cap.startsWith('llm.')));
        }
      } catch { /* ignore */ }
    };
    fetchCapabilities();
  }, [apiKey]);

  useEffect(() => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (!currentTask) return;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/task/poll/${encodeURIComponent(currentTask.capability)}/${currentTask.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey }),
          }
        );
        const data = await res.json();

        if (data.log) {
          setStreamingLog(data.log);
        }
        if (data.output) {
          const content = extractContent(data.output);
          setMessages(prev => [...prev, { role: 'assistant', content }]);
          setStreamingLog('');
          setIsLoading(false);
          setPollingStatus('');
          setCurrentTask(null);
        } else if (data.error) {
          setError(String(data.error.message || data.error));
          setStreamingLog('');
          setIsLoading(false);
          setPollingStatus('');
          setCurrentTask(null);
        } else {
          setPollingStatus('Status: ' + data.status);
        }
      } catch (err) {
        setError(`Polling failed: ${err.message}`);
        setIsLoading(false);
        setPollingStatus('');
        setCurrentTask(null);
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, 2000);
    return () => clearInterval(pollIntervalRef.current);
  }, [currentTask, apiKey]);

  const extractContent = (output) => {
    try {
      const parsed = typeof output === 'string' ? JSON.parse(output) : output;
      if (parsed?.message?.content) return parsed.message.content;
      if (parsed?.choices?.[0]?.message?.content) return parsed.choices[0].message.content;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return typeof output === 'string' ? output : JSON.stringify(output);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);
    setError(null);

    const payload = {
      capability: `llm.${model}`,
      urgent: false,
      payload: {
        model,
        messages: [{ role: 'system', content: systemMessage }, ...newMessages],
        stream: true,
      },
      apiKey,
    };

    try {
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (data.id?.id && data.id?.cap) {
        setCurrentTask({ id: data.id.id, capability: data.id.cap });
      } else if (data.error) {
        setError(data.error.message);
        setIsLoading(false);
      } else {
        setError('Unexpected response format.');
        setIsLoading(false);
      }
    } catch (err) {
      setError(`An error occurred: ${err.message}`);
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setMessages([]);
    setError(null);
    setCurrentTask(null);
    setIsLoading(false);
    setPollingStatus('');
    setStreamingLog('');
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  };

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div style={styles.modelRow}>
          <label style={styles.label}>Model:</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            style={styles.modelInput}
          />
          <button onClick={handleClear} style={styles.clearBtn} title="Clear conversation">
            <Trash2 size={16} />
          </button>
        </div>
        <div style={styles.capRow}>
          {capabilities.map(cap => {
            const strip = cap.replace('llm.', '');
            return (
              <a
                key={cap}
                style={styles.capLink}
                href="#"
                onClick={e => { e.preventDefault(); setModel(strip); }}
              >
                {strip}
              </a>
            );
          })}
        </div>
        <div style={styles.systemRow}>
          <label style={styles.label}>System:</label>
          <textarea
            value={systemMessage}
            onChange={e => setSystemMessage(e.target.value)}
            style={styles.systemInput}
            rows={3}
          />
        </div>
      </div>

      <div style={styles.chatArea}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>Start a conversation</div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{ ...styles.bubble, ...(msg.role === 'user' ? styles.userBubble : styles.assistantBubble) }}
          >
            <div style={styles.bubbleText}>{msg.content}</div>
          </div>
        ))}
        {isLoading && (
          <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
            {streamingLog
              ? <div style={styles.bubbleText}>{streamingLog}</div>
              : <div style={styles.typing}>{pollingStatus || 'Thinking…'}</div>
            }
          </div>
        )}
        {error && <div style={styles.errorMsg}>{error}</div>}
        <div ref={chatEndRef} />
      </div>

      <div style={styles.inputRow}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          style={styles.textarea}
          rows={2}
          disabled={isLoading}
        />
        <button
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
          style={{ ...styles.sendBtn, opacity: isLoading || !input.trim() ? 0.5 : 1 }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
};

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '65vh',
    fontFamily: 'system-ui, sans-serif',
    color: 'var(--text)',
  },
  header: {
    paddingBottom: '12px',
    borderBottom: '1px solid var(--border)',
    marginBottom: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  systemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  capRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  capLink: {
    fontSize: '11px',
    color: 'var(--muted)',
    textDecoration: 'none',
    padding: '1px 6px',
    border: '1px solid var(--border)',
    borderRadius: '10px',
  },
  label: {
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--text)',
    whiteSpace: 'nowrap',
  },
  modelInput: {
    flex: 1,
    padding: '5px 10px',
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    outline: 'none',
    background: 'var(--input-bg)',
    color: 'var(--text)',
  },
  systemInput: {
    flex: 1,
    padding: '5px 10px',
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    outline: 'none',
    color: 'var(--muted)',
    background: 'var(--input-bg)',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: '1.5',
  },
  clearBtn: {
    padding: '5px 8px',
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'var(--muted)',
    display: 'flex',
    alignItems: 'center',
  },
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '4px 2px',
  },
  emptyState: {
    textAlign: 'center',
    color: 'var(--muted)',
    fontSize: '14px',
    marginTop: '40px',
  },
  bubble: {
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: '12px',
    fontSize: '14px',
    lineHeight: '1.5',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: 'var(--primary)',
    color: '#fff',
    borderBottomRightRadius: '4px',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: 'var(--chip-bg)',
    color: 'var(--text)',
    borderBottomLeftRadius: '4px',
  },
  bubbleText: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  typing: {
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
  inputRow: {
    display: 'flex',
    gap: '8px',
    paddingTop: '8px',
    borderTop: '1px solid var(--border)',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    outline: 'none',
    resize: 'none',
    fontFamily: 'inherit',
    lineHeight: '1.5',
    background: 'var(--input-bg)',
    color: 'var(--text)',
  },
  sendBtn: {
    padding: '8px 12px',
    backgroundColor: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

export default LlmChatApp;
