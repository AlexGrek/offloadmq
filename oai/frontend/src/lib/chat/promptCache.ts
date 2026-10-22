const MAX_AGE_MS = 24 * 60 * 60 * 1000
const cacheKey = (userId: number) => `oai_chat_system_prompt:${userId}`

export function readChatPrompt(userId: number): string | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    if (!raw) return null
    const cached = JSON.parse(raw)
    if (
      typeof cached.prompt === 'string' && cached.prompt.trim() &&
      typeof cached.savedAt === 'number' &&
      cached.savedAt <= Date.now() && Date.now() - cached.savedAt < MAX_AGE_MS
    ) return cached.prompt
    localStorage.removeItem(cacheKey(userId))
  } catch {
    // Storage may be unavailable or contain a malformed entry.
  }
  return null
}

export function rememberChatPrompt(userId: number, prompt: string) {
  if (!prompt.trim()) return
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify({ prompt, savedAt: Date.now() }))
  } catch {
    // A storage failure must not prevent creating or editing a chat.
  }
}
