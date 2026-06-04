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
}

/** Form-style model picker for image generation (shared UI with other OAI apps). */
export function ImgGenModelPicker(props: ImgGenModelPickerProps) {
  return (
    <CapabilityModelPicker
      {...props}
      formatLabel={cap => capabilityBaseLabel(cap.base)}
      testIdPrefix="imggen-model-picker"
    />
  )
}
