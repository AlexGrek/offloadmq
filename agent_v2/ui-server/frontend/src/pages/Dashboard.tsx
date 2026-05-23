import { useCallback, useEffect, useRef, useState } from "react";
import { api, AgentStatus } from "../api";
import { LogPane } from "../components/LogPane";
import { StatusBadge } from "../components/StatusBadge";

const POLL_MS = 2000;

export function Dashboard() {
  const [status, setStatus] = useState<AgentStatus>({
    running: false,
    agentId: "",
    capabilities: [],
  });
  const [logs, setLogs] = useState<string[]>([]);
  const logCursor = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await api.getStatus());
    } catch {
      // server may not be ready yet
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await api.getLogs(logCursor.current);
      if (res.logs.length > 0) {
        setLogs((prev) => [...prev, ...res.logs]);
        logCursor.current += res.logs.length;
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    const id = setInterval(() => {
      fetchStatus();
      fetchLogs();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus, fetchLogs]);

  const toggleAgent = async () => {
    if (status.running) {
      await api.stopAgent();
    } else {
      await api.startAgent();
    }
    await fetchStatus();
  };

  return (
    <div style={{ padding: "32px 24px", maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 700, color: "#fff" }}>
        OffloadMQ Agent
      </h1>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <StatusBadge running={status.running} />
        {status.agentId && (
          <span style={{ fontSize: 12, color: "#666" }}>ID: {status.agentId}</span>
        )}
        <button
          onClick={toggleAgent}
          style={{
            marginLeft: "auto",
            padding: "6px 18px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 13,
            background: status.running ? "#7f1d1d" : "#14532d",
            color: "#fff",
          }}
        >
          {status.running ? "Stop" : "Start"}
        </button>
      </div>

      {status.capabilities.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Capabilities</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {status.capabilities.map((cap) => (
              <span
                key={cap}
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "#1e293b",
                  fontSize: 12,
                  color: "#94a3b8",
                  border: "1px solid #334155",
                }}
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Logs</div>
      <LogPane logs={logs} />
    </div>
  );
}
