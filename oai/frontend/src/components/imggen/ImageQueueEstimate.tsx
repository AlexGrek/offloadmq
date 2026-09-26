import { useEffect, useState } from 'react'
import { Hourglass } from 'lucide-react'
import type { ImageJobDetails } from '../../api/images'
import type { RunningJobItem } from '../../api/progress'
import { estimateQueue, formatDuration } from '../../lib/imggen'

type ImageQueueEstimateProps = {
  /** In-flight image jobs (Progress feed). Renders nothing when empty. */
  running: RunningJobItem[]
  /** Recent jobs, used as runtime history for jobs with no estimate of their own. */
  history: ImageJobDetails[]
}

/** "Estimated full queue time" — shown under the sidebar's New button while anything is rendering. */
export function ImageQueueEstimate({ running, history }: ImageQueueEstimateProps) {
  const active = running.length > 0
  const [now, setNow] = useState(() => Date.now())

  // Tick so the countdown moves between the 5s progress refreshes.
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])

  if (!active) return null
  const est = estimateQueue(running, history, now)
  if (est.jobs === 0) return null

  const time =
    est.seconds == null
      ? 'estimating…'
      : `${est.partial ? '≥ ' : '~'}${formatDuration(est.seconds)}`

  return (
    <div
      className="mx-1 mt-1 flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"
      title="Estimated time until every queued and running job has finished, assuming they run one after another"
      data-testid="imggen-queue-estimate"
    >
      <Hourglass className="size-3.5 shrink-0" />
      <span className="truncate">
        Queue: {est.jobs} {est.jobs === 1 ? 'job' : 'jobs'} ·{' '}
        <span className="font-medium tabular-nums text-foreground/80">{time}</span>
      </span>
    </div>
  )
}
