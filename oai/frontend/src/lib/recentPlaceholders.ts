import { useSyncExternalStore } from 'react'

/** Most-recently-used `{placeholder}` tokens typed into an image/video prompt —
 *  `{?}`, built-in `{category}` names, or the user's own custom templates.
 *  Purely a client-side convenience for the quick-insert row below the prompt
 *  textarea: persisted in localStorage, never sent to or read from the server. */
const STORAGE_KEY = 'oai_imggen_recent_placeholders'
const MAX_RECENT = 7

function readStored(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

let cache = typeof window !== 'undefined' ? readStored() : []
const listeners = new Set<() => void>()

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // best-effort — quota/availability issues just mean the history doesn't survive reload
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return
    cache = readStored()
    listeners.forEach(l => l())
  })
}

/** Every literal `{token}` in `text`, in order of appearance. */
function extractPlaceholders(text: string): string[] {
  return text.match(/\{[^{}]+\}/g) ?? []
}

/** Records every placeholder token found in `text` as just-used — each moves
 *  to the front (deduped), list capped at `MAX_RECENT`. No-op if `text` has no
 *  `{...}` tokens or the resulting order is unchanged. */
export function recordPlaceholdersUsed(text: string): void {
  const found = extractPlaceholders(text)
  if (found.length === 0) return

  let next = cache
  for (const token of found) {
    next = [token, ...next.filter(t => t !== token)]
  }
  next = next.slice(0, MAX_RECENT)

  if (next.length === cache.length && next.every((t, i) => t === cache[i])) return
  cache = next
  persist()
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): string[] {
  return cache
}

/** Reactive, most-recently-used-first list of placeholder tokens (max 7). */
export function useRecentPlaceholders(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}
