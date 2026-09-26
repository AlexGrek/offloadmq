import { useCallback, useEffect, useRef, useState } from 'react'
import { listPromptEntries, type PromptEntry, type PromptKind } from '@/api/prompts'

const PAGE_SIZE = 40
const SEARCH_DEBOUNCE_MS = 250

type Options = {
  token: string | null
  bucket: string
  kind: PromptKind
  /** Raw search box text; debounced here before it hits the server. */
  query: string
  /** Load only while the drawer is open. */
  enabled: boolean
}

/**
 * Paged, server-filtered saved-prompt list for one (bucket, kind). The first page
 * loads when `enabled` turns on or the filter changes; `loadMore` appends the next
 * keyset page (driven by the drawer's scroll sentinel). A filter change aborts the
 * in-flight request and a generation counter drops any page that still resolves
 * late, so results from an older query never append to a newer list. The previous
 * list stays on screen (dimmed via `loading`) until the new first page lands.
 */
export function usePromptLibrary({ token, bucket, kind, query, enabled }: Options) {
  const [items, setItems] = useState<PromptEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  const [reloadNonce, setReloadNonce] = useState(0)
  /** Key of the filter the current `items` were loaded for. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const generation = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query])

  const key = `${bucket}\u0000${kind}\u0000${debouncedQuery.trim()}\u0000${reloadNonce}`

  // First page for the current filter.
  useEffect(() => {
    if (!enabled || !token) return
    const gen = ++generation.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    listPromptEntries(token, bucket, {
      kind,
      q: debouncedQuery,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then(page => {
        if (gen !== generation.current) return
        setItems(page.items)
        setCursor(page.next_cursor)
        setError(null)
        setLoadedKey(key)
      })
      .catch(e => {
        if (gen !== generation.current || controller.signal.aborted) return
        setError(e instanceof Error ? e.message : 'Failed to load prompts')
        setLoadedKey(key)
      })
    return () => controller.abort()
  }, [enabled, token, bucket, kind, debouncedQuery, key])

  const loading = enabled && loadedKey !== key
  const done = !loading && cursor === null

  const loadMore = useCallback(() => {
    if (!enabled || !token || loading || loadingMore || !cursor) return
    const gen = generation.current
    const controller = new AbortController()
    abortRef.current = controller
    setLoadingMore(true)
    listPromptEntries(token, bucket, {
      kind,
      q: debouncedQuery,
      cursor,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then(page => {
        if (gen !== generation.current) return
        setItems(prev => {
          const seen = new Set(prev.map(i => i.id))
          return [...prev, ...page.items.filter(i => !seen.has(i.id))]
        })
        setCursor(page.next_cursor)
      })
      .catch(e => {
        if (gen !== generation.current || controller.signal.aborted) return
        setError(e instanceof Error ? e.message : 'Failed to load prompts')
      })
      .finally(() => setLoadingMore(false))
  }, [enabled, token, loading, loadingMore, cursor, bucket, kind, debouncedQuery])

  const reload = useCallback(() => setReloadNonce(n => n + 1), [])

  const patchItem = useCallback((next: PromptEntry) => {
    setItems(prev => prev.map(i => (i.id === next.id ? next : i)))
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
  }, [])

  return {
    items,
    loading,
    loadingMore,
    done,
    error,
    /** The query the current list was fetched with (for match highlighting). */
    activeQuery: debouncedQuery,
    loadMore,
    reload,
    patchItem,
    removeItem,
  }
}
