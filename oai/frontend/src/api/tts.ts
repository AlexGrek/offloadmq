export interface TtsCapability {
  base: string
  voices: string[]
  raw: string
  online: boolean
  last_available_at: string
}

export interface TtsJob {
  job_id: string
  status: string
  text: string
  capability: string
  voice: string
  model: string
  audio_content_type: string | null
  audio_size_bytes: number | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  created_at: string
  updated_at: string
}

export interface StartTtsJobRequest {
  capability: string
  voice: string
  text: string
}

export interface StartTtsJobResponse {
  job_id: string
  status: string
}

export interface CancelTtsJobResponse {
  job_id: string
  status: string
  message: string
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const headers = new Headers(options?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!isFormData) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
}

export function listTtsCapabilities(token: string): Promise<{ capabilities: TtsCapability[] }> {
  return request('/api/tts/capabilities', token)
}

export function startTtsJob(
  token: string,
  payload: StartTtsJobRequest,
): Promise<StartTtsJobResponse> {
  return request('/api/tts/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listTtsJobs(token: string): Promise<TtsJob[]> {
  return request('/api/tts/jobs', token)
}

export function getTtsJob(token: string, jobId: string): Promise<TtsJob> {
  return request(`/api/tts/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollTtsJob(token: string, jobId: string): Promise<TtsJob> {
  return request(`/api/tts/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelTtsJob(token: string, jobId: string): Promise<CancelTtsJobResponse> {
  return request(`/api/tts/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryTtsJob(token: string, jobId: string): Promise<StartTtsJobResponse> {
  return request(`/api/tts/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteTtsJob(token: string, jobId: string): Promise<void> {
  return request(`/api/tts/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}

/** URL for the synthesized audio blob — JWT travels in `?token=` (browsers omit Authorization on <audio>). */
export function ttsAudioUrl(jobId: string, token: string | null | undefined): string {
  const base = `/api/tts/jobs/${encodeURIComponent(jobId)}/audio`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}
