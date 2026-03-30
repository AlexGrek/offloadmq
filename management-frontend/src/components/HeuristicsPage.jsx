import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch, fmtDate } from "../utils";
import Banner from "./Banner";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function ms(val) {
  if (val == null) return "—";
  return val < 1000 ? `${Math.round(val)} ms` : `${(val / 1000).toFixed(2)} s`;
}

function pct(val) {
  if (val == null) return "—";
  return `${val.toFixed(1)}%`;
}

function Mono({ children }) {
  return (
    <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{children}</span>
  );
}

function SuccessBadge({ success }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "12px",
      fontSize: "11px",
      fontWeight: 600,
      color: "#fff",
      background: success ? "#22c55e" : "#ef4444",
    }}>
      {success ? "ok" : "fail"}
    </span>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border)", marginBottom: "16px" }}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: "8px 16px",
            border: "none",
            borderBottom: active === t.id ? "2px solid var(--primary)" : "2px solid transparent",
            background: "none",
            cursor: "pointer",
            fontWeight: active === t.id ? 600 : 400,
            color: active === t.id ? "var(--primary)" : "var(--muted)",
            fontSize: "13px",
            marginBottom: "-1px",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Filter bar ──────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, onApply, loading }) {
  const [local, setLocal] = useState(filters);
  useEffect(() => setLocal(filters), [filters]);

  const set = (k, v) => setLocal(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onChange(local);
    onApply(local);
  };

  return (
    <form onSubmit={handleSubmit}
      style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
      {[
        { key: "capability", placeholder: "capability" },
        { key: "runner_id",  placeholder: "runner ID" },
        { key: "machine_id", placeholder: "machine ID" },
      ].map(({ key, placeholder }) => (
        <input
          key={key}
          value={local[key] ?? ""}
          onChange={e => set(key, e.target.value)}
          placeholder={placeholder}
          style={{
            padding: "5px 10px", borderRadius: "6px", fontSize: "13px",
            border: "1px solid var(--border)", background: "var(--input-bg)",
            color: "var(--text)", width: "160px",
          }}
        />
      ))}
      <button type="submit" className="btn" disabled={loading}>Apply</button>
      <button type="button" className="btn"
        onClick={() => { const empty = { capability: "", runner_id: "", machine_id: "" }; onChange(empty); onApply(empty); }}>
        Clear
      </button>
    </form>
  );
}

// ─── Records tab ─────────────────────────────────────────────────────────────

const LIMIT = 50;

function RecordsTab() {
  const [filters, setFilters] = useState({ capability: "", runner_id: "", machine_id: "" });
  const [items, setItems]     = useState([]);
  const [cursor, setCursor]   = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]     = useState("");

  const fetchPage = useCallback(async (f, cur, append) => {
    const setter = append ? setLoadingMore : setLoading;
    setter(true);
    if (!append) setError("");
    try {
      const params = new URLSearchParams({ limit: LIMIT });
      if (f.capability) params.set("capability", f.capability);
      if (f.runner_id)  params.set("runner_id",  f.runner_id);
      if (f.machine_id) params.set("machine_id", f.machine_id);
      if (cur)          params.set("cursor", cur);

      const data = await apiFetch(`/management/heuristics/records?${params}`);
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

  // Initial load
  useEffect(() => { fetchPage(filters, null, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = (f) => fetchPage(f, null, false);
  const handleRefresh = () => fetchPage(filters, null, false);

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <FilterBar filters={filters} onChange={setFilters} onApply={handleApply} loading={loading} />
        <button className="btn" onClick={handleRefresh} disabled={loading}>
          <RefreshCw size={14} /> <span>Refresh</span>
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)", fontSize: "14px" }}>
          No records found
        </div>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--muted)", textAlign: "left" }}>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Time</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Capability</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Runner</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Machine</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Duration</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.recordId} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: "var(--muted)", verticalAlign: "top" }}>
                    {fmtDate(r.completedAt)}
                  </td>
                  <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                    <Mono>{r.capability}</Mono>
                  </td>
                  <td style={{ padding: "8px 10px", verticalAlign: "top", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Mono>{r.runnerId}</Mono>
                  </td>
                  <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                    {r.machineId ? <Mono>{r.machineId}</Mono> : <span style={{ color: "var(--muted)" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 10px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                    {ms(r.executionTimeMs)}
                  </td>
                  <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                    <SuccessBadge success={r.success} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {hasMore && (
            <div style={{ padding: "16px", textAlign: "center" }}>
              <button className="btn" onClick={() => fetchPage(filters, cursor, true)}
                disabled={loadingMore} style={{ minWidth: "120px" }}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Shared stats table ───────────────────────────────────────────────────────

function StatsTable({ items, idLabel, idKey, loading, error, onRefresh }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
        <button className="btn" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} /> <span>Refresh</span>
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)", fontSize: "14px" }}>
          No data yet
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "8px 10px", fontWeight: 500 }}>Capability</th>
              <th style={{ padding: "8px 10px", fontWeight: 500 }}>{idLabel}</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Runs</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Success%</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Avg (ok)</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Min (ok)</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Max (ok)</th>
              <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Avg (fail)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px" }}><Mono>{r.capability}</Mono></td>
                <td style={{ padding: "8px 10px", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <Mono>{r[idKey]}</Mono>
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{r.totalRuns}</td>
                <td style={{ padding: "8px 10px", textAlign: "right",
                    color: r.successPct >= 90 ? "var(--success, #22c55e)" : r.successPct < 50 ? "var(--danger, #ef4444)" : undefined }}>
                  {pct(r.successPct)}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{ms(r.successAvgMs)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{ms(r.successMinMs)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{ms(r.successMaxMs)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: r.failAvgMs != null ? "var(--danger, #ef4444)" : undefined }}>
                  {ms(r.failAvgMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function useStatsTab(endpoint) {
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(endpoint);
      setItems(data.items ?? []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  return { items, loading, error, fetch: fetch_ };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "records",  label: "Records" },
  { id: "runners",  label: "Runner Stats" },
  { id: "machines", label: "Machine Stats" },
];

export default function HeuristicsPage() {
  const [tab, setTab] = useState("records");

  const runners  = useStatsTab("/management/heuristics/stats/runners");
  const machines = useStatsTab("/management/heuristics/stats/machines");

  // Lazy-load stats tabs on first visit
  const loadedTabs = useRef(new Set());
  useEffect(() => {
    if (!loadedTabs.current.has(tab)) {
      loadedTabs.current.add(tab);
      if (tab === "runners")  runners.fetch();
      if (tab === "machines") machines.fetch();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Heuristics</div>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === "records" && <RecordsTab />}

      {tab === "runners" && (
        <StatsTable
          items={runners.items}
          idLabel="Runner ID"
          idKey="runnerId"
          loading={runners.loading}
          error={runners.error}
          onRefresh={runners.fetch}
        />
      )}

      {tab === "machines" && (
        <StatsTable
          items={machines.items}
          idLabel="Machine ID"
          idKey="machineId"
          loading={machines.loading}
          error={machines.error}
          onRefresh={machines.fetch}
        />
      )}
    </div>
  );
}
