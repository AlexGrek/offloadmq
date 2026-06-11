import type {
  ImageJobDetails,
  ImageJobFile,
  ImagePipelineParams,
  ImagePipelineRescaleParams,
  ImgGenCapability,
  ImageJobEvent,
  UploadedImage,
} from '../api/images'
import { pickListedCapability } from './capability-picker'

export type ImgGenMode = 'txt2img' | 'img2img' | 'txt2video' | 'img2video'

export function isVideoMode(mode: ImgGenMode): boolean {
  return mode === 'txt2video' || mode === 'img2video'
}

export function isInputImageMode(mode: ImgGenMode): boolean {
  return mode === 'img2img' || mode === 'img2video'
}

export type RescaleMode = 'exact' | 'max'

/** 4K UHD width — img2img inputs whose larger edge reaches this are too big to offer "original resolution". */
export const FOUR_K_EDGE = 3840

/** True when an image is small enough to safely generate at its original (un-rescaled) resolution. */
export function fitsOriginalResolution(width: number, height: number): boolean {
  return Math.max(width, height) < FOUR_K_EDGE
}

/** Long-edge sizes proposed as proportional ("keep proportions") variants in img2img. */
export const PRESET_LONG_EDGES = [512, 768, 1024, 1280, 1536] as const

/** Diffusion models expect dimensions on an 8px grid; round (never below the grid step). */
function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

/** Scale an input's aspect ratio to a target long edge, snapped to an 8px grid. */
export function proportionalSize(
  inputWidth: number,
  inputHeight: number,
  longEdge: number,
): [number, number] {
  if (inputWidth <= 0 || inputHeight <= 0) return [longEdge, longEdge]
  const landscape = inputWidth >= inputHeight
  const shortRatio = landscape ? inputHeight / inputWidth : inputWidth / inputHeight
  const short = roundToMultiple(longEdge * shortRatio, 8)
  return landscape ? [longEdge, short] : [short, longEdge]
}

/** Dimension presets that preserve the input image's aspect ratio (deduped). */
export function proportionalPresets(inputWidth: number, inputHeight: number): [number, number][] {
  const seen = new Set<string>()
  const presets: [number, number][] = []
  for (const longEdge of PRESET_LONG_EDGES) {
    const [w, h] = proportionalSize(inputWidth, inputHeight, longEdge)
    const key = `${w}x${h}`
    if (!seen.has(key)) {
      seen.add(key)
      presets.push([w, h])
    }
  }
  return presets
}

/** Given one edited dimension, the matching other dimension that preserves the input ratio. */
export function proportionalCounterpart(
  changed: 'width' | 'height',
  value: number,
  inputWidth: number,
  inputHeight: number,
): number {
  if (inputWidth <= 0 || inputHeight <= 0 || value <= 0) return value
  const ratio = inputWidth / inputHeight
  return changed === 'width'
    ? roundToMultiple(value / ratio, 8)
    : roundToMultiple(value * ratio, 8)
}

export interface RescaleState {
  enabled: boolean
  mode: RescaleMode
  width: number
  height: number
  px: number | ''
  mp: number | ''
}

/** OffloadMQ `dataPreparation` map for input bucket files (matches sandbox RescaleWidget). */
export function rescaleDataPrep(
  enabled: boolean,
  { mode, width, height, px, mp }: RescaleState,
): Record<string, string> | null {
  if (!enabled) return null
  if (mode === 'max') {
    const parts: string[] = []
    if (px !== '' && px != null) parts.push(`px=${px}`)
    if (mp !== '' && mp != null) parts.push(`mp=${mp}`)
    if (!parts.length) return null
    return { '*': `scale/max[${parts.join(',')}]` }
  }
  return { '*': `scale/${width}x${height}` }
}

/** Capabilities that declare support for a workflow via bracket tags (e.g. `[txt2img;img2img]`). */
export function filterCapabilitiesByWorkflow(
  caps: ImgGenCapability[],
  workflow: ImgGenMode,
): ImgGenCapability[] {
  const filtered = caps.filter(
    cap => cap.tags.length === 0 || cap.tags.some(t => t.toLowerCase() === workflow),
  )
  return filtered.length > 0 ? filtered : caps
}

export function capabilityLabel(cap: ImgGenCapability): string {
  return cap.tags.length ? `${cap.base} [${cap.tags.join(', ')}]` : cap.base
}

/** Display name for imggen capability on history cards (e.g. `imggen.flux` → `flux`). */
export function modelNameFromCapability(capability: string): string {
  const base = capability.replace(/^imggen\./, '').trim()
  return base || capability
}

/** User-facing title: prompt excerpt (never the generated slug). */
export function jobPromptTitle(prompt: string, maxLen = 52): string {
  return promptExcerpt(prompt, maxLen)
}

/** @deprecated Use jobPromptTitle — kept for call-site clarity during migration. */
export function jobDisplayName(job: Pick<ImageJobDetails, 'prompt'>): string {
  return jobPromptTitle(job.prompt, 48)
}

/** Generated slug (e.g. `rusty-nail`) for support / debug UI only. */
export function jobPipelineSlug(job: Pick<ImageJobDetails, 'display_name'>): string | null {
  const name = job.display_name?.trim()
  return name || null
}

/** Compact tech meta: slug · model (slug omitted when empty). */
export function jobTechMeta(
  job: Pick<ImageJobDetails, 'display_name' | 'capability'>,
): string {
  const slug = jobPipelineSlug(job)
  const model = modelNameFromCapability(job.capability)
  return slug ? `${slug} · ${model}` : model
}

export function promptExcerpt(prompt: string, maxLen = 52): string {
  const t = prompt.trim()
  if (!t) return 'Untitled pipeline'
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen).trimEnd()}…`
}

export function lastOutputImageId(job: { files: { direction: string; image_id: string }[] }): string | null {
  const outputs = job.files.filter(f => f.direction === 'output')
  if (outputs.length === 0) return null
  return outputs[outputs.length - 1].image_id
}

const POLL_EVENT_STEPS = new Set(['offload.poll', 'worker.offload.poll'])

export function isPipelinePollEvent(event: ImageJobEvent): boolean {
  return POLL_EVENT_STEPS.has(event.step)
}

/** Pipeline events worth showing in the UI (excludes periodic offload polls). */
export function pipelineEventsWithoutPolls(events: ImageJobEvent[]): ImageJobEvent[] {
  return events.filter(e => !isPipelinePollEvent(e))
}

/** One-line status for the collapsed pipeline header. */
export function pipelineStatusLine(
  jobStatus: string,
  stage: string | null | undefined,
  events: ImageJobEvent[],
): string {
  if (stage) return `${jobStatus} — ${stage}`
  const visible = pipelineEventsWithoutPolls(events)
  const last = visible[visible.length - 1]
  if (last) {
    return last.details ? `${last.step}: ${last.details}` : `${last.step} (${last.state})`
  }
  return jobStatus
}

/** Build pipeline params from legacy job columns when `pipeline_params` is missing. */
export function pipelineParamsFromJob(job: ImageJobDetails): ImagePipelineParams {
  if (job.pipeline_params) return job.pipeline_params
  const workflow = job.workflow as ImgGenMode
  return {
    capability: job.capability,
    prompt: job.prompt,
    negative_prompt: job.negative_prompt,
    override_negative: job.negative_prompt != null && job.negative_prompt.length > 0,
    width: job.width,
    height: job.height,
    seed: job.seed,
    workflow,
    input_image_id: job.input_image_id,
    data_preparation: null,
    video_length: null,
    rescale:
      workflow === 'img2img' || workflow === 'img2video'
        ? {
            enabled: true,
            mode: 'exact',
            width: job.width,
            height: job.height,
          }
        : null,
  }
}

function rescaleFromParams(r: ImagePipelineRescaleParams | null | undefined): RescaleState {
  if (!r) return { enabled: false, mode: 'exact', width: 768, height: 768, px: '', mp: '' }
  return {
    enabled: r.enabled,
    mode: r.mode,
    width: r.width,
    height: r.height,
    px: r.px ?? '',
    mp: r.mp ?? '',
  }
}

export function uploadedInputFromJobFile(file: ImageJobFile): UploadedImage {
  return {
    image_id: file.image_id,
    filename: file.filename,
    content_type: file.content_type,
    width: file.width,
    height: file.height,
    size_bytes: file.size_bytes,
    rescaled: file.rescaled,
    reencoded: file.reencoded,
  }
}

export interface ApplyPipelineToNewFormHandlers {
  setMode: (mode: ImgGenMode) => void
  setPrompt: (v: string) => void
  setNegativePrompt: (v: string) => void
  setOverrideNegative: (v: boolean) => void
  setCapability: (v: string) => void
  setWidth: (v: number) => void
  setHeight: (v: number) => void
  setSeed: (v: string) => void
  setVideoLength: (v: number) => void
  setRescale: (v: RescaleState) => void
  setOriginalResolution: (v: boolean) => void
  setKeepProportions: (v: boolean) => void
  setUploadedInput: (v: UploadedImage | null) => void
  setInputPreviewUrl: (v: string | null) => void
  rescaleUserEditedRef: { current: boolean }
}

/** Copy a job's stored pipeline parameters into the New job form. */
export function applyPipelineParamsToNewForm(
  job: ImageJobDetails,
  handlers: ApplyPipelineToNewFormHandlers,
  imagePreviewUrl?: string | null,
  availableCapabilities?: readonly { base: string }[],
): void {
  const p = pipelineParamsFromJob(job)
  const mode: ImgGenMode =
    p.workflow === 'img2img' ? 'img2img'
    : p.workflow === 'txt2video' ? 'txt2video'
    : p.workflow === 'img2video' ? 'img2video'
    : 'txt2img'
  handlers.setMode(mode)
  handlers.setPrompt(p.prompt)
  handlers.setNegativePrompt(p.negative_prompt?.trim() ?? '')
  handlers.setOverrideNegative(!!p.override_negative)
  if (availableCapabilities?.length) {
    const cap = pickListedCapability(p.capability, availableCapabilities)
    if (cap) handlers.setCapability(cap)
  }
  handlers.setWidth(p.width)
  handlers.setHeight(p.height)
  handlers.setSeed(p.seed != null ? String(p.seed) : '')
  handlers.setVideoLength(p.video_length ?? 25)
  handlers.rescaleUserEditedRef.current = true
  handlers.setRescale(rescaleFromParams(p.rescale))
  const inputFile =
    (mode === 'img2img' || mode === 'img2video') && p.input_image_id
      ? job.files.find(f => f.direction === 'input')
      : undefined
  if (inputFile) {
    handlers.setUploadedInput(uploadedInputFromJobFile(inputFile))
    handlers.setInputPreviewUrl(imagePreviewUrl ?? null)
  } else {
    handlers.setUploadedInput(null)
    handlers.setInputPreviewUrl(null)
  }
  // Re-derive the "original resolution" toggle: img2img job whose generation dims match a
  // sub-4K input image (and no active rescale) was generated at the input's native size.
  // Not applicable to img2video.
  handlers.setOriginalResolution(
    mode === 'img2img' &&
      !!inputFile &&
      fitsOriginalResolution(inputFile.width, inputFile.height) &&
      p.width === inputFile.width &&
      p.height === inputFile.height &&
      !p.rescale?.enabled,
  )
  // Lock proportions for img2img with an input image; not for video modes.
  handlers.setKeepProportions(mode === 'img2img' && !!inputFile)
}

export const MODE_DEFAULTS: Record<
  ImgGenMode,
  { prompt: string; width: number; height: number; rescale: Partial<RescaleState> }
> = {
  txt2img: {
    prompt: 'A cinematic portrait of a cyberpunk fox in neon rain',
    width: 1024,
    height: 1024,
    rescale: { enabled: false },
  },
  img2img: {
    prompt: 'turn this into an oil painting',
    width: 768,
    height: 768,
    rescale: { enabled: false, mode: 'exact', width: 768, height: 768 },
  },
  txt2video: {
    prompt: 'A majestic eagle soaring over mountain peaks, cinematic',
    width: 768,
    height: 512,
    rescale: { enabled: false },
  },
  img2video: {
    prompt: 'animate this image with subtle motion',
    width: 768,
    height: 512,
    rescale: { enabled: false, mode: 'exact', width: 768, height: 512 },
  },
}
