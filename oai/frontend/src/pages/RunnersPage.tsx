import { useCallback, useEffect, useState } from 'react'
import { Activity, Cpu, Loader2, RefreshCw, UserRound } from 'lucide-react'
import { listOnlineRunners, type RunnerSummary } from '../api/runners'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/button'

function formatLastContact(lastContact: string | null): string {
  if (!lastContact) return 'Unknown'
  const date = new Date(lastContact)
  if (Number.isNaN(date.getTime())) return lastContact
  return date.toLocaleString()
}

export default function RunnersPage() {
  const { token } = useAuth()
  const [runners, setRunners] = useState<RunnerSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    setError(null)
    const data = await listOnlineRunners(token)
    setRunners(data.runners)
  }, [token])

  useEffect(() => {
    if (!token) return
    setLoading(true)
    void load()
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [token, load])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="runners-loading">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="runners-page"
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display flex items-center gap-2 text-2xl font-bold">
            <Activity className="h-6 w-6 text-muted-foreground" />
            Active Runners
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Online OffloadMQ agents visible via management API.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          data-testid="runners-refresh"
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <p className="mb-4 text-sm text-muted-foreground" data-testid="runners-count">
        {runners.length} runner{runners.length === 1 ? '' : 's'} online
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {runners.map(runner => (
          <section
            key={runner.uid}
            className="rounded-xl border border-border bg-muted/20 p-4"
            data-testid={`runner-card-${runner.uid_short}`}
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {runner.display_name || `Runner ${runner.uid_short}`}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{runner.uid}</p>
              </div>
              <span className="rounded-md bg-background px-2 py-1 text-xs font-medium">
                Tier {runner.tier}
              </span>
            </div>

            <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Cpu className="h-3.5 w-3.5" />
                Cap {runner.capacity}
              </span>
              <span className="inline-flex items-center gap-1">
                <UserRound className="h-3.5 w-3.5" />
                {runner.uid_short}
              </span>
            </div>

            <p className="mb-2 text-xs text-muted-foreground">
              Last contact: {formatLastContact(runner.last_contact)}
            </p>

            <div className="flex flex-wrap gap-1.5">
              {runner.capabilities.map(cap => (
                <span
                  key={cap}
                  className="rounded bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground"
                >
                  {cap}
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>

      {!error && runners.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No online runners found.</p>
      ) : null}
    </main>
  )
}
