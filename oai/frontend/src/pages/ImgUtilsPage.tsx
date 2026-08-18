import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Columns2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react'
import {
  cancelImgUtilsJob,
  deleteImgUtilsJob,
  describeResizeOptions,
  getImgUtilsJob,
  listImgUtilsJobs,
  pollImgUtilsJob,
  prettyLabel,
  retryImgUtilsJob,
  startImgUtilsJob,
  takesScaleMultiplier,
  RESIZE_WORKFLOW,
  type ImgUtilsJob,
  type JobImageRef,
} from '../api/imgUtils'
import { imageFileUrl, type UploadedImage } from '../api/images'
import { Button } from '../components/ui/button'
import {
  IMGUTILS_NEW_PANEL,
  ImgUtilsHistorySidebar,
} from '../components/imgutils/ImgUtilsHistorySidebar'
import ResizeControls from '../components/imgutils/ResizeControls'
import { ImageSlot } from '../components/imgutils/ImageSlot'
import { useImageSlot } from '../hooks/useImageSlot'
import { ImgUtilsToolPicker } from '../components/imgutils/ImgUtilsToolPicker'
import { ScaleControl } from '../components/imgutils/ScaleControl'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { ImageLightbox, type ImageLightboxActions } from '../components/ImageLightbox'
import { NudeDetectModal } from '../components/nudedetect/NudeDetectModal'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { useImgUtilsTools } from '../hooks/useImgUtilsTools'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import { imageJobStatusLabel, type ImggenRouteState } from '../lib/imggen'

const POLL_INTERVAL_MS = 3000
const LIST_REFRESH_INTERVAL_MS = 5000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

export default function ImgUtilsPage() {
  const { token } = useAuth()
  const navigate = useNavigate()

  // Online tools + their knobs; shared with the quick-transform popup.
  const tools = useImgUtilsTools(token)

  const input = useImageSlot(token)
  const source = useImageSlot(token)
  const [pickerTarget, setPickerTarget] = useState<'input' | 'source' | null>(null)

  const [jobs, setJobs] = useState<ImgUtilsJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(IMGUTILS_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<ImgUtilsJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Before/after view of the transform — the img2img compare on the generation page.
  const [compareMode, setCompareMode] = useState(false)
  const [nudeDetectTarget, setNudeDetectTarget] = useState<{
    imageId: string
    filename: string
  } | null>(null)
  // Bumped after a lightbox mutation (delete/star) so <img> URLs miss the cache.
  const [mediaRevision, setMediaRevision] = useState(0)

  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  // Mobile: the sidebar is a full-screen overlay — collapse it when the viewport
  // becomes narrow. Done as a render-phase adjustment (React's "reset state when a
  // value changes" pattern) rather than an effect, so it never double-renders.
  const [prevIsMobile, setPrevIsMobile] = useState(isMobile)
  if (isMobile !== prevIsMobile) {
    setPrevIsMobile(isMobile)
    if (isMobile) setSidebarOpen(false)
  }

  const viewingJob = activePanel !== IMGUTILS_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const { activeTool, needsSource, takesScale, isResize } = tools

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      setJobs(await listImgUtilsJobs(token))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    // Kick the initial fetches off a microtask so their setState lands in the
    // async continuation, never synchronously in the effect body.
    void (async () => {
      await Promise.resolve()
      void loadJobs()
    })()
  }, [loadJobs])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getImgUtilsJob(token, jobId)
      setSelectedJob(job)
      setJobs(prev => {
        const idx = prev.findIndex(j => j.job_id === job.job_id)
        if (idx < 0) return [job, ...prev]
        const next = [...prev]
        next[idx] = job
        return next
      })
      return job
    },
    [token],
  )

  function selectNew() {
    setActivePanel(IMGUTILS_NEW_PANEL)
    setError(null)
  }

  async function selectJob(jobId: string) {
    if (!token) return
    setActivePanel(jobId)
    setError(null)
    setJobDetailLoading(true)
    try {
      await refreshJob(jobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobDetailLoading(false)
    }
  }

  /** Feed an image back into this page's New-transform form. */
  function applyAsInput(image: UploadedImage) {
    input.pickStored(image)
    source.clear()
    setError(null)
    setActivePanel(IMGUTILS_NEW_PANEL)
  }

  /** Hand an image to image generation as an img2img / img2video input. */
  const sendToImggen = useCallback(
    (image: UploadedImage, mode: 'img2img' | 'img2video') => {
      const state: ImggenRouteState = { useInputImage: { mode, image } }
      navigate('/app/images', { state })
    },
    [navigate],
  )

  const onImageMutated = useCallback(async () => {
    setMediaRevision(v => v + 1)
    if (viewedJobId) {
      try {
        await refreshJob(viewedJobId)
      } catch (e) {
        setError((e as Error).message)
      }
    }
  }, [viewedJobId, refreshJob])

  /** Lightbox action set shared by the result, the compare panes and the input. */
  const lightboxActions = useCallback(
    (image: JobImageRef): ImageLightboxActions | undefined =>
      token
        ? {
            imageId: image.image_id,
            filename: image.filename,
            direction: image.direction,
            token,
            onDeleted: onImageMutated,
            onSendToImg2Img: () => sendToImggen(image, 'img2img'),
            onSendToImg2Video: () => sendToImggen(image, 'img2video'),
            imgUtils: { onResult: onImageMutated },
            onNudeDetect: () =>
              setNudeDetectTarget({ imageId: image.image_id, filename: image.filename }),
          }
        : undefined,
    [token, onImageMutated, sendToImggen],
  )

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || submitting || !canSubmit) return

    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    try {
      const res = await startImgUtilsJob(token, {
        capability: activeTool!.capability,
        // Always explicit: the pack directory is not a usable task type, and a
        // pack may install more than one operation.
        workflow: activeTool!.workflow,
        input_image_id: input.slot!.uploaded!.image_id,
        source_image_id: needsSource ? source.slot!.uploaded!.image_id : undefined,
        options: tools.buildOptions(),
      })
      input.clear()
      source.clear()
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      await loadJobs()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  const onPollNow = useCallback(
    async (jobId: string) => {
      if (!token) return
      setPolling(true)
      setError(null)
      try {
        const job = await pollImgUtilsJob(token, jobId)
        setSelectedJob(job)
        setJobs(prev => prev.map(j => (j.job_id === job.job_id ? job : j)))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setPolling(false)
      }
    },
    [token],
  )

  async function onCancel(jobId: string) {
    if (!token) return
    setCanceling(true)
    setError(null)
    try {
      await cancelImgUtilsJob(token, jobId)
      await refreshJob(jobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCanceling(false)
    }
  }

  async function onRetry(jobId: string) {
    if (!token) return
    setRetrying(true)
    setError(null)
    try {
      const res = await retryImgUtilsJob(token, jobId)
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      await loadJobs()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }

  async function onDelete(jobId: string) {
    if (!token) return
    setDeleting(true)
    setError(null)
    try {
      await deleteImgUtilsJob(token, jobId)
      const next = jobs.filter(j => j.job_id !== jobId)
      setJobs(next)
      if (next.length > 0) {
        await selectJob(next[0].job_id)
      } else {
        selectNew()
        setSelectedJob(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!token || !viewedJobId) return
    const status = selectedJob?.status
    if (status && TERMINAL.has(status)) return
    const id = window.setInterval(() => {
      void onPollNow(viewedJobId)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, viewedJobId, selectedJob?.status, onPollNow])

  // The poll above only advances the job being *viewed*. Other in-flight jobs are
  // driven to completion by the backend worker, so the sidebar just needs to
  // re-read them — a plain DB listing, no OffloadMQ round trip, hence the slower
  // interval. Without this their rows sit at their submit-time status until reload.
  const hasPendingJobs = jobs.some(j => !TERMINAL.has(j.status))
  useEffect(() => {
    if (!token || !hasPendingJobs) return
    const id = window.setInterval(() => {
      void loadJobs()
    }, LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, hasPendingJobs, loadJobs])

  const inputReady = Boolean(input.slot?.uploaded && !input.slot.error)
  const sourceReady = Boolean(source.slot?.uploaded && !source.slot.error)
  const resizeError = tools.resizeError
  const canSubmit =
    Boolean(activeTool) &&
    inputReady &&
    (!needsSource || sourceReady) &&
    !resizeError &&
    !submitting

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'
  const outputImage = selectedJob?.output_image ?? null
  const inputImage = selectedJob?.input_image ?? null
  // Metadata only comes back from the single-job endpoints; fall back to the bare
  // id so a listing-sourced row still renders (without lightbox actions).
  const shownImage = outputImage ?? inputImage
  const shownImageId = selectedJob?.output_image_id ?? selectedJob?.input_image_id ?? null
  const canCompare = outputImage != null && inputImage != null

  // A fresh job has nothing to compare yet — never carry the toggle across jobs.
  // Render-phase reset (React's "adjust state on change" pattern) rather than an effect.
  const [compareJobId, setCompareJobId] = useState(selectedJob?.job_id)
  if (selectedJob?.job_id !== compareJobId) {
    setCompareJobId(selectedJob?.job_id)
    setCompareMode(false)
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="imgutils-page"
    >
      <ToolSidebar
        title="Transforms"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="imgutils-sidebar"
      >
        <ImgUtilsHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          token={token}
          loading={jobsLoading}
          onSelectNew={() => {
            selectNew()
            if (isMobile) setSidebarOpen(false)
          }}
          onSelectJob={jobId => {
            void selectJob(jobId)
            if (isMobile) setSidebarOpen(false)
          }}
        />
      </ToolSidebar>

      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(v => !v)}
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <h1 className="min-w-0 flex-1 truncate font-display text-sm font-semibold">
            {viewingJob && selectedJob ? prettyLabel(selectedJob.workflow) : 'New transform'}
          </h1>
          {viewingJob && selectedJob ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete transform"
              aria-label="Delete transform"
              data-testid="imgutils-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === IMGUTILS_NEW_PANEL && (
              <section data-testid="imgutils-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Wand2 className="h-4 w-4 text-cyan-500" />
                    Image Tools
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    One-shot transforms — no prompt, just an image in and an image out.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <ImgUtilsToolPicker
                    tools={tools.tools}
                    loading={tools.loading}
                    selectedKey={tools.selectedKey}
                    activeTool={activeTool}
                    onSelect={tools.setSelectedKey}
                    onRefresh={tools.reload}
                  />

                  <ImageSlot
                    label={needsSource ? 'Target image' : 'Image'}
                    hint={
                      needsSource
                        ? 'The photo whose face gets replaced'
                        : 'PNG, JPEG, WebP or GIF'
                    }
                    slot={input.slot}
                    testId="imgutils-input"
                    onPick={file => void input.pickFile(file)}
                    onPickFromLibrary={() => setPickerTarget('input')}
                    onClear={input.clear}
                  />

                  {isResize ? (
                    <ResizeControls
                      state={tools.resizeState}
                      onChange={tools.patchResize}
                      methods={activeTool?.methods ?? []}
                      inputSize={
                        input.slot?.uploaded
                          ? { width: input.slot.uploaded.width, height: input.slot.uploaded.height }
                          : null
                      }
                      error={resizeError}
                    />
                  ) : null}

                  {takesScale ? (
                    <ScaleControl
                      value={tools.scaleMultiplier}
                      onChange={tools.setScaleMultiplier}
                    />
                  ) : null}

                  {needsSource ? (
                    <ImageSlot
                      label="Face reference"
                      hint="The face to transfer onto the target"
                      slot={source.slot}
                      testId="imgutils-source"
                      onPick={file => void source.pickFile(file)}
                      onPickFromLibrary={() => setPickerTarget('source')}
                      onClear={source.clear}
                    />
                  ) : null}

                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="min-h-11 w-full"
                    data-testid="imgutils-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <Wand2 className="mr-2 size-4" />
                        Run {activeTool ? prettyLabel(activeTool.workflow) : 'transform'}
                      </>
                    )}
                  </Button>

                  {error ? <JobErrorBanner message={error} testId="imgutils-error" /> : null}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="imgutils-job-detail" className="space-y-4">
                {error ? <JobErrorBanner message={error} testId="imgutils-job-error" /> : null}
                {/* Keep the spinner up while a *different* job is still loading, so
                    switching panels never flashes the "could not load" fallback. */}
                {jobDetailLoading && selectedJob?.job_id !== viewedJobId ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    {compareMode && canCompare && token ? (
                      <div
                        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border"
                        data-testid="imgutils-compare-view"
                      >
                        {([
                          ['Before', inputImage!, 'imgutils-compare-input'],
                          ['After', outputImage!, 'imgutils-compare-output'],
                        ] as const).map(([caption, image, testId]) => (
                          <div key={testId} className="relative overflow-hidden bg-muted/30">
                            <span className="absolute left-2 top-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                              {caption}
                            </span>
                            <ImageLightbox
                              src={imageFileUrl(image.image_id, token, mediaRevision)}
                              alt={image.filename}
                              triggerClassName="group block w-full overflow-hidden"
                              testId={testId}
                              actions={lightboxActions(image)}
                            >
                              <img
                                src={imageFileUrl(image.image_id, token, mediaRevision)}
                                alt=""
                                aria-hidden
                                className="max-h-[40dvh] w-full object-contain transition-opacity group-hover:opacity-95 sm:max-h-[60vh]"
                              />
                            </ImageLightbox>
                          </div>
                        ))}
                      </div>
                    ) : shownImage && token ? (
                      <ImageLightbox
                        src={imageFileUrl(shownImage.image_id, token, mediaRevision)}
                        alt={shownImage.filename}
                        caption={`${shownImage.filename} — ${shownImage.width}×${shownImage.height}`}
                        triggerClassName="group block w-full overflow-hidden rounded-xl bg-muted/30"
                        testId="imgutils-job-image"
                        actions={lightboxActions(shownImage)}
                      >
                        <img
                          src={imageFileUrl(shownImage.image_id, token, mediaRevision)}
                          alt=""
                          aria-hidden
                          className="max-h-[60vh] w-full object-contain transition-opacity group-hover:opacity-95"
                        />
                      </ImageLightbox>
                    ) : shownImageId && token ? (
                      <div className="overflow-hidden rounded-xl bg-muted/30">
                        <img
                          src={imageFileUrl(shownImageId, token, mediaRevision)}
                          alt={selectedJob.output_image_id ? 'Result' : 'Input'}
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="imgutils-job-image"
                        />
                      </div>
                    ) : null}

                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold">
                        {prettyLabel(selectedJob.workflow)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {selectedJob.capability} · {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                      {selectedJob.workflow === RESIZE_WORKFLOW ? (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid="imgutils-resize-summary"
                        >
                          {describeResizeOptions(selectedJob.options)}
                          {outputImage
                            ? ` → ${outputImage.width}×${outputImage.height}`
                            : ''}
                        </p>
                      ) : takesScaleMultiplier(selectedJob.workflow) &&
                        typeof selectedJob.options?.scale_multiplier === 'number' ? (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid="imgutils-scale-summary"
                        >
                          {selectedJob.options.scale_multiplier}× upscale
                          {outputImage
                            ? ` → ${outputImage.width}×${outputImage.height}`
                            : ''}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {outputImage ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => sendToImggen(outputImage, 'img2img')}
                            data-testid="imgutils-edit-output"
                          >
                            <Pencil className="mr-1 h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => sendToImggen(outputImage, 'img2video')}
                            data-testid="imgutils-animate-output"
                          >
                            <Video className="mr-1 h-4 w-4" />
                            Animate
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => applyAsInput(outputImage)}
                            data-testid="imgutils-use-as-input"
                          >
                            <Wand2 className="mr-1 h-4 w-4" />
                            Use as input
                          </Button>
                        </>
                      ) : null}
                      {canCompare ? (
                        <Button
                          type="button"
                          variant={compareMode ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setCompareMode(v => !v)}
                          data-testid="imgutils-compare-toggle"
                        >
                          <Columns2 className="mr-1 h-4 w-4" />
                          {compareMode ? 'Result' : 'Compare'}
                        </Button>
                      ) : null}
                      {canRetry ? (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onRetry(selectedJob.job_id)}
                          disabled={retrying}
                          data-testid="imgutils-retry-job"
                        >
                          {retrying ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 h-4 w-4" />
                          )}
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void onPollNow(selectedJob.job_id)}
                        disabled={polling}
                        data-testid="imgutils-poll-job"
                      >
                        {polling ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        Poll now
                      </Button>
                      {isRunning ? (
                        <>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void onCancel(selectedJob.job_id)}
                            disabled={canceling}
                            data-testid="imgutils-cancel-job"
                          >
                            {canceling ? (
                              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : (
                              <Square className="mr-1 h-4 w-4 fill-current" />
                            )}
                            Cancel
                          </Button>
                          <span className="flex items-center text-xs text-muted-foreground">
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            Auto-polling…
                          </span>
                        </>
                      ) : null}
                    </div>

                    {selectedJob.status === 'failed' ? (
                      <JobErrorBanner
                        message={selectedJob.error || 'Task failed'}
                        testId="imgutils-job-failed"
                      />
                    ) : selectedJob.status === 'canceled' ? (
                      <p className="text-xs text-muted-foreground">Task canceled.</p>
                    ) : selectedJob.status !== 'completed' ? (
                      <div className="flex justify-center rounded-md bg-muted/30 px-3 py-4">
                        <JobProgressBar
                          status={selectedJob.status}
                          stage={selectedJob.stage}
                          startedAt={selectedJob.started_at}
                          typicalRuntimeSeconds={selectedJob.typical_runtime_seconds}
                          // No separate submit timestamp: the task is created and
                          // submitted in one request, so `created_at` is the queue entry.
                          submittedAt={selectedJob.created_at}
                          label={imageJobStatusLabel(selectedJob.status)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    Could not load this transform.
                  </p>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {token && (
        <ImagePickerModal
          open={pickerTarget !== null}
          onClose={() => setPickerTarget(null)}
          onSelect={image => {
            ;(pickerTarget === 'source' ? source : input).pickStored(image)
          }}
          token={token}
        />
      )}

      {nudeDetectTarget && token ? (
        <NudeDetectModal
          open
          onOpenChange={open => {
            if (!open) setNudeDetectTarget(null)
          }}
          token={token}
          imageId={nudeDetectTarget.imageId}
          imageUrl={imageFileUrl(nudeDetectTarget.imageId, token, mediaRevision)}
          filename={nudeDetectTarget.filename}
        />
      ) : null}
    </div>
  )
}
