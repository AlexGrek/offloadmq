export function toolDebugReady(cap: string | null | undefined, taskId: string | null | undefined): boolean {
  return Boolean(cap?.trim() && taskId?.trim())
}
