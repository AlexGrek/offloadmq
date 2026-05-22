import { useCallback, useEffect, useState } from 'react'
import { fetchRunningImageJobs, type RunningJobItem } from '../api/progress'

const POLL_MS = 5000

export function useRunningImageJobs(token: string | null) {
  const [jobs, setJobs] = useState<RunningJobItem[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!token) {
      setJobs([])
      return
    }
    setLoading(true)
    try {
      const r = await fetchRunningImageJobs(token)
      setJobs(r.jobs)
    } catch {
      setJobs([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    void refresh()
    const id = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(id)
  }, [token, refresh])

  return { jobs, loading, refresh }
}
