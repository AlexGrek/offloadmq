import { unavailableModelDotOpacity } from '@/lib/modelAvailability'
import type { LlmCapabilityInfo } from '@/types/ws'

/** Green dot for online models; fading amber dot for recently-seen offline ones. */
export function ModelAvailabilityDot({ cap }: { cap: LlmCapabilityInfo }) {
  if (cap.online) {
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-emerald-500"
        aria-hidden
        data-testid="model-dot-online"
      />
    )
  }
  const opacity = unavailableModelDotOpacity(cap.last_available_at)
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-amber-400"
      style={{ opacity }}
      aria-hidden
      data-testid="model-dot-offline"
    />
  )
}
