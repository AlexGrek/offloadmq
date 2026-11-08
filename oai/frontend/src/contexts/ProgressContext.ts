import { createContext, useContext } from 'react'
import type { RunningJobItem } from '../api/progress'

export type ProgressContextValue = {
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  runningImageJobs: RunningJobItem[]
  runningDescribeJobs: RunningJobItem[]
  runningImgUtilsJobs: RunningJobItem[]
  runningImageJobsLoading: boolean
  refreshRunningImageJobs: () => Promise<void>
  /**
   * Marks the job the open page is polling itself (`source` as in the progress
   * feed: `image`, `describe`, `img-utils`); the background loop skips it. `null` clears.
   */
  setForegroundJob: (source: string, jobId: string | null) => void
}

export const ProgressContext = createContext<ProgressContextValue | null>(null)

export function useProgress(): ProgressContextValue {
  const ctx = useContext(ProgressContext)
  if (!ctx) throw new Error('useProgress must be used within ProgressProvider')
  return ctx
}
