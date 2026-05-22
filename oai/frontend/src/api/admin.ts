const BASE = '/api/admin'

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export async function amIAdmin(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/am_i_admin`, { headers: authHeaders(token) })
    if (!res.ok) return false
    const data = await res.json() as { is_admin: boolean }
    return data.is_admin
  } catch {
    return false
  }
}

export interface AdminSettings {
  offloadmq_url: string
  client_api_token: string | null
  management_api_token: string | null
}

async function adminRequest<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders(token),
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getSettings(token: string) {
  return adminRequest<AdminSettings>('/settings', token)
}

export function updateSettings(token: string, settings: AdminSettings) {
  return adminRequest<AdminSettings>('/settings', token, {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export interface TokenCheckResult {
  ok: boolean
  error: string | null
}

export interface CheckConnectionResponse {
  client_token: TokenCheckResult | null
  management_token: TokenCheckResult | null
}

export function checkConnection(token: string, settings: AdminSettings) {
  return adminRequest<CheckConnectionResponse>('/check_connection', token, {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export interface ImageWorkerLogPayload {
  component?: string
  tick_secs?: number
  batch_size?: number
  started_at?: string
  finished_at?: string
  duration_ms?: number
  status?: string
  error?: string | null
  raw?: unknown
}

export interface AdminImageWorkerLog {
  id: string
  run_id: string
  level: string
  message: string
  data_json: ImageWorkerLogPayload
  created_at: string
}

export function listImageWorkerLogs(token: string) {
  return adminRequest<AdminImageWorkerLog[]>('/images/worker_logs', token)
}

export type K8sComponent = 'app' | 'postgres' | 'garage'

export interface K8sPodCondition {
  condition_type: string
  status: string
  reason: string | null
  message: string | null
}

export interface K8sContainerStatus {
  name: string
  ready: boolean
  restart_count: number
  state: unknown
}

export interface K8sPodStatus {
  component: string
  name: string
  namespace: string
  phase: string | null
  pod_ip: string | null
  host_ip: string | null
  start_time: string | null
  ready: boolean
  conditions: K8sPodCondition[]
  containers: K8sContainerStatus[]
}

export interface K8sPodLogs {
  component: string
  pod: string
  namespace: string
  container: string
  tail_lines: number
  content: string
}

export function getK8sPodStatus(token: string, component: K8sComponent) {
  const qs = new URLSearchParams({ component })
  return adminRequest<K8sPodStatus>(`/k8s/self/pod?${qs}`, token)
}

export function getK8sPodLogs(token: string, component: K8sComponent, tailLines = 100) {
  const qs = new URLSearchParams({
    component,
    tail_lines: String(tailLines),
  })
  return adminRequest<K8sPodLogs>(`/k8s/self/logs?${qs}`, token)
}
