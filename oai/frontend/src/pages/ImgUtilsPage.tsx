import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Columns2,
  FolderOpen,
  ImageUp,
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
  X,
} from 'lucide-react'
import {
  cancelImgUtilsJob,
  defaultResizeForm,
  deleteImgUtilsJob,
  describeResizeOptions,
  getImgUtilsJob,
  listImgUtilsCapabilities,
  listImgUtilsJobs,
  pollImgUtilsJob,
  prettyLabel,
  resizeFormError,
  resizeOptionsFromForm,
  retryImgUtilsJob,
  startImgUtilsJob,
  takesScaleMultiplier,
  toolKey,
  toolsFromCapabilities,
  DEFAULT_SCALE_MULTIPLIER,
  MAX_SCALE_MULTIPLIER,
  MIN_SCALE_MULTIPLIER,
  RESIZE_WORKFLOW,
  type ImgUtilsRouteState,
  type ImgUtilTool,
  type ImgUtilsJob,
  type JobImageRef,
  type ResizeFormState,
} from '../api/imgUtils'
import { imageFileUrl, uploadImage, type UploadedImage } from '../api/images'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import {
  IMGUTILS_NEW_PANEL,
  ImgUtilsHistorySidebar,
} from '../components/imgutils/ImgUtilsHistorySidebar'
import ResizeControls from '../components/imgutils/ResizeControls'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { ImageLightbox, type ImageLightboxActions } from '../components/ImageLightbox'
import { NudeDetectModal } from '../components/nudedetect/NudeDetectModal'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import { imageJobStatusLabel, type ImggenRouteState } from '../lib/imggen'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

/** One upload slot: local preview while the file uploads, then the stored image. */
type Slot = {
  preview: string
  uploaded: UploadedImage | null
  error: string | null
}

/** Short blurb per known operation; unknown ones fall back to a generic line.
 *  Keyed on the operation (`depth`), not the pack directory — packs are named
 *  after the model (`image_lotus_depth_v1_1`). */
const OPERATION_HINTS: Record<string, string> = {
  depth: 'Estimate a depth map from the image.',
  face_swap: 'Replace the face in the target image with the face from the reference image.',
  upscale: 'Upscale the image with SeedVR2 by the chosen multiplier.',
  [RESIZE_WORKFLOW]:
    'Scale the image with Pillow — no GPU or ComfyUI needed, so any online agent can run it.',
}

function operationHint(workflow: string): string {
  return OPERATION_HINTS[workflow] ?? 'Run this ComfyUI transform on the uploaded image.'
}

export default function ImgUtilsPage() {
  const { token } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [tools, setTools] = useState<ImgUtilTool[]>([])
  const [capsLoading, setCapsLoading] = useState(true)
  const [selectedTool, setSelectedTool] = useState<string>('')

  const [input, setInput] = useState<Slot | null>(null)
  const [source, setSource] = useState<Slot | null>(null)
  const [pickerTarget, setPickerTarget] = useState<'input' | 'source' | null>(null)
  // Only meaningful for the built-in resize tool; kept across tool switches so
  // flipping back and forth does not lose the settings.
  const [resizeForm, setResizeForm] = useState<ResizeFormState>(() => defaultResizeForm([]))
  // Only meaningful for upscale tools; kept across tool switches like resizeForm.
  const [scaleMultiplier, setScaleMultiplier] = useState<number>(DEFAULT_SCALE_MULTIPLIER)

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

  const previewsRef = useRef<string[]>([])
  useEffect(() => {
    return () => {
      previewsRef.current.forEach(URL.revokeObjectURL)
    }
  }, [])

  const viewingJob = activePanel !== IMGUTILS_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const activeTool = useMemo(
    () => tools.find(t => toolKey(t) === selectedTool) ?? null,
    [tools, selectedTool],
  )
  const needsSource = activeTool?.needsSourceImage ?? false
  const takesScale = activeTool?.takesScale ?? false
  const isResize = activeTool?.kind === 'resize'

  // Agents publish their resampling filters in the capability brackets, so a
  // stored choice can go stale when the tool — or the agent behind it — changes.
  // Reconciled on read rather than written back, so no render cascade.
  const resizeState = useMemo<ResizeFormState>(() => {
    const methods = activeTool?.methods ?? []
    const method =
      resizeForm.method && methods.includes(resizeForm.method)
        ? resizeForm.method
        : defaultResizeForm(methods).method
    return method === resizeForm.method ? resizeForm : { ...resizeForm, method }
  }, [resizeForm, activeTool])

  const loadCapabilities = useCallback(async () => {
    if (!token) return
    // `capsLoading` starts true and the Refresh button flips it back on, so the
    // spinner is already showing whenever this runs — no synchronous setState here
    // (which, inside the mount effect, would be a cascading render).
    try {
      const res = await listImgUtilsCapabilities(token)
      const next = toolsFromCapabilities(res.capabilities)
      setTools(next)
      setSelectedTool(prev =>
        next.some(t => toolKey(t) === prev) ? prev : (next[0] ? toolKey(next[0]) : ''),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCapsLoading(false)
    }
  }, [token])

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
    void loadCapabilities()
    void loadJobs()
  }, [loadCapabilities, loadJobs])

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

  async function pickFile(file: File, setSlot: (slot: Slot | null) => void) {
    if (!token) return
    const preview = URL.createObjectURL(file)
    previewsRef.current.push(preview)
    setSlot({ preview, uploaded: null, error: null })
    setError(null)
    try {
      const uploaded = await uploadImage(token, file)
      setSlot({ preview, uploaded, error: null })
    } catch (e) {
      setSlot({ preview, uploaded: null, error: (e as Error).message })
    }
  }

  function pickFromLibrary(image: UploadedImage, setSlot: (slot: Slot | null) => void) {
    if (!token) return
    setSlot({ preview: imageFileUrl(image.image_id, token), uploaded: image, error: null })
    setError(null)
  }

  /** Feed an image back into this page's New-transform form (lightbox "Image Tools"). */
  function applyAsInput(image: UploadedImage) {
    pickFromLibrary(image, setInput)
    setSource(null)
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
            onSendToImgUtils: () => applyAsInput(image),
            onNudeDetect: () =>
              setNudeDetectTarget({ imageId: image.image_id, filename: image.filename }),
          }
        : undefined,
    // `applyAsInput` only touches setState, so it needs no dependency tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, onImageMutated, sendToImggen],
  )

  // Deep link from another page (lightbox "Image Tools", generation results) —
  // land on the New transform panel with the image preloaded as input. The image
  // is consumed during render (gated by a ref so it fires once per navigation);
  // the effect only clears the one-shot router state, which can't run in render.
  // Keeping the setState out of the effect avoids a cascading render.
  const deepLinkImage = token
    ? ((location.state as ImgUtilsRouteState | null)?.useInputImage ?? null)
    : null
  const [consumedDeepLink, setConsumedDeepLink] = useState<string | null>(null)
  if (!deepLinkImage) {
    // Router state cleared (below) — arm for the next navigation, incl. the same image.
    if (consumedDeepLink !== null) setConsumedDeepLink(null)
  } else if (consumedDeepLink !== deepLinkImage.image_id && token) {
    setConsumedDeepLink(deepLinkImage.image_id)
    setInput({
      preview: imageFileUrl(deepLinkImage.image_id, token),
      uploaded: deepLinkImage,
      error: null,
    })
    setError(null)
    setActivePanel(IMGUTILS_NEW_PANEL)
  }
  useEffect(() => {
    if (deepLinkImage) navigate(location.pathname, { replace: true, state: null })
  }, [deepLinkImage, location.pathname, navigate])

  function clearSlots() {
    for (const slot of [input, source]) {
      if (slot) URL.revokeObjectURL(slot.preview)
    }
    previewsRef.current = []
    setInput(null)
    setSource(null)
  }

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
        input_image_id: input!.uploaded!.image_id,
        source_image_id: needsSource ? source!.uploaded!.image_id : undefined,
        // Resize carries its resize params here; upscale carries its multiplier;
        // depth/face_swap have no knobs from the UI.
        options: isResize
          ? resizeOptionsFromForm(resizeState)
          : takesScale
            ? { scale_multiplier: scaleMultiplier }
            : undefined,
      })
      clearSlots()
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

  const inputReady = Boolean(input?.uploaded && !input.error)
  const sourceReady = Boolean(source?.uploaded && !source.error)
  const resizeError = isResize ? resizeFormError(resizeState) : null
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

                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {capsLoading
                      ? 'Checking agents…'
                      : tools.length === 0
                        ? 'No image tools online — check OffloadMQ agents'
                        : `${tools.length} tool(s) online`}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setCapsLoading(true)
                      void loadCapabilities()
                    }}
                    disabled={capsLoading}
                    data-testid="imgutils-refresh-capabilities"
                  >
                    <RefreshCw className={cn('size-3', capsLoading && 'animate-spin')} />
                    Refresh
                  </button>
                </div>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <div className="space-y-1.5" data-testid="imgutils-tool-picker">
                    <Label>Tool</Label>
                    <div className="flex flex-wrap gap-2">
                      {tools.map(tool => {
                        const key = toolKey(tool)
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedTool(key)}
                            className={cn(
                              'rounded-lg px-3 py-2 text-left text-sm transition-colors',
                              key === selectedTool
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                            )}
                            data-testid={`imgutils-tool-${tool.workflow}`}
                          >
                            <span className="block">{prettyLabel(tool.workflow)}</span>
                            <span className="block truncate text-[10px] opacity-70">
                              {tool.pack}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    {activeTool ? (
                      <p className="text-xs text-muted-foreground">
                        {operationHint(activeTool.workflow)}{' '}
                        <code className="text-[11px]">{activeTool.capability}</code>
                      </p>
                    ) : null}
                  </div>

                  <ImageSlot
                    label={needsSource ? 'Target image' : 'Image'}
                    hint={
                      needsSource
                        ? 'The photo whose face gets replaced'
                        : 'PNG, JPEG, WebP or GIF'
                    }
                    slot={input}
                    testId="imgutils-input"
                    onPick={file => void pickFile(file, setInput)}
                    onPickFromLibrary={() => setPickerTarget('input')}
                    onClear={() => {
                      if (input) URL.revokeObjectURL(input.preview)
                      setInput(null)
                    }}
                  />

                  {isResize ? (
                    <ResizeControls
                      state={resizeState}
                      onChange={patch => setResizeForm(prev => ({ ...prev, ...patch }))}
                      methods={activeTool?.methods ?? []}
                      inputSize={
                        input?.uploaded
                          ? { width: input.uploaded.width, height: input.uploaded.height }
                          : null
                      }
                      error={resizeError}
                    />
                  ) : null}

                  {takesScale ? (
                    <div
                      className="space-y-2 rounded-xl border border-border p-3"
                      data-testid="imgutils-scale"
                    >
                      <Label htmlFor="imgutils-scale-input">Scale multiplier</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        {[2, 4, 6, 8].map(preset => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setScaleMultiplier(preset)}
                            className={cn(
                              'rounded-md px-3 py-1.5 text-sm transition-colors',
                              scaleMultiplier === preset
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                            )}
                            data-testid={`imgutils-scale-preset-${preset}`}
                          >
                            {preset}×
                          </button>
                        ))}
                        <Input
                          id="imgutils-scale-input"
                          type="number"
                          min={MIN_SCALE_MULTIPLIER}
                          max={MAX_SCALE_MULTIPLIER}
                          step={1}
                          value={scaleMultiplier}
                          onChange={e => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n)) {
                              setScaleMultiplier(
                                Math.min(MAX_SCALE_MULTIPLIER, Math.max(MIN_SCALE_MULTIPLIER, n)),
                              )
                            }
                          }}
                          className="h-9 w-24"
                          data-testid="imgutils-scale-value"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Output is roughly {scaleMultiplier}× the input on each edge.
                      </p>
                    </div>
                  ) : null}

                  {needsSource ? (
                    <ImageSlot
                      label="Face reference"
                      hint="The face to transfer onto the target"
                      slot={source}
                      testId="imgutils-source"
                      onPick={file => void pickFile(file, setSource)}
                      onPickFromLibrary={() => setPickerTarget('source')}
                      onClear={() => {
                        if (source) URL.revokeObjectURL(source.preview)
                        setSource(null)
                      }}
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
            pickFromLibrary(image, pickerTarget === 'source' ? setSource : setInput)
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

type ImageSlotProps = {
  label: string
  hint: string
  slot: Slot | null
  testId: string
  onPick: (file: File) => void
  onPickFromLibrary: () => void
  onClear: () => void
}

function ImageSlot({
  label,
  hint,
  slot,
  testId,
  onPick,
  onPickFromLibrary,
  onClear,
}: ImageSlotProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files: FileList | null) {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'))
    if (file) onPick(file)
  }

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <Label>{label}</Label>
      {slot ? (
        <div className="flex items-start gap-3">
          <div className="relative w-24">
            <img src={slot.preview} alt="" className="size-24 rounded-lg object-cover" />
            {!slot.uploaded && !slot.error ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : null}
            <button
              type="button"
              className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground"
              onClick={onClear}
              aria-label={`Remove ${label}`}
              data-testid={`${testId}-clear`}
            >
              <X className="size-3" />
            </button>
          </div>
          {slot.error ? (
            <p className="text-xs text-destructive">{slot.error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <label
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 px-6 py-8 text-muted-foreground transition-colors hover:bg-muted/70',
              dragOver && 'bg-primary/5 ring-2 ring-primary/30',
            )}
            onDragOver={e => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault()
              setDragOver(false)
              handleFiles(e.dataTransfer.files)
            }}
            data-testid={`${testId}-drop-zone`}
          >
            <ImageUp className="size-7 text-muted-foreground/60" />
            <span className="text-sm font-medium">Click or drag an image here</span>
            <span className="text-xs">{hint}</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onPickFromLibrary}
            data-testid={`${testId}-pick-library`}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            From library
          </Button>
        </div>
      )}
    </div>
  )
}
