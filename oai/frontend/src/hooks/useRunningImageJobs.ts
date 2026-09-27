import { useCallback, useEffect, useRef, useState } from 'react'
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

  const load = useCallback(
    async (silent: boolean) => {
      if (!token) {
        publish([])
        return
      }
      if (!silent) setLoading(true)
      try {
        const r = await fetchRunningImageJobs(token)
        publish(r.jobs)
      } catch {
        publish([])
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [token, publish],
  )

  /** Manual refresh — shows the spinner. */
  const refresh = useCallback(() => load(false), [load])
  /** Background refresh — no loading UI. */
  const refreshSilent = useCallback(() => load(true), [load])

  useEffect(() => {
    if (!token) return
    void load(false)
    const id = window.setInterval(() => {
      if (document.hidden) return
      void load(true)
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [token, load])

  return { jobs, loading, refresh, refreshSilent }
}
