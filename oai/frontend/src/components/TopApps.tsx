import { useEffect, useMemo, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { appForPath, recordAppVisit, topApps, useAppUsageCounts } from '../lib/appUsage'
import { cn } from '@/lib/utils'

/**
 * The (up to 3) most-used apps as shortcuts beside the logo — large screens only
 * (icon-only at `lg`, with labels from `xl`).
 * Also owns the visit counting: it is always mounted in the TopBar, so a visit is
 * recorded on every viewport even though the shortcuts themselves are `lg:` only.
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
    <nav className="ml-4 hidden items-center gap-1 lg:flex" aria-label="Most used apps" data-testid="top-apps">
      {shortcuts.map(app => {
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
              'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <app.icon className={cn('size-4', app.iconColor)} />
            <span className="hidden xl:inline">{app.title}</span>
          </Link>
        )
      })}
    </nav>
  )
}
