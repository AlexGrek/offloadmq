import { Download, Eraser, Loader2, Plus } from 'lucide-react'
import type { BgRemoverJob } from '@/api/bgRemover'
import { imageThumbnailUrl } from '@/api/images'
import { useDownloadedImages } from '@/lib/downloadedImages'
import { modelLabel } from '@/lib/bgRemover'
import { cn } from '@/lib/utils'

export const BGREMOVER_NEW_PANEL = '__new__'

type Props = {
  jobs: BgRemoverJob[]
  activePanel: string
  token: string | null
  loading: boolean
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function jobSummary(job: BgRemoverJob): string {
  if (job.status === 'completed') return 'Done'
  if (job.status === 'failed') return 'Failed'
  if (job.status === 'canceled') return 'Canceled'
  return job.stage ?? job.status
}

export function BgRemoverHistorySidebar({
  jobs,
  activePanel,
  token,
  loading,
  onSelectNew,
  onSelectJob,
}: Props) {
  const downloadedImages = useDownloadedImages()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        className={cn(
          'mx-2 mt-2 flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          activePanel === BGREMOVER_NEW_PANEL
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
        )}
        data-testid="bgremover-new-panel-btn"
      >
        <Plus className="size-4 shrink-0" />
        New cutout
      </button>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
        data-testid="bgremover-sidebar-list"
      >
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No cutouts yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map(job => {
              const active = activePanel === job.job_id
              // The result once it exists, so the list reads as a gallery of cutouts.
              const thumbId = job.output_image_id ?? job.input_image_id
              const downloaded = job.output_image_id != null && downloadedImages.has(job.output_image_id)
              return (
                <li key={job.job_id}>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    className={cn(
                      'relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-2 text-left transition-colors',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'hover:bg-sidebar-accent/60',
                    )}
                    data-testid={`bgremover-item-${job.job_id}`}
                  >
                    {/* The checkerboard shows through a cutout's transparent pixels. */}
                    <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-checkerboard">
                      {thumbId && token ? (
                        <img
                          src={imageThumbnailUrl(thumbId, token)}
                          alt=""
                          className="size-full object-contain"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center">
                          <Eraser className="size-4 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1 truncate text-xs font-medium">
                        <span className="truncate">{modelLabel(job.model)}</span>
                        {downloaded && (
                          <span title="Downloaded" data-testid={`bgremover-item-downloaded-${job.job_id}`}>
                            <Download className="size-3 shrink-0 text-muted-foreground" aria-label="Downloaded" />
                          </span>
                        )}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground capitalize">
                        {jobSummary(job)}
                      </p>
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
