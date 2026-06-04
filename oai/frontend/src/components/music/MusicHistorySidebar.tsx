import { Loader2, Music, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MusicJob } from '../../api/music_generation'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
export const MUSIC_NEW_PANEL = 'new' as const

type MusicHistorySidebarProps = {
  jobs: MusicJob[]
  activePanel: string
  loading?: boolean
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function statusLabel(status: string): string | null {
  if (TERMINAL.has(status)) return null
  return status.replace(/_/g, ' ')
}

function jobTitle(tags: string, limit = 72): string {
  const trimmed = tags.trim()
  if (!trimmed) return 'Music'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

function capabilityLabel(capability: string): string {
  return capability.replace(/^txt2music\./, '')
}

export function MusicHistorySidebar({
  jobs,
  activePanel,
  loading,
  onSelectNew,
  onSelectJob,
}: MusicHistorySidebarProps) {
  const isNewActive = activePanel === MUSIC_NEW_PANEL

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        data-testid="music-new-panel-btn"
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
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No tracks yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map(job => {
              const active = activePanel === job.job_id
              const inProgress = statusLabel(job.status)
              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    data-testid={`music-item-${job.job_id}`}
                    className={cn(
                      'group/music relative w-full overflow-hidden rounded-lg text-left transition-colors',
                      'min-h-17 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'ring-2 ring-sidebar-primary shadow-sm bg-sidebar-accent'
                        : 'ring-1 ring-sidebar-border hover:ring-sidebar-accent bg-sidebar-accent/30',
                    )}
                  >
                    <div className="relative z-10 flex min-h-17 flex-col justify-center gap-0.5 px-3 py-2">
                      <div className="flex items-start gap-1.5">
                        <Music className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <p className="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-snug text-foreground">
                          {jobTitle(job.tags)}
                        </p>
                      </div>
                      <span className="truncate pl-5 font-mono text-[10px] text-muted-foreground/80">
                        {capabilityLabel(job.capability)} · {job.duration}s
                      </span>
                      <span className="pl-5">
                        {inProgress ? (
                          <span className="inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground">
                            <span className="size-1.5 animate-pulse rounded-full bg-primary/80" />
                            {inProgress}
                          </span>
                        ) : job.status === 'failed' ? (
                          <span className="text-[10px] font-medium text-destructive">Failed</span>
                        ) : job.status === 'completed' ? (
                          <span className="text-[10px] text-muted-foreground">
                            {job.audio_tracks.length > 1
                              ? `${job.audio_tracks.length} tracks`
                              : 'Completed'}
                          </span>
                        ) : (
                          <span className="text-[10px] capitalize text-muted-foreground">
                            {job.status}
                          </span>
                        )}
                      </span>
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
