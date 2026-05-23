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
}

export interface Settings {
  server: string;
  api_key: string;
  capabilities: string[];
  custom_caps: string[];
  tier: number;
  max_concurrent: number;
  autostart: boolean;
  agent_id: string;
  key: string;
  jwt_token: string;
  token_expires_in: number;
}

export const TERMINAL_STATUSES: TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];
