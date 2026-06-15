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

/** React Router location state for `/app/images` deep links from other pages. */
export type ImggenRouteState = {
  usePrompt?: string
  useInputImage?: {
    mode: 'img2img' | 'img2video'
    image: UploadedImage
  }
  /** Prefill the New job form from file metadata (My Files properties). */
  generateAgain?: {
    jobId?: string
    parameters: Record<string, unknown>
  }
}

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
  // Fall back to all caps only when every capability is untagged (legacy agents with no
  // bracket metadata). If some caps have tags but none match this workflow, return empty
  // so the UI shows "No models found for this mode" instead of unrelated models.
  if (filtered.length === 0 && caps.some(c => c.tags.length > 0)) return []
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

export function uploadedInputFromJobFile(
  file: Pick<
    ImageJobFile,
    | 'image_id'
    | 'filename'
    | 'content_type'
    | 'width'
    | 'height'
    | 'size_bytes'
    | 'rescaled'
    | 'reencoded'
  >,
): UploadedImage {
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

export function parseVideoLength(raw: string): number {
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return 25
  return Math.min(300, Math.max(1, Math.round(n)))
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
  setVideoLength: (v: string) => void
  setRescale: (v: RescaleState) => void
  setOriginalResolution: (v: boolean) => void
  setKeepProportions: (v: boolean) => void
  setUploadedInput: (v: UploadedImage | null) => void
  setInputPreviewUrl: (v: string | null) => void
  rescaleUserEditedRef: { current: boolean }
}

function workflowToMode(workflow: string): ImgGenMode {
  if (workflow === 'img2img') return 'img2img'
  if (workflow === 'txt2video') return 'txt2video'
  if (workflow === 'img2video') return 'img2video'
  return 'txt2img'
}

function asParamRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Build pipeline params from a `generation_parameters` row (file properties API). */
export function pipelineParamsFromStored(stored: Record<string, unknown>): ImagePipelineParams {
  const nested = asParamRecord(stored.pipeline_params)
  const workflowRaw = String(nested?.workflow ?? stored.workflow ?? 'txt2img')
  const width = Number(nested?.width ?? stored.width ?? 1024)
  const height = Number(nested?.height ?? stored.height ?? 1024)
  const seedRaw = nested?.seed ?? stored.seed
  const inputRaw = nested?.input_image_id ?? stored.input_image_id
  return {
    capability: String(nested?.capability ?? stored.capability ?? ''),
    prompt: String(nested?.prompt ?? stored.prompt ?? ''),
    negative_prompt:
      nested?.negative_prompt != null
        ? String(nested.negative_prompt)
        : stored.negative_prompt != null
          ? String(stored.negative_prompt)
          : null,
    override_negative: Boolean(nested?.override_negative),
    width: Number.isFinite(width) ? width : 1024,
    height: Number.isFinite(height) ? height : 1024,
    seed: seedRaw != null && seedRaw !== '' ? Number(seedRaw) : null,
    workflow: workflowToMode(workflowRaw),
    input_image_id: inputRaw != null && inputRaw !== '' ? String(inputRaw) : null,
    data_preparation: (nested?.data_preparation ??
      null) as ImagePipelineParams['data_preparation'],
    rescale: (nested?.rescale ?? null) as ImagePipelineParams['rescale'],
    video_length:
      nested?.video_length != null ? Number(nested.video_length) : null,
  }
}

export function storedImggenWorkflow(
  stored: Record<string, unknown>,
): ImgGenMode | null {
  const workflow = pipelineParamsFromStored(stored).workflow
  if (
    workflow === 'txt2img' ||
    workflow === 'img2img' ||
    workflow === 'txt2video' ||
    workflow === 'img2video'
  ) {
    return workflow
  }
  return null
}

function stubUploadedInput(
  imageId: string,
  width: number,
  height: number,
): UploadedImage {
  return {
    image_id: imageId,
    filename: 'input',
    content_type: 'image/jpeg',
    width,
    height,
    size_bytes: 0,
    rescaled: false,
    reencoded: false,
  }
}

function applyPipelineParamsCore(
  p: ImagePipelineParams,
  inputFile:
    | Pick<
        ImageJobFile,
        | 'image_id'
        | 'filename'
        | 'content_type'
        | 'width'
        | 'height'
        | 'size_bytes'
        | 'rescaled'
        | 'reencoded'
      >
    | null
    | undefined,
  handlers: ApplyPipelineToNewFormHandlers,
  imagePreviewUrl?: string | null,
  availableCapabilities?: readonly { base: string }[],
): void {
  const mode = workflowToMode(p.workflow)
  handlers.setMode(mode)
  handlers.setPrompt(p.prompt)
  handlers.setNegativePrompt(p.negative_prompt?.trim() ?? '')
  handlers.setOverrideNegative(!!p.override_negative)
  if (availableCapabilities?.length) {
    const cap = pickListedCapability(p.capability, availableCapabilities)
    if (cap) handlers.setCapability(cap)
  } else if (p.capability) {
    handlers.setCapability(p.capability)
  }
  handlers.setWidth(p.width)
  handlers.setHeight(p.height)
  handlers.setSeed(p.seed != null ? String(p.seed) : '')
  handlers.setVideoLength(String(p.video_length ?? 25))
  handlers.rescaleUserEditedRef.current = true
  handlers.setRescale(rescaleFromParams(p.rescale))
  if (inputFile) {
    handlers.setUploadedInput(uploadedInputFromJobFile(inputFile))
    handlers.setInputPreviewUrl(imagePreviewUrl ?? null)
  } else {
    handlers.setUploadedInput(null)
    handlers.setInputPreviewUrl(null)
  }
  handlers.setOriginalResolution(
    mode === 'img2img' &&
      !!inputFile &&
      fitsOriginalResolution(inputFile.width, inputFile.height) &&
      p.width === inputFile.width &&
      p.height === inputFile.height &&
      !p.rescale?.enabled,
  )
  handlers.setKeepProportions(mode === 'img2img' && !!inputFile)
}

/** Copy a job's stored pipeline parameters into the New job form. */
export function applyPipelineParamsToNewForm(
  job: ImageJobDetails,
  handlers: ApplyPipelineToNewFormHandlers,
  imagePreviewUrl?: string | null,
  availableCapabilities?: readonly { base: string }[],
): void {
  const p = pipelineParamsFromJob(job)
  const mode = workflowToMode(p.workflow)
  const inputFile =
    (mode === 'img2img' || mode === 'img2video') && p.input_image_id
      ? job.files.find(f => f.direction === 'input')
      : undefined
  applyPipelineParamsCore(p, inputFile, handlers, imagePreviewUrl, availableCapabilities)
}

/** Copy file metadata (`generation_parameters`) into the New job form. */
export function applyStoredGenerationParamsToNewForm(
  stored: Record<string, unknown>,
  handlers: ApplyPipelineToNewFormHandlers,
  options?: {
    inputFile?: Pick<
      ImageJobFile,
      | 'image_id'
      | 'filename'
      | 'content_type'
      | 'width'
      | 'height'
      | 'size_bytes'
      | 'rescaled'
      | 'reencoded'
    > | null
    imagePreviewUrl?: string | null
    availableCapabilities?: readonly { base: string }[]
  },
): void {
  const p = pipelineParamsFromStored(stored)
  const mode = workflowToMode(p.workflow)
  let inputFile = options?.inputFile ?? null
  if (!inputFile && (mode === 'img2img' || mode === 'img2video') && p.input_image_id) {
    inputFile = stubUploadedInput(p.input_image_id, p.width, p.height)
  }
  applyPipelineParamsCore(
    p,
    inputFile,
    handlers,
    options?.imagePreviewUrl,
    options?.availableCapabilities,
  )
}

/** Rotating starter prompts for txt2img — one is picked at random on the frontend. */
export const TXT2IMG_DEFAULT_PROMPTS = [
  'A cinematic portrait of {?} in neon rain',
  'A bioluminescent {?} drifting through deep ocean darkness, ethereal light rays',
  'An astronaut gardener tending {?} on a Martian crater rim at golden hour',
  'A steampunk {?} surrounded by floating brass orbs and parchment scrolls',
  'A {?} composed entirely of cherry blossom petals standing in a misty bamboo forest',
  'A vintage dieselpunk {?} racing through clouds at sunset, dramatic wide angle',
  'A crystalline {?} howling at a fractured moon over an aurora-lit frozen lake',
  'A baroque {?} overgrown with luminous tropical vines and butterflies',
  'A noir detective {?} in a rain-soaked alley, cigarette smoke curling into neon signs',
  'A giant {?} carrying an entire medieval village on its shell through desert dunes',
  'An art deco {?} lounging in a submerged 1920s ballroom, caustic light patterns',
  'A {?} reborn from ashes in a volcanic forge, molten feathers trailing sparks',
  'A floating island {?} with waterfalls cascading into clouds, warm candlelight inside',
  'A retro-futuristic synthwave {?} stretching into infinity under twin suns',
  'A macro photograph of a dewdrop reflecting {?} within it',
  'A Victorian automaton {?} performing on a stage of gears and starlight',
  'A minimalist ink wash painting of {?} dissolving into cherry ink clouds at dawn',
  'A {?} woven from lightning threads at the edge of a thunderstorm sea',
  'A cozy cottagecore {?} baking bread in a sunlit forest kitchen, flour in the air',
  'A surreal dreamscape where {?} floats above an endless mirror desert',
  'A samurai-era {?} meditating beneath a torii gate during a cherry blossom blizzard',
  'A cyberpunk {?} reflected in shattered holographic billboards after midnight rain',
  'A prehistoric {?} silhouetted against a blood-orange sky of volcanic ash',
  'A whimsical {?} riding a paper boat down a canal of liquid gold',
  'A haunted library {?} reading by candlelight among towering stacks of ancient tomes',
  'A post-apocalyptic {?} tending glowing mushrooms in the ruins of a cathedral',
  'A mythical {?} emerging from a cracked glacier under polar twilight',
  'A lavish Renaissance fresco depicting {?} surrounded by cherubs and celestial clouds',
  'A lonely {?} waiting at a foggy rural train station, golden hour, cinematic grain',
  'A microscopic {?} colony forming intricate patterns inside a geode of amethyst',
  'A desert nomad {?} crossing salt flats beneath a sky full of shooting stars',
  'An underwater {?} guard patrolling coral halls lit by bioluminescent jellyfish',
  'A brutalist {?} statue overgrown with moss in an abandoned concrete plaza',
  'A whimsical stop-motion {?} tangled in yarn inside a cluttered attic workshop',
  'An elven {?} archer poised on a moonlit bridge spanning a misty waterfall gorge',
  'A diesel-era {?} mechanic welding beneath oily amber workshop lights',
  'A fantastical {?} hatched from a pearl inside a giant clam on the ocean floor',
  'A stained-glass {?} illuminated by cathedral sunbeams, vivid jewel tones',
  'A wild west {?} silhouetted against a dust storm on the open prairie',
  'A solarpunk {?} tending vertical gardens atop a glass eco-tower at sunrise',
  'A cosmic {?} drifting through a nebula painted in ultraviolet and magenta hues',
  'A medieval {?} blacksmith forging a blade that glows with inner starlight',
  'A tropical {?} hidden in the canopy during a monsoon, vivid rain streaks',
  'A gothic {?} waltzing alone in an abandoned ballroom lit by moon through broken windows',
  'A pixar-style {?} splashing through a puddle that reflects an entire galaxy',
  'A zen garden {?} composed of sand ripples and a single perfectly placed stone',
] as const

export function randomTxt2imgPrompt(exclude?: string): string {
  const pool =
    exclude && TXT2IMG_DEFAULT_PROMPTS.length > 1
      ? TXT2IMG_DEFAULT_PROMPTS.filter(p => p !== exclude)
      : TXT2IMG_DEFAULT_PROMPTS
  const i = Math.floor(Math.random() * pool.length)
  return pool[i]!
}

/** Rotating starter prompts for txt2video — motion/camera-focused, with {?} subjects. */
export const TXT2VIDEO_DEFAULT_PROMPTS = [
  'A cinematic slow pan around {?} standing in wind-swept dunes at golden hour',
  '{?} sprinting through neon rain, camera tracking low behind splashing puddles',
  'Timelapse of clouds racing over {?} perched on a cliff above the sea',
  'An orbiting drone shot circling {?} in a misty bamboo forest at dawn',
  '{?} emerging from smoke in slow motion, embers drifting through dark air',
  'Gentle handheld footage of {?} reading by candlelight as pages flutter',
  'A dramatic crane rise revealing {?} alone on a rooftop at midnight',
  '{?} dancing in a sunbeam inside a dusty attic, particles swirling',
  'Underwater tracking shot following {?} through kelp forests, caustic light',
  'A vintage film reel of {?} racing a steam train along a mountain pass',
  'Macro close-up of {?} blinking as rain streaks the lens, shallow depth of field',
  '{?} walking through a crowded Tokyo crossing in slow motion, bokeh lights',
  'A steadicam follow behind {?} exploring a candlelit cathedral aisle',
  'Lightning flashing over {?} on a jagged peak, storm clouds rolling',
  'Stop-motion style {?} assembling itself from scattered clockwork parts',
  '{?} surfing a giant wave in slow motion, spray catching sunset light',
  'A rotating gimbal shot around {?} floating in zero gravity among debris',
  'Fireworks blooming behind {?} on a lakeshore, ripples spreading outward',
  '{?} riding a motorcycle through desert highway heat shimmer, wide angle',
  'Snowfall accumulating on {?} as the camera slowly pushes in, soft focus',
  'A hyperlapse of {?} crossing a bustling market from dawn to dusk',
  '{?} performing on a rainy stage, spotlight cutting through stage fog',
  'FPV-style dive toward {?} standing at the center of a spiral staircase',
  'Northern lights pulsing over {?} seated by a campfire on frozen tundra',
  '{?} releasing paper lanterns into the night sky, warm glow rising upward',
  'Slow dolly zoom on {?} in a crowded train car, realization dawning',
  'A looping shot of {?} beside a window as rain runs down the glass',
  '{?} marching through autumn leaves, leaves spiraling upward in their wake',
  'Cinematic aerial orbit of {?} on a glass bridge above a sea of clouds',
  'Soft focus pull from foreground bokeh to {?} opening eyes in morning light',
] as const

export function randomTxt2videoPrompt(exclude?: string): string {
  const pool =
    exclude && TXT2VIDEO_DEFAULT_PROMPTS.length > 1
      ? TXT2VIDEO_DEFAULT_PROMPTS.filter(p => p !== exclude)
      : TXT2VIDEO_DEFAULT_PROMPTS
  const i = Math.floor(Math.random() * pool.length)
  return pool[i]!
}

export const MODE_DEFAULTS: Record<
  ImgGenMode,
  { prompt: string; width: number; height: number; rescale: Partial<RescaleState> }
> = {
  txt2img: {
    prompt: TXT2IMG_DEFAULT_PROMPTS[0],
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
    prompt: TXT2VIDEO_DEFAULT_PROMPTS[0],
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
