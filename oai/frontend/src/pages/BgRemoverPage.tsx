import { useCallback, useEffect, useState } from 'react'
import {
  Columns2,
  Download,
  Eraser,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  DEFAULT_BG_OPTIONS,
  bgOptionsError,
  cancelBgRemoverJob,
  deleteBgRemoverJob,
  getBgRemoverJob,
  listBgRemoverCapabilities,
  listBgRemoverJobs,
  pollBgRemoverJob,
  retryBgRemoverJob,
  startBgRemoverJob,
  type BgRemoverCapabilities,
  type BgRemoverJob,
  type BgRemoverOptions,
} from '../api/bgRemover'
import { imageFileUrl } from '../api/images'
import { Button } from '../components/ui/button'
import {
  BGREMOVER_NEW_PANEL,
  BgRemoverHistorySidebar,
} from '../components/bgremover/BgRemoverHistorySidebar'
import { BgRemoverControls } from '../components/bgremover/BgRemoverControls'
import { ImageSetSlot } from '../components/imgutils/ImageSetSlot'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { ImageLightbox } from '../components/ImageLightbox'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useImageSet } from '../hooks/useImageSet'
import { useIsMobile } from '../hooks/useIsMobile'
import { usePasteImages } from '../hooks/usePasteImages'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import {
  describeBgOptions,
  foregroundWarning,
  modelLabel,
  readBgRemoverPrefs,
  writeBgRemoverPrefs,
} from '../lib/bgRemover'
import { markImageDownloaded, triggerImageDownload } from '../lib/downloadedImages'
import { formatDuration, imageJobStatusLabel } from '../lib/imggen'

const POLL_INTERVAL_MS = 3000
const LIST_REFRESH_INTERVAL_MS = 5000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

export default function BgRemoverPage() {
  const { token } = useAuth()
  const { refreshRunningImageJobs, setForegroundJob } = useProgress()

  const [caps, setCaps] = useState<BgRemoverCapabilities | null>(null)
  const [capsLoading, setCapsLoading] = useState(true)
  // Last-used model + options; a stale model is ignored once it is no longer online.
  const [selectedBase, setSelectedBase] = useState<string | null>(() => readBgRemoverPrefs().model ?? null)
  const [options, setOptions] = useState<BgRemoverOptions>(() => ({
    ...DEFAULT_BG_OPTIONS,
    ...readBgRemoverPrefs().options,
  }))

  const images = useImageSet(token)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [jobs, setJobs] = useState<BgRemoverJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(BGREMOVER_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<BgRemoverJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState(false)

  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)

  const viewingJob = activePanel !== BGREMOVER_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const capabilities = caps?.capabilities ?? []
  const activeCap =
    capabilities.find(c => c.base === selectedBase) ??
    capabilities.find(c => c.model === caps?.default_model) ??
    capabilities[0] ??
    null
  const activeBase = activeCap?.base ?? null
  const optionsError = bgOptionsError(options)

  // ⌘/Ctrl+V of images adds them as inputs (only on the form, not while the picker is up).
  usePasteImages(images.addFiles, !viewingJob && !pickerOpen)

  useEffect(() => {
    writeBgRemoverPrefs({ model: activeBase ?? '', options })
  }, [activeBase, options])

  const loadCaps = useCallback(async () => {
    if (!token) return
    setCapsLoading(true)
    try {
      setCaps(await listBgRemoverCapabilities(token))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCapsLoading(false)
    }
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      setJobs(await listBgRemoverJobs(token))
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
      void loadCaps()
      void loadJobs()
    })()
  }, [loadCaps, loadJobs])

  const patchOptions = useCallback(
    (patch: Partial<BgRemoverOptions>) => setOptions(prev => ({ ...prev, ...patch })),
    [],
  )

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getBgRemoverJob(token, jobId)
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
    setActivePanel(BGREMOVER_NEW_PANEL)
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

  /** Back to the form with this job's picture, model and settings, to iterate on the result. */
  function adjustAndRerun(job: BgRemoverJob) {
    images.clear()
    if (job.input_image) images.addStored([job.input_image])
    setOptions({ ...DEFAULT_BG_OPTIONS, ...job.options })
    setSelectedBase(job.capability)
    setError(null)
    setActivePanel(BGREMOVER_NEW_PANEL)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || submitting || !canSubmit || !activeBase) return

    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    // One job per image, sharing the model and options. Images leave the set as their
    // job is accepted, so after a failure only the rest remain.
    const targets = images.ready
    let lastJobId: string | null = null
    let submitted = 0
    try {
      for (const target of targets) {
        const res = await startBgRemoverJob(token, {
          capability: activeBase,
          input_image_id: target.uploaded!.image_id,
          options,
        })
        images.remove(target.key)
        lastJobId = res.job_id
        submitted++
      }
    } catch (err) {
      const message = (err as Error).message
      setError(
        submitted > 0 ? `Submitted ${submitted} of ${targets.length} jobs, then failed: ${message}` : message,
      )
    }
    try {
      if (lastJobId) {
        void refreshRunningImageJobs()
        await loadJobs()
        // Everything went through → show the newest job; otherwise stay on the form
        // (with the error and the images still to do) and let the sidebar list the rest.
        if (submitted === targets.length) {
          setActivePanel(lastJobId)
          await refreshJob(lastJobId)
        }
      }
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
        const job = await pollBgRemoverJob(token, jobId)
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
      await cancelBgRemoverJob(token, jobId)
      void refreshRunningImageJobs()
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
      const res = await retryBgRemoverJob(token, jobId)
      setActivePanel(res.job_id)
      void refreshRunningImageJobs()
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
      await deleteBgRemoverJob(token, jobId)
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

  // Auto-poll while viewing a non-terminal job. The shell's background loop
  // (Progress drawer) skips this job meanwhile, so it isn't polled twice.
  useEffect(() => {
    if (!token || !viewedJobId) return
    const status = selectedJob?.status
    if (status && TERMINAL.has(status)) return
    setForegroundJob('bg-remover', viewedJobId)
    const id = window.setInterval(() => {
      void onPollNow(viewedJobId)
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(id)
      setForegroundJob('bg-remover', null)
    }
  }, [token, viewedJobId, selectedJob?.status, onPollNow, setForegroundJob])

  // The poll above only advances the job being *viewed*. Other in-flight jobs are driven
  // to completion by the backend worker, so the sidebar just re-reads them (a plain DB
  // listing, no OffloadMQ round trip) at a slower interval.
  const hasPendingJobs = jobs.some(j => !TERMINAL.has(j.status))
  useEffect(() => {
    if (!token || !hasPendingJobs) return
    const id = window.setInterval(() => {
      void loadJobs()
    }, LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, hasPendingJobs, loadJobs])

  const canSubmit =
    activeBase != null && images.ready.length > 0 && !images.uploading && !optionsError && !submitting

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const isViewedLoaded = selectedJob != null && selectedJob.job_id === viewedJobId
  const executionSeconds =
    selectedJob?.started_at && !isRunning
      ? (Date.parse(selectedJob.updated_at) - Date.parse(selectedJob.started_at)) / 1000
      : null
  const canRetry = status === 'failed' || status === 'canceled'
  const outputImage = selectedJob?.output_image ?? null
  const inputImage = selectedJob?.input_image ?? null
  const canDownload = status === 'completed' && outputImage != null && isViewedLoaded
  const canCompare = outputImage != null && inputImage != null
  const warning = selectedJob ? foregroundWarning(selectedJob) : null

  const downloadJobOutput = useCallback(() => {
    if (!token || !outputImage || !canDownload) return
    triggerImageDownload(imageFileUrl(outputImage.image_id, token), outputImage.filename)
    markImageDownloaded(outputImage.image_id)
  }, [token, outputImage, canDownload])

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
      data-testid="bgremover-page"
    >
      <ToolSidebar
        title="Cutouts"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="bgremover-sidebar"
      >
        <BgRemoverHistorySidebar
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
            {viewingJob && selectedJob ? 'Background removal' : 'New cutout'}
          </h1>
          {viewingJob && selectedJob ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete cutout"
              aria-label="Delete cutout"
              data-testid="bgremover-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          ) : null}
          {viewingJob && canDownload ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={downloadJobOutput}
              title="Download cutout"
              aria-label="Download cutout"
              data-testid="bgremover-download-job"
            >
              <Download className="size-4" />
            </Button>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === BGREMOVER_NEW_PANEL && (
              <section data-testid="bgremover-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Eraser className="h-4 w-4 text-emerald-500" />
                    Background Remover
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Cut the subject out of a picture — a transparent PNG, or a flat colour behind it.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <ImageSetSlot
                    label="Images"
                    hint="PNG, JPEG, WebP or GIF — one cutout per image"
                    entries={images.entries}
                    note={images.note}
                    max={images.max}
                    testId="bgremover-input"
                    onAddFiles={images.addFiles}
                    onPickFromLibrary={() => setPickerOpen(true)}
                    onRemove={images.remove}
                    onClear={images.clear}
                  />

                  <BgRemoverControls
                    capabilities={capabilities}
                    loading={capsLoading}
                    selectedBase={activeBase}
                    onSelectModel={setSelectedBase}
                    onRefresh={() => void loadCaps()}
                    options={options}
                    onChange={patchOptions}
                    error={optionsError}
                  />

                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="min-h-11 w-full"
                    data-testid="bgremover-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <Eraser className="mr-2 size-4" />
                        Remove background
                        {images.ready.length > 1 ? ` from ${images.ready.length} images` : ''}
                      </>
                    )}
                  </Button>

                  {error ? <JobErrorBanner message={error} testId="bgremover-error" /> : null}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="bgremover-job-detail" className="space-y-4">
                {error ? <JobErrorBanner message={error} testId="bgremover-job-error" /> : null}
                {/* Keep the spinner up while a *different* job is still loading, so
                    switching panels never flashes the "could not load" fallback. */}
                {jobDetailLoading && !isViewedLoaded ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && isViewedLoaded ? (
                  <>
                    {compareMode && canCompare && token ? (
                      <div
                        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border"
                        data-testid="bgremover-compare-view"
                      >
                        {([
                          ['Before', inputImage!, 'bgremover-compare-input', false],
                          ['After', outputImage!, 'bgremover-compare-output', true],
                        ] as const).map(([caption, image, testId, cutout]) => (
                          <div
                            key={testId}
                            className={`relative overflow-hidden ${cutout ? 'bg-checkerboard' : 'bg-muted/30'}`}
                          >
                            <span className="absolute left-2 top-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                              {caption}
                            </span>
                            <ImageLightbox
                              src={imageFileUrl(image.image_id, token)}
                              alt={image.filename}
                              triggerClassName="group block w-full overflow-hidden"
                              testId={testId}
                              allowDownload={cutout && canDownload}
                            >
                              <img
                                src={imageFileUrl(image.image_id, token)}
                                alt=""
                                aria-hidden
                                className="max-h-[40dvh] w-full object-contain sm:max-h-[60vh]"
                              />
                            </ImageLightbox>
                          </div>
                        ))}
                      </div>
                    ) : outputImage && token ? (
                      <ImageLightbox
                        src={imageFileUrl(outputImage.image_id, token)}
                        alt={outputImage.filename}
                        caption={`${outputImage.filename} — ${outputImage.width}×${outputImage.height}`}
                        triggerClassName="group block w-full overflow-hidden rounded-xl bg-checkerboard"
                        testId="bgremover-job-image"
                        allowDownload={canDownload}
                      >
                        <img
                          src={imageFileUrl(outputImage.image_id, token)}
                          alt=""
                          aria-hidden
                          className="max-h-[60vh] w-full object-contain"
                        />
                      </ImageLightbox>
                    ) : inputImage && token ? (
                      <div className="overflow-hidden rounded-xl bg-muted/30">
                        <img
                          src={imageFileUrl(inputImage.image_id, token)}
                          alt="Input"
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="bgremover-job-image"
                        />
                      </div>
                    ) : null}

                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold">
                        {modelLabel(selectedJob.model)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {selectedJob.capability} · {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                      <p className="text-xs text-muted-foreground" data-testid="bgremover-options-summary">
                        {describeBgOptions(selectedJob.options)}
                        {inputImage ? ` · ${inputImage.width}×${inputImage.height}` : ''}
                        {outputImage ? ` → ${outputImage.width}×${outputImage.height}` : ''}
                      </p>
                      {!isRunning && (
                        <p className="font-mono text-xs text-muted-foreground" data-testid="bgremover-job-timing">
                          Execution time:{' '}
                          {executionSeconds != null && Number.isFinite(executionSeconds) && executionSeconds >= 0
                            ? formatDuration(executionSeconds)
                            : 'Unavailable'}
                        </p>
                      )}
                    </div>

                    {warning ? (
                      <p
                        className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                        data-testid="bgremover-warning"
                      >
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                        {warning}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => adjustAndRerun(selectedJob)}
                        data-testid="bgremover-adjust"
                      >
                        <Settings2 className="mr-1 h-4 w-4" />
                        Adjust &amp; re-run
                      </Button>
                      {canCompare ? (
                        <Button
                          type="button"
                          variant={compareMode ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setCompareMode(v => !v)}
                          data-testid="bgremover-compare-toggle"
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
                          data-testid="bgremover-retry-job"
                        >
                          {retrying ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 h-4 w-4" />
                          )}
                          Retry
                        </Button>
                      ) : null}
                      {isRunning ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void onPollNow(selectedJob.job_id)}
                            disabled={polling}
                            data-testid="bgremover-poll-job"
                          >
                            {polling ? (
                              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1 h-4 w-4" />
                            )}
                            Poll now
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void onCancel(selectedJob.job_id)}
                            disabled={canceling}
                            data-testid="bgremover-cancel-job"
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
                        testId="bgremover-job-failed"
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
                          // The task is created and submitted in one request, so
                          // `created_at` is the queue entry.
                          submittedAt={selectedJob.created_at}
                          label={imageJobStatusLabel(selectedJob.status)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    Could not load this cutout.
                  </p>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {token && (
        <ImagePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelectMany={images.addStored}
          token={token}
        />
      )}
    </div>
  )
}
