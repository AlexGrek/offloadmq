import type { LlmCapabilityInfo } from '../types/ws'

/** Human-readable model name with the `llm.` prefix stripped. */
export function modelLabel(cap: LlmCapabilityInfo): string {
  return cap.base.replace(/^llm\./, '')
}

/** Matches backend `llm_capabilities::STALE_AFTER` (3 days). */
export const MODEL_UNAVAILABLE_FADE_MS = 3 * 24 * 60 * 60 * 1000

/** Yellow dot opacity for offline models: 1 when just went offline → 0 at 3 days. */
export function unavailableModelDotOpacity(lastAvailableAt: string, nowMs = Date.now()): number {
  const last = Date.parse(lastAvailableAt)
  if (Number.isNaN(last)) return 0
  const elapsed = Math.max(0, nowMs - last)
  return Math.max(0, 1 - elapsed / MODEL_UNAVAILABLE_FADE_MS)
}

export function sortCapabilitiesForPicker(caps: LlmCapabilityInfo[]): LlmCapabilityInfo[] {
  return [...caps].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    const ta = Date.parse(a.last_available_at)
    const tb = Date.parse(b.last_available_at)
    const diff = (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
    if (diff !== 0) return diff
    return a.base.localeCompare(b.base)
  })
}

export function firstSelectableModel(caps: LlmCapabilityInfo[]): string | null {
  const online = caps.find(c => c.online)
  if (online) return online.base
  return caps[0]?.base ?? null
}
