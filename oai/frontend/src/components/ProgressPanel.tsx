import { Loader2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RunningJobItem } from '../api/progress'
import type { ChatTaskRecord } from '../contexts/WorkloadContext'

export type ProgressRow = {
  key: string
  label: string
  status: string
  stage?: string | null
  detail?: string
  /** When set, shows a stop control that calls this handler. */
  onCancel?: () => void
  cancelDisabled?: boolean
}

function chatRows(
  tasks: ChatTaskRecord[],
  onCancelChat?: (task: ChatTaskRecord) => void,
): ProgressRow[] {
  return tasks.map(t => ({
    key: t.reqId,
    label: `Chat ${t.chatId.slice(0, 8)}…`,
    status: t.statusText ?? t.status,
    stage: t.stage,
    detail: t.cap ? `${t.cap} · ${t.id.slice(0, 8)}…` : t.id.slice(0, 8) + '…',
    onCancel: onCancelChat ? () => onCancelChat(t) : undefined,
    cancelDisabled: !t.cap || !t.id,
  }))
}

function imageRows(
  jobs: RunningJobItem[],
  focusJobId: string | null,
  onCancelImage?: (job: RunningJobItem) => void,
): ProgressRow[] {
  const rows = jobs.map(j => ({
    key: j.key,
    label: j.label,
    status: j.status,
    stage: j.stage,
    detail: focusJobId === j.job_id ? 'current' : undefined,
    onCancel: onCancelImage ? () => onCancelImage(j) : undefined,
    cancelDisabled: !j.offload_cap || !j.offload_task_id,
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
                <span className="flex-1" />
                {row.onCancel && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 shrink-0 text-destructive hover:text-destructive"
                    title="Cancel task"
                    data-testid={`progress-cancel-${row.key}`}
                    disabled={row.cancelDisabled}
                    onClick={() => row.onCancel?.()}
                  >
                    <Square className="size-3 fill-current" />
                  </Button>
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

export function chatProgressRows(
  tasks: ChatTaskRecord[],
  onCancelChat?: (task: ChatTaskRecord) => void,
): ProgressRow[] {
  return chatRows(tasks, onCancelChat)
}

export function imageProgressRows(
  jobs: RunningJobItem[],
  focusJobId: string | null,
  onCancelImage?: (job: RunningJobItem) => void,
): ProgressRow[] {
  return imageRows(jobs, focusJobId, onCancelImage)
}
