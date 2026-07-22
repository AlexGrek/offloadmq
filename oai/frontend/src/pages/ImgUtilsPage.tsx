import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ImageUp,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import {
  cancelImgUtilsJob,
  deleteImgUtilsJob,
  getImgUtilsJob,
  listImgUtilsCapabilities,
  listImgUtilsJobs,
  pollImgUtilsJob,
  retryImgUtilsJob,
  startImgUtilsJob,
  utilityLabel,
  type ImgUtilCapability,
  type ImgUtilsJob,
} from '../api/imgUtils'
import { imageFileUrl, uploadImage, type UploadedImage } from '../api/images'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import {
  IMGUTILS_NEW_PANEL,
  ImgUtilsHistorySidebar,
} from '../components/imgutils/ImgUtilsHistorySidebar'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

/** One upload slot: local preview while the file uploads, then the stored image. */
type Slot = {
  preview: string
  uploaded: UploadedImage | null
  error: string | null
}

/** Short blurb per known utility; unknown ones fall back to a generic line. */
const UTILITY_HINTS: Record<string, string> = {
  depth: 'Estimate a depth map from the image.',
  face_swap: 'Replace the face in the target image with the face from the reference image.',
}

function utilityHint(utility: string): string {
  return UTILITY_HINTS[utility] ?? 'Run this ComfyUI transform on the uploaded image.'
}

export default function ImgUtilsPage() {
  const { token } = useAuth()

  const [capabilities, setCapabilities] = useState<ImgUtilCapability[]>([])
  const [capsLoading, setCapsLoading] = useState(true)
  const [selectedCap, setSelectedCap] = useState<string>('')

  const [input, setInput] = useState<Slot | null>(null)
  const [source, setSource] = useState<Slot | null>(null)

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

  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  // Mobile: the sidebar is a full-screen overlay — collapse it on entering a narrow viewport.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

  const previewsRef = useRef<string[]>([])
  useEffect(() => {
    return () => {
      previewsRef.current.forEach(URL.revokeObjectURL)
    }
  }, [])

  const viewingJob = activePanel !== IMGUTILS_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const activeCap = capabilities.find(c => c.base === selectedCap) ?? null
  const needsSource = activeCap?.needs_source_image ?? false

  const loadCapabilities = useCallback(async () => {
    if (!token) return
    setCapsLoading(true)
    try {
      const res = await listImgUtilsCapabilities(token)
      setCapabilities(res.capabilities)
      setSelectedCap(prev =>
        res.capabilities.some(c => c.base === prev) ? prev : (res.capabilities[0]?.base ?? ''),
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
        capability: selectedCap,
        input_image_id: input!.uploaded!.image_id,
        source_image_id: needsSource ? source!.uploaded!.image_id : undefined,
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
  const canSubmit =
    Boolean(selectedCap) && inputReady && (!needsSource || sourceReady) && !submitting

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'
  const shownImageId = selectedJob?.output_image_id ?? selectedJob?.input_image_id ?? null

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
            {viewingJob && selectedJob ? utilityLabel(selectedJob.utility) : 'New transform'}
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
                    One-shot ComfyUI transforms — no prompt, just images in and an image out.
                  </p>
                </header>

                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {capsLoading
                      ? 'Checking agents…'
                      : capabilities.length === 0
                        ? 'No img-utils.* capability online — check OffloadMQ agents'
                        : `${capabilities.length} tool(s) online`}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    onClick={() => void loadCapabilities()}
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
                      {capabilities.map(cap => (
                        <button
                          key={cap.base}
                          type="button"
                          onClick={() => setSelectedCap(cap.base)}
                          className={cn(
                            'rounded-lg px-3 py-2 text-sm transition-colors',
                            cap.base === selectedCap
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                          )}
                          data-testid={`imgutils-tool-${cap.utility}`}
                        >
                          {utilityLabel(cap.utility)}
                        </button>
                      ))}
                    </div>
                    {activeCap ? (
                      <p className="text-xs text-muted-foreground">
                        {utilityHint(activeCap.utility)}{' '}
                        <code className="text-[11px]">{activeCap.base}</code>
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
                    onClear={() => {
                      if (input) URL.revokeObjectURL(input.preview)
                      setInput(null)
                    }}
                  />

                  {needsSource ? (
                    <ImageSlot
                      label="Face reference"
                      hint="The face to transfer onto the target"
                      slot={source}
                      testId="imgutils-source"
                      onPick={file => void pickFile(file, setSource)}
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
                        Run {activeCap ? utilityLabel(activeCap.utility) : 'transform'}
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
                    {shownImageId && token ? (
                      <div className="overflow-hidden rounded-xl bg-muted/30">
                        <img
                          src={imageFileUrl(shownImageId, token)}
                          alt={selectedJob.output_image_id ? 'Result' : 'Input'}
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="imgutils-job-image"
                        />
                      </div>
                    ) : null}

                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold">
                        {utilityLabel(selectedJob.utility)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {selectedJob.capability} · {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
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
                      <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {selectedJob.stage || selectedJob.status || 'Running…'}
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
    </div>
  )
}

type ImageSlotProps = {
  label: string
  hint: string
  slot: Slot | null
  testId: string
  onPick: (file: File) => void
  onClear: () => void
}

function ImageSlot({ label, hint, slot, testId, onPick, onClear }: ImageSlotProps) {
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
      )}
    </div>
  )
}
