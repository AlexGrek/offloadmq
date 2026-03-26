import React, { useState, useCallback, useEffect, useRef } from 'react';
import { FolderPlus, Upload, Hash, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { clientFetch, fmtBytes } from '../sandboxUtils';


// ---- sub-components ---------------------------------------------------------

function LimitsPanel({ limits }) {
    if (!limits) return null;
    const items = [
        { label: 'Max buckets',      value: limits.max_count ?? '—' },
        { label: 'Max bucket size',  value: fmtBytes(limits.max_size_bytes) },
        { label: 'TTL',              value: limits.ttl_minutes != null ? `${limits.ttl_minutes} min` : '—' },
    ];
    return (
        <div style={s.panel}>
            <div style={s.sectionTitle}>Limits</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                {items.map(({ label, value }) => (
                    <div key={label} style={s.statTile}>
                        <div style={s.tileLabel}>{label}</div>
                        <div style={s.tileValue}>{value}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function FileRow({ file, bucketUid, apiKey, onDeleted, addDevEntry }) {
    const [hash, setHash] = useState(null);
    const [loadingHash, setLoadingHash] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [err, setErr] = useState(null);

    const fetchHash = async () => {
        setLoadingHash(true); setErr(null);
        try {
            const url = `/api/storage/bucket/${encodeURIComponent(bucketUid)}/file/${encodeURIComponent(file.file_uid)}/hash`;
            const res = await clientFetch(url, apiKey, { _label: 'File hash' }, addDevEntry);
            setHash(res?.hash ?? JSON.stringify(res));
        } catch (e) { setErr(e.message); }
        finally { setLoadingHash(false); }
    };

    const handleDelete = async () => {
        setDeleting(true); setErr(null);
        try {
            const url = `/api/storage/bucket/${encodeURIComponent(bucketUid)}/file/${encodeURIComponent(file.file_uid)}`;
            await clientFetch(url, apiKey, { method: 'DELETE', _label: 'Delete file' }, addDevEntry);
            onDeleted();
        } catch (e) { setErr(e.message); setDeleting(false); }
    };

    return (
        <div style={s.fileRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <code style={s.fileUid}>{file.file_uid}</code>
                    <span style={s.chip}>{fmtBytes(file.size_bytes)}</span>
                    {file.name && <span style={s.chip}>{file.name}</span>}
                </div>
                {hash && (
                    <div style={s.hashRow}>
                        <span style={s.dimLabel}>SHA-256</span>
                        <code style={s.hashCode}>{hash}</code>
                    </div>
                )}
                {err && <div style={s.inlineErr}>{err}</div>}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button style={s.iconBtn} title="Get SHA-256 hash" disabled={loadingHash} onClick={fetchHash}>
                    {loadingHash ? '…' : <Hash size={14} />}
                </button>
                <button style={{ ...s.iconBtn, color: '#ef4444' }} title="Delete file" disabled={deleting} onClick={handleDelete}>
                    {deleting ? '…' : <Trash2 size={14} />}
                </button>
            </div>
        </div>
    );
}

function BucketPanel({ bucketUid, apiKey, onRemoved, addDevEntry }) {
    const [open, setOpen] = useState(true);
    const [stat, setStat] = useState(null);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [err, setErr] = useState(null);
    const fileInputRef = useRef(null);

    const shortUid = bucketUid.length > 18 ? bucketUid.slice(0, 8) + '…' + bucketUid.slice(-6) : bucketUid;

    const loadStat = useCallback(async () => {
        setLoading(true); setErr(null);
        try {
            const res = await clientFetch(
                `/api/storage/bucket/${encodeURIComponent(bucketUid)}/stat`,
                apiKey,
                { _label: 'Bucket stat' },
                addDevEntry
            );
            setStat(res);
        } catch (e) {
            if (e.message.startsWith('404')) {
                onRemoved(bucketUid);
            } else {
                setErr(e.message);
            }
        }
        finally { setLoading(false); }
    }, [bucketUid, apiKey, onRemoved, addDevEntry]);

    useEffect(() => { loadStat(); }, [loadStat]);

    const handleUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true); setErr(null);
        try {
            const form = new FormData();
            form.append('file', file);
            const headers = new Headers();
            headers.set('X-API-Key', apiKey);
            const uploadUrl = `/api/storage/bucket/${encodeURIComponent(bucketUid)}/upload`;
            const res = await fetch(uploadUrl, {
                method: 'POST', headers, body: form,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                addDevEntry?.({ label: 'Upload file', method: 'POST', url: uploadUrl, request: { fileName: file.name, size: file.size }, response: { error: text } });
                throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
            }
            const uploadData = await res.json().catch(() => null);
            addDevEntry?.({ label: 'Upload file', method: 'POST', url: uploadUrl, request: { fileName: file.name, size: file.size }, response: uploadData });
            await loadStat();
        } catch (e) { setErr(e.message); }
        finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
    };

    const handleDeleteBucket = async () => {
        if (!window.confirm(`Delete bucket ${shortUid} and all its files?`)) return;
        setDeleting(true); setErr(null);
        try {
            await clientFetch(
                `/api/storage/bucket/${encodeURIComponent(bucketUid)}`,
                apiKey,
                { method: 'DELETE', _label: 'Delete bucket' },
                addDevEntry
            );
            onRemoved(bucketUid);
        } catch (e) { setErr(e.message); setDeleting(false); }
    };

    return (
        <div style={s.bucketCard}>
            {/* Header */}
            <div style={s.bucketHeader}>
                <button style={s.chevronBtn} onClick={() => setOpen(o => !o)}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <code style={{ fontSize: '0.85rem', fontWeight: 700 }}>{shortUid}</code>
                        {stat && (
                            <>
                                <span style={s.chip}>{stat.files?.length ?? 0} file{stat.files?.length !== 1 ? 's' : ''}</span>
                                <span style={s.chip}>{fmtBytes(stat.used_bytes)}</span>
                                {stat.remaining_bytes != null && (
                                    <span style={{ ...s.chip, color: 'var(--muted)' }}>{fmtBytes(stat.remaining_bytes)} free</span>
                                )}
                            </>
                        )}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '2px', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {bucketUid}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button style={s.iconBtn} title="Refresh" disabled={loading} onClick={loadStat}>
                        <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                    </button>
                    <label style={{ ...s.iconBtn, cursor: uploading ? 'not-allowed' : 'pointer' }} title="Upload file">
                        {uploading ? '…' : <Upload size={14} />}
                        <input ref={fileInputRef} type="file" style={{ display: 'none' }} disabled={uploading} onChange={handleUpload} />
                    </label>
                    <button style={{ ...s.iconBtn, color: '#ef4444' }} title="Delete bucket" disabled={deleting} onClick={handleDeleteBucket}>
                        {deleting ? '…' : <Trash2 size={14} />}
                    </button>
                </div>
            </div>

            {err && <div style={{ ...s.inlineErr, margin: '6px 12px' }}>{err}</div>}

            {open && (
                <div style={s.bucketBody}>
                    {loading && <div style={s.muted}>Loading…</div>}
                    {!loading && stat && (
                        stat.files?.length > 0 ? (
                            stat.files.map(f => (
                                <FileRow
                                    key={f.file_uid}
                                    file={f}
                                    bucketUid={bucketUid}
                                    apiKey={apiKey}
                                    onDeleted={loadStat}
                                    addDevEntry={addDevEntry}
                                />
                            ))
                        ) : (
                            <div style={s.muted}>No files — use the upload button above.</div>
                        )
                    )}
                </div>
            )}
        </div>
    );
}

// ---- main app ---------------------------------------------------------------

const StorageBucketApp = ({ apiKey: propApiKey, addDevEntry }) => {
    const [apiKey, setApiKey] = useState(propApiKey || '');
    const [limits, setLimits] = useState(null);
    const [limitsErr, setLimitsErr] = useState(null);
    const [bucketUids, setBucketUids] = useState([]);
    const [loadingBuckets, setLoadingBuckets] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createErr, setCreateErr] = useState(null);

    // Keep local apiKey in sync if prop changes
    useEffect(() => { if (propApiKey) setApiKey(propApiKey); }, [propApiKey]);

    const fetchBuckets = useCallback(async () => {
        if (!apiKey) { setBucketUids([]); return; }
        setLoadingBuckets(true);
        try {
            const res = await clientFetch('/api/storage/buckets', apiKey, { _label: 'List buckets' }, addDevEntry);
            setBucketUids((res?.buckets || []).map(b => b.bucket_uid));
        } catch { setBucketUids([]); }
        finally { setLoadingBuckets(false); }
    }, [apiKey, addDevEntry]);

    const fetchLimits = useCallback(async () => {
        if (!apiKey) return;
        setLimitsErr(null);
        try {
            const res = await clientFetch('/api/storage/limits', apiKey, { _label: 'Storage limits' }, addDevEntry);
            setLimits(res);
        } catch (e) { setLimitsErr(e.message); }
    }, [apiKey, addDevEntry]);

    useEffect(() => { fetchLimits(); fetchBuckets(); }, [fetchLimits, fetchBuckets]);

    const createBucket = async () => {
        if (!apiKey) return;
        setCreating(true); setCreateErr(null);
        try {
            await clientFetch('/api/storage/bucket/create', apiKey, { method: 'POST', _label: 'Create bucket' }, addDevEntry);
            await fetchBuckets();
        } catch (e) { setCreateErr(e.message); }
        finally { setCreating(false); }
    };

    const removeBucket = useCallback(() => {
        fetchBuckets();
    }, [fetchBuckets]);

    return (
        <div style={s.root}>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

            <h2 style={s.title}>Storage Buckets</h2>
            <p style={s.subtitle}>
                Test the Client Storage API — create buckets, upload files, get hashes, and delete.
            </p>

            {/* API key row */}
            <div style={s.row}>
                <label style={s.label}>Client API Key</label>
                <input
                    style={s.input}
                    type="text"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Enter client API key…"
                    spellCheck={false}
                />
            </div>

            {limitsErr && <div style={s.errBox}>{limitsErr}</div>}
            <LimitsPanel limits={limits} />

            {/* Create bucket + refresh */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button style={s.createBtn} disabled={creating || !apiKey} onClick={createBucket}>
                    <FolderPlus size={16} />
                    {creating ? 'Creating…' : 'Create new bucket'}
                </button>
                <button style={s.iconBtn} title="Refresh bucket list" disabled={loadingBuckets || !apiKey} onClick={fetchBuckets}>
                    <RefreshCw size={14} style={{ animation: loadingBuckets ? 'spin 1s linear infinite' : 'none' }} />
                </button>
                {createErr && <span style={{ color: '#ef4444', fontSize: '0.82rem' }}>{createErr}</span>}
            </div>

            {loadingBuckets ? (
                <div style={s.muted}>Loading buckets…</div>
            ) : bucketUids.length === 0 ? (
                <div style={s.muted}>No buckets yet. Create one above.</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={s.sectionTitle}>Buckets ({bucketUids.length})</div>
                    {bucketUids.map(uid => (
                        <BucketPanel key={uid} bucketUid={uid} apiKey={apiKey} onRemoved={removeBucket} addDevEntry={addDevEntry} />
                    ))}
                </div>
            )}
        </div>
    );
};

// ---- styles -----------------------------------------------------------------

const s = {
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '4px',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text)',
    },
    title: { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
    subtitle: { margin: 0, fontSize: '0.88rem', color: 'var(--muted)' },
    row: { display: 'flex', alignItems: 'center', gap: '10px' },
    label: { fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap' },
    input: {
        flex: 1,
        padding: '8px 12px',
        fontSize: '14px',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        background: 'var(--input-bg)',
        color: 'var(--text)',
        outline: 'none',
        fontFamily: 'monospace',
    },
    panel: {
        background: 'var(--glass)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    sectionTitle: {
        fontSize: '0.72rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.5px',
        color: 'var(--muted)',
    },
    statTile: {
        background: 'var(--code-bg)',
        borderRadius: '8px',
        padding: '8px 10px',
    },
    tileLabel: { fontSize: '0.70rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)', marginBottom: '4px' },
    tileValue: { fontWeight: 700, fontSize: '0.95rem' },
    createBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '9px 16px',
        fontSize: '14px',
        fontWeight: 600,
        color: '#fff',
        background: 'linear-gradient(180deg, #3b82f6, #2563eb)',
        border: 'none',
        borderRadius: '10px',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(37,99,235,0.25)',
    },
    bucketCard: {
        border: '1px solid var(--border)',
        borderRadius: '12px',
        background: 'var(--glass)',
        overflow: 'hidden',
    },
    bucketHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
    },
    bucketBody: {
        borderTop: '1px solid var(--border)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    chevronBtn: {
        background: 'transparent',
        border: 0,
        cursor: 'pointer',
        color: 'var(--muted)',
        padding: '2px',
        flexShrink: 0,
    },
    iconBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '30px',
        height: '30px',
        background: 'var(--glass)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        cursor: 'pointer',
        color: 'var(--text)',
        fontSize: '13px',
    },
    chip: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '0.74rem',
        fontWeight: 600,
        background: 'var(--chip-bg)',
        border: '1px solid var(--border)',
    },
    fileRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '8px 10px',
        background: 'var(--code-bg)',
        borderRadius: '8px',
    },
    fileUid: { fontSize: '0.80rem', wordBreak: 'break-all' },
    hashRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '5px', flexWrap: 'wrap' },
    dimLabel: { fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)' },
    hashCode: { fontSize: '0.72rem', wordBreak: 'break-all', color: 'var(--muted)' },
    inlineErr: { fontSize: '0.78rem', color: '#ef4444', wordBreak: 'break-word' },
    errBox: {
        padding: '8px 12px',
        borderRadius: '8px',
        background: 'rgba(239,68,68,0.08)',
        border: '1px solid rgba(239,68,68,0.25)',
        color: '#ef4444',
        fontSize: '0.84rem',
    },
    muted: { color: 'var(--muted)', fontStyle: 'italic', fontSize: '0.88rem' },
};

export default StorageBucketApp;
