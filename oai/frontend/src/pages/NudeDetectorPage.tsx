import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ImageUp,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  cancelNudeDetectJob,
  deleteNudeDetectJob,
  getNudeDetectAvailability,
  getNudeDetectJob,
  listNudeDetectJobs,
  pollNudeDetectJob,
  retryNudeDetectJob,
  startNudeDetectJob,
  type NudeDetectJob,
} from '../api/nudeDetect'
import { imageFileUrl, uploadImage, type UploadedImage } from '../api/images'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import {
  NUDEDETECT_NEW_PANEL,
  NudeDetectHistorySidebar,
} from '../components/nudedetect/NudeDetectHistorySidebar'
import { NudeDetectResultsList } from '../components/nudedetect/NudeDetectResultView'
import { useAuth } from '../contexts/AuthContext'
import { DEFAULT_NUDENET_THRESHOLD, totalDetectionCount } from '../lib/nudeDetectLabels'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

type PendingUpload = {
  file: File
  preview: string
  uploaded: UploadedImage | null
  error: string | null
}

export default function NudeDetectorPage() {
  const { token } = useAuth()

  const [available, setAvailable] = useState<boolean | null>(null)
  const [availLoading, setAvailLoading] = useState(true)

  const [threshold, setThreshold] = useState(DEFAULT_NUDENET_THRESHOLD)
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [jobs, setJobs] = useState<NudeDetectJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(NUDEDETECT_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<NudeDetectJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const previewsRef = useRef<string[]>([])

  const viewingJob = activePanel !== NUDEDETECT_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const loadAvailability = useCallback(() => {
    if (!token) return
    setAvailLoading(true)
    getNudeDetectAvailability(token)
      .then(r => setAvailable(r.available))
      .catch(() => setAvailable(false))
      .finally(() => setAvailLoading(false))
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listNudeDetectJobs(token)
      setJobs(list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    loadAvailability()
    void loadJobs()
  }, [loadAvailability, loadJobs])

  useEffect(() => {
    return () => {
      previewsRef.current.forEach(URL.revokeObjectURL)
    }
  }, [])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getNudeDetectJob(token, jobId)
      setSelectedJob(job)
      setJobs(prev => {
        const idx = prev.findIndex(j => j.job_id === job.job_id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = job
          return next
        }
        return [job, ...prev]
      })
      return job
    },
    [token],
  )

  function selectNew() {
    setActivePanel(NUDEDETECT_NEW_PANEL)
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

  function clearPending() {
    pending.forEach(p => URL.revokeObjectURL(p.preview))
    previewsRef.current = []
    setPending([])
  }

  function removePending(idx: number) {
    setPending(prev => {
      URL.revokeObjectURL(prev[idx].preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  async function addFiles(files: FileList | File[]) {
    if (!token) return
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (!imageFiles.length) return

    const entries: PendingUpload[] = imageFiles.map(file => ({
      file,
      preview: URL.createObjectURL(file),
      uploaded: null,
      error: null,
    }))
    previewsRef.current.push(...entries.map(e => e.preview))
    setPending(prev => [...prev, ...entries])

    setUploading(true)
    setError(null)
    for (let i = 0; i < entries.length; i++) {
      const file = entries[i].file
      try {
        const uploaded = await uploadImage(token, file)
        setPending(prev =>
          prev.map(p => (p.file === file ? { ...p, uploaded } : p)),
        )
      } catch (e) {
        setPending(prev =>
          prev.map(p =>
            p.file === file ? { ...p, error: (e as Error).message } : p,
          ),
        )
      }
    }
    setUploading(false)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || submitting) return
    const ready = pending.filter(p => p.uploaded && !p.error)
    if (!ready.length || !available) return

    setError(null)
    setSubmitting(true)
    try {
      let firstJobId: string | null = null
      for (const item of ready) {
        const res = await startNudeDetectJob(token, {
          image_id: item.uploaded!.image_id,
          threshold,
        })
        if (!firstJobId) firstJobId = res.job_id
      }
      clearPending()
      if (firstJobId) {
        setActivePanel(firstJobId)
        await refreshJob(firstJobId)
        await loadJobs()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function onPollNow(jobId: string) {
    if (!token) return
    setPolling(true)
    setError(null)
    try {
      const job = await pollNudeDetectJob(token, jobId)
      setSelectedJob(job)
      setJobs(prev => prev.map(j => (j.job_id === job.job_id ? job : j)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPolling(false)
    }
  }

  async function onCancel(jobId: string) {
    if (!token) return
    setCanceling(true)
    setError(null)
    try {
      await cancelNudeDetectJob(token, jobId)
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
      const res = await retryNudeDetectJob(token, jobId)
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
      await deleteNudeDetectJob(token, jobId)
      setJobs(prev => {
        const next = prev.filter(j => j.job_id !== jobId)
        if (next.length > 0) {
          void selectJob(next[0].job_id)
        } else {
          selectNew()
          setSelectedJob(null)
        }
        return next
      })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, viewedJobId, selectedJob?.status])

  const readyCount = pending.filter(p => p.uploaded && !p.error).length
  const canSubmit = Boolean(readyCount > 0 && available && !submitting && !uploading)

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="nudedetect-page"
    >
      <aside
        className={cn(
          'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200',
          sidebarOpen ? 'w-64' : 'w-0',
        )}
        data-testid="nudedetect-sidebar"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-sm font-semibold text-sidebar-foreground">Scans</span>
        </div>
        <NudeDetectHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          token={token}
          loading={jobsLoading}
          onSelectNew={selectNew}
          onSelectJob={jobId => void selectJob(jobId)}
        />
      </aside>

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
            {viewingJob && selectedJob
              ? `Scan · ${selectedJob.threshold.toFixed(2)}`
              : 'New scan'}
          </h1>
          {viewingJob && selectedJob ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete scan"
              aria-label="Delete scan"
              data-testid="nudedetect-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === NUDEDETECT_NEW_PANEL && (
              <section data-testid="nudedetect-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <ShieldAlert className="h-4 w-4 text-amber-500" />
                    Nude Detector
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Upload one or more images and run NudeNet NSFW detection with a tunable
                    confidence threshold.
                  </p>
                </header>

                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {availLoading ? (
                      'Checking agent…'
                    ) : available ? (
                      <>
                        Agent online · <code className="text-[11px]">onnx.nudenet</code>
                      </>
                    ) : (
                      'onnx.nudenet not available — check OffloadMQ agents'
                    )}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    onClick={loadAvailability}
                    disabled={availLoading}
                    data-testid="nudedetect-refresh-availability"
                  >
                    <RefreshCw className={cn('size-3', availLoading && 'animate-spin')} />
                    Refresh
                  </button>
                </div>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <div className="space-y-1.5" data-testid="nudedetect-threshold">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="nudedetect-threshold">Confidence threshold</Label>
                      <span className="font-mono text-xs text-muted-foreground">
                        {threshold.toFixed(2)}
                      </span>
                    </div>
                    <input
                      id="nudedetect-threshold"
                      type="range"
                      min={0.05}
                      max={0.95}
                      step={0.05}
                      value={threshold}
                      onChange={e => setThreshold(parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1.5" data-testid="nudedetect-upload">
                    <Label>Images</Label>
                    {pending.length > 0 ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {pending.map((item, idx) => (
                            <div key={item.preview} className="relative w-20">
                              <img
                                src={item.preview}
                                alt=""
                                className="size-20 rounded-lg object-cover"
                              />
                              {!item.uploaded && !item.error ? (
                                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                                  <Loader2 className="size-4 animate-spin" />
                                </div>
                              ) : null}
                              <button
                                type="button"
                                className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground"
                                onClick={() => removePending(idx)}
                                aria-label="Remove"
                              >
                                <X className="size-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={e => {
                              if (e.target.files?.length) void addFiles(e.target.files)
                              e.target.value = ''
                            }}
                          />
                          Add more images
                        </label>
                      </div>
                    ) : (
                      <label
                        className={cn(
                          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 px-6 py-10 text-muted-foreground transition-colors hover:bg-muted/70',
                          dragOver && 'bg-primary/5 ring-2 ring-primary/30',
                        )}
                        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={e => {
                          e.preventDefault()
                          setDragOver(false)
                          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
                        }}
                        data-testid="nudedetect-drop-zone"
                      >
                        <ImageUp className="size-8 text-muted-foreground/60" />
                        <span className="text-sm font-medium">Click or drag images here</span>
                        <span className="text-xs">PNG, JPEG, WebP, GIF — multiple files OK</span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={e => {
                            if (e.target.files?.length) void addFiles(e.target.files)
                            e.target.value = ''
                          }}
                        />
                      </label>
                    )}
                  </div>

                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full min-h-11"
                    data-testid="nudedetect-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="mr-2 size-4" />
                        Detect {readyCount > 0 ? `${readyCount} image${readyCount > 1 ? 's' : ''}` : ''}
                      </>
                    )}
                  </Button>

                  {error ? (
                    <p className="text-xs text-destructive" data-testid="nudedetect-error">
                      {error}
                    </p>
                  ) : null}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="nudedetect-job-detail" className="space-y-4">
                {jobDetailLoading && !selectedJob ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    {selectedJob.input_image_id && token ? (
                      <div className="overflow-hidden rounded-xl bg-muted/30">
                        <img
                          src={imageFileUrl(selectedJob.input_image_id, token)}
                          alt="Scanned"
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="nudedetect-job-image"
                        />
                      </div>
                    ) : null}

                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold">
                        Threshold {selectedJob.threshold.toFixed(2)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground capitalize">
                        {selectedJob.status.replace(/_/g, ' ')}
                        {selectedJob.result
                          ? ` · ${totalDetectionCount(selectedJob.result)} detection(s)`
                          : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {canRetry ? (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onRetry(selectedJob.job_id)}
                          disabled={retrying}
                          data-testid="nudedetect-retry-job"
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
                        data-testid="nudedetect-poll-job"
                      >
                        {polling ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        Poll now
                      </Button>
                      {isRunning ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void onCancel(selectedJob.job_id)}
                          disabled={canceling}
                          data-testid="nudedetect-cancel-job"
                        >
                          {canceling ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <Square className="mr-1 h-4 w-4 fill-current" />
                          )}
                          Cancel
                        </Button>
                      ) : null}
                      {isRunning ? (
                        <span className="flex items-center text-xs text-muted-foreground">
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          Auto-polling…
                        </span>
                      ) : null}
                    </div>

                    {error ? (
                      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {error}
                      </p>
                    ) : null}

                    {selectedJob.result?.results ? (
                      <NudeDetectResultsList
                        results={selectedJob.result.results}
                        previewUrl={
                          selectedJob.input_image_id && token
                            ? imageFileUrl(selectedJob.input_image_id, token)
                            : null
                        }
                      />
                    ) : selectedJob.status === 'failed' ? (
                      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {selectedJob.error || 'Task failed'}
                      </p>
                    ) : selectedJob.status === 'canceled' ? (
                      <p className="text-xs text-muted-foreground">Task canceled.</p>
                    ) : (
                      <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {selectedJob.stage || selectedJob.status || 'Running…'}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    Could not load this scan.
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
