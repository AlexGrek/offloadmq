import React, { useState } from "react";
import * as jsyaml from 'js-yaml';
import { getMgmtToken, runSlavemodeAndPoll } from "./slavemodeApi";

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

const BTN = {
    base: {
        padding: '3px 9px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', transition: 'opacity 0.15s',
    },
    amber: {
        background: '#78350f', border: '1px solid #92400e', color: '#fef3c7',
    },
    save: {
        background: 'var(--primary)', border: '1px solid var(--primary)', color: '#fff',
    },
    neutral: {
        background: 'var(--chip-bg)', border: '1px solid var(--border)', color: 'var(--muted)',
    },
    danger: {
        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)',
    },
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

export default function SpecialCapsModal({ agentUid }) {
    const [open, setOpen] = useState(false);
    const [caps, setCaps] = useState(null);
    const [loadingCaps, setLoadingCaps] = useState(false);
    const [yaml, setYaml] = useState('');
    const [opStatus, setOpStatus] = useState({ msg: '', kind: '' });
    const [saving, setSaving] = useState(false);

    async function fetchCaps() {
        setLoadingCaps(true);
        try {
            const out = await runSlavemodeAndPoll('slavemode.special-caps-ctrl', { runner: agentUid, get: true }, getMgmtToken());
            setCaps(out?.caps || []);
            setOpStatus({ msg: '', kind: '' });
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        } finally {
            setLoadingCaps(false);
        }
    }

    function openModal(e) {
        e.stopPropagation();
        setOpen(true);
        if (caps === null) fetchCaps();
    }

    function closeModal(e) {
        e?.stopPropagation();
        setOpen(false);
    }

    async function saveCap(e) {
        e.stopPropagation();
        let parsed;
        try {
            parsed = jsyaml.load(yaml);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Must be a YAML object');
        } catch (err) {
            setOpStatus({ msg: `YAML error: ${err.message}`, kind: 'error' });
            return;
        }
        setSaving(true);
        setOpStatus({ msg: 'Saving…', kind: 'running' });
        try {
            await runSlavemodeAndPoll('slavemode.special-caps-ctrl', { runner: agentUid, set: parsed }, getMgmtToken());
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
            await runSlavemodeAndPoll('slavemode.special-caps-ctrl', { runner: agentUid, delete: name }, getMgmtToken());
            setOpStatus({ msg: `Deleted "${name}"`, kind: 'ok' });
            await fetchCaps();
        } catch (e) {
            setOpStatus({ msg: e.message, kind: 'error' });
        }
    }

    function editCap(cap) {
        try { setYaml(jsyaml.dump(cap)); } catch { setYaml(''); }
    }

    const statusColor = opStatus.kind === 'error' ? 'var(--danger)' : opStatus.kind === 'ok' ? '#4ade80' : 'var(--muted)';

    return (
        <>
            <button onClick={openModal} style={btn('amber')}>
                Custom Caps
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
                            width: '100%', maxWidth: '640px', maxHeight: '85vh',
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
                            <span style={{ fontSize: '14px', fontWeight: 700, color: '#f59e0b' }}>Custom Caps</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {opStatus.msg && (
                                    <span style={{ fontSize: '11px', color: statusColor, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {opStatus.msg}
                                    </span>
                                )}
                                {opStatus.msg && (opStatus.kind === 'ok' || opStatus.kind === 'error') && (
                                    <button onClick={() => setOpStatus({ msg: '', kind: '' })} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✕</button>
                                )}
                                <button
                                    onClick={closeModal}
                                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '0 4px' }}
                                >
                                    ✕
                                </button>
                            </div>
                        </div>

                        {/* Editor */}
                        <div>
                            <SectionLabel>Custom Cap Editor</SectionLabel>
                            <textarea
                                value={yaml}
                                onChange={e => setYaml(e.target.value)}
                                placeholder={'name: my-cap\ntype: shell\ndescription: ...'}
                                rows={12}
                                style={{
                                    width: '100%', boxSizing: 'border-box',
                                    fontFamily: 'monospace', fontSize: '12px',
                                    background: 'var(--input-bg)', color: 'var(--text)',
                                    border: '1px solid var(--border)',
                                    borderRadius: '6px', padding: '10px',
                                    resize: 'vertical', outline: 'none', lineHeight: 1.6,
                                }}
                            />
                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                                <button onClick={saveCap} disabled={!yaml.trim() || saving} style={btn('save', !yaml.trim() || saving)}>
                                    {saving ? 'Saving…' : 'Save'}
                                </button>
                                <button onClick={() => setYaml(SHELL_TEMPLATE)} style={btn('neutral')}>Shell template</button>
                                <button onClick={() => setYaml(LLM_TEMPLATE)} style={btn('neutral')}>LLM template</button>
                                {yaml.trim() && (
                                    <button onClick={() => setYaml('')} style={btn('danger')}>Clear</button>
                                )}
                            </div>
                        </div>

                        {/* Installed caps */}
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                <SectionLabel>Installed custom caps</SectionLabel>
                                <button
                                    onClick={fetchCaps}
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
                                            background: 'var(--chip-bg)', borderRadius: '6px',
                                            padding: '8px 10px', border: '1px solid rgba(217,119,6,0.2)',
                                            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px',
                                        }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
                                                    {cap.name}
                                                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--muted)', marginLeft: '6px' }}>{cap.type}</span>
                                                </div>
                                                {cap.description && (
                                                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{cap.description}</div>
                                                )}
                                                <code style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '3px', display: 'block', wordBreak: 'break-all' }}>{cap.capability}</code>
                                                {cap.params?.length > 0 && (
                                                    <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>
                                                        Params: {cap.params.map(p => p.name).join(', ')}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                <button onClick={() => editCap(cap)} style={btn('neutral')}>Edit</button>
                                                <button onClick={() => deleteCap(cap.name)} style={btn('danger')}>Delete</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
