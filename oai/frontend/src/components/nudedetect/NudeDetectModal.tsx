import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  getNudeDetectAvailability,
  pollNudeDetectJob,
  startNudeDetectJob,
  type NudeDetectJob,
} from '@/api/nudeDetect'
import { NudeDetectResultsList } from '@/components/nudedetect/NudeDetectResultView'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { DEFAULT_NUDENET_THRESHOLD, totalDetectionCount } from '@/lib/nudeDetectLabels'

const POLL_INTERVAL_MS = 2500
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

export interface NudeDetectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string | null
  imageId: string
  imageUrl: string
  filename: string
}

export function NudeDetectModal({
  open,
  onOpenChange,
  token,
  imageId,
  imageUrl,
  filename,
}: NudeDetectModalProps) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [threshold, setThreshold] = useState(DEFAULT_NUDENET_THRESHOLD)
  const [running, setRunning] = useState(false)
  const [job, setJob] = useState<NudeDetectJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const clearPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open || !token) return
    setError(null)
    setJob(null)
    setRunning(false)
    setThreshold(DEFAULT_NUDENET_THRESHOLD)
    getNudeDetectAvailability(token)
      .then(r => setAvailable(r.available))
      .catch((e: Error) => {
        setAvailable(false)
        setError(e.message)
      })
    return clearPoll
  }, [open, token, clearPoll])

  useEffect(() => {
    if (!open) clearPoll()
  }, [open, clearPoll])

  const pollJob = useCallback(
    async (jobId: string) => {
      if (!token) return
      const updated = await pollNudeDetectJob(token, jobId)
      setJob(updated)
      if (TERMINAL.has(updated.status)) {
        setRunning(false)
        clearPoll()
        if (updated.status === 'failed') {
          setError(updated.error ?? 'Detection failed')
        }
      }
    },
    [token, clearPoll],
  )

  async function onRun() {
    if (!token || !imageId || running) return
    setError(null)
    setJob(null)
    setRunning(true)
    try {
      const res = await startNudeDetectJob(token, { image_id: imageId, threshold })
      const initial = await pollNudeDetectJob(token, res.job_id)
      setJob(initial)
      if (TERMINAL.has(initial.status)) {
        setRunning(false)
        if (initial.status === 'failed') {
          setError(initial.error ?? 'Detection failed')
        }
        return
      }
      clearPoll()
      pollRef.current = window.setInterval(() => {
        void pollJob(res.job_id).catch((e: Error) => {
          setError(e.message)
          setRunning(false)
          clearPoll()
        })
      }, POLL_INTERVAL_MS)
    } catch (e) {
      setError((e as Error).message)
      setRunning(false)
    }
  }

  const resultCount = totalDetectionCount(job?.result)
  const statusLabel =
    job?.status === 'completed'
      ? `Done — ${resultCount} detection${resultCount !== 1 ? 's' : ''}`
      : job?.status
        ? job.status.replace(/_/g, ' ')
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        data-testid="nudedetect-modal"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <ShieldAlert className="size-4 text-amber-500" />
            NSFW Detection
          </DialogTitle>
          <DialogDescription>
            Run NudeNet on this image. Adjust confidence threshold before scanning.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg bg-muted/40">
            <img
              src={imageUrl}
              alt={filename}
              className="max-h-48 w-full object-contain"
              data-testid="nudedetect-modal-preview"
            />
            <p className="truncate px-2 py-1.5 text-xs text-muted-foreground">{filename}</p>
          </div>

          {available === false ? (
            <p className="text-xs text-muted-foreground" data-testid="nudedetect-unavailable">
              <code className="text-[11px]">onnx.nudenet</code> is not online. Ensure an agent
              with NudeNet installed is connected, or open the{' '}
              <Link to="/app/nude-detect" className="text-primary underline-offset-2 hover:underline">
                Nude Detector
              </Link>{' '}
              app for batch uploads later.
            </p>
          ) : null}

          <div className="space-y-1.5" data-testid="nudedetect-threshold">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="nudedetect-modal-threshold">Confidence threshold</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {threshold.toFixed(2)}
              </span>
            </div>
            <input
              id="nudedetect-modal-threshold"
              type="range"
              min={0.05}
              max={0.95}
              step={0.05}
              value={threshold}
              disabled={running}
              onChange={e => setThreshold(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <Button
            type="button"
            className="w-full min-h-11"
            disabled={!token || !available || running}
            onClick={() => void onRun()}
            data-testid="nudedetect-modal-run"
          >
            {running ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Detecting…
              </>
            ) : (
              <>
                <ShieldAlert className="mr-2 size-4" />
                Run detection
              </>
            )}
          </Button>

          {statusLabel && running ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {job?.stage ?? statusLabel}
            </p>
          ) : null}

          {error ? (
            <p className="text-xs text-destructive" data-testid="nudedetect-modal-error">
              {error}
            </p>
          ) : null}

          {job?.result?.results ? (
            <NudeDetectResultsList
              results={job.result.results}
              previewUrl={imageUrl}
            />
          ) : null}

          <div className="flex justify-end border-t border-border pt-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/app/nude-detect" className="gap-1.5">
                <ExternalLink className="size-3.5" />
                Open full app
              </Link>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
