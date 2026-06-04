import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import type { LlmCapabilityInfo } from '@/types/ws'
import { CapabilityModelPicker } from '@/components/CapabilityModelPicker'

/** Popover model selector pinned to the chat composer. */
export function ModelPicker({
  capabilities,
  selected,
  onSelect,
  onRefresh,
  wsStatus,
  capabilitiesStatus,
  capabilitiesError,
}: {
  capabilities: LlmCapabilityInfo[]
  selected: string | null
  onSelect: (base: string) => void
  onRefresh: () => void
  wsStatus: string
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
}) {
  const connectionLabel =
    wsStatus === 'connecting' ? 'Connecting…' :
    wsStatus !== 'connected' ? 'Offline' :
    null

  const effectiveStatus: CapabilitiesStatus =
    wsStatus === 'connected' ? capabilitiesStatus : 'idle'

  return (
    <CapabilityModelPicker
      capabilities={capabilities}
      selected={selected ?? ''}
      onSelect={onSelect}
      onRefresh={onRefresh}
      capabilitiesStatus={effectiveStatus}
      capabilitiesError={capabilitiesError}
      variant="inline"
      placement="above"
      testIdPrefix="model-picker"
      connectionLabel={connectionLabel}
    />
  )
}
