import { apiRequest as request } from './http'
import type { UploadedImage } from './images'

/** React Router location state for `/app/img-utils` deep links from other pages. */
export type ImgUtilsRouteState = {
  useInputImage?: UploadedImage
}

/** Which family a tool belongs to: a ComfyUI `img-utils.*` pack, or the built-in
 *  Pillow `image_resize`. Resize takes flat payload parameters instead of a
 *  workflow, so the form differs. */
export type ImgUtilKind = 'comfy' | 'resize'

/** The synthetic operation name the backend stores for resize jobs. */
export const RESIZE_WORKFLOW = 'basic_resize'

/** One Image Tools capability advertised by an online agent. */
export interface ImgUtilCapability {
  /** Base capability, e.g. `img-utils.image_lotus_depth_v1_1` or `image_resize`. */
  base: string
  /** Capability minus the `img-utils.` prefix — the workflow pack, named after
   *  the model (`image_lotus_depth_v1_1`), *not* the operation. */
  utility: string
  /** Operations the pack installs (`["depth"]`) — the values `workflow` accepts. */
  workflows: string[]
  raw: string
  /** True when one of the operations consumes a second "source" image. */
  needs_source_image: boolean
  kind: ImgUtilKind
  /** Resampling filters the agent offers — `resize` only, empty otherwise. */
  methods: string[]
}

/** A pack/operation pair — what the user actually picks. */
export interface ImgUtilTool {
  capability: string
  /** Pack directory, e.g. `image_lotus_depth_v1_1`. */
  pack: string
  /** Operation, e.g. `depth` — sent as `workflow`. */
  workflow: string
  needsSourceImage: boolean
  kind: ImgUtilKind
  /** Resampling filters offered by this tool — `resize` only. */
  methods: string[]
}

/** Flatten capabilities into one entry per operation the user can run. */
export function toolsFromCapabilities(caps: ImgUtilCapability[]): ImgUtilTool[] {
  return caps.flatMap(cap =>
    (cap.workflows.length > 0 ? cap.workflows : [cap.utility]).map(workflow => ({
      capability: cap.base,
      pack: cap.utility,
      workflow,
      // Resize has no second slot regardless of what its attributes look like.
      needsSourceImage: cap.kind !== 'resize' && /^face[_-]swap/.test(workflow),
      kind: cap.kind,
      methods: cap.methods ?? [],
    })),
  )
}

/** Stable key for a tool — a pack may install more than one operation. */
export function toolKey(tool: ImgUtilTool): string {
  return `${tool.capability}::${tool.workflow}`
}

/** Stored-image metadata attached to a job's image slots. Superset of
 *  {@link UploadedImage}, so it can be handed straight to another feature. */
export interface JobImageRef extends UploadedImage {
  /** `input` (user upload) or `output` (produced by a job). */
  direction: string
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
  /** Resolved image metadata — only present on the single-job endpoints
   *  (`get`/`poll`); the listing leaves these null. */
  input_image?: JobImageRef | null
  source_image?: JobImageRef | null
  output_image?: JobImageRef | null
  options: Record<string, unknown> | null
  stage: string | null
  error: string | null
  offload_cap: string | null
  offload_task_id: string | null
  /** RFC3339 time execution began on an agent; null while queued. */
  started_at?: string | null
  /** Heuristic execution-time estimate in seconds; null when unknown. */
  typical_runtime_seconds?: number | null
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

// ---------------------------------------------------------------------------
// Basic resize
// ---------------------------------------------------------------------------

/** Largest edge OAI keeps for a stored image. Asking the agent for more is
 *  pointless — every image is downscaled to this on the way into storage — so
 *  the backend rejects larger dimensions and the form caps them here.
 *  Mirrors `image_processing::MAX_IMAGE_EDGE`. */
export const MAX_RESIZE_EDGE = 1920

/** How the target box is interpreted. Matches the agent's `mode` field. */
export type ResizeFitMode = 'fit' | 'exact' | 'cover'

/** Whether the user is sizing in pixels or as a percentage of the original. */
export type ResizeSizeMode = 'pixels' | 'percent'

export type ResizeOutputFormat = '' | 'png' | 'jpeg' | 'webp'

export const RESIZE_FIT_MODES: { value: ResizeFitMode; label: string; hint: string }[] = [
  { value: 'fit', label: 'Fit', hint: 'Largest size that fits the box, aspect ratio kept' },
  { value: 'exact', label: 'Stretch', hint: 'Exactly these dimensions, aspect ratio ignored' },
  { value: 'cover', label: 'Crop', hint: 'Fills the box and crops the overflow' },
]

/** Form state for the resize tool. A blank dimension means "derive from the
 *  other one" — only valid in `fit`, where one edge is enough. */
export interface ResizeFormState {
  sizeMode: ResizeSizeMode
  mode: ResizeFitMode
  width: number | ''
  height: number | ''
  percent: number
  method: string
  format: ResizeOutputFormat
  quality: number
  allowUpscale: boolean
}

export function defaultResizeForm(methods: string[]): ResizeFormState {
  return {
    sizeMode: 'pixels',
    mode: 'fit',
    width: 1024,
    height: 1024,
    percent: 50,
    method: methods.includes('lanczos') ? 'lanczos' : (methods[0] ?? ''),
    format: '',
    quality: 90,
    allowUpscale: false,
  }
}

/** Why the current form cannot be submitted, or `null` when it can. */
export function resizeFormError(state: ResizeFormState): string | null {
  if (state.sizeMode === 'percent') {
    if (!(state.percent > 0) || state.percent > 400) {
      return 'Scale must be between 1% and 400%.'
    }
    return null
  }
  const dims = [state.width, state.height].filter((d): d is number => d !== '')
  if (dims.length === 0) return 'Set a width or a height.'
  if (dims.some(d => d < 1 || d > MAX_RESIZE_EDGE)) {
    return `Width and height must be between 1 and ${MAX_RESIZE_EDGE} pixels.`
  }
  if (state.mode !== 'fit' && (state.width === '' || state.height === '')) {
    const label = RESIZE_FIT_MODES.find(m => m.value === state.mode)?.label ?? state.mode
    return `${label} needs both a width and a height.`
  }
  return null
}

/** Translate the form into the `options` map the backend validates. */
export function resizeOptionsFromForm(state: ResizeFormState): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (state.method) options.method = state.method
  if (state.format) {
    options.format = state.format
    if (state.format !== 'png') options.quality = state.quality
  }

  if (state.sizeMode === 'percent') {
    // Scale bypasses the fit modes on the agent, so don't imply one.
    options.scale = state.percent / 100
    return options
  }

  options.mode = state.mode
  if (state.width !== '') options.width = state.width
  if (state.height !== '') options.height = state.height
  if (state.mode === 'fit') options.allow_upscale = state.allowUpscale
  return options
}

/** One-line summary of a stored resize job's options, for the job detail. */
export function describeResizeOptions(options: Record<string, unknown> | null): string {
  if (!options) return 'Resize'
  const num = (key: string): number | null =>
    typeof options[key] === 'number' ? (options[key] as number) : null
  const str = (key: string): string | null =>
    typeof options[key] === 'string' ? (options[key] as string) : null

  const parts: string[] = []
  const scale = num('scale')
  if (scale != null) {
    parts.push(`${Math.round(scale * 100)}%`)
  } else {
    const mode = str('mode') ?? 'fit'
    const label = RESIZE_FIT_MODES.find(m => m.value === mode)?.label ?? mode
    const width = num('width')
    const height = num('height')
    parts.push(`${label} ${width ?? 'auto'}×${height ?? 'auto'}`)
  }
  const method = str('method')
  if (method) parts.push(method)
  const format = str('format')
  if (format) {
    const quality = num('quality')
    parts.push(quality != null && format !== 'png' ? `${format} q${quality}` : format)
  }
  return parts.join(' · ')
}
