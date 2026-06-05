export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LogLevel = "info" | "progress" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  stage: string;
  message: string;
  data: Record<string, unknown>;
}

export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  output: Record<string, unknown>;
  error: string | null;
}

export interface TaskRecord {
  id: string;
  capability: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  logs: LogEntry[];
  result: TaskResult | null;
  error: string | null;
}

export interface AgentStatus {
  running: boolean;
  online: boolean;
  message: string;
  agentId: string;
  server: string;
  capabilities: string[];
  maxConcurrent: number;
  activeTasks: number;
  displayName?: string;
  sysinfo?: Record<string, unknown>;
  scanning?: boolean;
}

export interface Settings {
  server: string;
  api_key: string;
  display_name: string;
  capabilities: string[];
  custom_caps: string[];
  max_concurrent: number;
  autostart: boolean;
  webui_port: number;
  regular_disabled_caps: string[];
  sensitive_allowed_caps: string[];
  slavemode_allowed_caps: string[];
  comfyui_url: string;
  kokoro_api_url: string;
  kokoro_api_key: string;
  win_startup_enabled: boolean;
  mac_startup_enabled: boolean;
  keep_awake_enabled: boolean;
  agent_id: string;
  key: string;
  jwt_token: string;
  token_expires_in: number;
}

export interface TierCaps {
  regular: string[];
  sensitive: string[];
  unknown: string[];
  regularDisabled: string[];
  sensitiveAllowed: string[];
  slavemodeAllowed: string[];
  slavemodeAll: string[];
}

export interface CapabilitiesState {
  caps: string[];
  sysinfo: Record<string, unknown>;
  scanning: boolean;
  tierCaps: TierCaps;
}

export const TERMINAL_STATUSES: TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];
