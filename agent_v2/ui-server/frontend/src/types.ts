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
  paused?: boolean;
  message: string;
  agentId: string;
  server: string;
  capabilities: string[];
  maxConcurrent: number;
  activeTasks: number;
  displayName?: string;
  sysinfo?: Record<string, unknown>;
  scanning?: boolean;
  version?: string;
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
  rescan_interval_secs: number;
  comfyui_url: string;
  comfyui_launch_on_startup: boolean;
  comfyui_restart_on_crash: boolean;
  comfyui_python: string;
  comfyui_main_py: string;
  comfyui_args: string[];
  llm_runtime_enabled: boolean;
  llm_runtime_cache_limit: number;
  ollama_base_url: string;
  kokoro_api_url: string;
  kokoro_api_key: string;
  win_startup_enabled: boolean;
  mac_startup_enabled: boolean;
  keep_awake_enabled: boolean;
  pause_on_battery: boolean;
  auto_update_enabled: boolean;
  auto_update_interval_hours: number;
  shell_workspace_root: string;
  shell_restrict_workspace: boolean;
  agent_id: string;
  key: string;
  jwt_token: string;
  token_expires_in: number;
}

export type ComfyProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "crash-loop"
  | "external";

export interface ComfyProcessStatus {
  state: ComfyProcessState;
  managed: boolean;
  adopted: boolean;
  pid: number | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastError: string;
  restartsInWindow: number;
  maxRestarts: number;
  windowMinutes: number;
  url: string;
  configProblem: string | null;
  command: string[];
  logPath: string;
  output: string[];
}

export interface ComfyInstall {
  name: string;
  source: string;
  python: string;
  mainPy: string;
  args: string[];
  url: string;
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

export type ParamTarget = [string, string];
export type ParamMap = Record<string, ParamTarget[] | null>;

export interface InputOption {
  node_id: string;
  input_name: string;
  class_type: string;
  kind: "wire" | "literal";
  preview: string;
}

export interface StandardField {
  key: string;
  label: string;
  help: string;
}

/** Why a field was left unwired, keyed by param field name. Produced by
 *  auto-detect only — never persisted to params.json. */
export type ParamNotes = Record<string, string>;

export interface ParamMapData {
  ok: boolean;
  params: ParamMap;
  standard_fields: StandardField[];
  extra_keys: string[];
  input_options: InputOption[];
  notes: ParamNotes;
}

export interface AutoUpdateStatus {
  phase: "idle" | "unsupported" | "checking" | "downloading" | "waiting-for-idle" | "restarting";
  current: string;
  latest: string | null;
  last_check: string | null;
  error: string | null;
  enabled: boolean;
  interval_hours: number;
  unsupported_reason: string | null;
}

export type SharpJob = {
  state: "idle" | "running" | "succeeded" | "failed";
  action: "install" | "repair" | "uninstall" | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  log: string[];
};

export type SharpStatus = {
  ready: boolean;
  venv_dir: string;
  models_dir: string;
  has_venv: boolean;
  has_model: boolean;
  model_bytes: number;
  manifest: {
    revision?: string;
    torch?: string;
    cuda?: boolean;
    device?: string | null;
    torch_index?: string;
    installed_at?: number;
  };
  summary: string;
  settings: { sharp_venv_dir: string; sharp_models_dir: string; sharp_torch_index: string };
  default_venv_dir: string;
  default_models_dir: string;
  source_available: boolean;
  uv_available: boolean;
  job: SharpJob;
};

export type SharpDoctorReport = {
  ok: boolean;
  action: "install" | "reinstall" | null;
  checks: { name: string; ok: boolean; detail: string }[];
};

export type BgRemoveModel = {
  name: string;
  short: string;
  capability: string;
  description: string;
  filename: string;
  installed: boolean;
  present: boolean;
  size_bytes: number;
  expected_bytes: number | null;
  default: boolean;
};

export type BgRemoveStatus = {
  ready: boolean;
  summary: string;
  models_dir: string;
  models: BgRemoveModel[];
  device: string;
  threads: number;
  keep_loaded: boolean;
  onnxruntime: string | null;
  available_providers: string[];
  providers: string[];
  device_error: string | null;
  settings: {
    onnx_models_dir: string;
    bgremove_device: string;
    bgremove_threads: number;
    bgremove_keep_loaded: boolean;
  };
  default_models_dir: string;
  device_choices: string[];
  job: Omit<SharpJob, "action"> & { action: "install" | "repair" | "uninstall" | null };
};

export type BgRemoveDoctorReport = {
  ok: boolean;
  action: "install" | "redownload" | null;
  redownload: string[];
  checks: { name: string; ok: boolean; detail: string }[];
};

export type Pano360Models = {
  unet: string | null;
  clip_l: string | null;
  t5: string | null;
  vae: string | null;
  lora: string | null;
};

export type Pano360Status = {
  ready: boolean;
  summary: string;
  comfyui_url: string;
  reachable: boolean;
  models: Pano360Models;
  problems: string[];
  choices: { unet: string[]; clip_l: string[]; t5: string[]; vae: string[] };
  settings: {
    pano360_unet: string;
    pano360_clip_l: string;
    pano360_t5: string;
    pano360_vae: string;
    pano360_lora_dir: string;
  };
  lora: {
    name: string;
    url: string;
    bytes: number;
    license: string;
    target_dir: string | null;
    installed_path: string | null;
  };
  job: Omit<SharpJob, "action"> & { action: "install" | "repair" | "uninstall" | null };
};

export type Pano360DoctorReport = {
  ok: boolean;
  action: "install" | null;
  checks: { name: string; ok: boolean; detail: string }[];
};

export type MirrorStatus = {
  ready: boolean;
  installed: boolean;
  license_accepted: boolean;
  summary: string;
  dir: string;
  default_dir: string;
  has_venv: boolean;
  has_code: boolean;
  has_model: boolean;
  model_bytes: number;
  download_bytes: number;
  manifest: { revision?: string; torch?: string; device?: string };
  settings: { mirror_dir: string; mirror_license_accepted: boolean; mirror_free_ollama: boolean };
  license: { notice: string; url: string };
  uv_available: boolean;
  git_available: boolean;
  job: Omit<SharpJob, "action"> & { action: "install" | "repair" | "uninstall" | null };
};

export type MirrorDoctorReport = {
  ok: boolean;
  action: "install" | "reinstall" | null;
  checks: { name: string; ok: boolean; detail: string }[];
};
