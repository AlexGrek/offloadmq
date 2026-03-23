import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiFetch, fmtDate } from "../utils";
import Banner from "./Banner";

const KIND_COLORS = {
  "heuristics-cleanup-job": "#a78bfa",
  "storage-cleanup-job":    "#22c55e",
};

function kindBadge(kind) {
  const color = KIND_COLORS[kind] ?? "#94a3b8";
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "12px",
      fontSize: "11px",
      fontWeight: 600,
      color: "#fff",
      background: color,
      whiteSpace: "nowrap",
    }}>
      {kind}
    </span>
  );
}

function ContentCell({ content }) {
  const [open, setOpen] = useState(false);
  const preview = Object.entries(content ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("  ·  ");

  return (
    <div>
      <button
        onClick={() => setOpen(s => !s)}
        style={{
          display: "inline-flex", alignItems: "center", gap: "4px",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--muted)", fontSize: "12px", padding: 0,
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span style={{ fontFamily: "monospace", color: "var(--text)" }}>{preview}</span>
      </button>
      {open && (
        <pre style={{
          marginTop: "6px", padding: "8px 12px",
          background: "var(--code-bg)", borderRadius: "6px",
          fontSize: "12px", fontFamily: "monospace",
          color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-all",
        }}>
          {JSON.stringify(content, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function ServiceLogsPage() {
  const [msgClass, setMsgClass]     = useState("bg");
  const [inputClass, setInputClass] = useState("bg");
  const [items, setItems]           = useState([]);
  const [cursor, setCursor]         = useState(null);   // for next page
  const [hasMore, setHasMore]       = useState(false);
  const [loading, setLoading]       = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState("");

  const LIMIT = 50;

  const fetchPage = useCallback(async (cls, cur, append) => {
    const setter = append ? setLoadingMore : setLoading;
    setter(true);
    if (!append) setError("");
    try {
      const params = new URLSearchParams({ class: cls, limit: LIMIT });
      if (cur) params.set("cursor", cur);
      const data = await apiFetch(`/management/service_logs?${params}`);
      if (append) {
        setItems(prev => [...prev, ...(data.items ?? [])]);
      } else {
        setItems(data.items ?? []);
      }
      setCursor(data.next_cursor ?? null);
      setHasMore(!!data.next_cursor);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setter(false);
    }
  }, []);

  // Initial load whenever class changes
  useEffect(() => { fetchPage(msgClass, null, false); }, [fetchPage, msgClass]);

  const handleApply = (e) => {
    e.preventDefault();
    const cls = inputClass.trim() || "bg";
    setInputClass(cls);
    setMsgClass(cls);
  };

  const handleRefresh = () => fetchPage(msgClass, null, false);
  const handleLoadMore = () => fetchPage(msgClass, cursor, true);

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Service Logs</div>
        <div className="actions">
          <form onSubmit={handleApply} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <label style={{ fontSize: "13px", color: "var(--muted)", fontWeight: 500 }}>Class</label>
            <input
              value={inputClass}
              onChange={e => setInputClass(e.target.value)}
              placeholder="bg"
              style={{
                padding: "5px 10px", borderRadius: "6px", fontSize: "13px",
                border: "1px solid var(--border)", background: "var(--input-bg)",
                color: "var(--text)", width: "110px",
              }}
            />
            <button type="submit" className="btn">Apply</button>
          </form>
          <button className="btn" onClick={handleRefresh} disabled={loading}>
            <RefreshCw size={14} /> <span>Refresh</span>
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)", fontSize: "14px" }}>
          No messages found for class <code>{msgClass}</code>
        </div>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--muted)", textAlign: "left" }}>
                <th style={{ padding: "8px 12px", fontWeight: 500, width: "160px" }}>Time</th>
                <th style={{ padding: "8px 12px", fontWeight: 500, width: "200px" }}>Kind</th>
                <th style={{ padding: "8px 12px", fontWeight: 500 }}>Content</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.recordId}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "10px 12px", color: "var(--muted)", whiteSpace: "nowrap", verticalAlign: "top" }}>
                    {fmtDate(item.timestamp)}
                  </td>
                  <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                    {kindBadge(item.messageKind)}
                  </td>
                  <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                    <ContentCell content={item.messageContent} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {hasMore && (
            <div style={{ padding: "16px", textAlign: "center" }}>
              <button
                className="btn"
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{ minWidth: "120px" }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
