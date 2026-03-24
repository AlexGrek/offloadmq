import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Upload, Loader, X } from 'lucide-react';
import { clientFetch, deleteBucket } from '../sandboxUtils';
import { useCapabilities } from '../hooks/useCapabilities';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import ModelSelector from './ModelSelector';

const ImageAnalyzerApp = ({ apiKey: propApiKey, addDevEntry }) => {
    const [apiKey, setApiKey] = useState(propApiKey || '');
    const [model, setModel] = useState('');
    const [prompt, setPrompt] = useState('Analyze this image. Describe what you see in detail.');
    const [mode, setMode] = useState('all');
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [dragover, setDragover] = useState(false);
    const [running, setRunning] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [statusType, setStatusType] = useState('info');
    // "all at once" result
    const [result, setResult] = useState(null);
    const [logText, setLogText] = useState('');
    // "one by one" results: [{ name, phase, statusText, result, error, log }]
    const [itemResults, setItemResults] = useState([]);
    const fileInputRef = useRef(null);
    const previewsRef = useRef(previews);
    previewsRef.current = previews;

    const [allCaps] = useCapabilities('llm.');
    const capabilities = useMemo(
        () => allCaps.filter(cap => parseCapabilityAttrs(cap).includes('vision')),
        [allCaps]
    );

    useEffect(() => { if (propApiKey) setApiKey(propApiKey); }, [propApiKey]);

    useEffect(() => {
        if (capabilities.length > 0 && !model) {
            setModel(stripCapabilityAttrs(capabilities[0]).replace(/^llm\./, ''));
        }
    }, [capabilities, model]);

    // Revoke preview URLs on unmount
    useEffect(() => () => previewsRef.current.forEach(URL.revokeObjectURL), []);

    const addFiles = useCallback((files) => {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (!imageFiles.length) return;
        const newPreviews = imageFiles.map(f => URL.createObjectURL(f));
        setSelectedFiles(prev => [...prev, ...imageFiles]);
        setPreviews(prev => [...prev, ...newPreviews]);
    }, []);

    const removeFile = useCallback((idx) => {
        setPreviews(prev => {
            URL.revokeObjectURL(prev[idx]);
            return prev.filter((_, i) => i !== idx);
        });
        setSelectedFiles(prev => prev.filter((_, i) => i !== idx));
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragover(false);
        addFiles(e.dataTransfer.files);
    }, [addFiles]);

    const setStatus = useCallback((msg, type = 'info') => {
        setStatusMsg(msg);
        setStatusType(type);
    }, []);

    const extractResult = useCallback((data) => {
        const payload = data.output ?? data.result;
        const s = data.status;
        const taskStatus = (typeof s === 'string' ? s : Object.keys(s)[0]).toLowerCase();
        if (taskStatus === 'failed') {
            const errMsg =
                payload?.error ||
                (Array.isArray(s?.failure) ? s.failure[0] : null) ||
                (Array.isArray(s?.failed) ? s.failed[0] : null) ||
                'Task failed';
            return { ok: false, text: errMsg };
        }
        if (payload?.message?.content) return { ok: true, text: payload.message.content };
        if (payload) return { ok: true, text: JSON.stringify(payload, null, 2) };
        return { ok: true, text: JSON.stringify(data, null, 2) };
    }, []);

    const pollTask = useCallback(async (cap, id, onLog, onStatusText) => {
        const encodedCap = encodeURIComponent(cap);
        const encodedId = encodeURIComponent(id);
        const pollUrl = `/api/task/poll/${encodedCap}/${encodedId}`;
        const pollBody = { apiKey };
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 3000));
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
                if (data.log) onLog?.(data.log);
                onStatusText?.(`${taskStatus}${data.stage ? ` · ${data.stage}` : ''}`);
                if (taskStatus === 'completed' || taskStatus === 'failed') {
                    addDevEntry?.({ key: `poll-${id}`, label: 'Poll task (final)', method: 'POST', url: pollUrl, request: pollBody, response: data });
                    return data;
                }
                addDevEntry?.({ key: `poll-${id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollBody, response: data });
            } catch { /* retry */ }
        }
        throw new Error('Polling timed out after 6 minutes');
    }, [apiKey, addDevEntry]);

    const uploadFile = useCallback(async (file, bucketUid) => {
        const formData = new FormData();
        formData.append('file', file);
        const headers = new Headers({ 'X-API-Key': apiKey });
        const url = `/api/storage/bucket/${bucketUid}/upload`;
        const resp = await fetch(url, { method: 'POST', headers, body: formData });
        if (!resp.ok) {
            const errText = await resp.text();
            addDevEntry?.({ label: `Upload ${file.name}`, method: 'POST', url, request: { fileName: file.name }, response: { error: errText } });
            throw new Error(`Upload failed: ${errText}`);
        }
        const result = await resp.json();
        addDevEntry?.({ label: `Upload ${file.name}`, method: 'POST', url, request: { fileName: file.name }, response: result });
        return result;
    }, [apiKey, addDevEntry]);

    const handleAnalyze = useCallback(async () => {
        if (!selectedFiles.length) { setStatus('Select at least one image', 'err'); return; }
        if (!apiKey) { setStatus('API key is required', 'err'); return; }
        if (!model) { setStatus('No vision model selected', 'err'); return; }

        setRunning(true);
        setResult(null);
        setLogText('');
        setItemResults([]);

        const capability = `llm.${model}`;
        const taskPayload = { messages: [{ role: 'user', content: prompt }], stream: false };

        if (mode === 'all') {
            let bucketUid = null;
            try {
                setStatus('Creating bucket...');
                const bucketResp = await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST', _label: 'Create bucket' }, addDevEntry);
                bucketUid = bucketResp.bucket_uid;

                for (let i = 0; i < selectedFiles.length; i++) {
                    setStatus(`Uploading ${selectedFiles[i].name} (${i + 1}/${selectedFiles.length})...`);
                    await uploadFile(selectedFiles[i], bucketUid);
                }

                setStatus('Submitting task...');
                const submitResp = await clientFetch('/api/task/submit', apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ capability, urgent: false, restartable: false, payload: taskPayload, fileBucket: [bucketUid], fetchFiles: [], artifacts: [], apiKey }),
                    _label: 'Submit task',
                }, addDevEntry);

                const taskId = submitResp.id.id;
                const taskCap = submitResp.id.cap;
                setStatus(`Task ${taskId.slice(0, 8)}… queued. Polling...`);

                const taskResult = await pollTask(taskCap, taskId, setLogText, (s) => setStatus(`Status: ${s}`));
                const { ok, text } = extractResult(taskResult);
                setResult(text);
                setStatus(ok ? 'Analysis complete' : 'Task failed', ok ? 'ok' : 'err');

                await deleteBucket(bucketUid, apiKey);
                bucketUid = null;
            } catch (err) {
                setStatus(err.message, 'err');
                if (bucketUid) await deleteBucket(bucketUid, apiKey);
            }
        } else {
            // One task per image, run in parallel
            setItemResults(selectedFiles.map(f => ({ name: f.name, phase: 'pending', statusText: '', result: null, error: null, log: '' })));
            setStatus(`Submitting ${selectedFiles.length} tasks...`);

            const processImage = async (file, idx) => {
                const update = (patch) => setItemResults(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
                let bucketUid = null;
                try {
                    update({ phase: 'uploading', statusText: 'Creating bucket...' });
                    const bucketResp = await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST', _label: `Bucket [${file.name}]` }, addDevEntry);
                    bucketUid = bucketResp.bucket_uid;

                    update({ statusText: 'Uploading...' });
                    await uploadFile(file, bucketUid);

                    update({ phase: 'queued', statusText: 'Queued' });
                    const submitResp = await clientFetch('/api/task/submit', apiKey, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ capability, urgent: false, restartable: false, payload: taskPayload, fileBucket: [bucketUid], fetchFiles: [], artifacts: [], apiKey }),
                        _label: `Submit [${file.name}]`,
                    }, addDevEntry);

                    const taskId = submitResp.id.id;
                    const taskCap = submitResp.id.cap;
                    update({ phase: 'polling', statusText: 'Polling...' });

                    const taskResult = await pollTask(
                        taskCap, taskId,
                        (log) => update({ log }),
                        (s) => update({ statusText: s }),
                    );
                    const { ok, text } = extractResult(taskResult);
                    update({ phase: ok ? 'done' : 'failed', statusText: ok ? 'Done' : 'Failed', result: ok ? text : null, error: ok ? null : text });

                    await deleteBucket(bucketUid, apiKey);
                } catch (err) {
                    update({ phase: 'error', statusText: 'Error', error: err.message });
                    if (bucketUid) await deleteBucket(bucketUid, apiKey);
                }
            };

            await Promise.all(selectedFiles.map((file, idx) => processImage(file, idx)));
            setStatus('All tasks complete', 'ok');
        }
        setRunning(false);
    }, [selectedFiles, apiKey, model, prompt, mode, setStatus, pollTask, uploadFile, extractResult, addDevEntry]);

    const hasVisionModels = capabilities.length > 0;

    return (
        <div style={s.root}>
            <h2 style={s.title}>Image Analyzer</h2>
            <p style={s.subtitle}>
                Upload images and analyze them with a vision-capable LLM via the Storage API.
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
                        <label style={s.label}>Vision Model {!hasVisionModels && <span style={{ color: 'var(--danger)', fontWeight: 400 }}>— no vision agents online</span>}</label>
                        <ModelSelector
                            capabilities={capabilities}
                            model={model}
                            setModel={setModel}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Mode</label>
                        <select style={s.input} value={mode} onChange={e => setMode(e.target.value)}>
                            <option value="all">All at once (one task)</option>
                            <option value="one">One by one (parallel tasks)</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label style={s.label}>Prompt</label>
                    <textarea
                        style={{ ...s.input, minHeight: '56px', resize: 'vertical' }}
                        value={prompt}
                        onChange={e => setPrompt(e.target.value)}
                    />
                </div>
            </div>

            {/* Drop zone */}
            <div
                style={{ ...s.dropZone, borderColor: dragover ? 'var(--accent, #3b82f6)' : 'var(--border)' }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragover(true); }}
                onDragLeave={() => setDragover(false)}
                onDrop={handleDrop}
            >
                <Upload size={22} style={{ color: 'var(--muted)', marginBottom: '6px' }} />
                <div>Drop images here or click to browse</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '4px' }}>PNG, JPG, WEBP, GIF — multiple files supported</div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
                />
            </div>

            {/* Selected images thumbnails */}
            {selectedFiles.length > 0 && (
                <div style={s.thumbGrid}>
                    {selectedFiles.map((file, idx) => (
                        <div key={idx} style={s.thumb}>
                            <img src={previews[idx]} alt={file.name} style={s.thumbImg} />
                            <button
                                style={s.thumbRemove}
                                onClick={() => removeFile(idx)}
                                disabled={running}
                                title="Remove"
                            >
                                <X size={10} />
                            </button>
                            <div style={s.thumbName} title={file.name}>{file.name}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Analyze button */}
            <button
                style={{ ...s.analyzeBtn, opacity: (!selectedFiles.length || running || !hasVisionModels) ? 0.5 : 1 }}
                disabled={!selectedFiles.length || running || !hasVisionModels}
                onClick={handleAnalyze}
            >
                {running ? (
                    <><Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing...</>
                ) : (
                    `Analyze ${selectedFiles.length > 0 ? `${selectedFiles.length} image${selectedFiles.length > 1 ? 's' : ''}` : 'Images'}`
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

            {/* "All at once" result */}
            {result && mode === 'all' && (
                <div style={s.panel}>
                    <label style={s.label}>Result</label>
                    <div style={s.resultContent}>{result}</div>
                    {logText && (
                        <>
                            <label style={{ ...s.label, marginTop: '10px' }}>Logs</label>
                            <div style={s.logContent}>{logText}</div>
                        </>
                    )}
                </div>
            )}

            {/* "One by one" results */}
            {itemResults.length > 0 && mode === 'one' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {itemResults.map((item, idx) => (
                        <div key={idx} style={{ ...s.panel, gap: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {previews[idx] && (
                                    <img src={previews[idx]} alt={item.name} style={s.resultThumb} />
                                )}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                                    <div style={{ fontSize: '0.78rem', marginTop: '2px', color: phaseMuted(item.phase) ? 'var(--muted)' : phaseColor(item.phase) }}>
                                        {item.statusText || item.phase}
                                    </div>
                                </div>
                                <PhaseBadge phase={item.phase} />
                            </div>
                            {item.log && !item.result && (
                                <div style={s.logContent}>{item.log}</div>
                            )}
                            {item.result && (
                                <div style={s.resultContent}>{item.result}</div>
                            )}
                            {item.error && (
                                <div style={{ fontSize: '0.82rem', color: '#ef4444', padding: '6px 8px', background: 'rgba(239,68,68,0.08)', borderRadius: '6px' }}>{item.error}</div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
};

function phaseColor(phase) {
    switch (phase) {
        case 'done': return '#4caf88';
        case 'failed':
        case 'error': return '#ef4444';
        case 'polling':
        case 'queued': return 'var(--accent, #3b82f6)';
        default: return 'var(--muted)';
    }
}

function phaseMuted(phase) {
    return phase === 'pending' || phase === 'uploading';
}

const PhaseBadge = ({ phase }) => {
    const labels = { pending: 'Pending', uploading: 'Uploading', queued: 'Queued', polling: 'Running', done: 'Done', failed: 'Failed', error: 'Error' };
    const colors = { done: '#4caf88', failed: '#ef4444', error: '#ef4444', polling: '#3b82f6', queued: '#f59e0b', uploading: '#a78bfa' };
    return (
        <span style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: '999px',
            background: colors[phase] ? `${colors[phase]}22` : 'var(--chip-bg)',
            color: colors[phase] || 'var(--muted)',
            flexShrink: 0,
        }}>
            {labels[phase] || phase}
        </span>
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
        boxSizing: 'border-box',
    },
    dropZone: {
        border: '2px dashed var(--border)',
        borderRadius: '12px',
        padding: '1.6rem',
        textAlign: 'center',
        color: 'var(--muted)',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
        fontSize: '0.88rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
    },
    thumbGrid: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px',
    },
    thumb: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        width: '80px',
    },
    thumbImg: {
        width: '80px',
        height: '80px',
        objectFit: 'cover',
        borderRadius: '8px',
        border: '1px solid var(--border)',
    },
    thumbRemove: {
        position: 'absolute',
        top: '-5px',
        right: '-5px',
        width: '18px',
        height: '18px',
        borderRadius: '50%',
        border: 'none',
        background: '#ef4444',
        color: '#fff',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
    },
    thumbName: {
        fontSize: '0.68rem',
        color: 'var(--muted)',
        maxWidth: '80px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'center',
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
        maxHeight: '400px',
        overflowY: 'auto',
    },
    logContent: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '0.8rem',
        lineHeight: 1.5,
        color: 'var(--muted)',
        maxHeight: '160px',
        overflowY: 'auto',
        padding: '8px',
        background: 'var(--code-bg)',
        borderRadius: '6px',
    },
    resultThumb: {
        width: '52px',
        height: '52px',
        objectFit: 'cover',
        borderRadius: '6px',
        border: '1px solid var(--border)',
        flexShrink: 0,
    },
};

export default ImageAnalyzerApp;
