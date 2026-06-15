import { pickListedCapability } from './capability-picker'

/** React Router location state for `/app/tts` deep links from other pages. */
export type TtsRouteState = {
  /** Prefill the New speech form from file metadata (My Files properties). */
  generateAgain?: {
    jobId?: string
    parameters: Record<string, unknown>
  }
}

export function storedTtsText(stored: Record<string, unknown>): string {
  return String(stored.text ?? '').trim()
}

export function canGenerateAgainFromTtsStored(stored: Record<string, unknown>): boolean {
  return storedTtsText(stored) !== ''
}

export interface ApplyTtsToNewFormHandlers {
  setText: (v: string) => void
  setSelectedCap: (v: string) => void
  setSelectedVoice: (v: string) => void
}

export function applyTtsParamsToNewForm(
  params: { text: string; capability?: string; voice?: string },
  handlers: ApplyTtsToNewFormHandlers,
  capabilities?: readonly { base: string }[],
): void {
  handlers.setText(params.text)
  if (params.capability) {
    const cap = capabilities?.length
      ? (pickListedCapability(params.capability, capabilities) ?? params.capability)
      : params.capability
    handlers.setSelectedCap(cap)
  }
  if (params.voice) handlers.setSelectedVoice(params.voice)
}

export function applyStoredTtsParamsToNewForm(
  stored: Record<string, unknown>,
  handlers: ApplyTtsToNewFormHandlers,
  capabilities?: readonly { base: string }[],
): void {
  applyTtsParamsToNewForm(
    {
      text: storedTtsText(stored),
      capability: stored.capability != null ? String(stored.capability) : undefined,
      voice: stored.voice != null ? String(stored.voice) : undefined,
    },
    handlers,
    capabilities,
  )
}
