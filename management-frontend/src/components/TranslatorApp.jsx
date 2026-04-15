import React, { useState, useMemo, useEffect } from 'react';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';
import { useTaskPolling } from '../hooks/useTaskPolling';
import { stripCapabilityAttrs } from '../utils';
import { cancelTask } from '../sandboxUtils';
import ModelSelector from './ModelSelector';
import SandboxMarkdown from './SandboxMarkdown';

const TranslatorApp = ({ apiKey, addDevEntry }) => {
    const [text, setText] = useState('');
    const [fromLang, setFromLang] = useState('');
    const [toLang, setToLang] = useState('English');
    const [model, setModel] = useState('');
    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [pollingStatus, setPollingStatus] = useState('');
    const [currentTask, setCurrentTask] = useState(null);
    const [fallbackWarning, setFallbackWarning] = useState('');

    const [allCaps] = useCapabilities('llm.', { setError });

    const translateCaps = useMemo(
        () => allCaps.filter(c => stripCapabilityAttrs(c).toLowerCase().includes('translate')),
        [allCaps]
    );
    const displayCaps = translateCaps.length > 0 ? translateCaps : allCaps;

    // Auto-select on first load
    useEffect(() => {
        if (!allCaps.length || model) return;
        if (translateCaps.length > 0) {
            setModel(stripCapabilityAttrs(translateCaps[0]).replace(/^llm\./, ''));
            setFallbackWarning('');
        } else {
            const first = stripCapabilityAttrs(allCaps[0]).replace(/^llm\./, '');
            setModel(first);
            setFallbackWarning(`No translate models online — using ${first}`);
        }
    }, [allCaps]); // eslint-disable-line react-hooks/exhaustive-deps

    useTaskPolling({
        currentTask, apiKey, addDevEntry,
        onResult: (data) => {
            setIsLoading(false);
            setPollingStatus('');
            setCurrentTask(null);
            const out = data.output;
            setResponse(out?.message?.content ?? out?.response ?? JSON.stringify(out, null, 2));
        },
        onError: (msg) => {
            setIsLoading(false);
            setError(msg);
            setPollingStatus('');
            setCurrentTask(null);
        },
        onStatus: (status) => setPollingStatus(`Status: ${status}`),
    });

    const handleSubmit = async () => {
        setIsLoading(true);
        setResponse(null);
        setError(null);
        setPollingStatus('Submitting...');
        setCurrentTask(null);

        const instruction = fromLang
            ? `Translate the following text from ${fromLang} to ${toLang}. Output only the translated text, no explanations or metadata.`
            : `Translate the following text to ${toLang}. Auto-detect the source language. Output only the translated text, no explanations or metadata.`;

        const body = {
            apiKey,
            capability: stripCapabilityAttrs(`llm.${model}`),
            urgent: false,
            restartable: true,
            fetchFiles: [],
            file_bucket: [],
            artifacts: [],
            payload: { stream: false, messages: [{ role: 'user', content: `${instruction}\n\n${text}` }] },
        };

        try {
            const res = await fetch('/api/task/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            addDevEntry?.({ label: 'Submit translation', method: 'POST', url: '/api/task/submit', request: body, response: data });

            if (data.error) {
                setError(data.error.message ?? String(data.error));
                setIsLoading(false);
                setPollingStatus('');
            } else if (data.id?.id && data.id?.cap) {
                setCurrentTask({ id: data.id.id, capability: data.id.cap });
            } else {
                setError('Unexpected response from server.');
                setIsLoading(false);
                setPollingStatus('');
            }
        } catch (err) {
            addDevEntry?.({ label: 'Submit translation', method: 'POST', url: '/api/task/submit', request: body, response: { error: err.message } });
            setError(err.message);
            setIsLoading(false);
            setPollingStatus('');
        }
    };

    const handleCancel = async () => {
        if (!currentTask) return;
        const { id, capability } = currentTask;
        setCurrentTask(null);
        setIsLoading(false);
        setPollingStatus('Cancelled');
        await cancelTask(capability, id, apiKey, addDevEntry);
    };

    const canSubmit = text.trim() && toLang.trim() && model && !isLoading;

    return (
        <div style={ss.content}>
            <div style={ss.form}>
                <div style={ss.formGroup}>
                    <label style={ss.label}>Model</label>
                    <ModelSelector
                        model={model}
                        setModel={(m) => { setModel(m); setFallbackWarning(''); }}
                        capabilities={displayCaps}
                    />
                    {fallbackWarning && (
                        <span style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '4px' }}>
                            ⚠ {fallbackWarning}
                        </span>
                    )}
                </div>

                <div style={ss.row}>
                    <div style={{ ...ss.formGroup, flex: 1 }}>
                        <label style={ss.label}>From</label>
                        <input
                            style={ss.input}
                            value={fromLang}
                            onChange={e => setFromLang(e.target.value)}
                            placeholder="Auto-detect"
                        />
                    </div>
                    <div style={{ ...ss.formGroup, flex: 1 }}>
                        <label style={ss.label}>To</label>
                        <input
                            style={ss.input}
                            value={toLang}
                            onChange={e => setToLang(e.target.value)}
                            placeholder="e.g. English"
                        />
                    </div>
                </div>

                <div style={ss.formGroup}>
                    <label style={ss.label}>Text</label>
                    <textarea
                        style={{ ...ss.textarea, minHeight: '120px' }}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        placeholder="Enter text to translate..."
                    />
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                        style={{ ...ss.button, opacity: canSubmit ? 1 : 0.5 }}
                        disabled={!canSubmit}
                        onClick={handleSubmit}
                    >
                        {isLoading ? 'Translating...' : 'Translate'}
                    </button>
                    {isLoading && currentTask && (
                        <button style={s.cancelBtn} onClick={handleCancel}>Cancel</button>
                    )}
                </div>
            </div>

            {(pollingStatus || error || response) && (
                <div style={ss.responseContainer}>
                    {isLoading && <p style={ss.loading}>{pollingStatus}</p>}
                    {error && <pre style={ss.error}>{error}</pre>}
                    {response && <SandboxMarkdown tone="light">{response}</SandboxMarkdown>}
                </div>
            )}
        </div>
    );
};

const s = {
    cancelBtn: {
        padding: '10px 16px',
        borderRadius: '8px',
        background: 'var(--danger, #ef4444)',
        color: '#fff',
        border: 'none',
        cursor: 'pointer',
        fontWeight: 600,
        fontSize: '14px',
    },
};

export default TranslatorApp;
