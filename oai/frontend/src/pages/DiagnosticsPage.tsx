import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Database,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import {
  getK8sPodLogs,
  getK8sPodStatus,
  type K8sComponent,
  type K8sPodLogs,
  type K8sPodStatus,
} from '../api/admin'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const LOG_TAIL_LINES = 100

const TABS: {
  id: K8sComponent
  label: string
  shortLabel: string
  icon: typeof Server
}[] = [
  { id: 'app', label: 'Application', shortLabel: 'App', icon: Server },
  { id: 'postgres', label: 'PostgreSQL', shortLabel: 'DB', icon: Database },
  { id: 'garage', label: 'Garage S3', shortLabel: 'S3', icon: HardDrive },
]

function PhaseBadge({ phase, ready }: { phase: string | null; ready: boolean }) {
  const ok = ready && phase === 'Running'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
        ok
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
          : 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
      )}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
      {phase ?? 'Unknown'}
      {ready ? '' : ' · not ready'}
    </span>
  )
}

export default function DiagnosticsPage() {
  const { token } = useAuth()
  const { isAdmin, loading: adminLoading } = useAdminStatus()
  const navigate = useNavigate()

  const [tab, setTab] = useState<K8sComponent>('app')
  const [status, setStatus] = useState<K8sPodStatus | null>(null)
  const [logs, setLogs] = useState<K8sPodLogs | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    setError(null)
    try {
      const [podStatus, podLogs] = await Promise.all([
        getK8sPodStatus(token, tab),
        getK8sPodLogs(token, tab, LOG_TAIL_LINES),
      ])
      setStatus(podStatus)
      setLogs(podLogs)
    } catch (e: unknown) {
      setStatus(null)
      setLogs(null)
      setError(e instanceof Error ? e.message : 'Failed to load diagnostics')
    }
  }, [token, tab])

  useEffect(() => {
    if (!adminLoading && !isAdmin) navigate('/app/settings', { replace: true })
  }, [isAdmin, adminLoading, navigate])

  useEffect(() => {
    if (!token || adminLoading || !isAdmin) return
    setLoading(true)
    void load().finally(() => setLoading(false))
  }, [token, isAdmin, adminLoading, load])

  async function handleRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (adminLoading || (loading && !status && !error)) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="diagnostics-loading">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) return null

  const activeTab = TABS.find(t => t.id === tab) ?? TABS[0]

  return (
    <main
      className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden px-4 py-6 sm:px-6 sm:py-8"
      data-testid="diagnostics-page"
    >
      <Link
        to="/app/settings"
        className="mb-4 inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to Settings
      </Link>

      <div className="mb-4 flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-2 text-xl font-bold sm:text-2xl">
            <Activity className="h-6 w-6 shrink-0 text-muted-foreground" />
            Diagnostics
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live pod status and the last {LOG_TAIL_LINES} log lines from the cluster.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void handleRefresh()}
          disabled={refreshing || loading}
          data-testid="diagnostics-refresh"
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <nav
        className="mb-4 flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-muted/30 p-1 [-webkit-overflow-scrolling:touch]"
        role="tablist"
        aria-label="Stack components"
      >
        {TABS.map(({ id, label, shortLabel, icon: Icon }) => {
          const selected = tab === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`diagnostics-panel-${id}`}
              id={`diagnostics-tab-${id}`}
              data-testid={`diagnostics-tab-${id}`}
              onClick={() => setTab(id)}
              className={cn(
                'flex min-h-11 min-w-[5.5rem] flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors sm:min-w-0 sm:flex-initial sm:px-4',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="sm:hidden">{shortLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          )
        })}
      </nav>

      {error && (
        <Alert variant="destructive" className="mb-4 shrink-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div
        id={`diagnostics-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`diagnostics-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <Card className="shrink-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{activeTab.label} pod</CardTitle>
            <CardDescription className="font-mono text-xs">
              {status ? `${status.namespace}/${status.name}` : '—'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            {loading && !status ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : status ? (
              <>
                <PhaseBadge phase={status.phase} ready={status.ready} />
                {status.pod_ip && (
                  <span className="text-xs text-muted-foreground">IP {status.pod_ip}</span>
                )}
                {status.containers.map(c => (
                  <span
                    key={c.name}
                    className={cn(
                      'rounded-md border border-border px-2 py-0.5 font-mono text-xs',
                      c.ready ? 'text-foreground' : 'text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {c.name}
                    {c.restart_count > 0 ? ` · restarts ${c.restart_count}` : ''}
                  </span>
                ))}
              </>
            ) : (
              <span className="text-muted-foreground">No status available</span>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0 pb-2">
            <CardTitle className="text-base">Container logs</CardTitle>
            <CardDescription>
              {logs
                ? `${logs.container} · tail ${logs.tail_lines} lines`
                : `Last ${LOG_TAIL_LINES} lines`}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 pb-4">
            {loading && !logs?.content ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : logs?.content ? (
              <pre
                className="max-h-[min(60vh,32rem)] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground sm:text-xs"
                data-testid="diagnostics-log-content"
              >
                {logs.content}
              </pre>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">No log output.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
