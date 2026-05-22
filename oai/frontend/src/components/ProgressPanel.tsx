import { Loader2 } from 'lucide-react'
import type { RunningJobItem } from '../api/progress'
import type { ChatTaskRecord } from '../contexts/WorkloadContext'

export type ProgressRow = {
  key: string
  label: string
  status: string
  stage?: string | null
  detail?: string
}

function chatRows(tasks: ChatTaskRecord[]): ProgressRow[] {
  return tasks.map(t => ({
    key: t.reqId,
    label: `Chat ${t.chatId.slice(0, 8)}…`,
    status: t.statusText ?? t.status,
    stage: t.stage,
    detail: t.cap ? `${t.cap} · ${t.id.slice(0, 8)}…` : t.id.slice(0, 8) + '…',
  }))
}

function imageRows(jobs: RunningJobItem[], focusJobId: string | null): ProgressRow[] {
  const rows = jobs.map(j => ({
    key: j.key,
    label: j.label,
    status: j.status,
    stage: j.stage,
    detail: focusJobId === j.job_id ? 'current' : undefined,
  }))
  if (focusJobId && !rows.some(r => r.key === `image:${focusJobId}`)) {
    return rows
  }
  if (focusJobId) {
    const focused = rows.filter(r => r.key === `image:${focusJobId}`)
    const rest = rows.filter(r => r.key !== `image:${focusJobId}`)
    return [...focused, ...rest]
  }
  return rows
}

type ProgressPanelProps = {
  title?: string
  loading?: boolean
  emptyMessage: string
  rows: ProgressRow[]
}

export function ProgressPanel({ title = 'Progress', loading, emptyMessage, rows }: ProgressPanelProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3" data-testid="progress-panel">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map(row => (
            <li key={row.key} className="text-xs" data-testid={`progress-row-${row.key}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">{row.label}</span>
                {row.detail === 'current' && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                    current
                  </span>
                )}
              </div>
              <p className="text-muted-foreground">
                {row.status}
                {row.stage ? ` · ${row.stage}` : ''}
              </p>
              {row.detail && row.detail !== 'current' && (
                <p className="font-mono text-[10px] text-muted-foreground/80">{row.detail}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function chatProgressRows(tasks: ChatTaskRecord[]): ProgressRow[] {
  return chatRows(tasks)
}

export function imageProgressRows(jobs: RunningJobItem[], focusJobId: string | null): ProgressRow[] {
  return imageRows(jobs, focusJobId)
}
