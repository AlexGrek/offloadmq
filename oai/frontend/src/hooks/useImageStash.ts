import { useCallback, useEffect, useState } from 'react'

import {
  deleteImageStashEntry,
  listImageStash,
  stashImageJob,
  startImageStashEntry,
  type ImageStashEntry,
  type StartImageJobRequest,
  type StartImageJobResponse,
} from '@/api/images'

/**
 * Image-generation stash state for `ImageGenerationPage`: the saved entries plus
 * add / start / delete. Starting an entry removes it here and on the server (the
 * server puts it back if the submit fails, so the list is reloaded on error).
 */
export function useImageStash(token: string | null) {
  const [entries, setEntries] = useState<ImageStashEntry[]>([])
  const [loading, setLoading] = useState(Boolean(token))
  const [error, setError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [startingAll, setStartingAll] = useState(false)

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds(prev => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      setEntries(await listImageStash(token))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [token])

  // Initial load. Not via `refresh()`, whose synchronous `setLoading(true)` would
  // be a setState inside the effect body; `loading` starts true for a token.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    listImageStash(token)
      .then(list => {
        if (!cancelled) setEntries(list)
      })
      .catch(e => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  /** Saves requests in order; returns how many were stashed before any error. */
  const stash = useCallback(
    async (requests: StartImageJobRequest[]): Promise<number> => {
      if (!token) return 0
      let saved = 0
      try {
        for (const req of requests) {
          const entry = await stashImageJob(token, req)
          setEntries(prev => [entry, ...prev])
          saved++
        }
      } catch (e) {
        throw new Error(
          saved > 0
            ? `Stashed ${saved} of ${requests.length}: ${(e as Error).message}`
            : (e as Error).message,
          { cause: e },
        )
      }
      return saved
    },
    [token],
  )

  const start = useCallback(
    async (id: string): Promise<StartImageJobResponse | null> => {
      if (!token) return null
      setBusy(id, true)
      setError(null)
      try {
        const res = await startImageStashEntry(token, id)
        setEntries(prev => prev.filter(e => e.id !== id))
        return res
      } catch (e) {
        setError((e as Error).message)
        void refresh()
        return null
      } finally {
        setBusy(id, false)
      }
    },
    [token, setBusy, refresh],
  )

  /** Starts every entry, oldest first (the order they were stashed in). */
  const startAll = useCallback(
    async (onStarted: (res: StartImageJobResponse) => void) => {
      setStartingAll(true)
      try {
        for (const entry of [...entries].reverse()) {
          const res = await start(entry.id)
          if (!res) break
          onStarted(res)
        }
      } finally {
        setStartingAll(false)
      }
    },
    [entries, start],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!token) return
      setBusy(id, true)
      setError(null)
      try {
        await deleteImageStashEntry(token, id)
        setEntries(prev => prev.filter(e => e.id !== id))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(id, false)
      }
    },
    [token, setBusy],
  )

  return { entries, loading, error, busyIds, startingAll, refresh, stash, start, startAll, remove }
}
