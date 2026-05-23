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
import { pollImageJob } from '../api/images'
import type { RunningJobItem } from '../api/progress'

const BACKGROUND_POLL_MS = 5000

type ProgressContextValue = {
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  runningImageJobs: RunningJobItem[]
  runningImageJobsLoading: boolean
  refreshRunningImageJobs: () => Promise<void>
}

const ProgressContext = createContext<ProgressContextValue | null>(null)

export function ProgressProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { jobs: runningImageJobs, loading: runningImageJobsLoading, refresh } =
    useRunningImageJobs(token)

  // Keep a ref so the polling interval always sees the latest job list without
  // recreating the timer on every refresh.
  const runningJobsRef = useRef(runningImageJobs)
  useEffect(() => { runningJobsRef.current = runningImageJobs }, [runningImageJobs])

  // Actively poll running jobs at the app-shell level so progress advances even
  // when the user navigates away from the image generation page.
  useEffect(() => {
    if (!token) return
    const id = window.setInterval(async () => {
      const jobs = runningJobsRef.current
      if (jobs.length === 0) return
      for (const job of jobs) {
        try {
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
      runningImageJobsLoading,
      refreshRunningImageJobs: refresh,
    }),
    [
      drawerOpen,
      toggleDrawer,
      runningImageJobs,
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
