import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './AuthContext'
import { useRunningImageJobs } from '../hooks/useRunningImageJobs'
import { cancelImageJob, pollImageJob } from '../api/images'
import { pollDescribeJob } from '../api/describe'
import type { RunningJobItem } from '../api/progress'
import { ProgressContext } from './ProgressContext'

const BACKGROUND_POLL_MS = 5000
const BACKGROUND_POLL_CONCURRENCY = 3

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export function ProgressProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // `/api/progress/running` feeds every job source; split it so image-only
  // consumers (page status overrides, cancel-requested re-issue) never see describe rows.
  const { jobs: runningJobs, loading: runningImageJobsLoading, refresh, refreshSilent } =
    useRunningImageJobs(token)
  const runningImageJobs = useMemo(
    () => runningJobs.filter(j => j.source === 'image'),
    [runningJobs],
  )
  const runningDescribeJobs = useMemo(
    () => runningJobs.filter(j => j.source === 'describe'),
    [runningJobs],
  )

  // Keep a ref so the polling loop always sees the latest job list without
  // recreating the timer on every refresh.
  const runningJobsRef = useRef(runningJobs)
  useEffect(() => { runningJobsRef.current = runningJobs }, [runningJobs])

  // The job the open page (image generation, describe) is showing — that page
  // already auto-polls it, so the background loop skips it instead of polling
  // it twice. Keyed `source:job_id`.
  const foregroundJobRef = useRef<string | null>(null)
  const setForegroundJob = useCallback((source: string, jobId: string | null) => {
    foregroundJobRef.current = jobId ? `${source}:${jobId}` : null
  }, [])

  // Actively poll running jobs at the app-shell level so progress advances even
  // when the user navigates away from the page that started them. A chained
  // timeout (not an interval) so a slow pass never overlaps the next one, and
  // a small concurrency cap so a long queue doesn't hog the browser's
  // per-host connections (thumbnails and images share them).
  useEffect(() => {
    if (!token) return
    let cancelled = false
    let timer: number | undefined

    const pollOne = async (job: RunningJobItem) => {
      try {
        if (job.source === 'describe') {
          await pollDescribeJob(token, job.job_id)
          return
        }
        if (job.status === 'cancelRequested') {
          await cancelImageJob(token, job.job_id)
        }
        await pollImageJob(token, job.job_id)
      } catch {
        // non-fatal
      }
    }

    const tick = async () => {
      if (!document.hidden) {
        // A foreground image job is still handled here while cancel-requested:
        // only this loop re-issues the cancel.
        const jobs = runningJobsRef.current.filter(
          j =>
            `${j.source}:${j.job_id}` !== foregroundJobRef.current ||
            (j.source === 'image' && j.status === 'cancelRequested'),
        )
        if (jobs.length > 0) {
          await runWithConcurrency(jobs, BACKGROUND_POLL_CONCURRENCY, pollOne)
          if (!cancelled) await refreshSilent()
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), BACKGROUND_POLL_MS)
    }

    timer = window.setTimeout(() => void tick(), BACKGROUND_POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, refreshSilent])

  const toggleDrawer = useCallback(() => {
    setDrawerOpen(prev => !prev)
  }, [])

  const value = useMemo(
    () => ({
      drawerOpen,
      setDrawerOpen,
      toggleDrawer,
      runningImageJobs,
      runningDescribeJobs,
      runningImageJobsLoading,
      refreshRunningImageJobs: refresh,
      setForegroundJob,
    }),
    [
      drawerOpen,
      toggleDrawer,
      runningImageJobs,
      runningDescribeJobs,
      runningImageJobsLoading,
      refresh,
      setForegroundJob,
    ],
  )

  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>
}
