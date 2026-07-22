import { apiRequest as request } from './http'

/** One `img-utils.*` capability advertised by an online agent. */
export interface ImgUtilCapability {
  /** Base capability, e.g. `img-utils.depth`. */
  base: string
  /** Capability minus the `img-utils.` prefix, e.g. `depth`. */
  utility: string
  /** Task types the agent declared in brackets — usable as `workflow`. */
  workflows: string[]
  raw: string
  /** True when the utility consumes a second "source" image (face reference). */
  needs_source_image: boolean
}

export interface ImgUtilsJob {
  job_id: string
  status: string
  capability: string
  utility: string
  workflow: string
  input_image_id: string | null
  source_image_id: string | null
  output_image_id: string | null
  options: Record<string, unknown> | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  created_at: string
  updated_at: string
}

export interface StartImgUtilsJobRequest {
  capability: string
  workflow?: string
  input_image_id: string
  source_image_id?: string
  options?: Record<string, unknown>
}

export interface StartImgUtilsJobResponse {
  job_id: string
  status: string
}

export interface CancelImgUtilsJobResponse {
  job_id: string
  status: string
  message: string
}

export function listImgUtilsCapabilities(
  token: string,
): Promise<{ capabilities: ImgUtilCapability[] }> {
  return request('/api/img-utils/capabilities', token)
}

export function startImgUtilsJob(
  token: string,
  payload: StartImgUtilsJobRequest,
): Promise<StartImgUtilsJobResponse> {
  return request('/api/img-utils/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listImgUtilsJobs(token: string): Promise<ImgUtilsJob[]> {
  return request('/api/img-utils/jobs', token)
}

export function getImgUtilsJob(token: string, jobId: string): Promise<ImgUtilsJob> {
  return request(`/api/img-utils/jobs/${encodeURIComponent(jobId)}`, token)
}

export function pollImgUtilsJob(token: string, jobId: string): Promise<ImgUtilsJob> {
  return request(`/api/img-utils/jobs/${encodeURIComponent(jobId)}/poll`, token, {
    method: 'POST',
  })
}

export function cancelImgUtilsJob(
  token: string,
  jobId: string,
): Promise<CancelImgUtilsJobResponse> {
  return request(`/api/img-utils/jobs/${encodeURIComponent(jobId)}/cancel`, token, {
    method: 'POST',
  })
}

export function retryImgUtilsJob(
  token: string,
  jobId: string,
): Promise<StartImgUtilsJobResponse> {
  return request(`/api/img-utils/jobs/${encodeURIComponent(jobId)}/retry`, token, {
    method: 'POST',
  })
}

export function deleteImgUtilsJob(token: string, jobId: string): Promise<void> {
  return request(`/api/img-utils/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  })
}

/** Human label for a utility slug (`face_swap` → `Face swap`). */
export function utilityLabel(utility: string): string {
  const words = utility.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
