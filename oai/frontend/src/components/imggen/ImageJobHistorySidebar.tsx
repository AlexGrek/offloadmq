import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { imageFileUrl, type ImageJobDetails } from '../../api/images'
import { lastOutputImageId, modelNameFromCapability, promptExcerpt } from '../../lib/imggen'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])

type ImageJobHistorySidebarProps = {
  jobs: ImageJobDetails[]
  activeJobId: string | null
  token: string | null
  loading?: boolean
  onSelect: (jobId: string) => void
}

function statusLabel(status: string): string | null {
  if (TERMINAL.has(status)) return null
  return status.replace(/_/g, ' ')
}

export function ImageJobHistorySidebar({
  jobs,
  activeJobId,
  token,
  loading,
  onSelect,
}: ImageJobHistorySidebarProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 px-1">
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">No pipelines yet</p>
      ) : (
        <ul className="space-y-1">
          {jobs.map(job => {
            const outputId = lastOutputImageId(job)
            const bgUrl = outputId ? imageFileUrl(outputId, token) : null
            const active = job.job_id === activeJobId
            const inProgress = statusLabel(job.status)

            return (
              <li key={job.job_id}>
                <button
                  type="button"
                  onClick={() => onSelect(job.job_id)}
                  data-testid={`imggen-pipeline-item-${job.job_id}`}
                  className={cn(
                    'group/pipeline relative w-full overflow-hidden rounded-lg text-left transition-colors',
                    'min-h-[4.75rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'ring-2 ring-sidebar-primary shadow-sm'
                      : 'ring-1 ring-sidebar-border hover:ring-sidebar-accent',
                  )}
                >
                  {bgUrl ? (
                    <>
                      <img
                        src={bgUrl}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 h-full w-full scale-110 object-cover blur-md saturate-[0.85] dark:saturate-[0.7] dark:brightness-[0.55] brightness-[0.92]"
                      />
                      <div
                        className="absolute inset-0 bg-gradient-to-br from-background/88 via-background/78 to-background/92 dark:from-background/90 dark:via-background/82 dark:to-background/94"
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

                  <div className="relative z-10 flex min-h-[4.75rem] flex-col justify-center gap-0.5 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {modelNameFromCapability(job.capability)}
                      </span>
                      <span className="shrink-0 rounded bg-foreground/8 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground dark:bg-foreground/12">
                        {job.workflow}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-sm font-medium leading-snug text-sidebar-foreground">
                      {promptExcerpt(job.prompt)}
                    </p>
                    {inProgress && (
                      <span className="mt-0.5 inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground">
                        <span className="size-1.5 animate-pulse rounded-full bg-primary/80" />
                        {inProgress}
                      </span>
                    )}
                    {job.status === 'failed' && (
                      <span className="mt-0.5 text-[10px] font-medium text-destructive">Failed</span>
                    )}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
