import { useEffect, useMemo, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { appForPath, recordAppVisit, topApps, useAppUsageCounts } from '../lib/appUsage'
import { cn } from '@/lib/utils'

/**
 * The (up to 3) most-used apps as shortcuts beside the logo, on every screen
 * size: icon-only below `lg`, with labels from `lg`. On the narrowest phones
 * (< 400px) only the top two fit. The TopBar's right-side buttons collapse to
 * icons first (below `xl`) so these keep their room.
 * Also owns the visit counting: it is always mounted in the TopBar.
 */
export function TopApps() {
  const { pathname } = useLocation()
  const counts = useAppUsageCounts()
  const shortcuts = useMemo(() => topApps(counts), [counts])
  const lastCounted = useRef<string | null>(null)

  useEffect(() => {
    const app = appForPath(pathname)
    // Count entering an app once, not every render (or StrictMode's double effect).
    if (!app || lastCounted.current === app.href) {
      if (!app) lastCounted.current = null
      return
    }
    lastCounted.current = app.href
    recordAppVisit(app.id)
  }, [pathname])

  if (shortcuts.length === 0) return null

  return (
    <nav className="ml-2 flex min-w-0 items-center gap-1 overflow-hidden sm:ml-4" aria-label="Most used apps" data-testid="top-apps">
      {shortcuts.map((app, i) => {
        const active = appForPath(pathname)?.id === app.id
        return (
          <Link
            key={app.id}
            to={app.href}
            title={app.title}
            aria-label={app.title}
            aria-current={active ? 'page' : undefined}
            data-testid={`top-app-${app.id}`}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors lg:px-2.5',
              i >= 2 && 'hidden min-[400px]:flex',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <app.icon className={cn('size-4', app.iconColor)} />
            <span className="hidden lg:inline">{app.title}</span>
          </Link>
        )
      })}
    </nav>
  )
}
