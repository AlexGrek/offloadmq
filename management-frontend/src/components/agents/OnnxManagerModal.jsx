import React, { useState } from "react";
import { getMgmtToken, runSlavemodeAndPoll, runSlavemodeAndPollWithTimeout } from "./slavemodeApi";

const BTN = {
    base: {
        padding: '3px 9px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', transition: 'opacity 0.15s',
    },
    amber: { background: '#78350f', border: '1px solid #92400e', color: '#fef3c7' },
    save:  { background: 'var(--primary)', border: '1px solid var(--primary)', color: '#fff' },
    danger: { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)' },
};

function btn(variant, disabled = false) {
    return { ...BTN.base, ...BTN[variant], ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}) };
}

function SectionLabel({ children }) {
    return (
        <div style={{ fontSize: '11px', fontWeight: 600, color: '#f59e0b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {children}
        </div>
    );
}

function statusColor(kind) {
    if (kind === 'error') return 'var(--danger)';
    if (kind === 'ok') return '#4ade80';
    return 'var(--muted)';
}

function fmtBytes(n) {
    if (n == null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log2(Math.max(n, 1)) / 10), units.length - 1);
    const val = n / Math.pow(1024, i);
    return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export default function OnnxManagerModal({ agentUid, hasList, hasDelete, hasPrepare }) {
    const [open, setOpen] = useState(false);
    const [models, setModels] = useState(null);
    const [loadingModels, setLoadingModels] = useState(false);
    const [prepareName, setPrepareName] = useState('');
    const [preparing, setPreparing] = useState(false);
    const [prepareStatus, setPrepareStatus] = useState({ msg: '', kind: '' });
    const [opStatus, setOpStatus] = useState({ msg: '', kind: '' });

    async function fetchModels() {
        if (!hasList) return;
        setLoadingModels(true);
        try {
            const out = await runSlavemodeAndPoll(
                'slavemode.onnx-models-list',
                { runner: agentUid },
                getMgmtToken(),
            );
            setModels(out?.models || []);
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        } finally {
            setLoadingModels(false);
        }
    }

    function openModal(e) {
        e.stopPropagation();
        setOpen(true);
        if (models === null) fetchModels();
    }

    function closeModal(e) {
        e?.stopPropagation();
        setOpen(false);
    }

    async function deleteModel(name) {
        if (!hasDelete) return;
        if (!window.confirm(`Delete ONNX model "${name}" from this agent?`)) return;
        setOpStatus({ msg: `Deleting ${name}…`, kind: 'running' });
        try {
            await runSlavemodeAndPoll(
                'slavemode.onnx-models-delete',
                { runner: agentUid, model: name },
                getMgmtToken(),
            );
            setOpStatus({ msg: `Deleted "${name}"`, kind: 'ok' });
            await fetchModels();
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        }
    }

    async function prepareModel(e) {
        e.stopPropagation();
        const name = prepareName.trim();
        if (!hasPrepare || !name || preparing) return;
        setPreparing(true);
        setPrepareStatus({ msg: 'Downloading…', kind: 'running' });
        try {
            await runSlavemodeAndPollWithTimeout(
                'slavemode.onnx-models-prepare',
                { runner: agentUid, model: name },
                getMgmtToken(),
                600,
            );
            setPrepareStatus({ msg: `"${name}" ready`, kind: 'ok' });
            setPrepareName('');
            await fetchModels();
        } catch (e) {
            setPrepareStatus({ msg: e.message, kind: 'error' });
        } finally {
            setPreparing(false);
        }
    }

    return (
        <>
            <button onClick={openModal} style={btn('amber')}>
                ONNX
            </button>

            {open && (
                <div
                    onClick={closeModal}
                    style={{
                        position: 'fixed', inset: 0, zIndex: 1000,
                        background: 'rgba(0,0,0,0.55)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: '20px',
                    }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            width: '100%', maxWidth: '560px', maxHeight: '85vh',
                            overflowY: 'auto',
                            background: 'var(--bg)',
                            border: '1px solid rgba(217,119,6,0.35)',
                            borderRadius: '10px',
                            boxShadow: 'var(--shadow)',
                            padding: '20px',
                            display: 'flex', flexDirection: 'column', gap: '18px',
                        }}
                    >
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '14px', fontWeight: 700, color: '#f59e0b' }}>ONNX Models</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {opStatus.msg && (
                                    <span style={{ fontSize: '11px', color: statusColor(opStatus.kind), maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {opStatus.msg}
                                    </span>
                                )}
                                {opStatus.msg && opStatus.kind !== 'running' && (
                                    <button
                                        onClick={() => setOpStatus({ msg: '', kind: '' })}
                                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}
                                    >✕</button>
                                )}
                                <button
                                    onClick={closeModal}
                                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '0 4px' }}
                                >✕</button>
                            </div>
                        </div>

                        {/* Prepare section */}
                        {hasPrepare && (
                            <div>
                                <SectionLabel>Download model</SectionLabel>
                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                    <input
                                        value={prepareName}
                                        onChange={e => setPrepareName(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && prepareModel(e)}
                                        placeholder="e.g. nudenet"
                                        disabled={preparing}
                                        style={{
                                            flex: 1, minWidth: '140px',
                                            padding: '4px 8px', borderRadius: '5px',
                                            border: '1px solid var(--border)',
                                            background: 'var(--input-bg)', color: 'var(--text)',
                                            fontSize: '12px', fontFamily: 'monospace', outline: 'none',
                                            opacity: preparing ? 0.6 : 1,
                                        }}
                                    />
                                    <button
                                        onClick={prepareModel}
                                        disabled={preparing || !prepareName.trim()}
                                        style={btn('save', preparing || !prepareName.trim())}
                                    >
                                        {preparing ? 'Downloading…' : 'Download'}
                                    </button>
                                </div>
                                {prepareStatus.msg && (
                                    <div style={{ marginTop: '5px', fontSize: '11px', color: statusColor(prepareStatus.kind), display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span>{prepareStatus.msg}</span>
                                        {prepareStatus.kind !== 'running' && (
                                            <button
                                                onClick={() => setPrepareStatus({ msg: '', kind: '' })}
                                                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '10px', padding: '0' }}
                                            >✕</button>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Installed models */}
                        {hasList && (
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                    <SectionLabel>Models</SectionLabel>
                                    <button
                                        onClick={fetchModels}
                                        disabled={loadingModels}
                                        style={{
                                            background: 'none', border: 'none',
                                            cursor: loadingModels ? 'not-allowed' : 'pointer',
                                            color: 'var(--muted)', fontSize: '13px',
                                            padding: '0 2px', opacity: loadingModels ? 0.5 : 1,
                                            marginBottom: '5px',
                                        }}
                                    >↻</button>
                                </div>
                                {loadingModels ? (
                                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Loading…</span>
                                ) : models === null || models.length === 0 ? (
                                    <span style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic' }}>No known models</span>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        {models.map(m => (
                                            <div
                                                key={m.name}
                                                style={{
                                                    background: 'var(--chip-bg)', borderRadius: '6px',
                                                    padding: '7px 10px',
                                                    border: `1px solid ${m.installed ? 'rgba(74,222,128,0.3)' : 'rgba(217,119,6,0.2)'}`,
                                                    display: 'flex', alignItems: 'center',
                                                    justifyContent: 'space-between', gap: '8px',
                                                }}
                                            >
                                                <div style={{ minWidth: 0 }}>
                                                    <code style={{ fontSize: '12px', color: 'var(--text)' }}>{m.name}</code>
                                                    <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '8px' }}>
                                                        {m.installed
                                                            ? `✓ ${m.size_bytes ? fmtBytes(m.size_bytes) : 'installed'}`
                                                            : '✗ not downloaded'}
                                                    </span>
                                                    {m.description && (
                                                        <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {m.description}
                                                        </div>
                                                    )}
                                                </div>
                                                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                    {!m.installed && hasPrepare && (
                                                        <button
                                                            onClick={() => { setPrepareName(m.name); }}
                                                            style={btn('save')}
                                                        >
                                                            Prepare
                                                        </button>
                                                    )}
                                                    {m.installed && hasDelete && (
                                                        <button onClick={() => deleteModel(m.name)} style={btn('danger')}>
                                                            Delete
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
