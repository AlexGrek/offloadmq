export interface NudeDetection {
  label: string
  confidence: number
  box: { x1: number; y1: number; x2: number; y2: number }
}

export interface NudeDetectImageResult {
  file: string
  detections: NudeDetection[]
  detection_count: number
  error?: string
}

export interface NudeDetectResultPayload {
  model: string
  threshold: number
  images_processed: number
  results: NudeDetectImageResult[]
}

export interface NudeDetectJob {
  job_id: string
  status: string
  threshold: number
  input_image_id: string | null
  result: NudeDetectResultPayload | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  created_at: string
  updated_at: string
}

export interface NudeDetectAvailability {
  available: boolean
  capability: string
}

export interface StartNudeDetectJobRequest {
  image_id: string
  threshold: number
}

export interface StartNudeDetectJobResponse {
  job_id: string
  status: string
}

export interface CancelNudeDetectJobResponse {
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

export function getNudeDetectAvailability(token: string): Promise<NudeDetectAvailability> {
  return request('/api/nude-detect/availability', token)
}

export function startNudeDetectJob(
  token: string,
  payload: StartNudeDetectJobRequest,
): Promise<StartNudeDetectJobResponse> {
  return request('/api/nude-detect/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listNudeDetectJobs(token: string): Promise<NudeDetectJob[]> {
  return request('/api/nude-detect/jobs', token)
}

export function getNudeDetectJob(token: string, jobId: string): Promise<NudeDetectJob> {
  return request(`/api/nude-detect/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollNudeDetectJob(token: string, jobId: string): Promise<NudeDetectJob> {
  return request(`/api/nude-detect/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelNudeDetectJob(
  token: string,
  jobId: string,
): Promise<CancelNudeDetectJobResponse> {
  return request(`/api/nude-detect/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryNudeDetectJob(
  token: string,
  jobId: string,
): Promise<StartNudeDetectJobResponse> {
  return request(`/api/nude-detect/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteNudeDetectJob(token: string, jobId: string): Promise<void> {
  return request(`/api/nude-detect/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}
