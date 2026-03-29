import React, { useEffect, useCallback, useState, useRef } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch, fmtDate, stripCapabilityAttrs, parseCapabilityAttrs, TOKEN_KEY } from "../utils";
import { RefreshCw, Cpu, Zap, AlertTriangle, CheckCircle2, Clock, ChevronDown, ChevronUp } from "lucide-react";
import Banner from "./Banner";
import Chip from "./Chip";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import AttributeTag from "./AttributeTag";
import ColorDot from "./ColorDot";

// ---------- Slavemode helpers ----------

async function submitSlavemodeTask(capability, mgmtToken) {
    const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MGMT-API-KEY': mgmtToken,
        },
        body: JSON.stringify({ capability, payload: {}, apiKey: 'mgmt' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

async function pollTask(cap, id, mgmtToken) {
    const res = await fetch(`/api/task/poll/${cap}/${id}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MGMT-API-KEY': mgmtToken,
        },
        body: JSON.stringify({ apiKey: 'mgmt' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

// ---------- ForceRescanButton ----------

function ForceRescanButton({ onDone }) {
    const [state, setState] = useState('idle'); // idle | running | done | error
    const [message, setMessage] = useState('');
    const pollRef = useRef(null);

    const handleRescan = async () => {
        const mgmtToken = localStorage.getItem(TOKEN_KEY) || '';
        if (!mgmtToken) {
            setMessage('No management token set.');
            setState('error');
            return;
        }
        setState('running');
        setMessage('Submitting…');
        try {
            const submitData = await submitSlavemodeTask('slavemode.force-rescan', mgmtToken);
            const taskId = submitData?.id?.id;
            const taskCap = submitData?.id?.cap;
            if (!taskId || !taskCap) throw new Error('Unexpected submit response');
            setMessage('Waiting for agent…');

            // Poll up to 60s
            let elapsed = 0;
            const INTERVAL = 2000;
            const MAX = 60000;
            pollRef.current = window.setInterval(async () => {
                elapsed += INTERVAL;
                try {
                    const poll = await pollTask(taskCap, taskId, mgmtToken);
                    const status = poll?.status || '';
                    if (poll?.output != null || status === 'completed' || status === 'failed') {
                        clearInterval(pollRef.current);
                        if (status === 'failed' || poll?.error) {
                            setState('error');
                            setMessage(poll?.output || poll?.error || 'Task failed');
                        } else {
                            const count = poll?.output?.count;
                            setState('done');
                            setMessage(count != null ? `Rescan complete — ${count} caps detected` : 'Rescan complete');
                            onDone?.();
                        }
                    } else if (elapsed >= MAX) {
                        clearInterval(pollRef.current);
                        setState('error');
                        setMessage('Timed out waiting for agent');
                    } else {
                        setMessage(`${status || 'waiting'}…`);
                    }
                } catch (e) {
                    clearInterval(pollRef.current);
                    setState('error');
                    setMessage(e.message);
                }
            }, INTERVAL);
        } catch (e) {
            setState('error');
            setMessage(e.message);
        }
    };

    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    const reset = (e) => { e.stopPropagation(); setState('idle'); setMessage(''); };

    const colors = {
        idle: { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
        running: { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
        done: { bg: '#14532d', border: '#166534', text: '#dcfce7' },
        error: { bg: '#7f1d1d', border: '#991b1b', text: '#fee2e2' },
    };
    const c = colors[state];

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
                onClick={(e) => { e.stopPropagation(); if (state === 'idle') handleRescan(); }}
                disabled={state === 'running'}
                style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    padding: '4px 10px', borderRadius: '5px', fontSize: '12px', fontWeight: 600,
                    background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                    cursor: state === 'running' ? 'not-allowed' : 'pointer',
                    opacity: state === 'running' ? 0.8 : 1,
                    transition: 'all 0.15s',
                }}
            >
                {state === 'running' ? (
                    <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                ) : state === 'done' ? (
                    <CheckCircle2 size={11} />
                ) : state === 'error' ? (
                    <AlertTriangle size={11} />
                ) : (
                    <Zap size={11} />
                )}
                Force rescan
            </button>
            {message && (
                <span style={{ fontSize: '11px', color: state === 'error' ? '#f87171' : state === 'done' ? '#4ade80' : 'var(--muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message}
                </span>
            )}
            {(state === 'done' || state === 'error') && (
                <button onClick={reset} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✕</button>
            )}
        </div>
    );
}

// ---------- AgentCard ----------

function isOnline(lastContact) {
    if (!lastContact) return false;
    return (Date.now() - new Date(lastContact).getTime()) < 120_000;
}

function relativeTime(iso) {
    if (!iso) return 'Never';
    const diff = Math.round((new Date(iso) - Date.now()) / 60000);
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(diff, 'minute');
}

function AgentCard({ a, onDelete, onRescanDone }) {
    const [isOpen, setIsOpen] = useState(false);
    const [capsExpanded, setCapsExpanded] = useState(false);
    const online = isOnline(a.lastContact);
    const slavemodeCapabilities = (a.capabilities || []).filter(c => stripCapabilityAttrs(c).startsWith('slavemode.'));
    const hasForceRescan = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.force-rescan');
    const regularCaps = (a.capabilities || []).filter(c => !stripCapabilityAttrs(c).startsWith('slavemode.'));
    const visibleCaps = capsExpanded ? regularCaps : regularCaps.slice(0, 4);

    return (
        <li style={{
            borderRadius: '10px',
            border: '1px solid var(--border)',
            background: 'var(--glass)',
            overflow: 'hidden',
            transition: 'box-shadow 0.15s',
        }}>
            {/* Header row */}
            <div
                onClick={() => setIsOpen(v => !v)}
                style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 14px', cursor: 'pointer',
                    userSelect: 'none',
                }}
            >
                {/* Online indicator */}
                <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: online ? '#22c55e' : '#6b7280',
                    boxShadow: online ? '0 0 0 2px rgba(34,197,94,0.25)' : 'none',
                }} />

                <ColorDot seed={a.systemInfo?.machineId || ''} />

                {/* Identity */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px', fontFamily: 'monospace' }}>
                            {a.uidShort || a.uid}
                        </span>
                        {a.systemInfo?.machineId && (
                            <span style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'monospace' }}>
                                {a.systemInfo.machineId}
                            </span>
                        )}
                        {a.displayName && (
                            <span style={{ fontSize: '13px', color: 'var(--text)' }}>— {a.displayName}</span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                        <Chip>Tier {a.tier}</Chip>
                        <Chip>Cap {a.capacity}</Chip>
                        <Chip><Cpu size={10} style={{ marginRight: 3 }} />{(a.capabilities || []).length} caps</Chip>
                        {a.appVersion && <Chip>v{a.appVersion}</Chip>}
                        {a.lastCommMethod === 'WebSocket' && <Chip variant="websocket">WebSocket</Chip>}
                        <Chip>
                            <Clock size={10} style={{ marginRight: 3 }} />
                            {relativeTime(a.lastContact)}
                        </Chip>
                        {hasForceRescan && (
                            <span style={{
                                fontSize: '10px', fontWeight: 600, padding: '1px 6px',
                                borderRadius: '4px', background: 'rgba(217,119,6,0.15)',
                                border: '1px solid rgba(217,119,6,0.3)', color: '#f59e0b',
                            }}>
                                SLAVEMODE
                            </span>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    <ExpandableDeleteButton onDelete={() => onDelete(a.uid)} itemName={a.uid} />
                </div>
                <div style={{ color: 'var(--muted)', flexShrink: 0 }}>
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
            </div>

            {/* Expanded details */}
            <AnimatePresence initial={false}>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
                        style={{ overflow: 'hidden' }}
                    >
                        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                                {/* Identity */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>Identity</div>
                                    {a.displayName && <KV label="Name" value={a.displayName} />}
                                    <KV label="UID" value={a.uid} mono />
                                    <KV label="Registered" value={fmtDate(a.registeredAt)} />
                                    <KV label="Last contact" value={fmtDate(a.lastContact)} />
                                    {a.appVersion && <KV label="Version" value={`v${a.appVersion}`} />}
                                    <KV label="Token" value={a.personalLoginToken} mono />
                                </div>

                                {/* System */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>System</div>
                                    <KV label="OS" value={a.systemInfo?.os} />
                                    <KV label="Client" value={a.systemInfo?.client} />
                                    <KV label="Runtime" value={a.systemInfo?.runtime} />
                                    <KV label="CPU Arch" value={a.systemInfo?.cpuArch} />
                                    {a.systemInfo?.cpuModel && <KV label="CPU" value={a.systemInfo.cpuModel} />}
                                    <KV label="RAM" value={a.systemInfo?.totalMemoryGb != null ? `${a.systemInfo.totalMemoryGb} GB` : null} />
                                    {a.systemInfo?.machineId && <KV label="Machine ID" value={a.systemInfo.machineId} mono />}
                                </div>

                                {/* GPU */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>GPU</div>
                                    {a.systemInfo?.gpu ? (
                                        <>
                                            <KV label="Vendor" value={a.systemInfo.gpu.vendor} />
                                            <KV label="Model" value={a.systemInfo.gpu.model} />
                                            <KV label="VRAM" value={`${a.systemInfo.gpu.vramGb} GB`} />
                                        </>
                                    ) : (
                                        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>No GPU</span>
                                    )}
                                </div>

                                {/* Capabilities */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>
                                        Capabilities ({regularCaps.length})
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {visibleCaps.map((c, i) => {
                                            const base = stripCapabilityAttrs(c);
                                            const attrs = parseCapabilityAttrs(c);
                                            return (
                                                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <Chip>{base}</Chip>
                                                    {attrs.length > 0 && (
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                                                            {attrs.map((attr, j) => <AttributeTag key={j} attr={attr} />)}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {regularCaps.length > 4 && (
                                            <button
                                                onClick={e => { e.stopPropagation(); setCapsExpanded(v => !v); }}
                                                style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--muted)', cursor: 'pointer' }}
                                            >
                                                {capsExpanded ? 'Show less' : `+${regularCaps.length - 4} more`}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Slavemode section */}
                            {slavemodeCapabilities.length > 0 && (
                                <div style={{
                                    marginTop: '12px',
                                    padding: '10px 12px',
                                    borderRadius: '7px',
                                    background: 'rgba(217,119,6,0.08)',
                                    border: '1px solid rgba(217,119,6,0.25)',
                                }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#f59e0b', marginBottom: '8px' }}>
                                        Slavemode
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                                        {hasForceRescan && (
                                            <ForceRescanButton onDone={onRescanDone} />
                                        )}
                                        {slavemodeCapabilities.filter(c => stripCapabilityAttrs(c) !== 'slavemode.force-rescan').map((c, i) => (
                                            <span key={i} style={{
                                                fontSize: '12px', padding: '2px 8px', borderRadius: '4px',
                                                background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.3)',
                                                color: '#fbbf24', fontFamily: 'monospace',
                                            }}>
                                                {stripCapabilityAttrs(c)}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </li>
    );
}

function KV({ label, value, mono }) {
    if (value == null || value === '') return null;
    return (
        <div style={{ display: 'flex', gap: '6px', fontSize: '12px', marginBottom: '3px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}:</span>
            {mono ? (
                <code style={{ fontSize: '11px', wordBreak: 'break-all' }}>{value}</code>
            ) : (
                <b style={{ wordBreak: 'break-word' }}>{value}</b>
            )}
        </div>
    );
}

// ---------- AgentsPage ----------

function AgentsPage() {
    const [agents, setAgents] = useState([]);
    const [initialLoading, setInitialLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const [onlineOnly, setOnlineOnly] = useState(true);
    const agentsRef = useRef(agents);
    agentsRef.current = agents;

    const load = useCallback(async (silent = false) => {
        const isFirst = agentsRef.current.length === 0;
        if (isFirst || !silent) setInitialLoading(true);
        else setRefreshing(true);
        setError('');
        try {
            const url = onlineOnly ? '/management/agents/list/online' : '/management/agents/list';
            const data = await apiFetch(url);
            setAgents(Array.isArray(data) ? data : []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setInitialLoading(false);
            setRefreshing(false);
        }
    }, [onlineOnly]);

    useEffect(() => { load(); }, [load]);

    // Background auto-refresh — no loading flash
    useEffect(() => {
        let intervalId = null;

        const startAutoRefresh = () => {
            if (intervalId !== null) return;
            intervalId = window.setInterval(() => {
                if (document.visibilityState === 'visible') load(true);
            }, 10000);
        };

        const stopAutoRefresh = () => {
            if (intervalId === null) return;
            window.clearInterval(intervalId);
            intervalId = null;
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') { load(true); startAutoRefresh(); }
            else stopAutoRefresh();
        };

        if (document.visibilityState === 'visible') startAutoRefresh();
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            stopAutoRefresh();
        };
    }, [load]);

    const onDelete = useCallback(async (uid) => {
        try {
            await apiFetch(`/management/agents/delete/${encodeURIComponent(uid)}`, { method: 'POST' });
            await load(true);
        } catch (e) {
            alert(`Failed to delete: ${e.message}`);
        }
    }, [load]);

    const handleReset = useCallback(async () => {
        try {
            await apiFetch('/management/agents/reset', { method: 'POST' });
            await load(true);
        } catch (e) {
            alert(`Failed to reset: ${e.message}`);
        }
    }, [load]);

    return (
        <div className="page">
            <div className="page-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div className="title">Agents</div>
                    {refreshing && (
                        <RefreshCw size={13} style={{ color: 'var(--muted)', animation: 'spin 1s linear infinite' }} />
                    )}
                </div>
                <div className="actions">
                    <ExpandableDeleteButton onDelete={handleReset} itemName="everything" customActionText="Reset" />
                    <label className="toggle">
                        <input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />
                        <span>Online only</span>
                    </label>
                    <button className="btn" onClick={() => load()}>
                        <RefreshCw /> <span>Refresh</span>
                    </button>
                </div>
            </div>

            {error && <Banner kind="error">{error}</Banner>}

            {initialLoading ? (
                <div className="loader" aria-busy="true">Loading…</div>
            ) : agents.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)', fontSize: '14px' }}>
                    No agents {onlineOnly ? 'online' : 'registered'}.
                </div>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {agents.map((a) => (
                        <AgentCard
                            key={a.uid}
                            a={a}
                            onDelete={onDelete}
                            onRescanDone={() => load(true)}
                        />
                    ))}
                </ul>
            )}

            <style>{`
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
}

export default AgentsPage;
