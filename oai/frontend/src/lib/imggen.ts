import type {
  ImageJobDetails,
  ImageJobFile,
  ImagePipelineParams,
  ImagePipelineRescaleParams,
  ImgGenCapability,
  ImageJobEvent,
  UploadedImage,
} from '../api/images'
import type { RunningJobItem } from '../api/progress'
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

/** Human-readable pipeline job status — distinguishes queue wait from agent work. */
export function imageJobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    submitted: 'In queue',
    pending: 'Pending',
    queued: 'Queued',
    assigned: 'Assigned',
    starting: 'Starting',
    running: 'Generating',
    cancelRequested: 'Canceling',
    completed: 'Completed',
    failed: 'Failed',
    canceled: 'Canceled',
  }
  return labels[status] ?? status.replace(/_/g, ' ')
}

/** True when an agent is actively executing (not merely queued). */
export function imageJobIsExecuting(status: string): boolean {
  return status === 'starting' || status === 'running'
}

/**
 * Compact human-readable duration, e.g. `42s`, `3m 05s`, `1h 02m`. Used for
 * the queue-wait / execution-time readouts — never sums the two into a total.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(sec)}s`
  return `${sec}s`
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
  setExternalResize: (v: boolean) => void
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
  // Replay the original choice rather than re-deriving it from the file size:
  // the job ran that way, so "Edit prompt" and retry should too.
  handlers.setExternalResize(!!inputFile && !!p.external_resize)
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
  let inputFile: UploadedImage | ImageJobFile | undefined =
    (mode === 'img2img' || mode === 'img2video') && p.input_image_id
      ? job.files.find(f => f.direction === 'input')
      : undefined
  if (!inputFile && (mode === 'img2img' || mode === 'img2video') && p.input_image_id) {
    inputFile = stubUploadedInput(p.input_image_id, p.width, p.height)
  }
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
  'An anime-style {?} standing on a rooftop at dusk, sakura petals swirling, vivid sky gradient',
  'A 35mm film photograph of {?} on a quiet coastal road, soft grain, faded Kodachrome colors',
  'A watercolor study of {?} sheltering under a huge umbrella in a rainy market square',
  'A woodcut print of {?} confronting a towering wave, bold black linework and flat inks',
  'A linocut illustration of {?} among owls and crescent moons, two-color red and cream',
  'An isometric low-poly diorama of {?} living inside a tiny floating workshop',
  'A sprawling space-station atrium where {?} waters hanging gardens beneath a curved glass ceiling',
  'A rustic still life featuring {?}, ripe figs, and a copper pot on a weathered oak table, Dutch master lighting',
  'A brutalist opera house reimagined as {?}, sunrise haze, ultra-wide architectural photograph',
  'A tiny dragon-shaped {?} curled around a candle flame in a stone alcove, warm glow',
  'A hushed forest clearing where {?} is watched by countless glowing eyes among the ferns',
  'A stadium at night with {?} taking a match-winning shot, floodlights and swirling confetti',
  'A first snowfall over a lantern-lit village, {?} hurrying home with a loaf of bread',
  'A macro shot of a frost-covered leaf that resembles {?}, crystalline detail, shallow focus',
  'A galaxy-scale portrait of {?} formed from spiral arms and drifting stardust',
  'A Studio Ghibli-inspired meadow with {?} lying in tall grass watching enormous clouds go by',
  'A retro 80s arcade where {?} plays a glowing cabinet, neon reflections on wet concrete',
  'A hand-painted ukiyo-e scene of {?} crossing an arched bridge in a snowstorm',
  'A Gothic cathedral built from ice, {?} standing in the nave as light fractures through the walls',
  'A clockwork {?} winding itself up in a watchmaker\'s window, brass gears and green glass',
  'A sunlit greenhouse jungle where {?} naps in a hammock between giant monstera leaves',
  'A gritty cyberpunk street food stall run by {?}, steam rising into holographic menus',
  'A mossy stone giant shaped like {?} sleeping under a canopy of ancient redwoods',
  'A high-fashion editorial of {?} in a sculptural gown, stark white studio, dramatic side light',
  'A pirate ship sailing through the sky carrying {?} at the helm, sunset clouds like waves',
  'A lighthouse keeper {?} climbing a spiral staircase during a howling gale, lamplight glow',
  'A mid-century modern living room with {?} lounging under a wall of hanging plants, golden hour',
  'A pastel dreamland where {?} rides a giant marshmallow cloud over a candy-colored sea',
  'A moody chiaroscuro portrait of {?} lit by a single candle, deep shadows, Rembrandt style',
  'A miniature village built inside a hollow tree stump, {?} peering from a round window',
  'A crystal cave illuminated from within, {?} standing at the mouth in silhouette',
  'A lively night market in Taipei with {?} sampling skewers, lanterns and steam everywhere',
  'A dreamy vaporwave statue of {?} on a checkerboard plain beneath a giant pink sun',
  'A rain-slicked Parisian cafe terrace at dusk, {?} sketching in a notebook, warm interior glow',
  'A cinematic western showdown between {?} and a tumbleweed at high noon, dust and long shadows',
  'A field of sunflowers taller than a house with {?} lost among them, hazy summer light',
  'A steam locomotive shaped like {?} charging across a viaduct through an alpine valley',
  'An origami {?} unfolding on a wooden desk, morning light streaming through paper blinds',
  'A deep-sea research submersible where {?} presses against the glass at a glowing anglerfish',
  'A children\'s book illustration of {?} building a snow fort, soft gouache, cozy winter palette',
  'A mystical alchemist\'s lab where {?} stirs a bubbling cauldron of liquid starlight',
  'A wide-angle photograph of {?} standing on a salt flat that mirrors the entire sky',
  'A retro sci-fi book cover starring {?} against a ringed planet, airbrushed gradients, bold title space',
  'A cliffside monastery in the clouds where {?} rings a giant bronze bell at dawn',
  'A Baroque banquet table crowded with fruit and candles, {?} peeking out from behind a golden goblet',
  'A grand library inside an enormous whale skeleton with {?} browsing shelves by lantern light',
  'A fisheye view of {?} skateboarding down a sun-drenched empty swimming pool',
  'A tranquil pond at twilight where {?} reflects among glowing lotus flowers and dragonflies',
  'A cutaway illustration of an underground city with {?} riding a glass elevator through layers of light',
  'A frosted window pane etched with the shape of {?}, warm firelight blurred behind it',
  'A stunt-pilot {?} looping a biplane through a canyon of red rock, dramatic aerial photography',
  'A tender oil painting of {?} feeding pigeons in a crumbling stone plaza, late autumn light',
  'A neon-lit karaoke room where {?} belts out a song, confetti cannons and mirrored walls',
  'A giant mechanical {?} kneeling in a wheat field, rust and wildflowers, soft evening haze',
  'A gemstone-encrusted {?} resting on velvet, macro jewelry photography, sparkling caustics',
  'A wandering merchant {?} leading a caravan of lanterns through a starlit desert canyon',
  'A sunken temple reclaimed by coral, {?} swimming through a shaft of turquoise light',
  'A rooftop garden in a rainy megacity where {?} shelters beneath a translucent umbrella',
  'A storm-tossed lighthouse island with {?} waving from the gallery, colossal waves crashing below',
  'A sleepy fox-spirit {?} curled among red torii gates on a moss-covered mountain trail',
  'A chalk pastel drawing of {?} dancing on a sun-warmed sidewalk, playful pastel colors',
  'A fantasy tavern where {?} tells a story to a rapt crowd, firelit faces, warm painterly style',
  'A candy-striped circus tent at twilight with {?} balancing on a tightrope of golden light',
  'An arctic research base under the aurora with {?} tending glowing instruments in the snow',
  'A dark-fantasy throne room where {?} sits atop a mountain of books, torches and drifting embers',
  'A retro travel poster for a floating city, {?} waving from the deck, bold flat shapes and textured print',
  'A rainy Tokyo alley at 3 a.m. with {?} sharing a ramen counter with a paper-lantern ghost',
  'A quiet moonlit orchard where {?} climbs a ladder to pick glowing pears, fireflies everywhere',
  'A sweeping fantasy vista where {?} stands atop a bridge of roots connecting two giant trees',
  'A cardboard-craft world with {?} piloting a paper rocket over a cotton-ball sky',
  'A vintage botanical plate depicting {?} as an unknown flowering species, fine ink and watercolor labels',
  'A double-exposure portrait of {?} blended with a misty pine forest at sunrise',
  'A surreal staircase floating in a cloudy sky, {?} descending toward a pool of stars',
  'A mountaintop observatory where {?} charts constellations by lamplight, snow-dusted dome',
  'A bustling medieval bazaar seen from above, {?} weaving through crowds carrying a golden lantern',
  'A dramatic long-exposure night photograph of {?} standing before a colossal glowing waterfall',
  'A whimsical treehouse village linked by rope bridges, {?} delivering mail at sunrise',
  'A knight\'s portrait of {?} in ornate filigreed armor, cracked helmet held under one arm, moody battlefield haze',
  'A neon-drenched boxing gym where {?} wraps their hands in slow, focused motion, sweat and smoke',
  'A quiet snow-covered temple courtyard where {?} rakes a pattern into the fresh white ground',
  'A macro photograph of {?} reflected in a soap bubble, iridescent swirls, black background',
  'A vibrant Mexican papel picado festival with {?} dancing beneath strings of cut-paper banners',
  'A sun-bleached desert diner at dusk, {?} at the counter, neon sign buzzing in the dry heat',
  'A giant glass terrarium containing a whole miniature world, {?} tending it with a tiny watering can',
  'A blueprint-style technical drawing of {?} as an intricate flying machine, annotated in white ink',
  'A surreal underwater cityscape where {?} rides a manta ray between glowing skyscrapers',
  'A dusk-lit rooftop gathering with {?} playing violin, city lights sparkling below like fallen stars',
  'A dramatic portrait of {?} half-lit by a stained-glass window, jewel-toned shadows on their face',
  'A cheerful claymation scene of {?} baking a giant cake in a tiny toy kitchen, soft studio lighting',
  'A vast crystal desert where {?} drags a sled of glowing shards beneath two pale moons',
  'A fairy-tale cottage roof covered in moss and mushrooms, {?} waving from a round chimney window',
  'A dramatic tilt-shift view of {?} conducting an orchestra of fireflies over a tiny valley town',
  'A grand ballroom frozen mid-waltz with {?} the only figure still moving, swirling gilded light',
  'A lush hanging-garden cityscape with {?} pruning vines from a suspended tram car',
  'A stormy sea cave where {?} sits by a fire of driftwood, glowing runes on the stone walls',
  'An inky black-and-white manga panel of {?} leaping between rooftops, dramatic speed lines',
  'A pixel-art village at sunset where {?} fishes from a wooden pier, crisp 16-bit palette',
  'A dreamy pastel portrait of {?} wearing a crown of paper flowers, soft window light',
  'A hidden mountain valley of floating lanterns with {?} paddling a canoe across the glassy lake',
  'A sun-drenched Mediterranean terrace, {?} sipping espresso, bougainvillea spilling over whitewashed walls',
  'A colossal tree-sized {?} sculpture carved from driftwood, standing on a windswept beach at low tide',
  'A cosmic tarot card illustration featuring {?}, ornate gilded border, starry backdrop',
  'A sleepy harbor town at blue hour, {?} lighting harbor lamps one by one, glass-calm water',
  'A hyper-detailed portrait of {?} with frost on their eyelashes, dramatic winter sunrise behind',
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
  'A slow dolly-in on {?} standing at the edge of a foggy lake at sunrise, mist curling off the water',
  'Drone shot rising over {?} on a snowy ridge as the sun crests the horizon',
  '{?} walking through a lantern-lit alley in the rain, camera gliding backward at shoulder height',
  'A time-lapse of stars wheeling above {?} beside a tent in a silent desert',
  'Handheld footage of {?} racing down a forest trail, sunbeams flickering through the trees',
  'A rack focus from raindrops on a window to {?} watching the street below',
  'A sweeping helicopter shot following {?} on horseback across a green highland valley',
  '{?} lighting sparklers on a beach at dusk, embers trailing into slow motion',
  'A whip pan from a neon sign to {?} stepping out of a taxi in a rainy city',
  'Slow-motion shot of {?} leaping through a wall of falling cherry blossoms',
  'An underwater slow orbit around {?} floating weightless, shafts of sunlight overhead',
  'A steadicam shot following {?} through a bustling night market, steam and lanterns blurring past',
  'Macro footage of {?} cradling a glowing firefly as it lifts off into the dark',
  'A dramatic push-in on {?} standing in a dust storm, cloak whipping in the wind',
  'A snowboarder {?} carving through fresh powder, spray catching the low sun, GoPro chase cam',
  'A cinematic reveal of {?} on the deck of a ship as fog parts to show a distant lighthouse',
  '{?} playing piano in an empty concert hall, dust motes drifting through a single spotlight',
  'A vertical tilt down a waterfall to {?} sitting quietly at its base, mist rising',
  'A lazy overhead shot of {?} floating on a river through autumn foliage',
  'A stop-motion shot of {?} kneading dough in a tiny kitchen, flour puffing in warm light',
  'Slow-motion footage of {?} dropping into a pool, bubbles exploding around them',
  'A gimbal shot circling {?} on a spinning carousel at twilight, colored bulbs streaking',
  'An extreme close-up of {?} exhaling a cloud of breath in freezing air, ice crystals sparkling',
  '{?} pedaling a bicycle along a coastal road, wind in their hair, camera tracking alongside',
  'A cinematic dolly zoom on {?} standing in the middle of a wheat field as storm clouds gather',
  'A crane shot descending onto {?} sitting on the roof of a train as it crosses a canyon bridge',
  'A time-lapse of a city waking up behind {?} on a balcony, sunrise painting the skyline',
  'A first-person view of {?} paragliding above turquoise water and jagged cliffs',
  '{?} juggling glowing orbs in a dark warehouse, long-exposure light trails',
  'A quiet observational shot of {?} watering plants in a sunlit greenhouse, water droplets glittering',
  'A bird\'s-eye view spiraling down toward {?} standing alone in a giant maze',
  '{?} lifting a lantern through a foggy graveyard, flame flickering in the breeze',
  'Slow-motion shot of {?} catching a falling star in cupped hands on a moonlit hilltop',
  'A tracking shot alongside {?} sprinting through a hall of mirrors, reflections multiplying',
  'A handheld documentary shot of {?} tuning a guitar in a tiny apartment as rain patters outside',
  'A sunset timelapse over {?} sitting on a dock as the water shifts from gold to violet',
  'An aerial orbit of {?} on a small boat in the middle of a glowing bioluminescent bay',
  'A cinematic pull-back from {?} reading in a window to reveal a sprawling nighttime cityscape',
  'A snowy forest chase with {?} sledding down a hillside, powder flying, dynamic wide shot',
  '{?} stepping through a shimmering portal, the camera following as the world melts into light',
  'A slow crane down through drifting clouds to {?} standing on a floating island',
  'A dramatic low-angle shot of {?} walking toward camera through a smoke-filled corridor, red emergency lights',
  'Kaleidoscopic slow-motion footage of {?} twirling in a room of falling confetti',
  'A high-speed macro of {?} cracking a frozen puddle underfoot, shards spinning in the light',
  'A cinematic sweep across a desert canyon to {?} on a lone motorcycle, dust trailing behind',
  'An ethereal slow pan across {?} asleep in a hammock as fireflies rise in the twilight',
  'A speedramp shot of {?} running through a neon tunnel, streaks of light bending around them',
  'A calm tracking shot following {?} rowing across a misty mountain lake, oars rippling the surface',
  'A dizzying spinning shot inside a lighthouse as {?} climbs the stairs, warm light on wet stone',
  'A quiet slow-motion shot of {?} releasing a paper airplane from a bridge into a golden sunset',
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

export interface QueueEstimate {
  /** In-flight jobs counted (canceling ones excluded). */
  jobs: number
  /** Estimated seconds until the whole queue has drained; `null` when nothing could be estimated. */
  seconds: number | null
  /** True when some jobs had no runtime estimate and were left out of `seconds`. */
  partial: boolean
}

const QUEUED_STATUSES = new Set(['submitted', 'pending', 'queued', 'assigned'])

function baseCap(cap: string): string {
  const i = cap.indexOf('[')
  return i < 0 ? cap : cap.slice(0, i)
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

/**
 * Estimated time to drain the image-generation queue, assuming jobs run one after
 * another (the number of agents is not known to the client, so this is an upper-ish
 * bound when several agents share the load).
 *
 * Per job: an executing job contributes `typical − elapsed` (floored at 0), a queued
 * one its full `typical`. A missing `typical` falls back to the mean of finished jobs
 * on the same capability (`history`), then to the mean of the other in-flight jobs.
 */
export function estimateQueue(
  running: Pick<RunningJobItem, 'status' | 'offload_cap' | 'started_at' | 'typical_runtime_seconds'>[],
  history: Pick<ImageJobDetails, 'capability' | 'typical_runtime_seconds'>[],
  nowMs: number,
): QueueEstimate {
  const active = running.filter(r => r.status !== 'cancelRequested')

  const byCap = new Map<string, number[]>()
  for (const h of history) {
    const t = h.typical_runtime_seconds
    if (t != null && t > 0) {
      const key = baseCap(h.capability)
      byCap.set(key, [...(byCap.get(key) ?? []), t])
    }
  }
  const inFlightKnown = active
    .map(r => r.typical_runtime_seconds)
    .filter((t): t is number => t != null && t > 0)
  const inFlightMean = mean(inFlightKnown)

  let seconds = 0
  let estimated = 0
  for (const r of active) {
    const typical =
      (r.typical_runtime_seconds != null && r.typical_runtime_seconds > 0
        ? r.typical_runtime_seconds
        : null) ??
      mean(byCap.get(baseCap(r.offload_cap)) ?? []) ??
      inFlightMean
    if (typical == null) continue
    const executing =
      imageJobIsExecuting(r.status) || (r.started_at != null && !QUEUED_STATUSES.has(r.status))
    const elapsed =
      executing && r.started_at ? Math.max(0, (nowMs - new Date(r.started_at).getTime()) / 1000) : 0
    seconds += Math.max(0, typical - elapsed)
    estimated += 1
  }
  return {
    jobs: active.length,
    seconds: estimated > 0 ? seconds : null,
    partial: estimated > 0 && estimated < active.length,
  }
}
