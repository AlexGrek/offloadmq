import { useSyncExternalStore } from 'react'
import { apps } from './apps'

/** How often each dashboard app has been opened. Purely a client-side convenience
 *  for the TopBar's most-used shortcuts: persisted in localStorage, never sent to
 *  or read from the server. */
const STORAGE_KEY = 'oai_app_usage'
export const MAX_TOP_APPS = 3

type Counts = Record<string, number>

function readStored(): Counts {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Counts = {}
    for (const [id, n] of Object.entries(parsed)) {
      if (typeof n === 'number' && n > 0) out[id] = n
    }
    return out
  } catch {
    return {}
  }
}

let cache: Counts = typeof window !== 'undefined' ? readStored() : {}
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return
    cache = readStored()
    listeners.forEach(l => l())
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Count one visit to app `id`. */
export function recordAppVisit(id: string): void {
  // New object each time: `useSyncExternalStore` compares snapshots by identity.
  cache = { ...cache, [id]: (cache[id] ?? 0) + 1 }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // best-effort — quota/availability issues just mean the counts don't survive reload
  }
  listeners.forEach(l => l())
}

/** The app whose page `pathname` belongs to (`/app/images` and `/app/images/...`). */
export function appForPath(pathname: string) {
  return apps.find(a => pathname === a.href || pathname.startsWith(`${a.href}/`))
}

/** Most-visited apps, most first (dashboard order breaks ties); never-opened apps are excluded. */
export function topApps(counts: Counts, limit = MAX_TOP_APPS) {
  return apps
    .map((app, order) => ({ app, order, count: counts[app.id] ?? 0 }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, limit)
    .map(e => e.app)
}

export function useAppUsageCounts(): Counts {
  return useSyncExternalStore(subscribe, () => cache, () => ({}))
}
