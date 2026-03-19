import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Send, ImagePlus, X } from 'lucide-react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';
import ModelSelector from './ModelSelector';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const LlmChatApp = ({ apiKey, addDevEntry }) => {
  const [messages, setMessages] = useState([]); // { role, content, images?, imageMimes? }
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [systemMessage, setSystemMessage] = useState('You are a helpful AI assistant.');
  const [capabilities, setCapabilities] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pollingStatus, setPollingStatus] = useState('');
  const [currentTask, setCurrentTask] = useState(null);
  const [streamingLog, setStreamingLog] = useState('');
  const [pendingImages, setPendingImages] = useState([]); // [{ name, mime, b64, previewUrl }]
  const chatEndRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const fetchCapabilities = async () => {
      try {
        const data = await fetchOnlineCapabilities();
        if (Array.isArray(data)) {
          const llmCaps = data.filter(cap => stripCapabilityAttrs(cap).startsWith('llm.'));
          setCapabilities(llmCaps);
          if (llmCaps.length > 0) {
            setModel(prev => prev || stripCapabilityAttrs(llmCaps[0]).replace(/^llm\./, ''));
          }
        }
      } catch { /* ignore */ }
    };
    fetchCapabilities();
  }, []);

  // Revoke all pending preview object URLs on unmount
  useEffect(() => {
    return () => {
      setPendingImages(prev => {
        prev.forEach(img => URL.revokeObjectURL(img.previewUrl));
        return [];
      });
    };
  }, []);

  useEffect(() => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (!currentTask) return;

    const poll = async () => {
      const pollUrl = `/api/task/poll/${encodeURIComponent(currentTask.capability)}/${currentTask.id}`;
      const pollBody = { apiKey };
      try {
        const res = await fetch(pollUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pollBody),
        });
        const data = await res.json();
        addDevEntry?.({ key: `poll-${currentTask.id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollBody, response: data });

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
  }, [currentTask, apiKey, addDevEntry]);

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

  const handleImageFiles = (files) => {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`"${file.name}" exceeds 10 MB limit and was skipped.`);
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        // Strip "data:<mime>;base64," prefix — Ollama expects raw base64
        const b64 = e.target.result.split(',')[1];
        setPendingImages(prev => [...prev, { name: file.name, mime: file.type, b64, previewUrl }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleRemoveImage = (idx) => {
    setPendingImages(prev => {
      URL.revokeObjectURL(prev[idx].previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSend = async () => {
    if ((!input.trim() && pendingImages.length === 0) || isLoading) return;

    const userMessage = {
      role: 'user',
      content: input.trim(),
      ...(pendingImages.length > 0 && {
        images: pendingImages.map(p => p.b64),
        imageMimes: pendingImages.map(p => p.mime), // UI-only display hint, stripped before sending
      }),
    };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    // Revoke object URLs now that b64 is committed to message history
    pendingImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setPendingImages([]);
    setIsLoading(true);
    setError(null);

    // Build Ollama-compatible messages: strip UI-only imageMimes before sending
    const ollamaMessages = [
      { role: 'system', content: systemMessage },
      ...newMessages.map(({ role, content, images }) => ({
        role,
        content,
        ...(images && { images }),
      })),
    ];

    const payload = {
      capability: stripCapabilityAttrs(`llm.${model}`),
      urgent: false,
      payload: {
        model,
        messages: ollamaMessages,
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
      addDevEntry?.({ label: 'Submit chat task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

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
    setPendingImages(prev => {
      prev.forEach(img => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  };

  return (
    <div style={styles.root}>
      <style>{`@keyframes llm-breathe { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>
      <div style={styles.header}>
        <div style={styles.modelRow}>
          <label style={styles.label}>Model:</label>
          <ModelSelector model={model} setModel={setModel} capabilities={capabilities} />
          <button onClick={handleClear} style={styles.clearBtn} title="Clear conversation">
            <Trash2 size={16} />
          </button>
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
            {msg.images && msg.images.length > 0 && (
              <div style={styles.bubbleImages}>
                {msg.images.map((b64, j) => (
                  <img
                    key={j}
                    src={`data:${msg.imageMimes?.[j] ?? 'image/png'};base64,${b64}`}
                    alt="attached"
                    style={styles.bubbleImg}
                  />
                ))}
              </div>
            )}
            {msg.content && <div style={styles.bubbleText}>{msg.content}</div>}
          </div>
        ))}
        {isLoading && (
          <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
            {streamingLog
              ? <div style={{ ...styles.bubbleText, animation: 'llm-breathe 1.8s ease-in-out infinite' }}>{streamingLog}</div>
              : <div style={styles.typing}>{pollingStatus || 'Thinking…'}</div>
            }
          </div>
        )}
        {error && <div style={styles.errorMsg}>{error}</div>}
        <div ref={chatEndRef} />
      </div>

      <div style={styles.inputArea}>
        {pendingImages.length > 0 && (
          <div style={styles.pendingImages}>
            {pendingImages.map((img, i) => (
              <div key={i} style={styles.pendingThumb}>
                <img src={img.previewUrl} alt={img.name} style={styles.thumbImg} />
                <button onClick={() => handleRemoveImage(i)} style={styles.thumbRemove} title="Remove">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={styles.inputRow}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={e => { handleImageFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            style={{ ...styles.iconBtn, opacity: isLoading ? 0.5 : 1 }}
            title="Attach image"
          >
            <ImagePlus size={18} />
          </button>
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
            disabled={isLoading || (!input.trim() && pendingImages.length === 0)}
            style={{ ...styles.sendBtn, opacity: isLoading || (!input.trim() && pendingImages.length === 0) ? 0.5 : 1 }}
          >
            <Send size={18} />
          </button>
        </div>
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
  label: {
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--text)',
    whiteSpace: 'nowrap',
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
  inputArea: {
    paddingTop: '8px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
  pendingImages: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  pendingThumb: {
    position: 'relative',
    display: 'inline-flex',
  },
  thumbImg: {
    width: '56px',
    height: '56px',
    objectFit: 'cover',
    borderRadius: '6px',
    border: '1px solid var(--border)',
  },
  thumbRemove: {
    position: 'absolute',
    top: '-5px',
    right: '-5px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    border: 'none',
    background: 'var(--danger, #ef4444)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  bubbleImages: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginBottom: '6px',
  },
  bubbleImg: {
    maxWidth: '180px',
    maxHeight: '180px',
    borderRadius: '6px',
    objectFit: 'cover',
  },
  iconBtn: {
    padding: '8px',
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    cursor: 'pointer',
    color: 'var(--muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
