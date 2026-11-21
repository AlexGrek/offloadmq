import { Loader2, Orbit, Plus } from 'lucide-react'
import { imageThumbnailUrl } from '@/api/images'
import { worldModeLabel, type WorldJob } from '@/api/worlds'
import { cn } from '@/lib/utils'

export const WORLDS_NEW_PANEL = '__new__'

type Props = {
  jobs: WorldJob[]
  activePanel: string
  token: string | null
  loading: boolean
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function jobSummary(job: WorldJob): string {
  if (job.status === 'completed') {
    const n = job.result?.splat_count
    return n ? `${(n / 1e6).toFixed(2)} M splats` : 'Done'
  }
  if (job.status === 'failed') return 'Failed'
  if (job.status === 'canceled') return 'Canceled'
  return job.stage ?? job.status
}

export function WorldsHistorySidebar({ jobs, activePanel, token, loading, onSelectNew, onSelectJob }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        className={cn(
          'mx-2 mt-2 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          activePanel === WORLDS_NEW_PANEL
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
        )}
        data-testid="worlds-new-panel-btn"
      >
        <Plus className="size-4 shrink-0" />
        New world
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" data-testid="worlds-sidebar-list">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No worlds yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map(job => {
              const active = activePanel === job.job_id
              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    className={cn(
                      'relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-2 text-left transition-colors',
                      active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60',
                    )}
                    data-testid={`worlds-item-${job.job_id}`}
                  >
                    <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted">
                      {job.input_image_id && token ? (
                        <img src={imageThumbnailUrl(job.input_image_id, token)} alt="" className="size-full object-cover" />
                      ) : (
                        <div className="flex size-full items-center justify-center">
                          <Orbit className="size-4 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {worldModeLabel(job.result?.mode ?? job.mode)}
                      </p>
                      <p className="truncate text-[10px] capitalize text-muted-foreground">{jobSummary(job)}</p>
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
