import { useCallback, useEffect, useState } from 'react'
import { Bug, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { useDebug } from '../contexts/DebugContext'
import { fetchOffloadDebugYaml } from '../api/debug'

const REFRESH_MS = 3000

export function DebugDrawer() {
  const { token } = useAuth()
  const { enabled, drawerOpen, setDrawerOpen, extraJobs } = useDebug()
  const [yaml, setYaml] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token || !enabled) return
    setLoading(true)
    setError(null)
    try {
      const text = await fetchOffloadDebugYaml(
        token,
        extraJobs.map(j => ({
          cap: j.cap,
          id: j.id,
          label: j.label,
          source: j.source,
          key: j.key,
        })),
      )
      setYaml(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load debug status')
    } finally {
      setLoading(false)
    }
  }, [token, enabled, extraJobs])

  useEffect(() => {
    if (!enabled || !drawerOpen) return
    refresh()
    const id = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [enabled, drawerOpen, refresh])

  if (!enabled) return null

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/20 md:hidden"
          aria-label="Close debug panel"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        className={cn(
          'fixed top-14 right-0 z-50 flex h-[calc(100dvh-3.5rem)] w-full max-w-md flex-col border-l border-border bg-background shadow-xl transition-transform duration-200',
          drawerOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        data-testid="debug-drawer"
        aria-hidden={!drawerOpen}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Bug className="size-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-semibold">OffloadMQ debug</span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            disabled={loading}
            title="Refresh now"
            data-testid="debug-refresh"
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDrawerOpen(false)}
            title="Close"
            data-testid="debug-close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Live poll of each tracked job (refreshes every {REFRESH_MS / 1000}s). Chat tasks register on
          queue; image jobs load from OAI DB.
        </p>

        {error && (
          <p className="shrink-0 px-3 py-2 text-xs text-destructive" data-testid="debug-error">
            {error}
          </p>
        )}

        <pre
          className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
          data-testid="debug-yaml"
        >
          {yaml || (loading ? 'Loading…' : 'No data yet')}
        </pre>
      </aside>
    </>
  )
}
