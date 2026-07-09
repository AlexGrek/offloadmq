import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { imageJobIsExecuting, imageJobStatusLabel } from '@/lib/imggen'

/**
 * Modern linear progress bar for an in-flight image/video job.
 *
 * Mirrors the sandbox `CircularProgress` heuristic (elapsed / typical runtime)
 * but restyled as a flat, gradient linear bar.
 *
 * Crucially it distinguishes *queued* from *running*: progress only advances
 * once the task is actually executing on an agent (`startedAt` is set when the
 * server first sees `starting`/`running`). While the task is still queued or
 * waiting for an agent, it shows an indeterminate "waiting" shimmer instead of
 * a misleading filling bar.
 */

const STATUS_LABEL: Record<string, string> = {
  submitted: 'In queue',
  pending: 'Pending',
  queued: 'Queued',
  assigned: 'Assigned',
  starting: 'Starting',
  running: 'Generating',
  cancelRequested: 'Canceling',
}

/** Statuses where the task is still waiting (not yet executing on an agent). */
const QUEUE_STATUSES = new Set(['submitted', 'pending', 'queued', 'assigned'])

function isExecutingStatus(status: string, startedAt?: string | null): boolean {
  if (imageJobIsExecuting(status)) return true
  // `startedAt` is set on first `starting`/`running` poll — use as fallback when
  // `job.status` in the API response lags behind the offload cache.
  return startedAt != null && !QUEUE_STATUSES.has(status)
}

function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export interface JobProgressBarProps {
  status: string
  stage?: string | null
  /** RFC3339 timestamp of when execution began on an agent; null while queued. */
  startedAt?: string | null
  /** Heuristic execution-time estimate in seconds; null when unknown. */
  typicalRuntimeSeconds?: number | null
  /** RFC3339 timestamp of when the task was submitted; drives the queued-time readout. */
  submittedAt?: string | null
  className?: string
}

export function JobProgressBar({
  status,
  stage,
  startedAt,
  typicalRuntimeSeconds,
  submittedAt,
  className,
}: JobProgressBarProps) {
  const [now, setNow] = useState(() => Date.now())

  // Tick a clock so the heuristic bar advances smoothly between 5s polls.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])

  const isRunning = isExecutingStatus(status, startedAt)
  const startedMs = startedAt ? new Date(startedAt).getTime() : null
  const elapsedSec = startedMs != null ? (now - startedMs) / 1000 : null

  // Determinate only when the task is actually running, we know when it
  // started, and we have a runtime estimate to measure against.
  const determinate =
    isRunning &&
    startedMs != null &&
    typicalRuntimeSeconds != null &&
    typicalRuntimeSeconds > 0

  const raw =
    determinate && elapsedSec != null ? elapsedSec / typicalRuntimeSeconds! : 0
  const overrun = determinate && raw > 1
  // Cap the visible fill at 99% until the job actually completes.
  const displayPct = determinate ? Math.min(Math.round(raw * 100), 99) : 0
  const remainingSec =
    determinate && elapsedSec != null ? Math.max(0, typicalRuntimeSeconds! - elapsedSec) : null

  const label = STATUS_LABEL[status] ?? imageJobStatusLabel(status)

  // Right-hand readout: remaining time (+ percent) when determinate, elapsed
  // time when running without an estimate, queued time while still waiting.
  let readout: string | null = null
  if (determinate && remainingSec != null) {
    readout = overrun ? 'finishing…' : `${formatElapsed(remainingSec)} left · ${displayPct}%`
  } else if (isRunning && elapsedSec != null) {
    readout = formatElapsed(elapsedSec)
  } else if (!isRunning && submittedAt) {
    const submittedMs = new Date(submittedAt).getTime()
    const queuedSec = (now - submittedMs) / 1000
    if (queuedSec >= 0) readout = `queued ${formatElapsed(queuedSec)}`
  }

  return (
    <div
      className={cn('w-full max-w-md space-y-1.5', className)}
      data-testid="imggen-progress-bar"
      data-progress-phase={determinate ? 'determinate' : 'indeterminate'}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? displayPct : undefined}
    >
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate font-medium text-foreground">
          {label}
          {stage ? (
            <span className="ml-1 font-normal text-muted-foreground">· {stage}</span>
          ) : null}
        </span>
        {readout ? (
          <span
            className={cn(
              'shrink-0 tabular-nums font-medium',
              overrun ? 'text-amber-500' : 'text-muted-foreground',
            )}
          >
            {readout}
          </span>
        ) : null}
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        {determinate ? (
          <div
            className={cn(
              'h-full rounded-full bg-gradient-to-r transition-[width] duration-500 ease-linear',
              overrun
                ? 'from-amber-400 to-amber-500'
                : 'from-primary/70 to-primary',
            )}
            style={{ width: `${overrun ? 100 : displayPct}%` }}
          />
        ) : (
          // Indeterminate: a soft sweep that reads as "working, no estimate".
          <motion.div
            className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent"
            animate={{ x: ['-120%', '360%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>
    </div>
  )
}

export default JobProgressBar
