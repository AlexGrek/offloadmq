import { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, FileText, Loader } from 'lucide-react';
import { clientFetch, cancelTask } from '../sandboxUtils';
import { useCapabilities } from '../hooks/useCapabilities';
import ModelSelector from './ModelSelector';
import SandboxMarkdown from './SandboxMarkdown';
import CircularProgress from './CircularProgress';

const PdfAnalyzerApp = ({ apiKey: propApiKey, addDevEntry }) => {
    const [apiKey, setApiKey] = useState(propApiKey || '');
    const [capability, setCapability] = useState('gemma3:4b');
    const [systemPrompt, setSystemPrompt] = useState('You are a helpful document analysis assistant. Be thorough, structured, and concise.');
    const [prompt, setPrompt] = useState('Analyze this PDF document. Summarize the key points and provide any insights.');
    const [mode, setMode] = useState('blocking');
    const [selectedFile, setSelectedFile] = useState(null);
    const [dragover, setDragover] = useState(false);
    const [running, setRunning] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [statusType, setStatusType] = useState('info');
    const [result, setResult] = useState(null);
    const [logText, setLogText] = useState('');
    const [heuristicSecs, setHeuristicSecs] = useState(null);
    const [taskCreatedAt, setTaskCreatedAt] = useState(null);
    const fileInputRef = useRef(null);
    const cancelledRef = useRef(false);
    const activeTaskRef = useRef(null); // { cap, id }

    const [capabilities] = useCapabilities('llm.');

    useEffect(() => { if (propApiKey) setApiKey(propApiKey); }, [propApiKey]);

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

    const showResult = useCallback((data) => {
        // Urgent tasks return AssignedTask with payload in `result`;
        // non-urgent poll returns a shaped object with `output`.
        const payload = data.output ?? data.result;
        const s = data.status;
        const taskStatus = (typeof s === 'string' ? s : Object.keys(s)[0]).toLowerCase();

        if (taskStatus === 'failed') {
            // Best-effort error message extraction
            const errMsg =
                payload?.error ||                          // agent failure_report puts error here
                (Array.isArray(s?.failure) ? s.failure[0] : null) ||   // Failure(String, f64) wire
                (Array.isArray(s?.failed)  ? s.failed[0]  : null) ||
                'Task failed';
            setResult(errMsg);
            status('Task failed', 'err');
        } else if (payload) {
            const msg = payload.message;
            if (msg?.content) {
                setResult(msg.content);
                status('Analysis complete', 'ok');
            } else {
                setResult(JSON.stringify(payload, null, 2));
                status('Task completed', 'ok');
            }
        } else {
            setResult(JSON.stringify(data, null, 2));
            status('Completed', 'ok');
        }

        if (data.log) setLogText(data.log);
    }, [status]);

    const pollTask = useCallback(async (cap, id) => {
        const encodedCap = encodeURIComponent(cap);
        const encodedId = encodeURIComponent(id);
        const pollUrl = `/api/task/poll/${encodedCap}/${encodedId}`;
        const pollBody = { apiKey };
        for (let i = 0; i < 120; i++) {
            if (cancelledRef.current) return null;
            await new Promise(r => setTimeout(r, 3000));
            if (cancelledRef.current) return null;
            try {
                const resp = await fetch(pollUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pollBody),
                });
                if (!resp.ok) continue;
                const data = await resp.json();
                const s = data.status;
                const taskStatus = typeof s === 'string' ? s : Object.keys(s)[0];

                if (data.log) setLogText(data.log);
                status(`Status: ${taskStatus}${data.stage ? ` (${data.stage})` : ''}`);

                if (taskStatus === 'completed' || taskStatus === 'failed') {
                    addDevEntry?.({ key: `poll-${id}`, label: 'Poll task (final)', method: 'POST', url: pollUrl, request: pollBody, response: data });
                    setHeuristicSecs(null);
                    setTaskCreatedAt(null);
                    return data;
                }
                if (data.createdAt) setTaskCreatedAt(prev => prev ?? data.createdAt);
                if (data.typicalRuntimeSeconds?.secs != null) setHeuristicSecs(data.typicalRuntimeSeconds.secs);
                addDevEntry?.({ key: `poll-${id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollBody, response: data });
            } catch {
                // retry
            }
        }
        throw new Error('Polling timed out');
    }, [apiKey, status, addDevEntry]);

    const handleCancel = useCallback(async () => {
        const task = activeTaskRef.current;
        cancelledRef.current = true;
        activeTaskRef.current = null;
        setRunning(false);
        setHeuristicSecs(null);
        setTaskCreatedAt(null);
        status('Cancelled', 'info');
        if (task) await cancelTask(task.cap, task.id, apiKey, addDevEntry);
    }, [apiKey, addDevEntry, status]);

    const handleAnalyze = useCallback(async () => {
        if (!selectedFile) return;
        if (!apiKey) { status('API key is required', 'err'); return; }
        if (!capability) { status('Capability is required', 'err'); return; }

        cancelledRef.current = false;
        setRunning(true);
        setResult(null);
        setLogText('');

        let bucketUid = null;
        try {
            // 1. Create bucket
            status('Creating file bucket...');
            const bucketResp = await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST', _label: 'Create bucket' }, addDevEntry);
            bucketUid = bucketResp.bucket_uid;
            status(`Bucket created: ${bucketUid.slice(0, 8)}...`);

            // 2. Upload file
            status(`Uploading ${selectedFile.name}...`);
            const formData = new FormData();
            formData.append('file', selectedFile);
            const uploadHeaders = new Headers();
            uploadHeaders.set('X-API-Key', apiKey);
            const uploadUrl = `/api/storage/bucket/${bucketUid}/upload`;
            const uploadResp = await fetch(uploadUrl, {
                method: 'POST', headers: uploadHeaders, body: formData,
            });
            if (!uploadResp.ok) {
                const errText = await uploadResp.text();
                addDevEntry?.({ label: 'Upload file', method: 'POST', url: uploadUrl, request: { fileName: selectedFile.name, size: selectedFile.size }, response: { error: errText } });
                throw new Error(`Upload failed: ${errText}`);
            }
            const uploadResult = await uploadResp.json();
            addDevEntry?.({ label: 'Upload file', method: 'POST', url: uploadUrl, request: { fileName: selectedFile.name, size: selectedFile.size }, response: uploadResult });
            status(`Uploaded: ${uploadResult.original_name} (${uploadResult.size} bytes)`);

            // 3. Submit task
            const messages = [];
            if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
            messages.push({ role: 'user', content: prompt });
            const taskPayload = { messages, stream: false };

            let taskResult;
            if (mode === 'blocking') {
                status('Submitting blocking task... (waiting for result)');
                taskResult = await clientFetch('/api/task/submit_blocking', apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                    body: JSON.stringify({
                        capability: `llm.${capability}`,
                        urgent: true,
                        restartable: false,
                        payload: taskPayload,
                        file_bucket: [bucketUid],
                        fetchFiles: [],
                        artifacts: [],
                        apiKey,
                    }),
                    _label: 'Submit task (blocking)',
                }, addDevEntry);
            } else {
                status('Submitting async task...');
                const submitResp = await clientFetch('/api/task/submit', apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                    body: JSON.stringify({
                        capability: `llm.${capability}`,
                        urgent: false,
                        restartable: false,
                        payload: taskPayload,
                        file_bucket: [bucketUid],
                        fetchFiles: [],
                        artifacts: [],
                        apiKey,
                    }),
                    _label: 'Submit task',
                }, addDevEntry);
                const taskId = submitResp.id.id;
                const taskCap = submitResp.id.cap;
                activeTaskRef.current = { cap: taskCap, id: taskId };
                status(`Task submitted: ${taskId}. Polling...`);
                taskResult = await pollTask(taskCap, taskId);
                activeTaskRef.current = null;
                if (taskResult === null) return; // cancelled
            }

            // Show result
            showResult(taskResult);

            // 4. Clean up bucket
            await clientFetch(`/api/storage/bucket/${bucketUid}`, apiKey, { method: 'DELETE', _label: 'Delete bucket' }, addDevEntry).catch(() => {});
            bucketUid = null;

        } catch (err) {
            status(err.message, 'err');
            // Clean up bucket on error
            if (bucketUid) {
                await clientFetch(`/api/storage/bucket/${bucketUid}`, apiKey, { method: 'DELETE', _label: 'Delete bucket' }, addDevEntry).catch(() => {});
            }
        } finally {
            setRunning(false);
            setHeuristicSecs(null);
            setTaskCreatedAt(null);
        }
    }, [selectedFile, apiKey, capability, prompt, systemPrompt, mode, status, pollTask, addDevEntry, showResult]);

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
                            model={capability}
                            setModel={setCapability}
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
                    <label style={s.label}>System Prompt</label>
                    <textarea
                        style={{ ...s.input, minHeight: '48px', resize: 'vertical' }}
                        value={systemPrompt}
                        onChange={e => setSystemPrompt(e.target.value)}
                    />
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

            {/* Analyze / Cancel buttons */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
                {running && mode === 'async' && activeTaskRef.current && (
                    <button style={s.cancelBtn} onClick={handleCancel}>Cancel</button>
                )}
            </div>

            {/* Status */}
            {statusMsg && (
                <div style={{
                    ...s.statusBox,
                    background: statusType === 'ok' ? 'rgba(76,175,136,0.1)' : statusType === 'err' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)',
                    color: statusType === 'ok' ? '#4caf88' : statusType === 'err' ? '#ef4444' : 'var(--accent, #3b82f6)',
                    display: 'flex', alignItems: 'center', gap: '10px',
                }}>
                    {running && (
                        <CircularProgress
                            typicalRuntimeSeconds={heuristicSecs}
                            createdAt={taskCreatedAt}
                            size={32}
                            strokeWidth={3}
                        />
                    )}
                    <span>{statusMsg}</span>
                </div>
            )}

            {/* Result */}
            {result && (
                <div style={s.panel}>
                    <label style={s.label}>Result</label>
                    <div style={s.resultContent}>
                        <SandboxMarkdown tone="light">{result}</SandboxMarkdown>
                    </div>
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
        fontFamily: 'var(--font-sans)',
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
    cancelBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '10px 20px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#fff',
        background: 'var(--danger, #ef4444)',
        border: 'none',
        borderRadius: '10px',
        cursor: 'pointer',
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
