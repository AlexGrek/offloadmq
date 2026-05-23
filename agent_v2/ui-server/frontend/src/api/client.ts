import type {
  AgentStatus,
  CapabilitiesState,
  Settings,
  TaskRecord,
} from "@/types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getSettings: () => request<Settings>("/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>("/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    }),

  getRawConfig: () => request<{ json: string }>("/config/raw"),
  saveRawConfig: (json: string) =>
    request<Settings>("/config/raw", {
      method: "POST",
      body: JSON.stringify({ json }),
    }),

  detectCapabilities: () =>
    request<{ capabilities: string[] }>("/capabilities/detect"),
  getCapabilitiesState: () =>
    request<CapabilitiesState>("/capabilities/state"),
  rescanCapabilities: (restartIfChanged = false) =>
    request<{ capabilities: string[]; changed: boolean; restarted: boolean }>(
      "/capabilities/rescan",
      {
        method: "POST",
        body: JSON.stringify({ restart_if_changed: restartIfChanged }),
      }
    ),
  saveCapabilityPolicy: (policy: {
    regular_disabled: string[];
    sensitive_allowed: string[];
    slavemode_allowed: string[];
  }) =>
    request<Settings>("/capabilities/policy", {
      method: "POST",
      body: JSON.stringify(policy),
    }),

  startAgent: () => request<AgentStatus>("/agent/start", { method: "POST" }),
  stopAgent: () => request<AgentStatus>("/agent/stop", { method: "POST" }),
  getStatus: () => request<AgentStatus>("/agent/status"),
  registerAgent: () =>
    request<{ agentId: string }>("/agent/register", { method: "POST" }),
  getAgentLogs: (n = 100) =>
    request<{ lines: string[] }>(`/agent/logs?n=${n}`),

  listTasks: () => request<{ tasks: TaskRecord[] }>("/tasks"),
  getTask: (id: string) => request<TaskRecord>(`/tasks/${id}`),
  cancelTask: (id: string) =>
    request<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: "POST" }),

  listCustomCaps: () =>
    request<{ caps: { name: string; capability: string }[] }>("/custom/list"),
  getCustomCap: (name: string) =>
    request<{ yaml: string }>(`/custom/get/${encodeURIComponent(name)}`),
  saveCustomCap: (name: string, yaml: string) =>
    request<{ ok: boolean }>("/custom/save", {
      method: "POST",
      body: JSON.stringify({ name, yaml }),
    }),
  deleteCustomCap: (name: string) =>
    request<{ ok: boolean }>("/custom/delete", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  getComfyWorkflows: () =>
    request<{
      workflows: { name: string; namespace: string; task_types: string[] }[];
      standardTaskTypes: string[];
    }>("/comfy/workflows"),
  saveComfyUrl: (comfyui_url: string) =>
    request<Settings>("/comfy/url", {
      method: "POST",
      body: JSON.stringify({ comfyui_url }),
    }),
  addComfyWorkflow: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
    graph_json: string;
  }) =>
    request<{ ok: boolean }>("/comfy/workflows/add", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  deleteComfyWorkflow: (workflow_name: string, namespace: string) =>
    request<{ ok: boolean }>("/comfy/workflows/delete", {
      method: "POST",
      body: JSON.stringify({ workflow_name, namespace }),
    }),
  autodetectComfyParamMap: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
    param_map_json: string;
  }) =>
    request<{ ok: boolean; paramMap: Record<string, unknown> }>(
      "/comfy/workflows/param-map/autodetect",
      { method: "POST", body: JSON.stringify(p) }
    ),

  getSystemInfo: () =>
    request<{ sysinfo: Record<string, unknown> }>("/system/info"),
  getStartupStatus: () =>
    request<{
      platform: string;
      mac_enabled: boolean;
      win_enabled: boolean;
      systemd_installed: boolean;
    }>("/system/startup-status"),
  setWinStartup: (enable: boolean) =>
    request<Settings>(`/system/win-startup?enable=${enable}`, { method: "POST" }),
  setMacStartup: (enable: boolean) =>
    request<Settings>(`/system/mac-startup?enable=${enable}`, { method: "POST" }),
  installSystemd: (host = "0.0.0.0", port = 8090) =>
    request<{ ok: boolean; message?: string }>(
      `/system/install-systemd?host=${host}&port=${port}`,
      { method: "POST" }
    ),
  uninstallSystemd: () =>
    request<{ ok: boolean; message?: string }>("/system/uninstall-systemd", {
      method: "POST",
    }),
  checkUpdate: () => request<Record<string, unknown>>("/update/check"),
  downloadUpdate: () =>
    request<Record<string, unknown>>("/update/download", { method: "POST" }),
};
