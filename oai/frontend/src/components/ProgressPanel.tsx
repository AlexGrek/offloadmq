import { Loader2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ProgressRow } from '@/lib/progressRows'

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
