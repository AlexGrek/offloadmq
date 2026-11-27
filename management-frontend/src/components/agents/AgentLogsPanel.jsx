import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { apiFetch } from "../../utils";
import { LogRow } from "../AgentLogRow";
import { SEVERITIES, SEVERITY_COLORS } from "../agentLogSeverity";

const PAGE_SIZE = 50;

/**
 * Logs reported by one agent, shown inside its expanded card on the Agents page.
 * Mounted only while the card is open, so nothing is fetched for collapsed agents.
 */
export default function AgentLogsPanel({ agentUid }) {
    const [items, setItems] = useState([]);
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [severities, setSeverities] = useState(() => new Set(SEVERITIES));
    const [expanded, setExpanded] = useState(() => new Set());

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const params = new URLSearchParams({ agent_id: agentUid, limit: String(limit) });
            const data = await apiFetch(`/management/agent_logs/by_agent?${params}`);
            setItems(Array.isArray(data?.items) ? data.items : []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, [agentUid, limit]);

    useEffect(() => { load(); }, [load]);

    const toggleSeverity = (sev) => setSeverities(prev => {
        const next = new Set(prev);
        if (next.has(sev)) next.delete(sev); else next.add(sev);
        return next;
    });

    const toggleExpanded = (id) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
    for (const r of items) if (r.severity in counts) counts[r.severity]++;
    const visible = items.filter(r => severities.has(r.severity));
    const mayHaveMore = items.length >= limit;

    return (
        <div style={{ marginTop: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                    <ScrollText size={12} /> Logs ({items.length}{mayHaveMore ? "+" : ""})
                </div>
                {SEVERITIES.map(s => {
                    const active = severities.has(s);
                    const c = SEVERITY_COLORS[s];
                    return (
                        <button
                            key={s}
                            type="button"
                            onClick={() => toggleSeverity(s)}
                            style={{
                                padding: "2px 8px", borderRadius: "999px", fontSize: "10px",
                                fontFamily: "monospace", fontWeight: 600, cursor: "pointer",
                                background: active ? c.bg : "transparent",
                                color: active ? c.fg : "var(--muted)",
                                border: `1px solid ${active ? c.border : "var(--border)"}`,
                                opacity: active ? 1 : 0.55,
                            }}
                        >
                            {s} {counts[s]}
                        </button>
                    );
                })}
                <div style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    title="Refresh logs"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: "2px", display: "inline-flex" }}
                >
                    <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
                </button>
            </div>

            {error && (
                <div style={{ fontSize: "12px", color: "#ef4444", marginBottom: "6px" }}>{error}</div>
            )}

            {loading && items.length === 0 ? (
                <div style={{ fontSize: "12px", color: "var(--muted)", padding: "8px 0" }}>Loading…</div>
            ) : visible.length === 0 ? (
                <div style={{ fontSize: "12px", color: "var(--muted)", padding: "8px 0" }}>
                    {items.length === 0 ? "No log records for this agent." : "No records match the selected severities."}
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "360px", overflowY: "auto" }}>
                    {visible.map(rec => (
                        <LogRow
                            key={rec.recordId}
                            rec={rec}
                            expanded={expanded.has(rec.recordId)}
                            onToggle={() => toggleExpanded(rec.recordId)}
                        />
                    ))}
                </div>
            )}

            {mayHaveMore && (
                <div style={{ marginTop: "6px", display: "flex", justifyContent: "center" }}>
                    <button
                        type="button"
                        onClick={() => setLimit(l => l + PAGE_SIZE)}
                        disabled={loading}
                        style={{ fontSize: "11px", padding: "3px 10px", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--muted)", cursor: "pointer" }}
                    >
                        Load {PAGE_SIZE} more
                    </button>
                </div>
            )}
        </div>
    );
}
