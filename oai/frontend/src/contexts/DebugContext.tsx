import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'oai_debug_mode'

export type DebugJobRegistration = {
  key: string
  cap: string
  id: string
  label?: string
  source: string
}

type DebugContextValue = {
  enabled: boolean
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  toggleEnabled: () => void
  /** Off → on with drawer open; closed drawer → open; open drawer → off. */
  cycleDebugUi: () => void
  extraJobs: DebugJobRegistration[]
  registerJob: (job: DebugJobRegistration) => void
  unregisterJob: (key: string) => void
}

const DebugContext = createContext<DebugContextValue | null>(null)

function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function DebugProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(readStoredEnabled)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [extraJobs, setExtraJobs] = useState<DebugJobRegistration[]>([])

  const persistEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const toggleEnabled = useCallback(() => {
    setEnabled(prev => {
      const next = !prev
      persistEnabled(next)
      if (!next) setDrawerOpen(false)
      else setDrawerOpen(true)
      return next
    })
  }, [persistEnabled])

  const cycleDebugUi = useCallback(() => {
    if (!enabled) {
      setEnabled(true)
      setDrawerOpen(true)
      persistEnabled(true)
      return
    }
    if (!drawerOpen) {
      setDrawerOpen(true)
      return
    }
    setEnabled(false)
    setDrawerOpen(false)
    persistEnabled(false)
  }, [enabled, drawerOpen, persistEnabled])

  const registerJob = useCallback((job: DebugJobRegistration) => {
    setExtraJobs(prev => {
      const idx = prev.findIndex(j => j.key === job.key)
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = job
        return copy
      }
      return [...prev, job]
    })
  }, [])

  const unregisterJob = useCallback((key: string) => {
    setExtraJobs(prev => prev.filter(j => j.key !== key))
  }, [])

  const value = useMemo(
    () => ({
      enabled,
      drawerOpen,
      setDrawerOpen,
      toggleEnabled,
      cycleDebugUi,
      extraJobs,
      registerJob,
      unregisterJob,
    }),
    [enabled, drawerOpen, extraJobs, toggleEnabled, cycleDebugUi, registerJob, unregisterJob],
  )

  return <DebugContext.Provider value={value}>{children}</DebugContext.Provider>
}

export function useDebug(): DebugContextValue {
  const ctx = useContext(DebugContext)
  if (!ctx) {
    throw new Error('useDebug must be used within DebugProvider')
  }
  return ctx
}

/** Safe when DebugProvider is absent (returns no-op stubs). */
export function useDebugOptional(): DebugContextValue | null {
  return useContext(DebugContext)
}
