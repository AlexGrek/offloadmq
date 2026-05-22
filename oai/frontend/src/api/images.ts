export interface UploadedImage {
  image_id: string
  filename: string
  content_type: string
  width: number
  height: number
  size_bytes: number
  rescaled: boolean
  reencoded: boolean
}

export interface StartImageJobRequest {
  capability: string
  prompt: string
  negative_prompt?: string | null
  /** When true, send negative_prompt to OffloadMQ; when false, use workflow default. */
  override_negative?: boolean
  width: number
  height: number
  seed?: number | null
  workflow?: 'txt2img' | 'img2img'
  input_image_id?: string | null
  /** OffloadMQ dataPreparation (glob → action), e.g. `{ "*": "scale/768x768" }`. */
  data_preparation?: Record<string, string> | null
}

export interface StartImageJobResponse {
  job_id: string
  status: string
}

export interface ImageRef {
  image_id: string
  filename: string
  width: number
  height: number
  content_type: string
  size_bytes: number
}

export interface PollImageJobResponse {
  job_id: string
  status: string
  stage: string | null
  error: string | null
  output_images: ImageRef[]
}

export interface ImageJobEvent {
  step: string
  state: string
  details: string | null
  created_at: string
}

export interface ImageJobFile {
  image_id: string
  direction: string
  source: string
  filename: string
  content_type: string
  width: number
  height: number
  size_bytes: number
  rescaled: boolean
  reencoded: boolean
}

export interface ImageJobDetails {
  job_id: string
  status: string
  prompt: string
  negative_prompt: string | null
  capability: string
  workflow: string
  width: number
  height: number
  seed: number | null
  input_image_id: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  files: ImageJobFile[]
  events: ImageJobEvent[]
}

export interface ImgGenCapability {
  base: string
  tags: string[]
  raw: string
}

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const headers = new Headers(options?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (!isFormData) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function uploadImage(token: string, file: File): Promise<UploadedImage> {
  const form = new FormData()
  form.append('file', file)
  return request('/api/images/upload', token, { method: 'POST', body: form })
}

export function startImageJob(token: string, payload: StartImageJobRequest): Promise<StartImageJobResponse> {
  return request('/api/images/jobs', token, { method: 'POST', body: JSON.stringify(payload) })
}

export function pollImageJob(token: string, jobId: string): Promise<PollImageJobResponse> {
  return request(`/api/images/jobs/${jobId}/poll`, token, { method: 'POST' })
}

export function listImageJobs(token: string): Promise<ImageJobDetails[]> {
  return request('/api/images/jobs', token)
}

export function getImageJob(token: string, jobId: string): Promise<ImageJobDetails> {
  return request(`/api/images/jobs/${jobId}`, token)
}

/** URL for `<img src>` / links — includes JWT query param (browsers omit Authorization). */
export function imageFileUrl(imageId: string, token: string | null | undefined): string {
  const base = `/api/images/files/${encodeURIComponent(imageId)}`
  if (!token) return base
  return `${base}?token=${encodeURIComponent(token)}`
}

export function listImgGenCapabilities(token: string): Promise<ImgGenCapability[]> {
  return request('/api/images/capabilities', token)
}
