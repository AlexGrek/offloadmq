import { useEffect, useCallback, useState, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "../utils";
import Banner from "./Banner";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import AgentCard from "./agents/AgentCard";

export default function AgentsPage() {
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
                        <AgentCard key={a.uid} a={a} onDelete={onDelete} onRescanDone={() => load(true)} />
                    ))}
                </ul>
            )}

            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
