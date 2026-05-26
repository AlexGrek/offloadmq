import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Copy, RefreshCw, X } from "lucide-react";
import { apiFetch, fmtDate } from "../utils";
import Banner from "./Banner";
import ColorDot from "./ColorDot";

const SEVERITIES = ["CRITICAL", "ERROR", "INFO"];

const SEVERITY_COLORS = {
  CRITICAL: { bg: "rgba(220, 38, 38, 0.15)", border: "rgba(220, 38, 38, 0.35)", fg: "#ef4444" },
  ERROR:    { bg: "rgba(217, 119, 6, 0.15)", border: "rgba(217, 119, 6, 0.35)", fg: "#f59e0b" },
  INFO:     { bg: "rgba(59, 130, 246, 0.15)", border: "rgba(59, 130, 246, 0.35)", fg: "#60a5fa" },
};

function SeverityBadge({ severity }) {
  const c = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.INFO;
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "10px",
      fontSize: "11px",
      fontWeight: 600,
      color: c.fg,
      background: c.bg,
      border: `1px solid ${c.border}`,
      whiteSpace: "nowrap",
      fontFamily: "monospace",
    }}>
      {severity}
    </span>
  );
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // ignore — clipboard may be blocked in non-secure contexts
  }
}

function CopyButton({ value, label }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label ? `Copy ${label}` : "Copy"}
      onClick={async (e) => {
        e.stopPropagation();
        await copyText(typeof value === "string" ? value : JSON.stringify(value));
        setDone(true);
        setTimeout(() => setDone(false), 900);
      }}
      style={{
        display: "inline-flex", alignItems: "center", gap: "3px",
        padding: "2px 5px", border: "1px solid var(--border)",
        background: done ? "rgba(34,197,94,0.15)" : "transparent",
        color: done ? "#22c55e" : "var(--muted)",
        borderRadius: "4px", cursor: "pointer", fontSize: "10px",
      }}
    >
      <Copy size={10} />
      {done && <span>ok</span>}
    </button>
  );
}

function Field({ label, value, mono = true }) {
  if (value == null || value === "") return null;
  const display = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "4px 0" }}>
      <span style={{ color: "var(--muted)", fontSize: "11px", minWidth: "110px", flexShrink: 0 }}>{label}</span>
      <span style={{
        flex: 1,
        fontFamily: mono ? "monospace" : "inherit",
        fontSize: "12px",
        wordBreak: "break-all",
        whiteSpace: "pre-wrap",
        color: "var(--text)",
      }}>{display}</span>
      <CopyButton value={display} label={label} />
    </div>
  );
}

function LogRow({ rec, onSelectAgent, expanded, onToggle }) {
  const fingerprintSeed = rec.machineFingerprint || rec.agentId || "";
  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: "8px",
      background: "var(--glass)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: "10px",
          padding: "8px 12px", cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ color: "var(--muted)", display: "inline-flex" }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <ColorDot seed={fingerprintSeed} size={12} title={rec.machineFingerprint || ""} />
        <SeverityBadge severity={rec.severity} />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelectAgent(rec.agentId); }}
          title="Filter by this agent ID"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text)", fontFamily: "monospace", fontSize: "12px",
            padding: 0, textDecoration: "underline dotted",
          }}
        >
          {rec.agentName || rec.agentId}
        </button>
        <span style={{
          flex: 1, minWidth: 0,
          fontFamily: "monospace", fontSize: "12px",
          color: "var(--text)", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {rec.text}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "11px", whiteSpace: "nowrap" }}>
          {fmtDate(rec.timestamp)}
        </span>
      </div>

      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "8px 14px",
          background: "var(--code-bg, rgba(0,0,0,0.15))",
        }}>
          <Field label="record id" value={rec.recordId} />
          <Field label="timestamp" value={rec.timestamp} />
          <Field label="severity" value={rec.severity} />
          <Field label="agent id" value={rec.agentId} />
          <Field label="agent name" value={rec.agentName || ""} />
          <Field label="machine fp" value={rec.machineFingerprint || ""} />
          <Field label="text" value={rec.text} />
          <div style={{ marginTop: "8px", display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => copyText(JSON.stringify(rec, null, 2))}
              style={{
                display: "inline-flex", alignItems: "center", gap: "5px",
                padding: "4px 10px", borderRadius: "5px",
                border: "1px solid var(--border)", background: "transparent",
                color: "var(--text)", cursor: "pointer", fontSize: "11px",
              }}
            >
              <Copy size={11} /> Copy as JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentLogsPage() {
  const [selectedSeverities, setSelectedSeverities] = useState(new Set(["ALL", ...SEVERITIES]));
  const [agentFilter, setAgentFilter] = useState("");      // active filter
  const [agentInput, setAgentInput]   = useState("");      // input field
  const [items, setItems]             = useState([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const [expanded, setExpanded]       = useState(() => new Set());
  const [limit, setLimit]             = useState(100);

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
            />
          ))}
        </div>
      )}
    </div>
  );
}
