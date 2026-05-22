import type { ImageJobEvent, ImgGenCapability } from '../api/images'

export type ImgGenMode = 'txt2img' | 'img2img'

export type RescaleMode = 'exact' | 'max'

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
    rescale: { enabled: true, mode: 'exact', width: 768, height: 768 },
  },
}
