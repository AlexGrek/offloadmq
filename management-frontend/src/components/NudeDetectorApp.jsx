import { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, Loader, X, ChevronDown, ChevronUp } from 'lucide-react';
import { clientFetch, deleteBucket, cancelTask } from '../sandboxUtils';
import CircularProgress from './CircularProgress';

const EXPOSED_LABELS = new Set([
    'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED',
    'ANUS_EXPOSED', 'BUTTOCKS_EXPOSED', 'BELLY_EXPOSED',
    'MALE_BREAST_EXPOSED', 'FEET_EXPOSED', 'ARMPITS_EXPOSED',
]);
const FACE_LABELS = new Set(['FACE_FEMALE', 'FACE_MALE']);

function labelColor(label) {
    if (EXPOSED_LABELS.has(label)) return '#ef4444';
    if (FACE_LABELS.has(label)) return '#3b82f6';
    return '#f59e0b';
}

function labelShort(label) {
    return label.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const NudeDetectorApp = ({ apiKey: propApiKey, addDevEntry }) => {
    const [apiKey, setApiKey] = useState(propApiKey || '');
    const [threshold, setThreshold] = useState(0.25);
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [dragover, setDragover] = useState(false);
    const [running, setRunning] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [statusType, setStatusType] = useState('info');
    const [results, setResults] = useState(null);
    const [heuristicSecs, setHeuristicSecs] = useState(null);
    const [taskCreatedAt, setTaskCreatedAt] = useState(null);
    const fileInputRef = useRef(null);
    const previewsRef = useRef(previews);
    previewsRef.current = previews;
    const cancelledRef = useRef(false);
    const activeTaskRef = useRef(null);

    useEffect(() => { if (propApiKey) setApiKey(propApiKey); }, [propApiKey]);
    useEffect(() => () => previewsRef.current.forEach(URL.revokeObjectURL), []);

    const addFiles = useCallback((files) => {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (!imageFiles.length) return;
        setSelectedFiles(prev => [...prev, ...imageFiles]);
        setPreviews(prev => [...prev, ...imageFiles.map(f => URL.createObjectURL(f))]);
    }, []);

    const removeFile = useCallback((idx) => {
        setPreviews(prev => { URL.revokeObjectURL(prev[idx]); return prev.filter((_, i) => i !== idx); });
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

    const pollTask = useCallback(async (cap, id) => {
        const pollUrl = `/api/task/poll/${encodeURIComponent(cap)}/${encodeURIComponent(id)}`;
        const pollBody = { apiKey };
        for (let i = 0; i < 120; i++) {
            if (cancelledRef.current) return null;
            await new Promise(r => setTimeout(r, 2000));
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
                setStatus(`Status: ${taskStatus}${data.stage ? ` · ${data.stage}` : ''}`);
                if (taskStatus === 'completed' || taskStatus === 'failed') {
                    addDevEntry?.({ key: `poll-${id}`, label: 'Poll (final)', method: 'POST', url: pollUrl, request: pollBody, response: data });
                    return data;
                }
                if (data.createdAt) setTaskCreatedAt(prev => prev ?? data.createdAt);
                if (data.typicalRuntimeSeconds?.secs != null) setHeuristicSecs(data.typicalRuntimeSeconds.secs);
                addDevEntry?.({ key: `poll-${id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollBody, response: data });
            } catch { /* retry */ }
        }
        throw new Error('Polling timed out');
    }, [apiKey, addDevEntry, setStatus]);

    const handleCancel = useCallback(async () => {
        const task = activeTaskRef.current;
        cancelledRef.current = true;
        activeTaskRef.current = null;
        setRunning(false);
        setHeuristicSecs(null);
        setTaskCreatedAt(null);
        setStatus('Cancelled', 'info');
        if (task) await cancelTask(task.cap, task.id, apiKey, addDevEntry);
    }, [apiKey, addDevEntry, setStatus]);

    const handleAnalyze = useCallback(async () => {
        if (!selectedFiles.length) { setStatus('Select at least one image', 'err'); return; }
        if (!apiKey) { setStatus('API key is required', 'err'); return; }

        cancelledRef.current = false;
        setRunning(true);
        setResults(null);

        let bucketUid = null;
        try {
            setStatus('Creating bucket...');
            const bucketResp = await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST', _label: 'Create bucket' }, addDevEntry);
            bucketUid = bucketResp.bucket_uid;

            for (let i = 0; i < selectedFiles.length; i++) {
                setStatus(`Uploading ${selectedFiles[i].name} (${i + 1}/${selectedFiles.length})...`);
                const formData = new FormData();
                formData.append('file', selectedFiles[i]);
                const headers = new Headers({ 'X-API-Key': apiKey });
                const url = `/api/storage/bucket/${bucketUid}/upload`;
                const resp = await fetch(url, { method: 'POST', headers, body: formData });
                if (!resp.ok) throw new Error(`Upload failed: ${await resp.text()}`);
                const uploadResult = await resp.json();
                addDevEntry?.({ label: `Upload ${selectedFiles[i].name}`, method: 'POST', url, request: { fileName: selectedFiles[i].name }, response: uploadResult });
            }

            setStatus('Submitting detection task...');
            const submitResp = await clientFetch('/api/task/submit', apiKey, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    capability: 'onnx.nudenet',
                    urgent: false,
                    restartable: false,
                    payload: { threshold },
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
            setStatus(`Task ${taskId.slice(0, 8)}… queued. Polling...`);

            const taskResult = await pollTask(taskCap, taskId);
            activeTaskRef.current = null;
            if (taskResult === null) return;

            const payload = taskResult.output ?? taskResult.result;
            const s = taskResult.status;
            const taskStatus = (typeof s === 'string' ? s : Object.keys(s)[0]).toLowerCase();

            if (taskStatus === 'failed') {
                const errMsg = payload?.error || (Array.isArray(s?.failure) ? s.failure[0] : null) || 'Task failed';
                setStatus(errMsg, 'err');
            } else if (payload?.results) {
                setResults(payload);
                const totalDetections = payload.results.reduce((sum, r) => sum + r.detection_count, 0);
                setStatus(`Done — ${payload.images_processed} image(s), ${totalDetections} detection(s)`, 'ok');
            } else {
                setResults(payload);
                setStatus('Completed', 'ok');
            }

            setHeuristicSecs(null);
            setTaskCreatedAt(null);
            await deleteBucket(bucketUid, apiKey);
            bucketUid = null;
        } catch (err) {
            setStatus(err.message, 'err');
            if (bucketUid) await deleteBucket(bucketUid, apiKey);
        } finally {
            setRunning(false);
            setHeuristicSecs(null);
            setTaskCreatedAt(null);
        }
    }, [selectedFiles, apiKey, threshold, setStatus, pollTask, addDevEntry]);

    const previewByName = {};
    selectedFiles.forEach((f, i) => { previewByName[f.name] = previews[i]; });

    return (
        <div style={s.root}>
            <h2 style={s.title}>Nude Detector</h2>
            <p style={s.subtitle}>
                Upload images for NSFW content detection using NudeNet (ONNX). Returns per-image detections with labels, confidence, and bounding boxes.
            </p>

            <div style={s.panel}>
                <div style={s.row}>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Client API Key</label>
                        <input style={s.input} type="text" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter client API key..." spellCheck={false} />
                    </div>
                </div>
                <div style={s.row}>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Capability</label>
                        <input style={{ ...s.input, opacity: 0.6 }} type="text" value="onnx.nudenet" readOnly />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={s.label}>Confidence Threshold</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <input type="range" min="0.05" max="0.95" step="0.05" value={threshold} onChange={e => setThreshold(parseFloat(e.target.value))} style={{ flex: 1 }} />
                            <span style={{ fontFamily: 'monospace', fontSize: '14px', minWidth: '40px' }}>{threshold.toFixed(2)}</span>
                        </div>
                    </div>
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
                <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </div>

            {/* Thumbnails */}
            {selectedFiles.length > 0 && (
                <div style={s.thumbGrid}>
                    {selectedFiles.map((file, idx) => (
                        <div key={idx} style={s.thumb}>
                            <img src={previews[idx]} alt={file.name} style={s.thumbImg} />
                            <button style={s.thumbRemove} onClick={() => removeFile(idx)} disabled={running} title="Remove"><X size={10} /></button>
                            <div style={s.thumbName} title={file.name}>{file.name}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Buttons */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                    style={{ ...s.analyzeBtn, opacity: (!selectedFiles.length || running) ? 0.5 : 1 }}
                    disabled={!selectedFiles.length || running}
                    onClick={handleAnalyze}
                >
                    {running ? <><Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Detecting...</> : `Detect ${selectedFiles.length > 0 ? `${selectedFiles.length} image${selectedFiles.length > 1 ? 's' : ''}` : ''}`}
                </button>
                {running && <button style={s.cancelBtn} onClick={handleCancel}>Cancel</button>}
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
                        <CircularProgress typicalRuntimeSeconds={heuristicSecs} createdAt={taskCreatedAt} size={32} strokeWidth={3} />
                    )}
                    <span>{statusMsg}</span>
                </div>
            )}

            {/* Results */}
            {results?.results && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                        Model: <strong>{results.model}</strong> &middot; Threshold: <strong>{results.threshold}</strong>
                    </div>
                    {results.results.map((imgResult, idx) => (
                        <ImageResultCard key={idx} result={imgResult} preview={previewByName[imgResult.file]} />
                    ))}
                </div>
            )}

            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
};

const ImageResultCard = ({ result, preview }) => {
    const [expanded, setExpanded] = useState(false);
    const hasExposed = result.detections?.some(d => EXPOSED_LABELS.has(d.label));
    const borderColor = result.error ? '#ef4444' : hasExposed ? '#ef4444' : result.detection_count > 0 ? '#f59e0b' : '#4caf88';

    return (
        <div style={{ ...s.panel, borderLeft: `3px solid ${borderColor}`, gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }} onClick={() => setExpanded(v => !v)}>
                {preview && <img src={preview} alt={result.file} style={s.resultThumb} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.file}</div>
                    <div style={{ fontSize: '0.78rem', marginTop: '2px', color: 'var(--muted)' }}>
                        {result.error ? <span style={{ color: '#ef4444' }}>{result.error}</span> : `${result.detection_count} detection${result.detection_count !== 1 ? 's' : ''}`}
                    </div>
                </div>
                {result.detection_count > 0 && (
                    expanded ? <ChevronUp size={16} color="var(--muted)" /> : <ChevronDown size={16} color="var(--muted)" />
                )}
            </div>

            {/* Detection badges (always visible) */}
            {result.detections?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {result.detections.map((d, i) => (
                        <span key={i} style={{ fontSize: '0.7rem', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', background: `${labelColor(d.label)}18`, color: labelColor(d.label), whiteSpace: 'nowrap' }}>
                            {labelShort(d.label)} ({(d.confidence * 100).toFixed(0)}%)
                        </span>
                    ))}
                </div>
            )}

            {/* Expanded details */}
            {expanded && result.detections?.length > 0 && (
                <div style={{ fontSize: '0.78rem', fontFamily: 'monospace', background: 'var(--code-bg)', borderRadius: '6px', padding: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                                <th style={{ padding: '2px 8px' }}>Label</th>
                                <th style={{ padding: '2px 8px' }}>Confidence</th>
                                <th style={{ padding: '2px 8px' }}>Box (x1,y1 → x2,y2)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {result.detections.map((d, i) => (
                                <tr key={i}>
                                    <td style={{ padding: '2px 8px', color: labelColor(d.label) }}>{d.label}</td>
                                    <td style={{ padding: '2px 8px' }}>{(d.confidence * 100).toFixed(1)}%</td>
                                    <td style={{ padding: '2px 8px', color: 'var(--muted)' }}>
                                        {d.box.x1},{d.box.y1} → {d.box.x2},{d.box.y2}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

const s = {
    root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px', fontFamily: 'var(--font-sans)', color: 'var(--text)' },
    title: { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
    subtitle: { margin: 0, fontSize: '0.88rem', color: 'var(--muted)' },
    panel: { background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
    row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
    label: { fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--muted)', marginBottom: '4px', display: 'block' },
    input: { width: '100%', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--input-bg)', color: 'var(--text)', outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box' },
    dropZone: { border: '2px dashed var(--border)', borderRadius: '12px', padding: '1.6rem', textAlign: 'center', color: 'var(--muted)', cursor: 'pointer', transition: 'border-color 0.2s', fontSize: '0.88rem', display: 'flex', flexDirection: 'column', alignItems: 'center' },
    thumbGrid: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
    thumb: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', width: '80px' },
    thumbImg: { width: '80px', height: '80px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)' },
    thumbRemove: { position: 'absolute', top: '-5px', right: '-5px', width: '18px', height: '18px', borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
    thumbName: { fontSize: '0.68rem', color: 'var(--muted)', maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' },
    cancelBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '10px 20px', fontSize: '14px', fontWeight: 600, color: '#fff', background: 'var(--danger, #ef4444)', border: 'none', borderRadius: '10px', cursor: 'pointer' },
    analyzeBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 24px', fontSize: '14px', fontWeight: 600, color: '#fff', background: 'linear-gradient(180deg, #3b82f6, #2563eb)', border: 'none', borderRadius: '10px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(37,99,235,0.25)', alignSelf: 'flex-start' },
    statusBox: { fontSize: '0.85rem', padding: '8px 12px', borderRadius: '8px' },
    resultThumb: { width: '52px', height: '52px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--border)', flexShrink: 0 },
};

export default NudeDetectorApp;
