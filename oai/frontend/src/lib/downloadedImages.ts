import { useSyncExternalStore } from 'react'

/** Client-only "have I downloaded this image before" tracker, shared by
 *  ImageGenerationPage and ImgUtilsPage (and the shared ImageLightbox).
 *  Persisted in localStorage — this is a UI convenience, not server state. */
const STORAGE_KEY = 'oai_downloaded_images'

function readStored(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

let cache = typeof window !== 'undefined' ? readStored() : new Set<string>()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(cache)))
  } catch {
    // best-effort — quota/availability issues just mean the mark doesn't survive reload
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return
    cache = readStored()
    listeners.forEach(l => l())
  })
}

/** Marks an image as downloaded; no-op (and no re-render) if already marked. */
export function markImageDownloaded(imageId: string): void {
  if (cache.has(imageId)) return
  cache = new Set(cache).add(imageId)
  persist()
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): Set<string> {
  return cache
}

/** Reactive set of image ids the user has downloaded at least once. */
export function useDownloadedImages(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Triggers a same-tab browser file download via a transient anchor element. */
export function triggerImageDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.click()
}
