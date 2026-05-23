import type { AgentStatus, Settings, TaskRecord } from "@/types";

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
      // non-JSON error body
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

  detectCapabilities: () =>
    request<{ capabilities: string[] }>("/capabilities/detect"),

  startAgent: () => request<AgentStatus>("/agent/start", { method: "POST" }),
  stopAgent: () => request<AgentStatus>("/agent/stop", { method: "POST" }),
  getStatus: () => request<AgentStatus>("/agent/status"),

  listTasks: () => request<{ tasks: TaskRecord[] }>("/tasks"),
  getTask: (id: string) => request<TaskRecord>(`/tasks/${id}`),
  cancelTask: (id: string) =>
    request<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: "POST" }),
};
