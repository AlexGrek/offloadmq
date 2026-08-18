import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  Square,
  Wand2,
} from 'lucide-react'
import {
  cancelImgUtilsJob,
  getImgUtilsJob,
  pollImgUtilsJob,
  prettyLabel,
  startImgUtilsJob,
  type ImgUtilsJob,
  type JobImageRef,
} from '../../api/imgUtils'
import { imageFileUrl, type UploadedImage } from '../../api/images'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { ImagePickerModal } from '../imggen/ImagePickerModal'
import { JobProgressBar } from '../imggen/JobProgressBar'
import { JobErrorBanner } from '../JobErrorBanner'
import ResizeControls from './ResizeControls'
import { ImageSlot } from './ImageSlot'
import { useImageSlot } from '../../hooks/useImageSlot'
import { ImgUtilsToolPicker } from './ImgUtilsToolPicker'
import { ScaleControl } from './ScaleControl'
import { useImgUtilsTools } from '../../hooks/useImgUtilsTools'
import { imageJobStatusLabel } from '../../lib/imggen'

const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

/** The image a quick transform runs on. Dimensions are optional — the lightbox
 *  only knows the id and filename — and just refine the resize form's hints. */
export type QuickTransformTarget = {
  image_id: string
  filename: string
  width?: number
  height?: number
}

export interface ImgUtilsQuickModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string | null
  /** Null closes the popup; changing it restarts with a fresh form. */
  image: QuickTransformTarget | null
  /** Fired once per finished transform, with the image it produced. */
  onResult?: (image: JobImageRef) => void | Promise<void>
}

/** Run one Image Tools transform without leaving the current page or lightbox.
 *  Same endpoints and job rows as `/app/img-utils`; the result can be fed
 *  straight back in as the next transform's input. */
export function ImgUtilsQuickModal({
  open,
  onOpenChange,
  token,
  image,
  onResult,
}: ImgUtilsQuickModalProps) {
  // Capabilities are only fetched while the popup is open, and refetched on
  // every open so a newly connected agent shows up.
  const tools = useImgUtilsTools(token, open)

  const [target, setTarget] = useState<QuickTransformTarget | null>(image)
  const [job, setJob] = useState<ImgUtilsJob | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const source = useImageSlot(token)

  // Restart on open, and whenever the host points the popup at another image.
  // Render-phase reset (React's "adjust state when a prop changes" pattern)
  // rather than an effect, so it never double-renders.
  const sessionKey = open && image ? image.image_id : null
  const [session, setSession] = useState<string | null>(sessionKey)
  if (session !== sessionKey) {
    setSession(sessionKey)
    setTarget(image)
    setJob(null)
    setError(null)
    setSubmitting(false)
    setCanceling(false)
    source.clear()
  }

  const jobId = job?.job_id ?? null
  const jobStatus = job?.status ?? null
  const running = jobId != null && (jobStatus == null || !TERMINAL.has(jobStatus))

  const refresh = useCallback(
    async (id: string, viaOffload: boolean) => {
      if (!token) return
      try {
        setJob(viaOffload ? await pollImgUtilsJob(token, id) : await getImgUtilsJob(token, id))
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [token],
  )

  useEffect(() => {
    if (!open || !token || !jobId || (jobStatus != null && TERMINAL.has(jobStatus))) return
    const id = window.setInterval(() => {
      void refresh(jobId, true)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [open, token, jobId, jobStatus, refresh])

  // Hand the finished image to the host exactly once per job.
  const reportedRef = useRef<string | null>(null)
  const output = job?.status === 'completed' ? (job.output_image ?? null) : null
  useEffect(() => {
    if (!job || !output || reportedRef.current === job.job_id) return
    reportedRef.current = job.job_id
    void onResult?.(output)
  }, [job, output, onResult])

  const inputSize =
    target?.width != null && target?.height != null
      ? { width: target.width, height: target.height }
      : null

  const sourceReady = Boolean(source.slot?.uploaded && !source.slot.error)
  const canRun =
    token != null &&
    target != null &&
    tools.activeTool != null &&
    (!tools.needsSource || sourceReady) &&
    !tools.resizeError &&
    !submitting &&
    !running

  async function onRun() {
    if (!token || !canRun || !target || !tools.activeTool) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await startImgUtilsJob(token, {
        capability: tools.activeTool.capability,
        // Always explicit: the pack directory is not a usable task type, and a
        // pack may install more than one operation.
        workflow: tools.activeTool.workflow,
        input_image_id: target.image_id,
        source_image_id: tools.needsSource
          ? source.slot!.uploaded!.image_id
          : undefined,
        options: tools.buildOptions(),
      })
      reportedRef.current = null
      await refresh(res.job_id, false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function onCancel() {
    if (!token || !jobId) return
    setCanceling(true)
    try {
      await cancelImgUtilsJob(token, jobId)
      await refresh(jobId, false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCanceling(false)
    }
  }

  /** Chain: the result becomes the input of the next transform. */
  function chain(next: UploadedImage) {
    setTarget(next)
    setJob(null)
    setError(null)
    source.clear()
  }

  function onDownload() {
    if (!output || !token) return
    const a = document.createElement('a')
    a.href = imageFileUrl(output.image_id, token)
    a.download = output.filename
    a.rel = 'noopener'
    a.click()
  }

  const previewUrl = target && token ? imageFileUrl(target.image_id, token) : null

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        data-testid="imgutils-quick-modal"
        // The library picker is a plain overlay, not a nested Radix dialog, so
        // Radix sees its clicks/Escape as "outside" this content and would
        // otherwise dismiss the quick modal out from under it.
        onEscapeKeyDown={e => {
          if (pickerOpen) e.preventDefault()
        }}
        onInteractOutside={e => {
          if (pickerOpen) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Wand2 className="size-4 text-cyan-500" />
            Image Tools
          </DialogTitle>
          <DialogDescription>
            One-shot transforms — no prompt, just an image in and an image out.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Current input — swaps to the result when a finished transform is chained. */}
          {previewUrl && target ? (
            <div className="overflow-hidden rounded-lg bg-muted/40">
              <img
                src={previewUrl}
                alt={target.filename}
                className="max-h-40 w-full object-contain"
                data-testid="imgutils-quick-input-preview"
              />
              <p className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                {target.filename}
                {inputSize ? ` — ${inputSize.width}×${inputSize.height}` : ''}
              </p>
            </div>
          ) : null}

          {output && token ? (
            <div className="space-y-3" data-testid="imgutils-quick-result">
              <div className="overflow-hidden rounded-lg bg-muted/40">
                <img
                  src={imageFileUrl(output.image_id, token)}
                  alt={output.filename}
                  className="max-h-64 w-full object-contain"
                  data-testid="imgutils-quick-result-image"
                />
                <p className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                  {prettyLabel(job!.workflow)} — {output.width}×{output.height}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => chain(output)}
                  data-testid="imgutils-quick-chain"
                >
                  <Wand2 className="mr-1 size-3.5" />
                  Transform again
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onDownload}
                  data-testid="imgutils-quick-download"
                >
                  <Download className="mr-1 size-3.5" />
                  Download
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setJob(null)
                    setError(null)
                  }}
                  data-testid="imgutils-quick-run-another"
                >
                  <RotateCcw className="mr-1 size-3.5" />
                  Another tool
                </Button>
              </div>
            </div>
          ) : running && job ? (
            <div className="space-y-3" data-testid="imgutils-quick-running">
              <div className="flex justify-center rounded-md bg-muted/30 px-3 py-4">
                <JobProgressBar
                  status={job.status}
                  stage={job.stage}
                  startedAt={job.started_at}
                  typicalRuntimeSeconds={job.typical_runtime_seconds}
                  // No separate submit timestamp: the task is created and
                  // submitted in one request, so `created_at` is the queue entry.
                  submittedAt={job.created_at}
                  label={imageJobStatusLabel(job.status)}
                />
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => void onCancel()}
                disabled={canceling}
                data-testid="imgutils-quick-cancel"
              >
                {canceling ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Square className="mr-1 size-3.5 fill-current" />
                )}
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <ImgUtilsToolPicker
                tools={tools.tools}
                loading={tools.loading}
                selectedKey={tools.selectedKey}
                activeTool={tools.activeTool}
                onSelect={tools.setSelectedKey}
                onRefresh={tools.reload}
                compact
                testIdPrefix="imgutils-quick"
              />

              {tools.isResize ? (
                <ResizeControls
                  state={tools.resizeState}
                  onChange={tools.patchResize}
                  methods={tools.activeTool?.methods ?? []}
                  inputSize={inputSize}
                  error={tools.resizeError}
                />
              ) : null}

              {tools.takesScale ? (
                <ScaleControl
                  value={tools.scaleMultiplier}
                  onChange={tools.setScaleMultiplier}
                  testIdPrefix="imgutils-quick"
                  compact
                />
              ) : null}

              {tools.needsSource ? (
                <ImageSlot
                  label="Face reference"
                  hint="The face to transfer onto the target"
                  slot={source.slot}
                  testId="imgutils-quick-source"
                  compact
                  onPick={file => {
                    setError(null)
                    void source.pickFile(file)
                  }}
                  onPickFromLibrary={() => setPickerOpen(true)}
                  onClear={source.clear}
                />
              ) : null}

              <Button
                type="button"
                className="min-h-11 w-full"
                disabled={!canRun}
                onClick={() => void onRun()}
                data-testid="imgutils-quick-run"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Wand2 className="mr-2 size-4" />
                    Run {tools.activeTool ? prettyLabel(tools.activeTool.workflow) : 'transform'}
                  </>
                )}
              </Button>
            </>
          )}

          {job?.status === 'failed' ? (
            <JobErrorBanner
              message={job.error || 'Task failed'}
              testId="imgutils-quick-job-failed"
            />
          ) : job?.status === 'canceled' ? (
            <p className="text-xs text-muted-foreground">Transform canceled.</p>
          ) : null}

          {error || tools.error ? (
            <JobErrorBanner
              message={(error ?? tools.error)!}
              testId="imgutils-quick-error"
            />
          ) : null}

          <div className="flex justify-end border-t border-border pt-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/app/img-utils" className="gap-1.5">
                <ExternalLink className="size-3.5" />
                Open full app
              </Link>
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>

    {/* Sibling of the Dialog on purpose: it centers itself with a `fixed`
        overlay, which would be pinned to DialogContent's own box (not the
        viewport) if nested inside it, since DialogContent is a transformed
        containing block. */}
    {token ? (
      <ImagePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={source.pickStored}
        token={token}
      />
    ) : null}
    </>
  )
}
