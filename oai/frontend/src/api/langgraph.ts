import { apiRequest as request } from './http'

export interface RuntimeCapability { base: string; tags: string[]; raw: string }
export interface LanggraphRequest {
  capability: string
  models: Record<string, string>
  main_py: string
  tools_py: string
  pyproject: string
  system_prompt: string
  user_prompt: string
  allowed_tools: string[] | null
  resources: unknown
  output: { data_file?: string | null; files: string[] }
  runtime_secs: number
}
export interface LanggraphSummary {
  job_id: string
  status: string
  capability: string
  prompt: string
  created_at: string
  updated_at: string
}
export interface LanggraphJob extends LanggraphSummary {
  request: LanggraphRequest
  result: Record<string, unknown> | null
  artifacts: { filename: string; content_type: string; size_bytes: number }[]
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
}
const base = '/api/langgraph'
export const listRuntimeCapabilities = (token: string) => request<RuntimeCapability[]>(`${base}/capabilities`, token)
export const listLanggraphJobs = (token: string) => request<LanggraphSummary[]>(`${base}/jobs`, token)
export const getLanggraphJob = (token: string, id: string, signal?: AbortSignal) => request<LanggraphJob>(`${base}/jobs/${id}`, token, { signal })
export const startLanggraphJob = (token: string, body: LanggraphRequest) => request<{ job_id: string }>(`${base}/jobs`, token, { method: 'POST', body: JSON.stringify(body) })
export const pollLanggraphJob = (token: string, id: string, signal?: AbortSignal) => request<LanggraphJob>(`${base}/jobs/${id}/poll`, token, { method: 'POST', signal })
export const cancelLanggraphJob = (token: string, id: string) => request(`${base}/jobs/${id}/cancel`, token, { method: 'POST' })
export const retryLanggraphJob = (token: string, id: string) => request<{ job_id: string }>(`${base}/jobs/${id}/retry`, token, { method: 'POST' })
export const deleteLanggraphJob = (token: string, id: string) => request<void>(`${base}/jobs/${id}`, token, { method: 'DELETE' })
export const langgraphArtifactUrl = (token: string, id: string, index: number) => `${base}/jobs/${id}/artifacts/${index}?token=${encodeURIComponent(token)}`
export const terminal = (status: string) => ['completed', 'failed', 'canceled'].includes(status)
