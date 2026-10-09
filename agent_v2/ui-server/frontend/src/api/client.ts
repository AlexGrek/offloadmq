import type {
  AgentStatus,
  AutoUpdateStatus,
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
    request<{
      caps: {
        name: string;
        capability: string;
        type: string;
        description: string;
        params: { name: string; type: string }[];
      }[];
    }>("/custom/list"),
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
  uploadCustomCap: async (file: File): Promise<{ ok: boolean }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(BASE + "/custom/upload", { method: "POST", body: fd });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try { const b = await res.json(); if (b?.detail) detail = b.detail; } catch { /* ignore */ }
      throw new Error(detail);
    }
    return res.json() as Promise<{ ok: boolean }>;
  },

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
  getComfyProcess: () =>
    request<import("@/types").ComfyProcessStatus>("/comfy/process"),
  comfyProcessAction: (action: "start" | "stop" | "restart") =>
    request<import("@/types").ComfyProcessStatus>(`/comfy/process/${action}`, {
      method: "POST",
    }),
  saveComfyLaunch: (
    p: Partial<
      Pick<
        Settings,
        | "comfyui_launch_on_startup"
        | "comfyui_restart_on_crash"
        | "comfyui_python"
        | "comfyui_main_py"
        | "comfyui_args"
      >
    >
  ) =>
    request<Settings>("/comfy/process/settings", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  detectComfyInstall: () =>
    request<{ install: import("@/types").ComfyInstall | null }>(
      "/comfy/process/detect"
    ),

  saveKokoroSettings: (p: { kokoro_api_url: string; kokoro_api_key: string }) =>
    request<Settings>("/kokoro/settings", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  getKokoroStatus: () =>
    request<{ ok: boolean; capabilities: string[]; reason: string }>(
      "/kokoro/status"
    ),
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
  renameComfyWorkflow: (p: {
    workflow_name: string;
    namespace: string;
    new_workflow_name: string;
    new_namespace: string;
  }) =>
    request<{ ok: boolean }>("/comfy/workflows/rename", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  duplicateComfyWorkflow: (p: {
    workflow_name: string;
    namespace: string;
    new_workflow_name: string;
    new_namespace: string;
  }) =>
    request<{ ok: boolean }>("/comfy/workflows/duplicate", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  getComfyWorkflowGraph: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
  }) => {
    const q = new URLSearchParams(p).toString();
    return request<{ graph_json: string }>(`/comfy/workflows/graph?${q}`);
  },
  getComfyParamMap: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
  }) => {
    const q = new URLSearchParams(p).toString();
    return request<import("@/types").ParamMapData>(`/comfy/workflows/param-map?${q}`);
  },
  saveComfyParamMap: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
    params: import("@/types").ParamMap;
  }) =>
    request<{ ok: boolean }>("/comfy/workflows/param-map", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  autodetectComfyParamMap: (p: {
    workflow_name: string;
    task_type: string;
    namespace: string;
    param_map_json: string;
  }) =>
    request<{
      ok: boolean;
      paramMap: import("@/types").ParamMap;
      notes: import("@/types").ParamNotes;
    }>("/comfy/workflows/param-map/autodetect", {
      method: "POST",
      body: JSON.stringify(p),
    }),

  getSystemInfo: () =>
    request<{ sysinfo: Record<string, unknown> }>("/system/info"),
  getDefaultDisplayName: () =>
    request<{ display_name: string }>("/system/default-display-name"),
  getStartupStatus: () =>
    request<{
      platform: string;
      mac_enabled: boolean;
      win_enabled: boolean;
      systemd_installed: boolean;
      gui_mode: boolean;
      keep_awake_available: boolean;
      keep_awake_active: boolean;
      keep_awake_enabled: boolean;
      keep_awake_method: string;
      battery_pause_available: boolean;
      pause_on_battery: boolean;
      on_battery: boolean | null;
      power_paused: boolean;
    }>("/system/startup-status"),
  setKeepAwake: (enable: boolean) =>
    request<Settings>(`/system/keep-awake?enable=${enable}`, { method: "POST" }),
  setPauseOnBattery: (enable: boolean) =>
    request<Settings>(`/system/pause-on-battery?enable=${enable}`, {
      method: "POST",
    }),
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
  getAutoUpdate: () => request<AutoUpdateStatus>("/update/auto"),
  runAutoUpdate: () =>
    request<AutoUpdateStatus>("/update/auto/run", { method: "POST" }),
};
