import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, FileText, Loader } from 'lucide-react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';
import ModelSelector from './ModelSelector';

async function clientFetch(path, apiKey, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-API-Key', apiKey);
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return null;
}

const PdfAnalyzerApp = ({ apiKey: propApiKey }) => {
    const [apiKey, setApiKey] = useState(propApiKey || '');
    const [capability, setCapability] = useState('llm.gemma3:4b');
    const [prompt, setPrompt] = useState('Analyze this PDF document. Summarize the key points and provide any insights.');
    const [mode, setMode] = useState('blocking');
    const [selectedFile, setSelectedFile] = useState(null);
    const [dragover, setDragover] = useState(false);
    const [running, setRunning] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [statusType, setStatusType] = useState('info');
    const [result, setResult] = useState(null);
    const [logText, setLogText] = useState('');
    const [capabilities, setCapabilities] = useState([]);
    const fileInputRef = useRef(null);

    useEffect(() => { if (propApiKey) setApiKey(propApiKey); }, [propApiKey]);

    useEffect(() => {
        fetchOnlineCapabilities()
            .then(data => {
                if (Array.isArray(data)) {
                    setCapabilities(data.filter(c => stripCapabilityAttrs(c).startsWith('llm.')));
                }
            })
            .catch(() => {});
    }, []);

    const status = useCallback((msg, type = 'info') => {
        setStatusMsg(msg);
        setStatusType(type);
    }, []);

    const handleFile = useCallback((file) => {
        setSelectedFile(file);
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragover(false);
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    }, [handleFile]);

    const pollTask = useCallback(async (cap, id) => {
        const encodedCap = encodeURIComponent(cap);
        const encodedId = encodeURIComponent(id);
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                const resp = await fetch(`/api/task/poll/${encodedCap}/${encodedId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey }),
                });
                if (!resp.ok) continue;
                const data = await resp.json();
                const s = data.status;
                const taskStatus = typeof s === 'string' ? s : Object.keys(s)[0];

                if (data.log) setLogText(data.log);
                status(`Status: ${taskStatus}${data.stage ? ` (${data.stage})` : ''}`);

                if (taskStatus === 'completed' || taskStatus === 'failed') {
                    return data;
                }
            } catch {
                // retry
            }
        }
        throw new Error('Polling timed out');
    }, [apiKey, status]);

    const handleAnalyze = useCallback(async () => {
        if (!selectedFile) return;
        if (!apiKey) { status('API key is required', 'err'); return; }
        if (!capability) { status('Capability is required', 'err'); return; }

        setRunning(true);
        setResult(null);
        setLogText('');

        let bucketUid = null;
        try {
            // 1. Create bucket
            status('Creating file bucket...');
            const bucketResp = await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST' });
            bucketUid = bucketResp.bucket_uid;
            status(`Bucket created: ${bucketUid.slice(0, 8)}...`);

            // 2. Upload file
            status(`Uploading ${selectedFile.name}...`);
            const formData = new FormData();
            formData.append('file', selectedFile);
            const uploadHeaders = new Headers();
            uploadHeaders.set('X-API-Key', apiKey);
            const uploadResp = await fetch(`/api/storage/bucket/${bucketUid}/upload`, {
                method: 'POST', headers: uploadHeaders, body: formData,
            });
            if (!uploadResp.ok) throw new Error(`Upload failed: ${await uploadResp.text()}`);
            const uploadResult = await uploadResp.json();
            status(`Uploaded: ${uploadResult.original_name} (${uploadResult.size} bytes)`);

            // 3. Submit task
            const taskPayload = {
                messages: [{ role: 'user', content: prompt }],
                stream: false,
            };

            let taskResult;
            if (mode === 'blocking') {
                status('Submitting blocking task... (waiting for result)');
                taskResult = await clientFetch('/api/task/submit_blocking', apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                    body: JSON.stringify({
                        capability,
                        urgent: true,
                        restartable: false,
                        payload: taskPayload,
                        fileBucket: [bucketUid],
                        fetchFiles: [],
                        artifacts: [],
                        apiKey,
                    }),
                });
            } else {
                status('Submitting async task...');
                const submitResp = await clientFetch('/api/task/submit', apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                    body: JSON.stringify({
                        capability,
                        urgent: false,
                        restartable: false,
                        payload: taskPayload,
                        fileBucket: [bucketUid],
                        fetchFiles: [],
                        artifacts: [],
                        apiKey,
                    }),
                });
                const { task } = submitResp;
                status(`Task submitted: ${task.id}. Polling...`);
                taskResult = await pollTask(task.cap, task.id);
            }

            // Show result
            showResult(taskResult);

            // 4. Clean up bucket
            await clientFetch(`/api/storage/bucket/${bucketUid}`, apiKey, { method: 'DELETE' }).catch(() => {});
            bucketUid = null;

        } catch (err) {
            status(err.message, 'err');
            // Clean up bucket on error
            if (bucketUid) {
                await clientFetch(`/api/storage/bucket/${bucketUid}`, apiKey, { method: 'DELETE' }).catch(() => {});
            }
        } finally {
            setRunning(false);
        }
    }, [selectedFile, apiKey, capability, prompt, mode, status, pollTask]);

    const showResult = useCallback((data) => {
        if (data.output) {
            const msg = data.output?.message;
            if (msg?.content) {
                setResult(msg.content);
                status('Analysis complete', 'ok');
            } else {
                setResult(JSON.stringify(data.output, null, 2));
                status('Task completed', 'ok');
            }
        } else if (data.status) {
            const s = data.status;
            const taskStatus = typeof s === 'string' ? s : Object.keys(s)[0];
            if (taskStatus === 'failed') {
                const failMsg = typeof s === 'object' && s.failure ? s.failure[0] : 'Task failed';
                setResult(failMsg);
                status('Task failed', 'err');
            } else {
                setResult(JSON.stringify(data, null, 2));
                status('Completed', 'ok');
            }
        }
        if (data.log) setLogText(data.log);
    }, [status]);

    return (
        <div style={s.root}>
            <h2 style={s.title}>PDF Analyzer</h2>
            <p style={s.subtitle}>
                Upload a PDF (or image), send it to an LLM agent for analysis via the Storage API.
            </p>

            {/* Config */}
            <div style={s.panel}>
                <div style={s.row}>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Client API Key</label>
                        <input
                            style={s.input}
                            type="text"
                            value={apiKey}
                            onChange={e => setApiKey(e.target.value)}
                            placeholder="Enter client API key..."
                            spellCheck={false}
                        />
                    </div>
                </div>
                <div style={s.row}>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>LLM Capability</label>
                        <ModelSelector
                            capabilities={capabilities}
                            value={capability}
                            onChange={setCapability}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Mode</label>
                        <select style={s.input} value={mode} onChange={e => setMode(e.target.value)}>
                            <option value="blocking">Blocking (urgent)</option>
                            <option value="async">Async (non-urgent)</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label style={s.label}>Prompt</label>
                    <textarea
                        style={{ ...s.input, minHeight: '60px', resize: 'vertical' }}
                        value={prompt}
                        onChange={e => setPrompt(e.target.value)}
                    />
                </div>
            </div>

            {/* File drop zone */}
            <div
                style={{
                    ...s.dropZone,
                    borderColor: dragover ? 'var(--accent, #3b82f6)' : 'var(--border)',
                }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragover(true); }}
                onDragLeave={() => setDragover(false)}
                onDrop={handleDrop}
            >
                <Upload size={24} style={{ color: 'var(--muted)', marginBottom: '8px' }} />
                <div>Drop a PDF or image here, or click to browse</div>
                {selectedFile && (
                    <div style={{ color: 'var(--accent, #3b82f6)', marginTop: '8px', fontSize: '0.85rem' }}>
                        <FileText size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                        {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </div>
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
                    style={{ display: 'none' }}
                    onChange={e => { if (e.target.files.length) handleFile(e.target.files[0]); }}
                />
            </div>

            {/* Analyze button */}
            <button
                style={{ ...s.analyzeBtn, opacity: (!selectedFile || running) ? 0.5 : 1 }}
                disabled={!selectedFile || running}
                onClick={handleAnalyze}
            >
                {running ? (
                    <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing...</>
                ) : (
                    'Analyze'
                )}
            </button>

            {/* Status */}
            {statusMsg && (
                <div style={{
                    ...s.statusBox,
                    background: statusType === 'ok' ? 'rgba(76,175,136,0.1)' : statusType === 'err' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)',
                    color: statusType === 'ok' ? '#4caf88' : statusType === 'err' ? '#ef4444' : 'var(--accent, #3b82f6)',
                }}>
                    {statusMsg}
                </div>
            )}

            {/* Result */}
            {result && (
                <div style={s.panel}>
                    <label style={s.label}>Result</label>
                    <div style={s.resultContent}>{result}</div>
                    {logText && (
                        <>
                            <label style={{ ...s.label, marginTop: '12px' }}>Logs</label>
                            <div style={s.logContent}>{logText}</div>
                        </>
                    )}
                </div>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
};

const s = {
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '4px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: 'var(--text)',
    },
    title: { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
    subtitle: { margin: 0, fontSize: '0.88rem', color: 'var(--muted)' },
    panel: {
        background: 'var(--glass)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
    label: {
        fontSize: '0.72rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.5px',
        color: 'var(--muted)',
        marginBottom: '4px',
        display: 'block',
    },
    input: {
        width: '100%',
        padding: '8px 12px',
        fontSize: '14px',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        background: 'var(--input-bg)',
        color: 'var(--text)',
        outline: 'none',
        fontFamily: 'monospace',
    },
    dropZone: {
        border: '2px dashed var(--border)',
        borderRadius: '12px',
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--muted)',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
        fontSize: '0.88rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
    },
    analyzeBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '10px 24px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#fff',
        background: 'linear-gradient(180deg, #3b82f6, #2563eb)',
        border: 'none',
        borderRadius: '10px',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(37,99,235,0.25)',
        alignSelf: 'flex-start',
    },
    statusBox: {
        fontSize: '0.85rem',
        padding: '8px 12px',
        borderRadius: '8px',
    },
    resultContent: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '0.85rem',
        lineHeight: 1.6,
        maxHeight: '500px',
        overflowY: 'auto',
    },
    logContent: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '0.8rem',
        lineHeight: 1.5,
        color: 'var(--muted)',
        maxHeight: '200px',
        overflowY: 'auto',
        padding: '8px',
        background: 'var(--code-bg)',
        borderRadius: '6px',
    },
};

export default PdfAnalyzerApp;
