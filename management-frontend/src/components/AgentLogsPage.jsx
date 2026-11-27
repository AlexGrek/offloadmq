import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { apiFetch } from "../utils";
import Banner from "./Banner";
import AgentStatsDrawer from "./agents/AgentStatsDrawer";
import { LogRow } from "./AgentLogRow";
import { SEVERITIES, SEVERITY_COLORS } from "./agentLogSeverity";

export default function AgentLogsPage() {
  const [selectedSeverities, setSelectedSeverities] = useState(new Set(["ALL", ...SEVERITIES]));
  const [agentFilter, setAgentFilter] = useState("");      // active filter
  const [agentInput, setAgentInput]   = useState("");      // input field
  const [items, setItems]             = useState([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const [expanded, setExpanded]       = useState(() => new Set());
  const [limit, setLimit]             = useState(100);
  const [statsAgent, setStatsAgent]   = useState(null);   // { uid, displayName }

  const toggleSeverity = (sev) => {
    setSelectedSeverities(prev => {
      const next = new Set(prev);
      if (sev === "ALL") {
        if (next.has("ALL")) {
          next.delete("ALL");
          SEVERITIES.forEach(s => next.delete(s));
        } else {
          next.add("ALL");
          SEVERITIES.forEach(s => next.add(s));
        }
        return next;
      }
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      // ALL is on iff every severity is on
      if (SEVERITIES.every(s => next.has(s))) next.add("ALL");
      else next.delete("ALL");
      return next;
    });
  };

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      let path;
      if (agentFilter) {
        params.set("agent_id", agentFilter);
        path = `/management/agent_logs/by_agent?${params}`;
        const data = await apiFetch(path);
        setItems(Array.isArray(data?.items) ? data.items : []);
      } else {
        const active = SEVERITIES.filter(s => selectedSeverities.has(s));
        if (active.length === 0) {
          setItems([]);
          return;
        }
        if (active.length === SEVERITIES.length) {
          path = `/management/agent_logs/latest?${params}`;
          const data = await apiFetch(path);
          setItems(Array.isArray(data?.items) ? data.items : []);
        } else {
          // fetch each severity, merge & sort
          const all = await Promise.all(active.map(s => {
            const p = new URLSearchParams({ severity: s, limit: String(limit) });
            return apiFetch(`/management/agent_logs/by_severity?${p}`);
          }));
          const merged = [];
          for (const d of all) {
            if (Array.isArray(d?.items)) merged.push(...d.items);
          }
          merged.sort((a, b) => (b.recordId || "").localeCompare(a.recordId || ""));
          setItems(limit > 0 ? merged.slice(0, limit) : merged);
        }
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [agentFilter, selectedSeverities, limit]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const onSelectAgent = (agentId) => {
    setAgentFilter(agentId);
    setAgentInput(agentId);
  };

  const onOpenStats = (agentId, agentName) => {
    setStatsAgent({ uid: agentId, displayName: agentName || null, uidShort: agentId?.slice(0, 8) });
  };

  const clearAgentFilter = () => {
    setAgentFilter("");
    setAgentInput("");
  };

  const applyAgentInput = (e) => {
    e?.preventDefault?.();
    const v = agentInput.trim();
    setAgentFilter(v);
  };

  const toggleExpanded = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Agent Logs</div>
        <div className="actions" style={{ flexWrap: "wrap" }}>
          <form onSubmit={applyAgentInput} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <label style={{ fontSize: "13px", color: "var(--muted)", fontWeight: 500 }}>Agent</label>
            <input
              value={agentInput}
              onChange={e => setAgentInput(e.target.value)}
              placeholder="agent id"
              style={{
                padding: "5px 10px", borderRadius: "6px", fontSize: "12px",
                border: "1px solid var(--border)", background: "var(--input-bg)",
                color: "var(--text)", width: "220px", fontFamily: "monospace",
              }}
            />
            <button type="submit" className="btn">Apply</button>
            {agentFilter && (
              <button type="button" className="btn" onClick={clearAgentFilter} title="Clear agent filter">
                <X size={13} />
              </button>
            )}
          </form>
          <label style={{ fontSize: "13px", color: "var(--muted)", display: "inline-flex", gap: "6px", alignItems: "center" }}>
            Limit
            <input
              type="number"
              value={limit}
              onChange={e => setLimit(Number(e.target.value) || 100)}
              style={{
                padding: "5px 8px", borderRadius: "6px", fontSize: "12px",
                border: "1px solid var(--border)", background: "var(--input-bg)",
                color: "var(--text)", width: "80px",
              }}
            />
          </label>
          <button className="btn" onClick={fetchLogs} disabled={loading}>
            <RefreshCw size={14} /> <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Severity switch — hidden when filtering by agent */}
      {!agentFilter && (
        <div style={{
          display: "flex", gap: "6px", marginBottom: "12px",
          flexWrap: "wrap", alignItems: "center",
        }}>
          <span style={{ fontSize: "12px", color: "var(--muted)", marginRight: "4px" }}>Severity:</span>
          {["ALL", ...SEVERITIES].map(s => {
            const active = selectedSeverities.has(s);
            const c = s === "ALL"
              ? { fg: "var(--text)", bg: active ? "rgba(120,120,120,0.2)" : "transparent" }
              : (active ? SEVERITY_COLORS[s] : { fg: "var(--muted)", bg: "transparent", border: "var(--border)" });
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSeverity(s)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: c.bg,
                  color: c.fg,
                  border: `1px solid ${c.border || "var(--border)"}`,
                  opacity: active ? 1 : 0.55,
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}

      {agentFilter && (
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          marginBottom: "12px", padding: "6px 10px",
          border: "1px solid var(--border)", borderRadius: "6px",
          background: "var(--glass)",
        }}>
          <span style={{ fontSize: "12px", color: "var(--muted)" }}>Filtered by agent:</span>
          <code style={{ fontSize: "12px" }}>{agentFilter}</code>
          <span style={{ fontSize: "11px", color: "var(--muted)" }}>(showing all severities)</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={clearAgentFilter}>
            <X size={12} /> Clear
          </button>
        </div>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)", fontSize: "14px" }}>
          No log records.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {items.map(rec => (
            <LogRow
              key={rec.recordId}
              rec={rec}
              expanded={expanded.has(rec.recordId)}
              onToggle={() => toggleExpanded(rec.recordId)}
              onSelectAgent={onSelectAgent}
              onOpenStats={onOpenStats}
            />
          ))}
        </div>
      )}

      <AgentStatsDrawer agent={statsAgent} onClose={() => setStatsAgent(null)} />
    </div>
  );
}
