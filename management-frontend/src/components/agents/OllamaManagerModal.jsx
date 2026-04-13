import React, { useState } from "react";
import { getMgmtToken, runSlavemodeAndPoll, runSlavemodeAndPollWithTimeout } from "./slavemodeApi";

const BTN = {
    base: {
        padding: '3px 9px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', transition: 'opacity 0.15s',
    },
    amber: { background: '#78350f', border: '1px solid #92400e', color: '#fef3c7' },
    save:  { background: 'var(--primary)', border: '1px solid var(--primary)', color: '#fff' },
    neutral: { background: 'var(--chip-bg)', border: '1px solid var(--border)', color: 'var(--muted)' },
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

export default function OllamaManagerModal({ agentUid, hasList, hasDelete, hasPull }) {
    const [open, setOpen] = useState(false);
    const [models, setModels] = useState(null);
    const [loadingModels, setLoadingModels] = useState(false);
    const [pullName, setPullName] = useState('');
    const [pulling, setPulling] = useState(false);
    const [pullStatus, setPullStatus] = useState({ msg: '', kind: '' });
    const [opStatus, setOpStatus] = useState({ msg: '', kind: '' });

    async function fetchModels() {
        if (!hasList) return;
        setLoadingModels(true);
        try {
            const out = await runSlavemodeAndPoll(
                'slavemode.ollama-list',
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
        if (!window.confirm(`Delete model "${name}" from this agent?`)) return;
        setOpStatus({ msg: `Deleting ${name}…`, kind: 'running' });
        try {
            await runSlavemodeAndPoll(
                'slavemode.ollama-delete',
                { runner: agentUid, model: name },
                getMgmtToken(),
            );
            setOpStatus({ msg: `Deleted "${name}"`, kind: 'ok' });
            await fetchModels();
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        }
    }

    async function pullModel(e) {
        e.stopPropagation();
        const name = pullName.trim();
        if (!hasPull || !name || pulling) return;
        setPulling(true);
        setPullStatus({ msg: 'Starting pull…', kind: 'running' });
        try {
            // Large models can take many minutes — allow up to 30 min
            await runSlavemodeAndPollWithTimeout(
                'slavemode.ollama-pull',
                { runner: agentUid, model: name },
                getMgmtToken(),
                1800,
            );
            setPullStatus({ msg: `"${name}" pulled successfully`, kind: 'ok' });
            setPullName('');
            await fetchModels();
        } catch (e) {
            setPullStatus({ msg: e.message, kind: 'error' });
        } finally {
            setPulling(false);
        }
    }

    return (
        <>
            <button onClick={openModal} style={btn('amber')}>
                Ollama
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
                            <span style={{ fontSize: '14px', fontWeight: 700, color: '#f59e0b' }}>Ollama Models</span>
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

                        {/* Pull section */}
                        {hasPull && (
                            <div>
                                <SectionLabel>Pull model</SectionLabel>
                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                    <input
                                        value={pullName}
                                        onChange={e => setPullName(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && pullModel(e)}
                                        placeholder="e.g. llama3.2:3b"
                                        disabled={pulling}
                                        style={{
                                            flex: 1, minWidth: '140px',
                                            padding: '4px 8px', borderRadius: '5px',
                                            border: '1px solid var(--border)',
                                            background: 'var(--input-bg)', color: 'var(--text)',
                                            fontSize: '12px', fontFamily: 'monospace', outline: 'none',
                                            opacity: pulling ? 0.6 : 1,
                                        }}
                                    />
                                    <button
                                        onClick={pullModel}
                                        disabled={pulling || !pullName.trim()}
                                        style={btn('save', pulling || !pullName.trim())}
                                    >
                                        {pulling ? 'Pulling…' : 'Pull'}
                                    </button>
                                </div>
                                {pullStatus.msg && (
                                    <div style={{ marginTop: '5px', fontSize: '11px', color: statusColor(pullStatus.kind), display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span>{pullStatus.msg}</span>
                                        {pullStatus.kind !== 'running' && (
                                            <button
                                                onClick={() => setPullStatus({ msg: '', kind: '' })}
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
                                    <SectionLabel>Installed models</SectionLabel>
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
                                    <span style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic' }}>No models installed</span>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        {models.map(m => (
                                            <div
                                                key={m.name}
                                                style={{
                                                    background: 'var(--chip-bg)', borderRadius: '6px',
                                                    padding: '7px 10px',
                                                    border: '1px solid rgba(217,119,6,0.2)',
                                                    display: 'flex', alignItems: 'center',
                                                    justifyContent: 'space-between', gap: '8px',
                                                }}
                                            >
                                                <div>
                                                    <code style={{ fontSize: '12px', color: 'var(--text)' }}>{m.name}</code>
                                                    {m.size_human && (
                                                        <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '8px' }}>
                                                            {m.size_human}
                                                        </span>
                                                    )}
                                                </div>
                                                {hasDelete && (
                                                    <button onClick={() => deleteModel(m.name)} style={btn('danger')}>
                                                        Delete
                                                    </button>
                                                )}
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
