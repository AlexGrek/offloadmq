import React, { useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle, Zap } from "lucide-react";
import { runSlavemodeAndPoll } from "./slavemodeApi";

export default function ForceRescanButton({ agentUid, onDone }) {
    const [state, setState] = useState('idle'); // idle | running | done | error
    const [message, setMessage] = useState('');

    const handleRescan = async () => {
        setState('running');
        setMessage('Submitting…');
        try {
            const out = await runSlavemodeAndPoll('slavemode.force-rescan', agentUid, {}, { onProgress: setMessage });
            setState('done');
            setMessage(out?.count != null ? `Rescan complete — ${out.count} caps detected` : 'Rescan complete');
            onDone?.();
        } catch (e) {
            setState('error');
            setMessage(e.message);
        }
    };

    const reset = (e) => { e.stopPropagation(); setState('idle'); setMessage(''); };

    const colors = {
        idle:    { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
        running: { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
        done:    { bg: '#14532d', border: '#166534', text: '#dcfce7' },
        error:   { bg: '#7f1d1d', border: '#991b1b', text: '#fee2e2' },
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
                {state === 'running' ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    : state === 'done' ? <CheckCircle2 size={11} />
                    : state === 'error' ? <AlertTriangle size={11} />
                    : <Zap size={11} />}
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
