import { Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { imageThumbnailUrl, type ImageJobDetails } from '../../api/images'
import { jobPromptTitle, jobTechMeta, imageJobIsExecuting, imageJobStatusLabel, lastOutputImageId } from '../../lib/imggen'
import { WorkflowBadge } from './WorkflowBadge'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
export const IMGGEN_NEW_PANEL = 'new' as const

type ImageJobHistorySidebarProps = {
  jobs: ImageJobDetails[]
  /** `'new'` or a job id */
  activePanel: string
  token: string | null
  /** Bust thumbnail cache after image delete / storage changes. */
  mediaRevision?: number
  loading?: boolean
  /** Live status from progress drawer poll cache (`last_poll_status`). */
  statusOverrides?: Record<string, string>
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function statusLabel(status: string): string | null {
  if (TERMINAL.has(status)) return null
  return imageJobStatusLabel(status)
}

export function ImageJobHistorySidebar({
  jobs,
  activePanel,
  token,
  mediaRevision = 0,
  loading,
  statusOverrides,
  onSelectNew,
  onSelectJob,
}: ImageJobHistorySidebarProps) {
  const isNewActive = activePanel === IMGGEN_NEW_PANEL

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        data-testid="imggen-pipeline-new"
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
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No jobs yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map(job => {
              const outputId = lastOutputImageId(job)
              const bgUrl = outputId
                ? imageThumbnailUrl(outputId, token, mediaRevision)
                : null
              const active = activePanel === job.job_id
              const jobStatus = statusOverrides?.[job.job_id] ?? job.status
              const inProgress = statusLabel(jobStatus)
              const executing = imageJobIsExecuting(jobStatus)

              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    data-testid={`imggen-pipeline-item-${job.job_id}`}
                    className={cn(
                      'group/pipeline relative w-full overflow-hidden rounded-lg text-left transition-colors',
                      'min-h-17 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'ring-2 ring-sidebar-primary shadow-sm'
                        : 'ring-1 ring-sidebar-border hover:ring-sidebar-accent',
                    )}
                  >
                    {bgUrl ? (
                      <>
                        <img
                          key={`${job.job_id}-${outputId}-${mediaRevision}`}
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
                          {jobPromptTitle(job.prompt, 72)}
                        </p>
                        <WorkflowBadge workflow={job.workflow} />
                      </div>
                      <span className="truncate font-mono text-[10px] text-muted-foreground/80">
                        {jobTechMeta(job)}
                      </span>
                      {inProgress ? (
                        <span className="inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground">
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              executing
                                ? 'animate-pulse bg-primary/80'
                                : 'bg-muted-foreground/50',
                            )}
                          />
                          {inProgress}
                        </span>
                      ) : jobStatus === 'failed' ? (
                        <span className="text-[10px] font-medium text-destructive">Failed</span>
                      ) : jobStatus === 'completed' ? (
                        <span className="text-[10px] text-muted-foreground">Completed</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">
                          {imageJobStatusLabel(jobStatus)}
                        </span>
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
