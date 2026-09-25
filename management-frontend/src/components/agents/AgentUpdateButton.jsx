import React, { useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle, Download } from "lucide-react";
import { getMgmtToken, runSlavemodeAndPoll } from "./slavemodeApi";

const CAP = 'slavemode.agent-update';

const COLORS = {
    idle:     { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
    busy:     { bg: '#78350f', border: '#92400e', text: '#fef3c7' },
    offer:    { bg: '#1e3a8a', border: '#1e40af', text: '#dbeafe' },
    done:     { bg: '#14532d', border: '#166534', text: '#dcfce7' },
    error:    { bg: '#7f1d1d', border: '#991b1b', text: '#fee2e2' },
};

/**
 * Two-step agent self-update: the first click only checks versions, the
 * second (shown only when a newer release exists) starts the update. The agent
 * installs it once idle and systemd restarts it — the version chip on the card
 * changes when it's back.
 */
export default function AgentUpdateButton({ agentUid, onDone }) {
    const [state, setState] = useState('idle'); // idle | busy | offer | done | error
    const [message, setMessage] = useState('');

    const run = async (checkOnly) => {
        const mgmtToken = getMgmtToken();
        if (!mgmtToken) { setState('error'); setMessage('No management token set.'); return; }
        setState('busy');
        setMessage(checkOnly ? 'Checking…' : 'Requesting update…');
        try {
            const out = await runSlavemodeAndPoll(CAP, { runner: agentUid, check: checkOnly }, mgmtToken);
            if (checkOnly) {
                if (out?.has_update) {
                    setState('offer');
                    setMessage(`${out.current} → ${out.latest}`);
                } else {
                    setState('done');
                    setMessage(`Up to date (${out?.current ?? '?'})`);
                }
            } else if (out?.updating) {
                setState('done');
                setMessage(`Updating to ${out.latest} — restarts when idle`);
                onDone?.();
            } else {
                setState('done');
                setMessage(`Up to date (${out?.current ?? '?'})`);
            }
        } catch (e) {
            setState('error');
            setMessage(e.message);
        }
    };

    const onClick = (e) => {
        e.stopPropagation();
        if (state === 'idle') run(true);
        else if (state === 'offer') run(false);
    };
    const reset = (e) => { e.stopPropagation(); setState('idle'); setMessage(''); };
    const c = COLORS[state];

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
                onClick={onClick}
                disabled={state === 'busy'}
                title={state === 'offer' ? 'Install the new version and restart the agent' : 'Check for a newer agent release'}
                style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    padding: '4px 10px', borderRadius: '5px', fontSize: '12px', fontWeight: 600,
                    background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                    cursor: state === 'busy' ? 'not-allowed' : 'pointer',
                    opacity: state === 'busy' ? 0.8 : 1,
                    transition: 'all 0.15s',
                }}
            >
                {state === 'busy' ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    : state === 'done' ? <CheckCircle2 size={11} />
                    : state === 'error' ? <AlertTriangle size={11} />
                    : <Download size={11} />}
                {state === 'offer' ? 'Update now' : 'Agent update'}
            </button>
            {message && (
                <span style={{ fontSize: '11px', color: state === 'error' ? '#f87171' : state === 'done' ? '#4ade80' : 'var(--muted)', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message}
                </span>
            )}
            {(state === 'done' || state === 'error' || state === 'offer') && (
                <button onClick={reset} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✕</button>
            )}
        </div>
    );
}
