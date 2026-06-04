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

export interface ImagePipelineRescaleParams {
  enabled: boolean
  mode: 'exact' | 'max'
  width: number
  height: number
  px?: number | null
  mp?: number | null
}

/** Full pipeline snapshot stored on each job and returned in job details. */
export interface ImagePipelineParams {
  capability: string
  prompt: string
  negative_prompt?: string | null
  override_negative: boolean
  width: number
  height: number
  seed?: number | null
  workflow: 'txt2img' | 'img2img'
  input_image_id?: string | null
  data_preparation?: Record<string, string> | null
  rescale?: ImagePipelineRescaleParams | null
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
  /** UI rescale state at submit time (img2img). */
  rescale?: ImagePipelineRescaleParams | null
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
  /** Human-readable name (e.g. `rusty-nail`). */
  display_name: string
  status: string
  prompt: string
  negative_prompt: string | null
  capability: string
  workflow: string
  width: number
  height: number
  seed: number | null
  input_image_id: string | null
  pipeline_params: ImagePipelineParams
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
  online: boolean
  last_available_at: string // RFC3339
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

export function uploadImage(
  token: string,
  file: File,
  opts?: { downscale?: boolean },
): Promise<UploadedImage> {
  const form = new FormData()
  form.append('file', file)
  // Image analysis uploads full-res (downscale=false) and lets the agent rescale.
  const query = opts?.downscale === false ? '?downscale=false' : ''
  return request(`/api/images/upload${query}`, token, { method: 'POST', body: form })
}

export function startImageJob(token: string, payload: StartImageJobRequest): Promise<StartImageJobResponse> {
  return request('/api/images/jobs', token, { method: 'POST', body: JSON.stringify(payload) })
}

export function pollImageJob(token: string, jobId: string): Promise<PollImageJobResponse> {
  return request(`/api/images/jobs/${jobId}/poll`, token, { method: 'POST' })
}

export interface CancelImageJobResponse {
  job_id: string
  status: string
  message: string
  offload_cap: string
  offload_task_id: string
}

export function cancelImageJob(token: string, jobId: string): Promise<CancelImageJobResponse> {
  return request(`/api/images/jobs/${jobId}/cancel`, token, { method: 'POST' })
}

export function retryImageJob(token: string, jobId: string): Promise<StartImageJobResponse> {
  return request(`/api/images/jobs/${jobId}/retry`, token, { method: 'POST' })
}

export function listImageJobs(token: string): Promise<ImageJobDetails[]> {
  return request('/api/images/jobs', token)
}

export function getImageJob(token: string, jobId: string): Promise<ImageJobDetails> {
  return request(`/api/images/jobs/${jobId}`, token)
}

export async function deleteImageJob(token: string, jobId: string): Promise<void> {
  const res = await fetch(`/api/images/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
}

/** Bust browser cache for thumbnails after delete or storage changes. */
export function withImageCacheRevision(url: string, revision?: number): string {
  if (!revision) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${revision}`
}

/** URL for full-size JPEG — includes JWT query param (browsers omit Authorization). */
export function imageFileUrl(
  imageId: string,
  token: string | null | undefined,
  revision?: number,
): string {
  const base = `/api/images/files/${encodeURIComponent(imageId)}`
  const withAuth = token ? `${base}?token=${encodeURIComponent(token)}` : base
  return withImageCacheRevision(withAuth, revision)
}

/** URL for stored thumbnail JPEG (sidebar / list previews). */
export function imageThumbnailUrl(
  imageId: string,
  token: string | null | undefined,
  revision?: number,
): string {
  const base = `/api/images/files/${encodeURIComponent(imageId)}/thumbnail`
  const withAuth = token ? `${base}?token=${encodeURIComponent(token)}` : base
  return withImageCacheRevision(withAuth, revision)
}

export function getImageStarred(
  token: string,
  imageId: string,
): Promise<{ starred: boolean }> {
  return request(`/api/images/files/${encodeURIComponent(imageId)}/starred`, token)
}

export function setImageStarred(
  token: string,
  imageId: string,
  starred: boolean,
): Promise<{ starred: boolean }> {
  return request(`/api/images/files/${encodeURIComponent(imageId)}/starred`, token, {
    method: 'PATCH',
    body: JSON.stringify({ starred }),
  })
}

export async function deleteImage(token: string, imageId: string): Promise<void> {
  const res = await fetch(`/api/images/files/${encodeURIComponent(imageId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
}

export function listImgGenCapabilities(token: string): Promise<ImgGenCapability[]> {
  return request('/api/images/capabilities', token)
}
