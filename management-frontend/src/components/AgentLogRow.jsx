import React, { useState } from "react";
import { BarChart2, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { fmtDate } from "../utils";
import ColorDot from "./ColorDot";
import { SEVERITY_COLORS } from "./agentLogSeverity";

export function SeverityBadge({ severity }) {
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

export function LogRow({ rec, onSelectAgent, onOpenStats, expanded, onToggle }) {
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
        {onSelectAgent && (
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
        )}
        {onOpenStats && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenStats(rec.agentId, rec.agentName); }}
          title="Runner stats"
          style={{
            display: "inline-flex", alignItems: "center", gap: "3px",
            padding: "1px 6px", borderRadius: "4px",
            border: "1px solid var(--border)", background: "var(--input-bg)",
            color: "var(--muted)", cursor: "pointer", fontSize: "10px",
          }}
        >
          <BarChart2 size={10} />
        </button>
        )}
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

