export type ChatTimeoutSettings = {
  timeoutSecs: number | null
  maxWaitSecs: number | null
  runtimeSecs: number | null
}

export const DEFAULT_TIMEOUT_SETTINGS: ChatTimeoutSettings = {
  timeoutSecs: 1500,
  maxWaitSecs: 300,
  runtimeSecs: 1200,
}
