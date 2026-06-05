import { useCallback, useEffect, useRef, useState } from 'react'
import { FRONTEND_VERSION, getServerVersion } from '../api/version'

/** How often to poll the server version while the tab is open. */
const POLL_INTERVAL_MS = 5 * 60 * 1000

/** A baked version is only meaningful if it's a real build, not local dev. */
const trackedVersion =
  FRONTEND_VERSION && FRONTEND_VERSION !== 'dev' ? FRONTEND_VERSION : null

export interface VersionCheck {
  /** A newer build has been deployed than the one currently loaded. */
  updateAvailable: boolean
  /** The version the server is currently reporting (once known). */
  serverVersion: string | null
  /** Hard-reload to pick up the new build. */
  reload: () => void
}

/**
 * Polls `GET /api/version` and flags when the server reports a different build
 * than the one this SPA was compiled with. Also re-checks whenever the tab
 * becomes visible/focused, so a long-idle tab notices a deploy on return.
 *
 * Disabled entirely in local dev (no baked `VITE_APP_VERSION`).
 */
export function useVersionCheck(): VersionCheck {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  // Hold the flag steady once a new version is seen — no need to keep polling.
  const settledRef = useRef(false)

  const reload = useCallback(() => {
    window.location.reload()
  }, [])

  useEffect(() => {
    if (!trackedVersion) return

    let cancelled = false
    let controller: AbortController | null = null

    const check = async () => {
      if (cancelled || settledRef.current) return
      controller?.abort()
      controller = new AbortController()
      try {
        const { version } = await getServerVersion(controller.signal)
        if (cancelled || !version) return
        setServerVersion(version)
        if (version !== trackedVersion) {
          settledRef.current = true
          setUpdateAvailable(true)
        }
      } catch {
        // Network blips / aborts are expected — try again on the next tick.
      }
    }

    const interval = window.setInterval(check, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    void check()

    return () => {
      cancelled = true
      controller?.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  return { updateAvailable, serverVersion, reload }
}
