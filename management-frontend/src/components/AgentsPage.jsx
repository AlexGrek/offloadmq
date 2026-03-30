import React, { useEffect, useCallback, useState, useRef } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import * as jsyaml from 'js-yaml';
import { apiFetch, fmtDate, stripCapabilityAttrs, parseCapabilityAttrs, TOKEN_KEY } from "../utils";
import { RefreshCw, Cpu, Zap, AlertTriangle, CheckCircle2, Clock, ChevronDown, ChevronUp, Layers, Gauge, Fingerprint, SquareArrowRight } from "lucide-react";
import Banner from "./Banner";
import Chip from "./Chip";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import AttributeTag from "./AttributeTag";
import ColorDot from "./ColorDot";

// ---------- Slavemode helpers ----------

async function submitSlavemodeTask(capability, payload, mgmtToken) {
    const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MGMT-API-KEY': mgmtToken,
        },
        body: JSON.stringify({ capability, payload, apiKey: 'mgmt' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

async function runSlavemodeAndPoll(capability, payload, mgmtToken) {
    const submitData = await submitSlavemodeTask(capability, payload, mgmtToken);
    const taskId = submitData?.id?.id;
    const taskCap = submitData?.id?.cap;
    if (!taskId || !taskCap) throw new Error('Unexpected submit response');

    const MAX_ATTEMPTS = 30;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await pollTask(taskCap, taskId, mgmtToken);
        const status = poll?.status || '';
        if (poll?.output != null || status === 'completed' || status === 'failed') {
            if (status === 'failed' || poll?.error) {
                const raw = poll?.output;
                const msg = typeof raw === 'string' ? raw : raw?.error ?? (raw != null ? JSON.stringify(raw) : null);
                throw new Error(msg || poll?.error || 'Task failed');
            }
            return poll?.output;
        }
    }
    throw new Error('Timed out waiting for agent');
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
            const submitData = await submitSlavemodeTask('slavemode.force-rescan', {}, mgmtToken);
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
                            const raw = poll?.output;
                            const outputMsg = typeof raw === 'string' ? raw : raw?.error ?? (raw != null ? JSON.stringify(raw) : null);
                            setMessage(outputMsg || poll?.error || 'Task failed');
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

// ---------- SpecialCapsCtrl ----------

const SHELL_TEMPLATE = `name: my-cap
type: shell
description: Shell script custom cap
script: |
  #!/bin/bash
  set -euo pipefail
  echo "Hello from \${CUSTOM_NAME}"
params:
  - name: name
    type: string
    default: World
timeout: 120
`;

const LLM_TEMPLATE = `name: my-llm-cap
type: llm
description: LLM prompt custom cap
model: mistral:7b
prompt: |
  Answer the following question in {{style}} style:
  {{question}}
system: You are a helpful assistant.
temperature: 0.7
max_tokens: 512
params:
  - name: question
    type: text
  - name: style
    type: string
    default: concise
`;

function smBtnStyle(bg, border, color, disabled = false) {
    return {
        padding: '3px 9px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
        background: bg, border: `1px solid ${border}`, color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
    };
}

function SpecialCapsCtrl({ agentUid }) {
    const [open, setOpen] = useState(false);
    const [caps, setCaps] = useState(null);
    const [loadingCaps, setLoadingCaps] = useState(false);
    const [yaml, setYaml] = useState('');
    const [opStatus, setOpStatus] = useState({ msg: '', kind: '' });
    const [saving, setSaving] = useState(false);

    function getMgmtToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

    async function fetchCaps() {
        setLoadingCaps(true);
        try {
            const out = await runSlavemodeAndPoll(
                'slavemode.special-caps-ctrl',
                { runner: agentUid, get: true },
                getMgmtToken(),
            );
            setCaps(out?.caps || []);
            setOpStatus({ msg: '', kind: '' });
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        } finally {
            setLoadingCaps(false);
        }
    }

    function handleToggle(e) {
        e.stopPropagation();
        if (!open) {
            setOpen(true);
            if (caps === null) fetchCaps();
        } else {
            setOpen(false);
        }
    }

    async function saveCap(e) {
        e.stopPropagation();
        let parsed;
        try {
            parsed = jsyaml.load(yaml);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('Must be a YAML object');
            }
        } catch (err) {
            setOpStatus({ msg: `YAML error: ${err.message}`, kind: 'error' });
            return;
        }
        setSaving(true);
        setOpStatus({ msg: 'Saving…', kind: 'running' });
        try {
            await runSlavemodeAndPoll(
                'slavemode.special-caps-ctrl',
                { runner: agentUid, set: parsed },
                getMgmtToken(),
            );
            setYaml('');
            setOpStatus({ msg: 'Saved', kind: 'ok' });
            await fetchCaps();
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        } finally {
            setSaving(false);
        }
    }

    async function deleteCap(name) {
        if (!window.confirm(`Delete custom cap "${name}"?`)) return;
        setOpStatus({ msg: 'Deleting…', kind: 'running' });
        try {
            await runSlavemodeAndPoll(
                'slavemode.special-caps-ctrl',
                { runner: agentUid, delete: name },
                getMgmtToken(),
            );
            setOpStatus({ msg: `Deleted "${name}"`, kind: 'ok' });
            await fetchCaps();
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        }
    }

    function editCap(cap) {
        try {
            setYaml(jsyaml.dump(cap));
        } catch {
            setYaml('');
        }
    }

    const statusColor = opStatus.kind === 'error' ? '#f87171'
        : opStatus.kind === 'ok' ? '#4ade80'
        : 'var(--muted)';

    return (
        <div
            style={{ borderTop: '1px solid rgba(217,119,6,0.2)', marginTop: '10px', paddingTop: '10px', width: '100%' }}
            onClick={e => e.stopPropagation()}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                    onClick={handleToggle}
                    style={smBtnStyle('#78350f', '#92400e', '#fef3c7')}
                >
                    {open ? '▴' : '▾'} Custom Caps
                </button>
                {opStatus.msg && (
                    <span style={{ fontSize: '11px', color: statusColor, maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {opStatus.msg}
                    </span>
                )}
                {opStatus.msg && (opStatus.kind === 'ok' || opStatus.kind === 'error') && (
                    <button onClick={() => setOpStatus({ msg: '', kind: '' })} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✕</button>
                )}
            </div>

            {open && (
                <div style={{ marginTop: '10px' }}>
                    {/* Editor section */}
                    <div style={{ marginBottom: '14px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#f59e0b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            Custom Cap Editor
                        </div>
                        <textarea
                            value={yaml}
                            onChange={e => setYaml(e.target.value)}
                            placeholder={'name: my-cap\ntype: shell\ndescription: ...'}
                            rows={12}
                            style={{
                                width: '100%', boxSizing: 'border-box',
                                fontFamily: 'monospace', fontSize: '12px',
                                background: '#0d1117', color: '#e6edf3',
                                border: '1px solid rgba(217,119,6,0.3)',
                                borderRadius: '6px', padding: '10px',
                                resize: 'vertical', outline: 'none',
                                lineHeight: 1.6,
                            }}
                        />
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                            <button
                                onClick={saveCap}
                                disabled={!yaml.trim() || saving}
                                style={smBtnStyle('#1e3a5f', '#2563eb', '#93c5fd', !yaml.trim() || saving)}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={e => { e.stopPropagation(); setYaml(SHELL_TEMPLATE); }} style={smBtnStyle('#292524', '#44403c', '#d6d3d1')}>
                                Shell template
                            </button>
                            <button onClick={e => { e.stopPropagation(); setYaml(LLM_TEMPLATE); }} style={smBtnStyle('#292524', '#44403c', '#d6d3d1')}>
                                LLM template
                            </button>
                            {yaml.trim() && (
                                <button onClick={e => { e.stopPropagation(); setYaml(''); }} style={smBtnStyle('#3b0a0a', '#7f1d1d', '#fca5a5')}>
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Installed caps list */}
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                Installed custom caps
                            </span>
                            <button
                                onClick={e => { e.stopPropagation(); fetchCaps(); }}
                                disabled={loadingCaps}
                                style={{ background: 'none', border: 'none', cursor: loadingCaps ? 'not-allowed' : 'pointer', color: 'var(--muted)', fontSize: '13px', padding: '0 2px', opacity: loadingCaps ? 0.5 : 1 }}
                            >
                                ↻
                            </button>
                        </div>
                        {loadingCaps ? (
                            <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Loading…</span>
                        ) : (caps === null || caps.length === 0) ? (
                            <span style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic' }}>No custom caps installed</span>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {caps.map(cap => (
                                    <div key={cap.name} style={{
                                        background: 'rgba(0,0,0,0.3)', borderRadius: '6px',
                                        padding: '8px 10px', border: '1px solid rgba(217,119,6,0.15)',
                                        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px',
                                    }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>
                                                {cap.name}
                                                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--muted)', marginLeft: '6px' }}>{cap.type}</span>
                                            </div>
                                            {cap.description && (
                                                <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{cap.description}</div>
                                            )}
                                            <code style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px', display: 'block', wordBreak: 'break-all' }}>{cap.capability}</code>
                                            {cap.params?.length > 0 && (
                                                <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>
                                                    Params: {cap.params.map(p => p.name).join(', ')}
                                                </div>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                            <button onClick={e => { e.stopPropagation(); editCap(cap); }} style={smBtnStyle('#1e293b', '#334155', '#94a3b8')}>
                                                Edit
                                            </button>
                                            <button onClick={e => { e.stopPropagation(); deleteCap(cap.name); }} style={smBtnStyle('#3b0a0a', '#7f1d1d', '#fca5a5')}>
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------- AgentCard ----------

function relativeTime(iso) {
    if (!iso) return 'Never';
    const diff = Math.round((new Date(iso) - Date.now()) / 60000);
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(diff, 'minute');
}

function AgentCard({ a, onDelete, onRescanDone }) {
    const [isOpen, setIsOpen] = useState(false);
    const [capsExpanded, setCapsExpanded] = useState(false);
    const slavemodeCapabilities = (a.capabilities || []).filter(c => stripCapabilityAttrs(c).startsWith('slavemode.'));
    const hasForceRescan = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.force-rescan');
    const hasSpecialCapsCtrl = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.special-caps-ctrl');
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
                    userSelect: 'none', flexWrap: 'wrap',
                }}
            >
                <ColorDot seed={a.systemInfo?.machineId || ''} />

                {/* Identity */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px', fontFamily: 'monospace' }}>
                            {a.uidShort || a.uid}
                        </span>
                        {a.displayName && (
                            <span style={{ fontSize: '13px', color: 'var(--text)' }}>— {a.displayName}</span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                        <Chip><Layers size={10} style={{ marginRight: 3 }} />{a.tier}</Chip>
                        <Chip><Gauge size={10} style={{ marginRight: 3 }} />{a.capacity}</Chip>
                        <Chip><Cpu size={10} style={{ marginRight: 3 }} />{(a.capabilities || []).length}</Chip>
                        {a.appVersion && <Chip>{a.appVersion}</Chip>}
                        {a.systemInfo?.machineId && (
                            <Chip><Fingerprint size={10} style={{ marginRight: 3 }} />{a.systemInfo.machineId}</Chip>
                        )}
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
                                    {a.appVersion && <KV label="Version" value={a.appVersion} />}
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
                                            {!!a.systemInfo.gpu.vramGb && <KV label="VRAM" value={`${a.systemInfo.gpu.vramGb} GB`} />}
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
                                        <SquareArrowRight />
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                                        {hasForceRescan && (
                                            <ForceRescanButton onDone={onRescanDone} />
                                        )}
                                        {slavemodeCapabilities
                                            .filter(c => !['slavemode.force-rescan', 'slavemode.special-caps-ctrl'].includes(stripCapabilityAttrs(c)))
                                            .map((c, i) => (
                                                <span key={i} style={{
                                                    fontSize: '12px', padding: '2px 8px', borderRadius: '4px',
                                                    background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.3)',
                                                    color: '#fbbf24', fontFamily: 'monospace',
                                                }}>
                                                    {stripCapabilityAttrs(c)}
                                                </span>
                                            ))
                                        }
                                    </div>
                                    {hasSpecialCapsCtrl && (
                                        <SpecialCapsCtrl agentUid={a.uid} />
                                    )}
                                </div>
                            )}
                            <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                                <ExpandableDeleteButton onDelete={() => onDelete(a.uid)} itemName={a.uid} />
                            </div>
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
