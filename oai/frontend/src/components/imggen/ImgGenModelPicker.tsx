import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import { capabilityBaseLabel } from '@/lib/modelAvailability'
import type { ImgGenCapability } from '../../api/images'
import { CapabilityModelPicker } from '../CapabilityModelPicker'

interface ImgGenModelPickerProps {
  capabilities: ImgGenCapability[]
  selected: string
  onSelect: (base: string) => void
  onRefresh: () => void
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  testIdPrefix?: string
}

/** Form-style model picker for image generation (shared UI with other OAI apps). */
export function ImgGenModelPicker({ testIdPrefix = 'imggen-model-picker', ...props }: ImgGenModelPickerProps) {
  return (
    <CapabilityModelPicker
      {...props}
      formatLabel={cap => capabilityBaseLabel(cap.base)}
      testIdPrefix={testIdPrefix}
    />
  )
}
