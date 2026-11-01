import { cancelImageJob, deleteImageJob, imageFileUrl, pollImageJob, startImageJob } from '@/api/images'
import { cancelImgUtilsJob, deleteImgUtilsJob, pollImgUtilsJob, startImgUtilsJob, type ImgUtilTool } from '@/api/imgUtils'
import { listPromptPlaceholders } from '@/api/promptPlaceholders'
import { createPlaceholderUsage, expandPromptPlaceholders } from './promptPlaceholders'

export const HALLUCINATE_BUCKET = 'hallucinate-prompt'
export const FADE_MS = 6000
const REQUEST_TIMEOUT_MS = 15000
const CLEANUP_TIMEOUT_MS = 30000

/** Submit has a deadline but must still return its ID after Pause so we can cancel it. */
export function wallpaperRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export class WallpaperCleanupError extends Error {}
export const WALLPAPER_SIZES = [
  { ratio: '16:9', color: 'border-cyan-500', sizes: [[768, 432], [1024, 576], [1280, 720], [1536, 864], [1920, 1080]] },
  { ratio: '3:2', color: 'border-violet-500', sizes: [[768, 512], [1152, 768], [1536, 1024]] },
  { ratio: '4:3', color: 'border-amber-500', sizes: [[768, 576], [1024, 768], [1280, 960]] },
  { ratio: '1:1', color: 'border-rose-500', sizes: [[512, 512], [768, 768], [1024, 1024], [1280, 1280], [1536, 1536]] },
] as const

export interface WallpaperSettings {
  prompt: string
  capability: string
  width: number
  height: number
  upscaler?: ImgUtilTool
  scale: number
}

export interface WallpaperJobProgress {
  kind: 'generation' | 'upscale'
  jobId: string | null
  capability: string
  status: string
  stage: string | null
  submittedAt: string
  startedAt: string | null
  finishedAt: string | null
  typicalRuntimeSeconds: number | null
  queuedSeconds: number | null
  executionSeconds: number | null
}

type WallpaperPoll = {
  status: string
  stage?: string | null
  submitted_at?: string | null
  created_at?: string
  started_at?: string | null
  typical_runtime_seconds?: number | null
  queued_seconds?: number | null
  execution_seconds?: number | null
}

export const isWallpaperJobTerminal = (status: string) => ['completed', 'failed', 'canceled', 'cancelled'].includes(status.toLowerCase())
const check = (signal: AbortSignal) => signal.throwIfAborted()
function delay(ms: number, signal: AbortSignal): Promise<void> {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** One owner, one task at a time. No server-side loop survives the page. */
export async function runWallpaper(
  token: string,
  settings: WallpaperSettings,
  signal: AbortSignal,
  onStage: (stage: string) => void,
  onFrame: (url: string) => void,
  onJob?: (job: WallpaperJobProgress | null) => void,
): Promise<void> {
  const definitions = await listPromptPlaceholders(token, wallpaperRequestSignal(signal))
  const custom = Object.fromEntries(definitions.map(d => [d.name.toLowerCase(), d.variants]))
  const usage = createPlaceholderUsage()
  let generation: string | undefined
  let upscale: string | undefined
  let generationDone = false
  let upscaleDone = false
  let lastFrameAt = 0
  let failure: unknown
  let currentJob: WallpaperJobProgress | null = null
  const beginJob = (kind: WallpaperJobProgress['kind'], capability: string) => {
    currentJob = {
      kind, capability, jobId: null, status: 'submitting', stage: null,
      submittedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      typicalRuntimeSeconds: null, queuedSeconds: null, executionSeconds: null,
    }
    onJob?.(currentJob)
  }
  const updateJob = (patch: Partial<WallpaperJobProgress>) => {
    if (!currentJob) return
    currentJob = { ...currentJob, ...patch }
    onJob?.(currentJob)
  }
  const reportPoll = (result: WallpaperPoll) => updateJob({
    status: result.status,
    stage: result.stage ?? null,
    submittedAt: result.submitted_at ?? result.created_at ?? currentJob?.submittedAt,
    startedAt: result.started_at ?? currentJob?.startedAt ?? null,
    finishedAt: isWallpaperJobTerminal(result.status) ? currentJob?.finishedAt ?? new Date().toISOString() : null,
    typicalRuntimeSeconds: result.typical_runtime_seconds ?? null,
    queuedSeconds: result.queued_seconds ?? null,
    executionSeconds: result.execution_seconds ?? null,
  })
  try {
    while (!signal.aborted) {
      // A background tab keeps its current picture but does not request more work.
      while (document.visibilityState === 'hidden') {
        onStage('Paused while tab is hidden')
        onJob?.(null)
        await delay(1000, signal)
      }
      check(signal)
      onStage('Rendering next image')
      generationDone = false
      beginJob('generation', settings.capability)
      const job = await startImageJob(token, {
        capability: settings.capability,
        prompt: expandPromptPlaceholders(settings.prompt, usage, custom),
        workflow: 'txt2img', width: settings.width, height: settings.height,
        seed: Math.floor(Math.random() * 2147483647),
        override_negative: true, negative_prompt: '',
      }, wallpaperRequestSignal())
      generation = job.job_id
      updateJob({ jobId: job.job_id, status: job.status || 'submitted' })
      check(signal)
      let imageId: string | undefined
      while (!generationDone) {
        const result = await pollImageJob(token, generation, wallpaperRequestSignal(signal))
        generationDone = isWallpaperJobTerminal(result.status)
        reportPoll(result)
        check(signal)
        if (generationDone) {
          if (result.status !== 'completed') throw new Error(result.error || `Generation ${result.status}`)
          imageId = result.output_images[0]?.image_id
        } else {
          onStage(result.stage || `Rendering · ${result.status}`)
          await delay(3000, signal)
        }
      }
      if (!imageId) throw new Error('The generator returned no image.')
      if (settings.upscaler) {
        check(signal)
        onStage(`Upscaling ×${settings.scale}`)
        upscaleDone = false
        beginJob('upscale', settings.upscaler.capability)
        const tool = await startImgUtilsJob(token, {
          capability: settings.upscaler.capability, workflow: settings.upscaler.workflow,
          input_image_id: imageId, options: { scale_multiplier: settings.scale },
        }, wallpaperRequestSignal())
        upscale = tool.job_id
        updateJob({ jobId: tool.job_id, status: tool.status || 'submitted' })
        check(signal)
        while (!upscaleDone) {
          const result = await pollImgUtilsJob(token, upscale, wallpaperRequestSignal(signal))
          upscaleDone = isWallpaperJobTerminal(result.status)
          reportPoll(result)
          check(signal)
          if (upscaleDone) {
            if (result.status !== 'completed' || !result.output_image_id) throw new Error(result.error || 'Upscale produced no image.')
            imageId = result.output_image_id
          } else await delay(3000, signal)
        }
      }
      // Own the bytes before removing temporary storage; only two blobs live in the UI.
      const response = await fetch(imageFileUrl(imageId, token), { signal: wallpaperRequestSignal(signal) })
      if (!response.ok) throw new Error(`Cannot load wallpaper (HTTP ${response.status}).`)
      const url = URL.createObjectURL(await response.blob())
      try {
        const image = new Image()
        image.src = url
        await image.decode()
        // Rendering can overlap the fade, but a fast result never cuts it short.
        const remainingFade = lastFrameAt ? lastFrameAt + FADE_MS - performance.now() : 0
        if (remainingFade > 0) await delay(remainingFade, signal)
        check(signal)
        onFrame(url)
        lastFrameAt = performance.now()
      } catch (error) { URL.revokeObjectURL(url); throw error }
      if (upscale) { await deleteImgUtilsJob(token, upscale, wallpaperRequestSignal()); upscale = undefined }
      await deleteImageJob(token, generation, wallpaperRequestSignal())
      generation = undefined
      onStage('Dreaming')
    }
  } catch (error) {
    failure = error
  }
  // Cancellation can race completion: a 400 from Cancel must not skip the final poll.
  // Each resource has its own deadline, so a broken upscale never skips generation cleanup.
  const clean = async (id: string, kind: 'generation' | 'upscale', done: boolean) => {
    const deadline = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    const requestSignal = () => AbortSignal.any([deadline, AbortSignal.timeout(5000)])
    if (!done) {
      try {
        if (kind === 'generation') await cancelImageJob(token, id, requestSignal())
        else await cancelImgUtilsJob(token, id, requestSignal())
      } catch {
        // A terminal job rejects cancellation; polling below distinguishes this
        // benign race from a task still executing or an unavailable backend.
      }
      while (!done) {
        const result = kind === 'generation'
          ? await pollImageJob(token, id, requestSignal())
          : await pollImgUtilsJob(token, id, requestSignal())
        done = isWallpaperJobTerminal(result.status)
        if (currentJob?.jobId === id && currentJob.kind === kind) reportPoll(result)
        if (!done) await delay(1500, deadline)
      }
    }
    // Executing rows stay available to the backend reconciler.
    if (kind === 'generation') await deleteImageJob(token, id, requestSignal())
    else await deleteImgUtilsJob(token, id, requestSignal())
  }
  const errors: string[] = []
  if (upscale) {
    try { await clean(upscale, 'upscale', upscaleDone) }
    catch (error) { errors.push(`upscale ${upscale}: ${String(error)}`) }
  }
  if (generation) {
    try { await clean(generation, 'generation', generationDone) }
    catch (error) { errors.push(`generation ${generation}: ${String(error)}`) }
  }
  if (errors.length) {
    const original = failure && !signal.aborted ? `${String(failure)}. ` : ''
    throw new WallpaperCleanupError(`${original}Temporary wallpaper cleanup failed: ${errors.join('; ')}`)
  }
  if (failure) throw failure
}
