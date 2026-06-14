import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Monitor, RefreshCw, Server } from "lucide-react";
import { apiFetch } from "../utils";
import Banner from "./Banner";

const DEFAULT_TAIL = 500;

const COMPONENTS = [
  { id: "server", label: "Server", short: "MQ", icon: Server },
  { id: "frontend", label: "Management UI", short: "UI", icon: Monitor },
];

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function parseApiError(err) {
  const msg = err?.message ?? String(err);
  try {
    const jsonStart = msg.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(msg.slice(jsonStart));
      if (parsed?.error?.message) return parsed.error.message;
    }
  } catch {
    /* use raw message */
  }
  return msg;
}

function PhaseBadge({ phase, ready }) {
  const ok = ready && phase === "Running";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "12px",
        fontSize: "12px",
        fontWeight: 600,
        color: "#fff",
        background: ok ? "var(--success, #22c55e)" : "var(--warn, #f59e0b)",
      }}
      data-testid="pod-logs-phase-badge"
    >
      {phase ?? "Unknown"}
      {!ready ? " · not ready" : ""}
    </span>
  );
}

function ExitStatusBanner({ exit, label = "Previous instance" }) {
  if (!exit || exit.phase !== "terminated") return null;
  const failed = exit.exit_code != null && exit.exit_code !== 0;
  return (
    <div
      data-testid="pod-logs-previous-exit"
      style={{
        marginBottom: "10px",
        padding: "10px 12px",
        borderRadius: "8px",
        fontSize: "13px",
        background: failed ? "rgba(239, 68, 68, 0.12)" : "var(--code-bg)",
        border: failed ? "1px solid rgba(239, 68, 68, 0.35)" : "1px solid var(--border, #333)",
      }}
    >
      <strong>{label}</strong>
      {" · "}
      {exit.exit_code != null ? `exit ${exit.exit_code}` : "terminated"}
      {exit.reason ? ` · ${exit.reason}` : ""}
      {exit.finished_at ? ` · ended ${exit.finished_at}` : ""}
      {exit.message ? (
        <div style={{ marginTop: "4px", color: "var(--muted)", fontSize: "12px" }}>{exit.message}</div>
      ) : null}
    </div>
  );
}

function LogPre({ content, testId }) {
  if (!content) {
    return (
      <p style={{ color: "var(--muted)" }} data-testid={testId}>
        No log output.
      </p>
    );
  }
  return (
    <pre
      data-testid={testId}
      style={{
        margin: 0,
        padding: "12px 16px",
        background: "var(--code-bg)",
        borderRadius: "8px",
        fontSize: "12px",
        fontFamily: "monospace",
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: "60vh",
        overflow: "auto",
      }}
    >
      {stripAnsi(content)}
    </pre>
  );
}

function buildLogParams({ component, tail, containerTrim, previous, timestamps }) {
  const params = new URLSearchParams({
    component,
    tail_lines: String(tail),
  });
  if (containerTrim) params.set("container", containerTrim);
  if (previous) params.set("previous", "true");
  if (timestamps) params.set("timestamps", "true");
  return params;
}

export default function PodLogsPage() {
  const [component, setComponent] = useState("server");
  const [status, setStatus] = useState(null);
  const [currentLogs, setCurrentLogs] = useState(null);
  const [previousLogs, setPreviousLogs] = useState(null);
  const [previousLogsError, setPreviousLogsError] = useState("");
  const [logView, setLogView] = useState("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tailLines, setTailLines] = useState(String(DEFAULT_TAIL));
  const [container, setContainer] = useState("");
  const [timestamps, setTimestamps] = useState(false);

  const containerTrim = container.trim();

  const activeContainer = useMemo(() => {
    if (!status?.containers?.length) return null;
    if (containerTrim) {
      return status.containers.find((c) => c.name === containerTrim) ?? null;
    }
    const defaults = { server: "offloadmq", frontend: "frontend" };
    const name = defaults[component] ?? status.containers[0]?.name;
    return status.containers.find((c) => c.name === name) ?? status.containers[0];
  }, [status, containerTrim, component]);

  const hasPreviousInstance = activeContainer?.has_previous_instance ?? false;
  const previousExit = activeContainer?.last_state ?? null;

  const fetchDiagnostics = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
        setError("");
        setPreviousLogsError("");
      }
      const tail = Math.min(
        10_000,
        Math.max(1, Number.parseInt(tailLines, 10) || DEFAULT_TAIL),
      );
      const podParams = new URLSearchParams({ component });
      const baseLog = { component, tail, containerTrim, timestamps };
      const currentParams = buildLogParams({ ...baseLog, previous: false });
      const previousParams = buildLogParams({ ...baseLog, previous: true });

      try {
        const podBody = await apiFetch(`/management/k8s/self/pod?${podParams}`);
        setStatus(podBody);

        const currentBody = await apiFetch(`/management/k8s/self/logs?${currentParams}`);
        setCurrentLogs(currentBody);
        setError("");

        const active = (() => {
          if (containerTrim) {
            return podBody.containers?.find((c) => c.name === containerTrim);
          }
          const defaults = { server: "offloadmq", frontend: "frontend" };
          const name = defaults[component];
          return podBody.containers?.find((c) => c.name === name) ?? podBody.containers?.[0];
        })();

        if (active?.has_previous_instance) {
          try {
            const prevBody = await apiFetch(`/management/k8s/self/logs?${previousParams}`);
            setPreviousLogs(prevBody);
            setPreviousLogsError("");
          } catch (err) {
            setPreviousLogs(null);
            setPreviousLogsError(parseApiError(err));
          }
        } else {
          setPreviousLogs(null);
          setPreviousLogsError("");
        }
      } catch (err) {
        setError(parseApiError(err));
        if (showLoading) {
          setStatus(null);
          setCurrentLogs(null);
          setPreviousLogs(null);
        }
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [component, tailLines, containerTrim, timestamps],
  );

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  useEffect(() => {
    if (!hasPreviousInstance && logView === "previous") {
      setLogView("current");
    }
  }, [hasPreviousInstance, logView]);

  const activeMeta = COMPONENTS.find((c) => c.id === component) ?? COMPONENTS[0];
  const displayedLogs = logView === "previous" ? previousLogs : currentLogs;
  const displayedExit =
    logView === "previous"
      ? previousLogs?.previous_exit ?? previousExit
      : activeContainer?.current_state;

  return (
    <div className="page" data-testid="pod-logs-page">
      <div className="page-header">
        <h1>Pod Logs</h1>
        <p style={{ color: "var(--muted)", margin: "4px 0 0", fontSize: "14px" }}>
          Live pod status and container logs from the Kubernetes API (in-cluster only).
        </p>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <nav
          role="tablist"
          aria-label="Stack components"
          data-testid="pod-logs-component-tabs"
          style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
        >
          {COMPONENTS.map(({ id, label, short, icon: Icon }) => {
            const selected = component === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`btn ${selected ? "primary" : ""}`}
                data-testid={`pod-logs-tab-${id}`}
                onClick={() => setComponent(id)}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <Icon size={16} />
                <span className="pod-logs-tab-long">{label}</span>
                <span className="pod-logs-tab-short">{short}</span>
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          className="btn"
          onClick={() => fetchDiagnostics()}
          disabled={loading}
          data-testid="pod-logs-refresh"
          style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
        >
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
          Refresh
        </button>
      </div>

      <div
        className="toolbar"
        data-testid="pod-logs-toolbar"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          alignItems: "flex-end",
          marginBottom: "16px",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
          <span style={{ color: "var(--muted)" }}>Tail lines</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={tailLines}
            onChange={(e) => setTailLines(e.target.value)}
            data-testid="pod-logs-tail-lines"
            style={{ width: "100px" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", flex: "1 1 160px" }}>
          <span style={{ color: "var(--muted)" }}>Container</span>
          <input
            type="text"
            placeholder="optional"
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            data-testid="pod-logs-container"
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
          <input
            type="checkbox"
            checked={timestamps}
            onChange={(e) => setTimestamps(e.target.checked)}
            data-testid="pod-logs-timestamps"
          />
          Timestamps
        </label>
      </div>

      {error && <Banner type="error">{error}</Banner>}

      <section
        data-testid="pod-logs-status-card"
        style={{
          marginBottom: "20px",
          padding: "16px",
          borderRadius: "8px",
          background: "var(--panel, var(--code-bg))",
        }}
      >
        <h2 style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "15px", margin: "0 0 12px" }}>
          <Cloud size={16} />
          {activeMeta.label} pod
        </h2>
        {loading && !status ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : status ? (
          <>
            <p
              data-testid="pod-logs-pod-id"
              style={{ fontFamily: "monospace", fontSize: "13px", margin: "0 0 8px" }}
            >
              {status.namespace}/{status.name}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
              <PhaseBadge phase={status.phase} ready={status.ready} />
              {status.pod_ip && (
                <span style={{ fontSize: "12px", color: "var(--muted)" }}>IP {status.pod_ip}</span>
              )}
              {status.host_ip && (
                <span style={{ fontSize: "12px", color: "var(--muted)" }}>Host {status.host_ip}</span>
              )}
            </div>
            <div data-testid="pod-logs-containers" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {status.containers.map((c) => (
                <div key={c.name} data-testid={`pod-logs-container-row-${c.name}`}>
                  <span
                    data-testid={`pod-logs-container-badge-${c.name}`}
                    style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: c.ready ? "var(--muted)" : "var(--warn, #f59e0b)",
                      color: "#fff",
                    }}
                  >
                    {c.name}
                    {c.restart_count > 0 ? ` · restarts ${c.restart_count}` : ""}
                    {c.current_state?.phase ? ` · ${c.current_state.phase}` : ""}
                  </span>
                  {c.last_state?.phase === "terminated" && (
                    <div
                      style={{ marginTop: "4px", fontSize: "12px", color: "var(--muted)" }}
                      data-testid={`pod-logs-container-previous-exit-${c.name}`}
                    >
                      Previous: exit {c.last_state.exit_code ?? "?"}
                      {c.last_state.reason ? ` (${c.last_state.reason})` : ""}
                      {c.last_state.finished_at ? ` · ${c.last_state.finished_at}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <p style={{ color: "var(--muted)" }} data-testid="pod-logs-status-empty">
            No status available.
          </p>
        )}
      </section>

      <section data-testid="pod-logs-log-section">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
            marginBottom: "10px",
          }}
        >
          <h2 style={{ fontSize: "15px", margin: 0, flex: "1 1 auto" }}>Container logs</h2>
          <nav
            role="tablist"
            aria-label="Log instance"
            data-testid="pod-logs-instance-tabs"
            style={{ display: "flex", gap: "6px" }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={logView === "current"}
              className={`btn ${logView === "current" ? "primary" : ""}`}
              data-testid="pod-logs-view-current"
              onClick={() => setLogView("current")}
            >
              Current
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={logView === "previous"}
              className={`btn ${logView === "previous" ? "primary" : ""}`}
              data-testid="pod-logs-view-previous"
              onClick={() => setLogView("previous")}
              disabled={!hasPreviousInstance}
              title={
                hasPreviousInstance
                  ? "Logs from the previous terminated container instance"
                  : "No previous container instance (no restarts)"
              }
            >
              Previous instance
            </button>
          </nav>
        </div>

        {displayedLogs && (
          <p
            data-testid="pod-logs-log-meta"
            style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--muted)", margin: "0 0 8px" }}
          >
            {displayedLogs.container} · tail {displayedLogs.tail_lines}
            {displayedLogs.previous ? " · previous instance" : " · current instance"}
          </p>
        )}

        {logView === "previous" && previousLogsError && (
          <Banner type="error">{previousLogsError}</Banner>
        )}

        {logView === "previous" && (
          <ExitStatusBanner exit={displayedExit} />
        )}

        {loading && !displayedLogs ? (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        ) : (
          <LogPre
            content={displayedLogs?.content}
            testId="pod-logs-log-content"
          />
        )}
      </section>
    </div>
  );
}
