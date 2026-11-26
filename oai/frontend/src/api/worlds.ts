import type { LlmCapabilityInfo } from '../types/ws'
import { apiRequest as request } from './http'
import type { JobImageRef } from './imgUtils'
import type { UploadedImage } from './images'

/**
 * VR Worlds — a library image turned into a Gaussian-splat world.
 * Generators: `world.splat` (Lotus depth → per-pixel splats, 360° panoramas),
 * `world.sharp` (Apple SHARP learned splat, perspective only, solid when leaning),
 * `world.pano360` (WorldGen recipe: FLUX outpaints the picture into a 360° panorama) and
 * `world.mirror` (experimental Tencent WorldMirror 2.0, perspective only).
 */

export const SHARP_CAPABILITY = 'world.sharp'
export const PANO360_CAPABILITY = 'world.pano360'
export const MIRROR_CAPABILITY = 'world.mirror'

/** One-line description of a world generator for the picker. */
export function worldGeneratorLabel(base: string): string {
  if (base === 'world.sharp') return 'Apple SHARP — solid, metric (perspective only)'
  if (base === 'world.splat') return 'Lotus depth — fast, 360° panoramas'
  if (base === 'world.pano360') return 'WorldGen 360° — extends any picture all around you'
  if (base === 'world.mirror') return 'WorldMirror 2.0 — experimental, for comparison'
  return base
}

export type WorldMode = 'auto' | 'perspective' | 'pano'

export type WorldsRouteState = { worldImage?: UploadedImage }

/** An online generator; `usage_count` ranks the picker (the user's last 20 worlds). */
export type WorldCapability = LlmCapabilityInfo

export interface WorldParams {
  mode: WorldMode
  /** Splat grid width — one splat per pixel. 1024 ≈ Quest budget, 2048 = full detail. */
  max_width: number
  /** Head movement (m) the hidden background layer covers. */
  fill_lean: number
  /** Horizontal FOV (degrees). Omitted = generator default (splat 70°, SHARP EXIF / 30 mm). */
  hfov?: number
  near: number
  far: number
  /** `world.pano360`: scene description for the outpaint. Omitted = the picture's generation prompt. */
  prompt?: string
  /** `world.pano360`: camera pitch in degrees, negative = looking down. */
  pitch?: number
  /** `world.pano360`: outpaint seed. */
  seed?: number
  /** `world.mirror`: apply its sky and depth-edge filters. */
  cleanup?: boolean
}

/** Agent summary stored on completion (see docs/oai-worlds.md). */
export interface WorldResult {
  mode?: 'perspective' | 'pano'
  generator?: string
  splat_count?: number
  splats_fg?: number
  splats_bg?: number
  grid?: { width: number; height: number }
  depth_range_m?: [number, number]
  timings?: Record<string, number>
  settings?: { hfov?: number; focal_source?: string; [key: string]: unknown }
  runtime?: { device?: string; torch?: string; revision?: string; peak_vram_gib?: number }
  source?: { width: number; height: number; sha256: string }
  /** `world.pano360`: fraction of the sphere the original picture covers. */
  coverage?: number
  ply_sha256?: string
}

export interface WorldJob {
  job_id: string
  status: string
  capability: string
  mode: WorldMode
  params: WorldParams | null
  input_image_id: string | null
  input_image: JobImageRef | null
  result: WorldResult | null
  has_scene: boolean
  has_preview: boolean
  ply_bytes: number | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  started_at: string | null
  typical_runtime_seconds: number | null
  created_at: string
  updated_at: string
}

export type StartWorldJobRequest = {
  capability: string
  input_image_id: string
} & Partial<WorldParams>

export interface StartWorldJobResponse {
  job_id: string
  status: string
}

export interface ShareLink {
  viewer_url: string
  ply_url: string
  preview_url: string | null
  expires_at: string
}

const jobPath = (jobId: string) => `/api/worlds/jobs/${encodeURIComponent(jobId)}`

export function listWorldCapabilities(token: string): Promise<{ capabilities: WorldCapability[] }> {
  return request('/api/worlds/capabilities', token)
}

export function startWorldJob(
  token: string,
  payload: StartWorldJobRequest,
  signal?: AbortSignal,
): Promise<StartWorldJobResponse> {
  return request('/api/worlds/jobs', token, { method: 'POST', body: JSON.stringify(payload), signal })
}

export function listWorldJobs(token: string): Promise<WorldJob[]> {
  return request('/api/worlds/jobs', token)
}

export function getWorldJob(token: string, jobId: string): Promise<WorldJob> {
  return request(jobPath(jobId), token)
}

export function pollWorldJob(token: string, jobId: string, signal?: AbortSignal): Promise<WorldJob> {
  return request(`${jobPath(jobId)}/poll`, token, { method: 'POST', signal })
}

export function cancelWorldJob(token: string, jobId: string): Promise<{ status: string; message: string }> {
  return request(`${jobPath(jobId)}/cancel`, token, { method: 'POST' })
}

export function retryWorldJob(token: string, jobId: string): Promise<StartWorldJobResponse> {
  return request(`${jobPath(jobId)}/retry`, token, { method: 'POST' })
}

export function deleteWorldJob(token: string, jobId: string): Promise<void> {
  return request(jobPath(jobId), token, { method: 'DELETE' })
}

export function shareWorldJob(token: string, jobId: string): Promise<ShareLink> {
  return request(`${jobPath(jobId)}/share`, token, { method: 'POST' })
}

/** Authenticated scene URL — `?token=` because loaders cannot send headers. */
export function worldSceneUrl(jobId: string, token: string): string {
  return `${jobPath(jobId)}/scene.ply?token=${encodeURIComponent(token)}`
}

export function worldPreviewUrl(jobId: string, token: string): string {
  return `${jobPath(jobId)}/preview.png?token=${encodeURIComponent(token)}`
}

/** Public, signature-authorized URLs used by the login-free viewer page. */
export function publicWorldUrls(jobId: string, query: string): { scene: string; preview: string } {
  const base = `/api/worlds/public/${encodeURIComponent(jobId)}`
  return { scene: `${base}/scene.ply?${query}`, preview: `${base}/preview.png?${query}` }
}

export function worldModeLabel(mode: string | undefined | null): string {
  if (mode === 'pano') return '360° panorama'
  if (mode === 'perspective') return 'Window (perspective)'
  return 'Auto'
}

export function formatMiB(bytes: number | null | undefined): string {
  return bytes == null ? '—' : `${(bytes / 2 ** 20).toFixed(1)} MiB`
}
