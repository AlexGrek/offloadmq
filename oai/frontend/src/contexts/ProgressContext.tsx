import {
  createContext,
  useCallback,
  useContext,
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

const BACKGROUND_POLL_MS = 5000

type ProgressContextValue = {
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  runningImageJobs: RunningJobItem[]
  runningDescribeJobs: RunningJobItem[]
  runningImageJobsLoading: boolean
  refreshRunningImageJobs: () => Promise<void>
}

const ProgressContext = createContext<ProgressContextValue | null>(null)

export function ProgressProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // `/api/progress/running` feeds every job source; split it so image-only
  // consumers (page status overrides, cancel-requested re-issue) never see describe rows.
  const { jobs: runningJobs, loading: runningImageJobsLoading, refresh } =
    useRunningImageJobs(token)
  const runningImageJobs = useMemo(
    () => runningJobs.filter(j => j.source === 'image'),
    [runningJobs],
  )
  const runningDescribeJobs = useMemo(
    () => runningJobs.filter(j => j.source === 'describe'),
    [runningJobs],
  )

  // Keep a ref so the polling interval always sees the latest job list without
  // recreating the timer on every refresh.
  const runningJobsRef = useRef(runningJobs)
  useEffect(() => { runningJobsRef.current = runningJobs }, [runningJobs])

  // Actively poll running jobs at the app-shell level so progress advances even
  // when the user navigates away from the page that started them.
  useEffect(() => {
    if (!token) return
    const id = window.setInterval(async () => {
      const jobs = runningJobsRef.current
      if (jobs.length === 0) return
      for (const job of jobs) {
        try {
          if (job.source === 'describe') {
            await pollDescribeJob(token, job.job_id)
            continue
          }
          if (job.status === 'cancelRequested') {
            await cancelImageJob(token, job.job_id)
          }
          await pollImageJob(token, job.job_id)
        } catch {
          // non-fatal
        }
      }
      void refresh()
    }, BACKGROUND_POLL_MS)
    return () => window.clearInterval(id)
  }, [token, refresh])

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
    }),
    [
      drawerOpen,
      toggleDrawer,
      runningImageJobs,
      runningDescribeJobs,
      runningImageJobsLoading,
      refresh,
    ],
  )

  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>
}

export function useProgress(): ProgressContextValue {
  const ctx = useContext(ProgressContext)
  if (!ctx) throw new Error('useProgress must be used within ProgressProvider')
  return ctx
}
