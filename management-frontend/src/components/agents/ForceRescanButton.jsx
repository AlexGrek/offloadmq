import React, { useEffect, useRef, useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle, Zap } from "lucide-react";
import { getMgmtToken, submitSlavemodeTask, pollTask } from "./slavemodeApi";

export default function ForceRescanButton({ onDone }) {
    const [state, setState] = useState('idle'); // idle | running | done | error
    const [message, setMessage] = useState('');
    const pollRef = useRef(null);

    const handleRescan = async () => {
        const mgmtToken = getMgmtToken();
        if (!mgmtToken) { setMessage('No management token set.'); setState('error'); return; }
        setState('running');
        setMessage('Submitting…');
        try {
            const submitData = await submitSlavemodeTask('slavemode.force-rescan', {}, mgmtToken);
            const taskId = submitData?.id?.id;
            const taskCap = submitData?.id?.cap;
            if (!taskId || !taskCap) throw new Error('Unexpected submit response');
            setMessage('Waiting for agent…');

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
                            const msg = typeof raw === 'string' ? raw : raw?.error ?? (raw != null ? JSON.stringify(raw) : null);
                            setMessage(msg || poll?.error || 'Task failed');
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
