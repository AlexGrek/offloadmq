import { apiRequest as request } from './http'
import type { UploadedImage } from './images'

/** React Router location state for `/app/img-utils` deep links from other pages. */
export type ImgUtilsRouteState = {
  useInputImage?: UploadedImage
}

/** One `img-utils.*` capability advertised by an online agent. */
export interface ImgUtilCapability {
  /** Base capability, e.g. `img-utils.image_lotus_depth_v1_1`. */
  base: string
  /** Capability minus the `img-utils.` prefix — the workflow pack, named after
   *  the model (`image_lotus_depth_v1_1`), *not* the operation. */
  utility: string
  /** Operations the pack installs (`["depth"]`) — the values `workflow` accepts. */
  workflows: string[]
  raw: string
  /** True when one of the operations consumes a second "source" image. */
  needs_source_image: boolean
}

/** A pack/operation pair — what the user actually picks. */
export interface ImgUtilTool {
  capability: string
  /** Pack directory, e.g. `image_lotus_depth_v1_1`. */
  pack: string
  /** Operation, e.g. `depth` — sent as `workflow`. */
  workflow: string
  needsSourceImage: boolean
}

/** Flatten capabilities into one entry per operation the user can run. */
export function toolsFromCapabilities(caps: ImgUtilCapability[]): ImgUtilTool[] {
  return caps.flatMap(cap =>
    (cap.workflows.length > 0 ? cap.workflows : [cap.utility]).map(workflow => ({
      capability: cap.base,
      pack: cap.utility,
      workflow,
      needsSourceImage: /^face[_-]swap/.test(workflow),
    })),
  )
}

/** Stable key for a tool — a pack may install more than one operation. */
export function toolKey(tool: ImgUtilTool): string {
  return `${tool.capability}::${tool.workflow}`
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

/** Human label for a slug (`face_swap` → `Face swap`). */
export function prettyLabel(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
