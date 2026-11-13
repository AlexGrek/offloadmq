import { useCallback, useEffect, useRef, useState } from 'react'
import { useResetOnChange } from './useResetOnChange'
import { fetchRunningImageJobs, type RunningJobItem } from '../api/progress'

const POLL_MS = 5000

/**
 * `/api/progress/running`, refreshed every 5s.
 *
 * Background ticks are silent (no `loading` flip) and only publish a new array
 * when the payload actually changed — every `useProgress()` consumer re-renders
 * on each state change here, so an idle tick must be a no-op.
 */
export function useRunningImageJobs(token: string | null) {
  const [jobs, setJobs] = useState<RunningJobItem[]>([])
  const [loading, setLoading] = useState(false)
  const lastPayloadRef = useRef('[]')

  const publish = useCallback((next: RunningJobItem[]) => {
    const payload = JSON.stringify(next)
    if (payload === lastPayloadRef.current) return
    lastPayloadRef.current = payload
    setJobs(next)
  }, [])

  // Network fetch + publish with no synchronous state writes, so the poll effect can
  // call it directly. Callers own the `loading` flag.
  const fetchJobs = useCallback(() => {
    if (!token) return Promise.resolve()
    return fetchRunningImageJobs(token)
      .then(r => publish(r.jobs))
      .catch(() => publish([]))
  }, [token, publish])

  const load = useCallback(
    async (silent: boolean) => {
      if (!token) {
        publish([])
        return
      }
      if (!silent) setLoading(true)
      try {
        await fetchJobs()
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [token, publish, fetchJobs],
  )

  /** Manual refresh — shows the spinner. */
  const refresh = useCallback(() => load(false), [load])
  /** Background refresh — no loading UI. */
  const refreshSilent = useCallback(() => load(true), [load])

  // A new token shows the spinner until its first fetch lands.
  useResetOnChange(token, t => {
    if (t) setLoading(true)
  })

  useEffect(() => {
    if (!token) return
    void fetchJobs().finally(() => setLoading(false))
    const id = window.setInterval(() => {
      if (document.hidden) return
      void fetchJobs()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [token, fetchJobs])

  return { jobs, loading, refresh, refreshSilent }
}
