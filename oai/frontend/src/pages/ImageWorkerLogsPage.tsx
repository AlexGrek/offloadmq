import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Loader2,
  RefreshCw,
  ScrollText,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useAdminStatus } from '../hooks/useAdminStatus'
import { listImageWorkerLogs, type AdminImageWorkerLog } from '../api/admin'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type LevelFilter = 'all' | 'info' | 'error'
type StatusFilter = 'all' | 'ok' | 'error'

function formatDuration(ms: number | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function StatusBadge({ status }: { status: string | undefined }) {
  const ok = status === 'ok'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
        ok
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
          : 'bg-destructive/15 text-destructive',
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {status ?? 'unknown'}
    </span>
  )
}

function LevelBadge({ level }: { level: string }) {
  const isError = level === 'error'
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        isError ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      {level}
    </span>
  )
}

function LogRow({ log }: { log: AdminImageWorkerLog }) {
  const d = log.data_json
  return (
    <tr className="border-b border-border/60 hover:bg-muted/30" data-testid={`worker-log-${log.id}`}>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
        {formatWhen(log.created_at)}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs text-foreground">{log.run_id}</span>
          <span className="text-xs text-muted-foreground">{log.message}</span>
        </div>
      </td>
      <td className="px-3 py-3">
        <LevelBadge level={log.level} />
      </td>
      <td className="px-3 py-3">
        <StatusBadge status={d.status} />
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">
        {formatDuration(d.duration_ms)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums text-muted-foreground">
        {d.tick_secs ?? '—'}s / {d.batch_size ?? '—'}
      </td>
      <td className="max-w-xs px-3 py-3 text-xs text-muted-foreground">
        {d.error ? (
          <span className="text-destructive">{d.error}</span>
        ) : (
          <span className="text-muted-foreground/80">—</span>
        )}
      </td>
    </tr>
  )
}

export default function ImageWorkerLogsPage() {
  const { token } = useAuth()
  const { isAdmin, loading: adminLoading } = useAdminStatus()
  const navigate = useNavigate()

  const [logs, setLogs] = useState<AdminImageWorkerLog[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const load = useCallback(async () => {
    if (!token) return
    setError(null)
    try {
      const data = await listImageWorkerLogs(token)
      setLogs(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load worker logs')
    }
  }, [token])

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

  const filtered = useMemo(() => {
    return logs.filter(log => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false
      if (statusFilter !== 'all' && log.data_json.status !== statusFilter) return false
      return true
    })
  }, [logs, levelFilter, statusFilter])

  const summary = useMemo(() => {
    const errors = logs.filter(l => l.data_json.status === 'error' || l.level === 'error').length
    const last = logs[0]
    const avgMs =
      logs.length === 0
        ? null
        : Math.round(
            logs.reduce((acc, l) => acc + (l.data_json.duration_ms ?? 0), 0) / logs.length,
          )
    return { total: logs.length, errors, last, avgMs }
  }, [logs])

  if (adminLoading || loading) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="worker-logs-loading">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) return null

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8" data-testid="image-worker-logs-page">
      <Link
        to="/app/settings"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to Settings
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display flex items-center gap-2 text-2xl font-bold">
            <ScrollText className="h-6 w-6 text-muted-foreground" />
            Image Pipeline Worker
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Background reconcile passes — structured telemetry from Postgres, not raw JSON dumps.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          data-testid="worker-logs-refresh"
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Runs logged</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.total}</p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={cn(
                'text-2xl font-semibold tabular-nums',
                summary.errors > 0 ? 'text-destructive' : 'text-foreground',
              )}
            >
              {summary.errors}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Last pass</CardTitle>
            <CardDescription>
              {summary.last ? formatWhen(summary.last.created_at) : 'No runs yet'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {summary.last && <StatusBadge status={summary.last.data_json.status} />}
            {summary.avgMs != null && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                avg {formatDuration(summary.avgMs)}
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run history</CardTitle>
          <CardDescription>
            Each row is one worker tick: poll active jobs, reconcile completed outputs, persist files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-muted-foreground self-center mr-1">Level:</span>
            {(['all', 'info', 'error'] as const).map(v => (
              <Button
                key={v}
                size="xs"
                variant={levelFilter === v ? 'default' : 'outline'}
                onClick={() => setLevelFilter(v)}
              >
                {v}
              </Button>
            ))}
            <span className="text-xs text-muted-foreground self-center ml-2 mr-1">Status:</span>
            {(['all', 'ok', 'error'] as const).map(v => (
              <Button
                key={v}
                size="xs"
                variant={statusFilter === v ? 'default' : 'outline'}
                onClick={() => setStatusFilter(v)}
              >
                {v}
              </Button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No logs match the current filters.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Run</th>
                    <th className="px-3 py-2 font-medium">Level</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Tick / batch</th>
                    <th className="px-3 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(log => (
                    <LogRow key={log.id} log={log} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.last?.data_json.error && (
            <Alert variant="destructive">
              <AlertDescription>
                <span className="font-medium">Latest error: </span>
                {summary.last.data_json.error}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
