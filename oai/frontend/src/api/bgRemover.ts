import { apiRequest as request } from './http'
import type { JobImageRef } from './imgUtils'

/** `png`/`webp` can be transparent; `jpeg` is always flattened onto a colour. */
export type BgFormat = 'png' | 'webp' | 'jpeg'

/** What to produce. Mirrors `BgRemoverOptions` on the backend, which re-validates. */
export interface BgRemoverOptions {
  format: BgFormat
  /** `transparent` or `#RRGGBB`. */
  background: string
  /** Trim the output to the subject's bounding box. */
  crop: boolean
  /** Margin around the crop, in pixels (only with `crop`). */
  padding: number
  /** Fix edge colours so the old background does not halo around hair. */
  refine_foreground: boolean
  /** Hard 0/1 alpha at this cut-off (0..1 exclusive); null keeps the soft matte. */
  alpha_threshold: number | null
  /** JPEG/WebP quality 1–100; null for the agent default. */
  quality: number | null
}

export const DEFAULT_BG_OPTIONS: BgRemoverOptions = {
  format: 'png',
  background: 'transparent',
  crop: false,
  padding: 0,
  refine_foreground: true,
  alpha_threshold: null,
  quality: null,
}

export const MAX_BG_PADDING = 4096
export const DEFAULT_SOLID_BACKGROUND = '#FFFFFF'
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** Why `options` cannot be submitted, or null. The backend enforces the same rules. */
export function bgOptionsError(o: BgRemoverOptions): string | null {
  if (o.background !== 'transparent' && !HEX_COLOR.test(o.background)) {
    return 'Background must be a #RRGGBB colour.'
  }
  if (o.format === 'jpeg' && o.background === 'transparent') {
    return 'JPEG cannot be transparent — pick a background colour.'
  }
  if (!Number.isInteger(o.padding) || o.padding < 0 || o.padding > MAX_BG_PADDING) {
    return `Padding must be a whole number from 0 to ${MAX_BG_PADDING}.`
  }
  if (o.alpha_threshold != null && !(o.alpha_threshold > 0 && o.alpha_threshold < 1)) {
    return 'Hard edge cut-off must be between 0 and 1 (exclusive).'
  }
  if (o.quality != null && (!Number.isInteger(o.quality) || o.quality < 1 || o.quality > 100)) {
    return 'Quality must be a whole number from 1 to 100.'
  }
  return null
}

/** One background-removal model advertised by an online agent. */
export interface BgRemoverCapability {
  /** Base capability, e.g. `onnx.bgremove.birefnet-general`. */
  base: string
  /** Capability minus the prefix, e.g. `birefnet-general`. */
  model: string
  raw: string
}

export interface BgRemoverCapabilities {
  capabilities: BgRemoverCapability[]
  default_model: string
}

export interface BgRemoverJob {
  job_id: string
  status: string
  capability: string
  model: string
  input_image_id: string | null
  output_image_id: string | null
  /** Resolved image metadata — only on the single-job endpoints (`get`/`poll`). */
  input_image?: JobImageRef | null
  output_image?: JobImageRef | null
  options: BgRemoverOptions
  /** Mean alpha of the cutout; null until completed. */
  foreground_ratio: number | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  /** RFC3339 time execution began on an agent; null while queued. */
  started_at?: string | null
  typical_runtime_seconds?: number | null
  created_at: string
  updated_at: string
}

export interface StartBgRemoverJobRequest {
  capability: string
  input_image_id: string
  options?: Partial<BgRemoverOptions>
}

export interface StartBgRemoverJobResponse {
  job_id: string
  status: string
}

export interface CancelBgRemoverJobResponse {
  job_id: string
  status: string
  message: string
}

const jobUrl = (jobId: string) => `/api/bg-remover/jobs/${encodeURIComponent(jobId)}`

export function listBgRemoverCapabilities(token: string): Promise<BgRemoverCapabilities> {
  return request('/api/bg-remover/capabilities', token)
}

export function startBgRemoverJob(
  token: string,
  payload: StartBgRemoverJobRequest,
  signal?: AbortSignal,
): Promise<StartBgRemoverJobResponse> {
  return request('/api/bg-remover/jobs', token, {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
  })
}

export function listBgRemoverJobs(token: string): Promise<BgRemoverJob[]> {
  return request('/api/bg-remover/jobs', token)
}

export function getBgRemoverJob(token: string, jobId: string): Promise<BgRemoverJob> {
  return request(jobUrl(jobId), token)
}

export function pollBgRemoverJob(
  token: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BgRemoverJob> {
  return request(`${jobUrl(jobId)}/poll`, token, { method: 'POST', signal })
}

export function cancelBgRemoverJob(
  token: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<CancelBgRemoverJobResponse> {
  return request(`${jobUrl(jobId)}/cancel`, token, { method: 'POST', signal })
}

export function retryBgRemoverJob(
  token: string,
  jobId: string,
): Promise<StartBgRemoverJobResponse> {
  return request(`${jobUrl(jobId)}/retry`, token, { method: 'POST' })
}

export function deleteBgRemoverJob(token: string, jobId: string): Promise<void> {
  return request(jobUrl(jobId), token, { method: 'DELETE' })
}
