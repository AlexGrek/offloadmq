import { useEffect, useState } from 'react'
import { JobProgressBar } from '@/components/imggen/JobProgressBar'
import { formatDuration, imageJobStatusLabel } from '@/lib/imggen'
import { isWallpaperJobTerminal, type WallpaperJobProgress } from '@/lib/hallucinate'

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** A single live snapshot, never a job history. Timings stop with monitoring. */
export function WallpaperJobStatus({ job, active }: { job: WallpaperJobProgress; active: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const done = isWallpaperJobTerminal(job.status)
  useEffect(() => {
    if (!active || done) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active, done])

  const submitted = timestamp(job.submittedAt)
  const started = timestamp(job.startedAt)
  const end = timestamp(job.finishedAt) ?? now
  const elapsed = (from: number | null, to: number) => from == null ? null : Math.max(0, (to - from) / 1000)
  const queue = job.queuedSeconds ?? elapsed(submitted, started ?? end)
  const execution = job.executionSeconds ?? elapsed(started, end)
  const total = elapsed(submitted, end)
  const duration = (seconds: number | null) => seconds == null ? '—' : formatDuration(seconds)
  const step = job.kind === 'prompt' ? 'Prompt' : job.kind === 'upscale' ? 'Upscale' : 'Generation'
  const status = job.status === 'submitting' ? 'Submitting'
    : job.status === 'running' ? 'Running' : imageJobStatusLabel(job.status)

  return (
    <section aria-label="Current wallpaper job" data-testid="hallucinate-job-status" className="min-w-0 space-y-2 [--primary:#67e8f9]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{step} · {status}</span>
        <span className="min-w-0 truncate text-white/60" title={job.capability}>{job.capability.replace(/^(imggen|img-utils)\./, '')}{job.jobId ? ` · #${job.jobId}` : ''}</span>
        {!active && !done && <span className="text-white/60">Monitoring stopped</span>}
      </div>
      <div data-testid="hallucinate-job-timings" className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-white/70">
        <span>Queue {duration(queue)}</span>
        <span>{job.kind === 'prompt' ? 'LLM' : job.kind === 'upscale' ? 'Upscale' : 'Render'} {duration(execution)}</span>
        <span>Total {duration(total)}</span>
        {job.typicalRuntimeSeconds != null && job.typicalRuntimeSeconds > 0 && <span>Typical ~{duration(job.typicalRuntimeSeconds)}</span>}
      </div>
      {active && !done ? <JobProgressBar
        key={`${job.kind}:${job.jobId ?? 'submitting'}`}
        status={job.status}
        stage={job.stage}
        submittedAt={job.submittedAt}
        startedAt={job.startedAt}
        typicalRuntimeSeconds={job.typicalRuntimeSeconds}
        label={status}
        className="max-w-none [&_.text-foreground]:text-white [&_.text-muted-foreground]:text-white/70 [&_.bg-muted]:bg-white/20"
      /> : job.status === 'completed' ? <div role="progressbar" aria-label={`${step} completed`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={100} className="h-2 rounded-full bg-cyan-400" /> : null}
    </section>
  )
}
