import { Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { imageThumbnailUrl } from '../../api/images'
import type { DescribeJob } from '../../api/describe'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
export const DESCRIBE_NEW_PANEL = 'new' as const

type DescribeHistorySidebarProps = {
  jobs: DescribeJob[]
  /** `'new'` or a job id */
  activePanel: string
  token: string | null
  mediaRevision?: number
  loading?: boolean
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function statusLabel(status: string): string | null {
  if (TERMINAL.has(status)) return null
  return status.replace(/_/g, ' ')
}

function jobTitle(prompt: string, limit = 72): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Analysis'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export function DescribeHistorySidebar({
  jobs,
  activePanel,
  token,
  mediaRevision = 0,
  loading,
  onSelectNew,
  onSelectJob,
}: DescribeHistorySidebarProps) {
  const isNewActive = activePanel === DESCRIBE_NEW_PANEL

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        data-testid="describe-new-panel-btn"
        className={cn(
          'mx-1 mt-1 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors',
          isNewActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
        )}
      >
        <Plus className="size-4 shrink-0" />
        New
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 px-1">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No analyses yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map(job => {
              const bgUrl = job.input_image_id
                ? imageThumbnailUrl(job.input_image_id, token, mediaRevision)
                : null
              const active = activePanel === job.job_id
              const inProgress = statusLabel(job.status)
              const model = job.capability.replace(/^llm\./, '')

              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    data-testid={`describe-item-${job.job_id}`}
                    className={cn(
                      'group/describe relative w-full overflow-hidden rounded-lg text-left transition-colors',
                      'min-h-17 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'ring-2 ring-sidebar-primary shadow-sm'
                        : 'ring-1 ring-sidebar-border hover:ring-sidebar-accent',
                    )}
                  >
                    {bgUrl ? (
                      <>
                        <img
                          key={`${job.job_id}-${job.input_image_id}-${mediaRevision}`}
                          src={bgUrl}
                          alt=""
                          aria-hidden
                          className="absolute inset-0 h-full w-full scale-105 object-cover blur-[3px] saturate-[0.9] dark:saturate-[0.75] dark:brightness-[0.6] brightness-[0.95]"
                        />
                        <div
                          className="absolute inset-0 bg-linear-to-br from-background/72 via-background/55 to-background/76 dark:from-background/78 dark:via-background/62 dark:to-background/82"
                          aria-hidden
                        />
                      </>
                    ) : (
                      <div
                        className={cn(
                          'absolute inset-0',
                          active ? 'bg-sidebar-accent' : 'bg-sidebar-accent/40',
                        )}
                        aria-hidden
                      />
                    )}

                    <div className="relative z-10 flex min-h-17 flex-col justify-center gap-0.5 px-3 py-2">
                      <div className="flex items-start justify-between gap-1.5">
                        <p className="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-snug text-foreground">
                          {jobTitle(job.prompt)}
                        </p>
                      </div>
                      <span className="truncate font-mono text-[10px] text-muted-foreground/80">
                        {model}
                      </span>
                      {inProgress ? (
                        <span className="inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground">
                          <span className="size-1.5 animate-pulse rounded-full bg-primary/80" />
                          {inProgress}
                        </span>
                      ) : job.status === 'failed' ? (
                        <span className="text-[10px] font-medium text-destructive">Failed</span>
                      ) : job.status === 'completed' ? (
                        <span className="text-[10px] text-muted-foreground">Completed</span>
                      ) : (
                        <span className="text-[10px] capitalize text-muted-foreground">{job.status}</span>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
