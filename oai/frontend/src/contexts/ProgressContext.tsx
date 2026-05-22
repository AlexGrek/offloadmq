import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './AuthContext'
import { useRunningImageJobs } from '../hooks/useRunningImageJobs'
import type { RunningJobItem } from '../api/progress'

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
