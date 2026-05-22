/** Pick a capability only if it appears in the server's available list. */
export function pickListedCapability(
  preferred: string,
  capabilities: readonly { base: string }[],
): string | null {
  const trimmed = preferred.trim()
  if (!trimmed) return null
  if (capabilities.some(c => c.base === trimmed)) return trimmed
  return capabilities[0]?.base ?? null
}

export function isListedCapability(
  cap: string | null | undefined,
  capabilities: readonly { base: string }[],
): boolean {
  return !!cap && capabilities.some(c => c.base === cap)
}
