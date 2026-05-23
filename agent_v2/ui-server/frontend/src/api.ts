const BASE = "/api";

export interface AgentConfig {
  server: string;
  api_key: string;
  capabilities: string[];
  custom_caps: string[];
  tier: number;
  capacity: number;
  autostart: boolean;
}

export interface AgentStatus {
  running: boolean;
  agentId: string;
  capabilities: string[];
}

export interface LogsResponse {
  logs: string[];
  total: number;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => json<AgentConfig>("/config"),
  saveConfig: (cfg: AgentConfig) =>
    json<{ ok: boolean }>("/config", { method: "POST", body: JSON.stringify(cfg) }),

  startAgent: () => json<{ ok: boolean }>("/agent/start", { method: "POST" }),
  stopAgent: () => json<{ ok: boolean }>("/agent/stop", { method: "POST" }),
  getStatus: () => json<AgentStatus>("/agent/status"),
  getLogs: (since = 0) => json<LogsResponse>(`/agent/logs?since=${since}`),

  detectCapabilities: () =>
    json<{ capabilities: string[] }>("/capabilities/detect"),
};
