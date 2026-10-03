import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Copy,
  Eye,
  FolderOpen,
  ImagePlus,
  ImageUp,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import {
  cancelDescribeJob,
  deleteDescribeJob,
  getDescribeJob,
  listDescribeCapabilities,
  listDescribeJobs,
  pollDescribeJob,
  retryDescribeJob,
  startDescribeJob,
  type DescribeCapability,
  type DescribeJob,
} from '../api/describe'
import {
  externalResizeDefault,
  getExternalResizeInfo,
  imageFileUrl,
  uploadImage,
  type ExternalResizeInfo,
  type UploadedImage,
} from '../api/images'
import { ExternalResizeToggle } from '../components/ExternalResizeToggle'
import { CapabilityModelPicker } from '../components/CapabilityModelPicker'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { InputImageGrid } from '../components/imggen/InputImageGrid'
import { PromptTextarea } from '../components/PromptTextarea'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import { capabilityBaseLabel } from '../lib/modelAvailability'
import { pickListedCapability } from '../lib/capability-picker'
import { MarkdownContent } from '../components/MarkdownContent'
import { SpeechListenWidget } from '../components/SpeechListenWidget'
import {
  DESCRIBE_NEW_PANEL,
  DescribeHistorySidebar,
} from '../components/describe/DescribeHistorySidebar'
import { QuickGenerateDialog } from '../components/describe/QuickGenerateDialog'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { keepIfUnchanged, mergeJobList, upsertJob } from '../lib/jobMerge'
import { useIsMobile } from '../hooks/useIsMobile'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import RescaleControls from '../components/imggen/RescaleControls'
import {
  appendInputs,
  MAX_BATCH_INPUT_IMAGES,
  rescaleDataPrep,
  type RescaleState,
} from '../lib/imggen'
import { cn } from '../lib/utils'
import { pastedImageFiles } from '../lib/clipboardImages'

const DEFAULT_PROMPT = [
  'Describe this image in detail. Use the following rules:',
  '1. Describe main subject or person visually, do not use general words like "person", mention gender, age, body shape, skin color, race, hair, what person is wearing, pose, significant visual details.',
  '2. Describe what the subject is doing, what is going on around, what is on background.',
  '3. Describe atmosphere, dominant colors, lighting, weather, style.',
  '',
  'Write one paragraph, no numeration, 6 sentences max.',
].join('\n')
const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

type DescribeRouteState = {
  describeImage?: UploadedImage
}

// Vision models handle modest resolutions best — downscale the input by default
// (mirrors the management sandbox Image Analyzer).
const DEFAULT_RESCALE: RescaleState = {
  enabled: true,
  mode: 'max',
  width: 1024,
  height: 1024,
  px: 1024,
  mp: '',
}

/** Change key for `lib/jobMerge` — everything a poll can move (not `updated_at`,
 *  which a poll bumps even when nothing else changed). */
function describeJobFingerprint(job: DescribeJob): string {
  return [
    job.status,
    job.stage ?? '',
    job.error ?? '',
    job.offload_cap ?? '',
    job.offload_task_id ?? '',
    job.result ?? '',
  ].join('|')
}

function jobTitle(prompt: string, limit = 56): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Analysis'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function DescribeImagePage() {
  const { token } = useAuth()
  const { setForegroundJob } = useProgress()
  const navigate = useNavigate()
  const location = useLocation()
  const routeImage = (location.state as DescribeRouteState | null)?.describeImage ?? null

  const [capabilities, setCapabilities] = useState<DescribeCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const [selectedCap, setSelectedCap] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [rescale, setRescale] = useState<RescaleState>(DEFAULT_RESCALE)

  // Each input image becomes its own analysis job on submit.
  const [uploadedInputs, setUploadedInputs] = useState<UploadedImage[]>(() =>
    routeImage ? [routeImage] : [],
  )
  // External resize: shrink the image on an `image_resize` agent rather than in
  // the backend. Only offered while such an agent is online.
  const [externalResizeInfo, setExternalResizeInfo] = useState<ExternalResizeInfo | null>(null)
  const [externalResize, setExternalResize] = useState(false)
  const previewUrlRef = useRef<string | null>(null)
  // Local blob of a single upload — in flight (`imageId` null) or finished — so
  // the preview doesn't re-download the image the user just picked.
  const [blobPreview, setBlobPreview] = useState<{ url: string; imageId: string | null } | null>(
    null,
  )
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)

  const [jobs, setJobs] = useState<DescribeJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(DESCRIBE_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<DescribeJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const viewingJob = activePanel !== DESCRIBE_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const loadCapabilities = useCallback(() => {
    if (!token) return
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    listDescribeCapabilities(token)
      .then(data => {
        setCapabilities(data.capabilities)
        setCapabilitiesStatus('ready')
        setSelectedCap(prev =>
          pickListedCapability(prev, data.capabilities) ?? data.capabilities[0]?.base ?? '',
        )
      })
      .catch((e: Error) => {
        setCapabilitiesError(e.message)
        setCapabilitiesStatus('error')
      })
  }, [token])

  // Availability + threshold for the External resize option. A failure is not
  // worth surfacing: the option simply stays hidden.
  const loadExternalResizeInfo = useCallback(async () => {
    if (!token) return
    try {
      setExternalResizeInfo(await getExternalResizeInfo(token))
    } catch {
      setExternalResizeInfo(null)
    }
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listDescribeJobs(token)
      setJobs(prev => mergeJobList(prev, list, describeJobFingerprint))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    loadCapabilities()
    void loadJobs()
    void loadExternalResizeInfo()
  }, [loadCapabilities, loadJobs, loadExternalResizeInfo])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  /** Publishes a fetched job; an unchanged snapshot keeps its object so idle polls don't re-render. */
  const applyJob = useCallback((job: DescribeJob) => {
    setSelectedJob(prev => keepIfUnchanged(prev, job, describeJobFingerprint))
    setJobs(prev => upsertJob(prev, job, describeJobFingerprint))
  }, [])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getDescribeJob(token, jobId)
      applyJob(job)
      return job
    },
    [token, applyJob],
  )

  const selectNew = useCallback(() => {
    setActivePanel(DESCRIBE_NEW_PANEL)
    setError(null)
  }, [])

  const selectJob = useCallback(
    async (jobId: string) => {
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
    },
    [token, refreshJob],
  )

  // Stable so the memoized history sidebar skips re-rendering on unrelated
  // page updates (prompt keystrokes, polls of the viewed job).
  const onSidebarSelectNew = useCallback(() => {
    selectNew()
    if (isMobile) setSidebarOpen(false)
  }, [selectNew, isMobile])

  const onSidebarSelectJob = useCallback(
    (jobId: string) => {
      void selectJob(jobId)
      if (isMobile) setSidebarOpen(false)
    },
    [selectJob, isMobile],
  )

  function dropBlobPreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setBlobPreview(null)
  }

  function clearInput() {
    setUploadedInputs([])
    dropBlobPreview()
  }

  /** Publishes a changed input set. Large uploads are stored at full size by
   *  the backend, so they are the ones worth handing to an agent. */
  function applyInputs(next: UploadedImage[]) {
    if (next.length === 0) {
      clearInput()
      return
    }
    setUploadedInputs(next)
    const threshold = externalResizeInfo?.threshold_bytes ?? Infinity
    setExternalResize(next.some(img => externalResizeDefault(img.size_bytes, threshold)))
  }

  /** Uploads `files` one by one and appends them to the input set. */
  async function onUpload(files: File[]) {
    if (!token || files.length === 0) return
    const room = MAX_BATCH_INPUT_IMAGES - uploadedInputs.length
    if (room <= 0) {
      setError(`At most ${MAX_BATCH_INPUT_IMAGES} images — remove one to add another.`)
      return
    }
    const batch = files.slice(0, room)
    setError(null)
    setUploading(true)
    const single = uploadedInputs.length === 0 && batch.length === 1
    let blobUrl: string | null = null
    if (single) {
      dropBlobPreview()
      blobUrl = URL.createObjectURL(batch[0])
      previewUrlRef.current = blobUrl
      setBlobPreview({ url: blobUrl, imageId: null })
    }
    let next = uploadedInputs
    const failures: string[] = []
    for (const [i, file] of batch.entries()) {
      setUploadProgress({ done: i + 1, total: batch.length })
      try {
        const img = await uploadImage(token, file)
        next = appendInputs(next, [img])
        setUploadedInputs(next)
        if (blobUrl) setBlobPreview({ url: blobUrl, imageId: img.image_id })
      } catch (e) {
        failures.push(batch.length > 1 ? `${file.name}: ${(e as Error).message}` : (e as Error).message)
      }
    }
    setUploading(false)
    setUploadProgress(null)
    applyInputs(next)
    if (files.length > batch.length) {
      failures.push(`${files.length - batch.length} more skipped — at most ${MAX_BATCH_INPUT_IMAGES} images.`)
    }
    if (failures.length > 0) setError(failures.join('; '))
  }

  function removeInput(imageId: string) {
    applyInputs(uploadedInputs.filter(img => img.image_id !== imageId))
  }

  // Paste images anywhere on the New panel (screenshot, copied image). Text
  // pastes fall through untouched, so the prompt textarea keeps working.
  const onWindowPaste = useEffectEvent((e: ClipboardEvent) => {
    if (uploading || pickerOpen) return
    const files = pastedImageFiles(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    void onUpload(files)
  })
  const onNewPanel = activePanel === DESCRIBE_NEW_PANEL
  useEffect(() => {
    if (!onNewPanel) return
    const handler = (e: ClipboardEvent) => onWindowPaste(e)
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [onNewPanel])

  /** Appends library picks to the input set. */
  function onPickInputs(picked: UploadedImage[]) {
    setError(null)
    applyInputs(appendInputs(uploadedInputs, picked))
  }

  /** Submits one analysis job per input image, all with the same settings. */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || uploadedInputs.length === 0 || !selectedCap || submitting) return
    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    const inputs = uploadedInputs
    const submittedIds: string[] = []
    try {
      for (const img of inputs) {
        const res = await startDescribeJob(token, {
          capability: selectedCap,
          prompt: prompt.trim() || DEFAULT_PROMPT,
          image_id: img.image_id,
          // null -> send the OAI-normalized upload without extra agent-side rescale.
          data_preparation: rescaleDataPrep(rescale.enabled, rescale),
          external_resize: externalResize,
        })
        submittedIds.push(res.job_id)
      }
      const lastId = submittedIds[submittedIds.length - 1]
      setActivePanel(lastId)
      clearInput()
      if (inputs.length > 1) await loadJobs()
      await refreshJob(lastId)
    } catch (err) {
      const message = (err as Error).message
      if (submittedIds.length > 0) {
        // Keep only the images that didn't make it, so pressing Analyze again
        // doesn't duplicate the jobs that did.
        applyInputs(inputs.slice(submittedIds.length))
        void loadJobs()
        setError(`Failed after ${submittedIds.length} of ${inputs.length} analyses: ${message}`)
      } else {
        setError(message)
      }
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  // Job ids with a poll in flight — auto-poll ticks never stack up behind a slow poll.
  const pollInFlightRef = useRef<Set<string>>(new Set())

  /** Polls `jobId`; only a manual "Poll now" drives the `polling` spinner. */
  const runPoll = useCallback(
    async (jobId: string, opts?: { manual?: boolean }) => {
      if (!token) return
      if (pollInFlightRef.current.has(jobId)) return
      pollInFlightRef.current.add(jobId)
      const manual = opts?.manual ?? false
      if (manual) setPolling(true)
      setError(null)
      try {
        applyJob(await pollDescribeJob(token, jobId))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        pollInFlightRef.current.delete(jobId)
        if (manual) setPolling(false)
      }
    },
    [token, applyJob],
  )

  async function onCancel(jobId: string) {
    if (!token) return
    setCanceling(true)
    setError(null)
    try {
      await cancelDescribeJob(token, jobId)
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
      const res = await retryDescribeJob(token, jobId)
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
      await deleteDescribeJob(token, jobId)
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

  // Auto-poll while viewing a non-terminal job. The shell's background loop
  // skips this job meanwhile, so it isn't polled twice.
  const selectedStatus = selectedJob?.status
  useEffect(() => {
    if (!token || !viewedJobId) return
    if (selectedStatus && TERMINAL.has(selectedStatus)) return
    setForegroundJob('describe', viewedJobId)
    const id = window.setInterval(() => {
      if (document.hidden) return
      void runPoll(viewedJobId)
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(id)
      setForegroundJob('describe', null)
    }
  }, [token, viewedJobId, selectedStatus, runPoll, setForegroundJob])

  function handleCopy() {
    if (!selectedJob?.result) return
    void navigator.clipboard.writeText(selectedJob.result).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  function useResultAsPrompt() {
    const result = selectedJob?.result?.trim()
    if (!result) return
    navigate('/app/images', { state: { usePrompt: result } })
  }

  function editPromptFromJob() {
    if (!selectedJob) return
    setPrompt(selectedJob.prompt)
    if (
      selectedJob.capability &&
      capabilities.some(c => c.base === selectedJob.capability)
    ) {
      setSelectedCap(selectedJob.capability)
    }
    if (selectedJob.input_image_id) {
      // A submitted job clears the temporary form input, but its persisted
      // image id remains valid for the lifetime of the job. Put that image
      // back into the form so editing a prompt does not turn the next run into
      // an analysis without an image.
      dropBlobPreview()
      setUploadedInputs([
        {
          image_id: selectedJob.input_image_id,
          filename: 'Analyzed image',
          content_type: 'image/*',
          width: 0,
          height: 0,
          size_bytes: 0,
          rescaled: false,
          reencoded: false,
        },
      ])
    }
    setActivePanel(DESCRIBE_NEW_PANEL)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(uploadedInputs.length > 0 && selectedCap && !submitting && !uploading),
    [uploadedInputs, selectedCap, submitting, uploading, capabilitiesStatus],
  )

  const multiInput = uploadedInputs.length > 1
  const singleInput = uploadedInputs.length === 1 ? uploadedInputs[0] : null
  // One image: its blob if that's what we have, else the stored file. None:
  // the blob of an upload still in flight.
  const imagePreview = singleInput
    ? blobPreview?.imageId === singleInput.image_id
      ? blobPreview.url
      : imageFileUrl(singleInput.image_id, token)
    : uploadedInputs.length === 0
      ? (blobPreview?.url ?? null)
      : null
  const largestInputBytes = Math.max(0, ...uploadedInputs.map(img => img.size_bytes))
  const uploadLabel =
    uploading && uploadProgress && uploadProgress.total > 1
      ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
      : 'Add images'
  const imageFileInput = (
    <input
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      disabled={uploading}
      onChange={e => {
        const files = Array.from(e.target.files ?? [])
        if (files.length > 0) void onUpload(files)
        e.target.value = ''
      }}
      data-testid="describe-upload-input"
    />
  )

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="describe-page"
    >
      <ToolSidebar
        title="Analyses"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="describe-sidebar"
      >
        <DescribeHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          token={token}
          loading={jobsLoading}
          onSelectNew={onSidebarSelectNew}
          onSelectJob={onSidebarSelectJob}
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
            {viewingJob && selectedJob ? jobTitle(selectedJob.prompt) : 'New analysis'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete analysis"
              aria-label="Delete analysis"
              data-testid="describe-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === DESCRIBE_NEW_PANEL && (
              <section data-testid="describe-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Eye className="h-4 w-4 text-sky-400" />
                    New Analysis
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Upload or paste images, choose a vision model, and run a description of each in the background.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <div className="space-y-1.5" data-testid="describe-capability-select">
                    <Label>Model</Label>
                    <CapabilityModelPicker
                      capabilities={capabilities}
                      selected={selectedCap}
                      onSelect={setSelectedCap}
                      onRefresh={loadCapabilities}
                      capabilitiesStatus={capabilitiesStatus}
                      capabilitiesError={capabilitiesError}
                      formatLabel={cap => capabilityBaseLabel(cap.base)}
                      filterTags={tags => tags.filter(t => t.toLowerCase() !== 'vision')}
                      testIdPrefix="describe-model-picker"
                    />
                    {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No vision models found. Start a vision-capable LLM agent or check OffloadMQ
                        connection in Settings.
                      </p>
                    )}
                  </div>

                  {/* Image upload */}
                  <div className="space-y-1.5" data-testid="describe-image-upload">
                    <Label>
                      {multiInput
                        ? `Images (${uploadedInputs.length}) · one analysis per image`
                        : 'Image'}
                    </Label>
                    {multiInput ? (
                      <div className="space-y-2">
                        <InputImageGrid
                          images={uploadedInputs}
                          token={token}
                          onRemove={removeInput}
                          onClear={clearInput}
                          testIdPrefix="describe"
                          disabled={uploading || submitting}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50">
                            {uploading ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <ImageUp className="size-3.5" />
                            )}
                            {uploadLabel}
                            {imageFileInput}
                          </label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-9"
                            onClick={() => setPickerOpen(true)}
                            disabled={uploading}
                            data-testid="describe-pick-from-library"
                          >
                            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                            From library
                          </Button>
                        </div>
                      </div>
                    ) : imagePreview ? (
                      <div className="relative inline-block">
                        <img
                          src={imagePreview}
                          alt="Selected"
                          className="max-h-64 max-w-full rounded-lg border border-border object-contain"
                          data-testid="describe-image-preview"
                        />
                        <button
                          type="button"
                          className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1 text-foreground backdrop-blur hover:bg-background transition-colors"
                          onClick={clearInput}
                          aria-label="Remove image"
                          data-testid="describe-remove-image"
                        >
                          <X className="size-3.5" />
                        </button>
                        {uploading && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60 backdrop-blur-sm">
                            <Loader2 className="size-5 animate-spin text-muted-foreground" />
                          </div>
                        )}
                        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
                          {imageFileInput}
                          {uploadLabel}
                        </label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => setPickerOpen(true)}
                          disabled={uploading}
                          data-testid="describe-pick-from-library"
                        >
                          <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                          From library
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <label
                          className={cn(
                            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 text-muted-foreground transition-colors hover:bg-muted/50',
                            dragOver && 'border-primary bg-primary/5',
                          )}
                          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={e => {
                            e.preventDefault()
                            setDragOver(false)
                            const files = Array.from(e.dataTransfer.files).filter(f =>
                              f.type.startsWith('image/'),
                            )
                            if (files.length > 0) void onUpload(files)
                          }}
                          data-testid="describe-drop-zone"
                        >
                          <ImageUp className="size-8 text-muted-foreground/60" />
                          <span className="text-sm font-medium">
                            {uploading && uploadProgress && uploadProgress.total > 1
                              ? uploadLabel
                              : 'Click, drag, or paste images here'}
                          </span>
                          <span className="text-xs">
                            PNG, JPEG, WebP, GIF… · up to {MAX_BATCH_INPUT_IMAGES}, one analysis each
                          </span>
                          {imageFileInput}
                        </label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => setPickerOpen(true)}
                          disabled={uploading}
                          data-testid="describe-pick-from-library"
                        >
                          <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                          From library
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Prompt */}
                  <div className="space-y-1.5" data-testid="describe-prompt">
                    <Label htmlFor="describe-prompt-input">Prompt</Label>
                    <PromptTextarea
                      id="describe-prompt-input"
                      value={prompt}
                      onChange={setPrompt}
                      bucket="describe-image-user"
                      token={token}
                      rows={8}
                      placeholder={DEFAULT_PROMPT}
                      data-testid="describe-prompt-input"
                    />
                  </div>

                  {/* Rescale */}
                  <div className="space-y-1.5">
                    <Label>Resize before analysis</Label>
                    <RescaleControls
                      state={rescale}
                      onChange={patch => setRescale(prev => ({ ...prev, ...patch }))}
                      label="Rescale input image"
                    />
                    <p className="text-xs text-muted-foreground">
                      On: the agent rescales to your limit. Off: OffloadAI caps the longest edge at
                      1920px.
                    </p>
                  </div>

                  {externalResizeInfo?.available && uploadedInputs.length > 0 && (
                    <ExternalResizeToggle
                      checked={externalResize}
                      onChange={setExternalResize}
                      sizeBytes={largestInputBytes}
                      imageCount={uploadedInputs.length}
                      thresholdBytes={externalResizeInfo.threshold_bytes}
                      testId="describe-external-resize"
                    />
                  )}

                  {/* Submit */}
                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full"
                    data-testid="describe-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <Eye className="mr-2 size-4" />
                        {multiInput ? `Analyze ${uploadedInputs.length} images` : 'Analyze'}
                      </>
                    )}
                  </Button>

                  {error && (
                    <JobErrorBanner message={error} testId="describe-error" />
                  )}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="describe-job-detail" className="space-y-4">
                {error && <JobErrorBanner message={error} testId="describe-job-error" />}
                {jobDetailLoading && !selectedJob ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    {/* Image */}
                    {selectedJob.input_image_id && (
                      <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
                        <img
                          src={imageFileUrl(selectedJob.input_image_id, token)}
                          alt="Analyzed"
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="describe-job-image"
                        />
                      </div>
                    )}

                    {/* Meta */}
                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold leading-snug">
                        {jobTitle(selectedJob.prompt, 200)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {capabilityBaseLabel(selectedJob.capability)} ·{' '}
                        {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={editPromptFromJob}
                        data-testid="describe-edit-prompt"
                      >
                        <Pencil className="mr-1 h-4 w-4" />
                        Edit prompt
                      </Button>
                      {canRetry && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onRetry(selectedJob.job_id)}
                          disabled={retrying}
                          data-testid="describe-retry-job"
                        >
                          {retrying ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 h-4 w-4" />
                          )}
                          Retry
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runPoll(selectedJob.job_id, { manual: true })}
                        disabled={polling}
                        data-testid="describe-poll-job"
                      >
                        {polling ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        Poll now
                      </Button>
                      {isRunning && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void onCancel(selectedJob.job_id)}
                          disabled={canceling}
                          data-testid="describe-cancel-job"
                        >
                          {canceling ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          ) : (
                            <Square className="mr-1 h-4 w-4 fill-current" />
                          )}
                          Cancel
                        </Button>
                      )}
                      {isRunning && (
                        <span className="flex items-center text-xs text-muted-foreground">
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          Auto-polling every {POLL_INTERVAL_MS / 1000}s…
                        </span>
                      )}
                    </div>

                    {/* Prompt */}
                    <section className="space-y-1.5">
                      <h3 className="text-xs font-medium text-muted-foreground">Prompt</h3>
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {selectedJob.prompt.trim() || '—'}
                      </p>
                    </section>

                    {/* Result / pending / error */}
                    {selectedJob.result ? (
                      <section className="space-y-2" data-testid="describe-result">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-xs font-medium text-muted-foreground">Result</h3>
                          <div className="flex flex-wrap items-center justify-end gap-0.5">
                            <SpeechListenWidget
                              text={selectedJob.result}
                              triggerVariant="ghost"
                              testIdPrefix="describe-listen"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs"
                              onClick={useResultAsPrompt}
                              title="Open Image Generation with this text as the prompt"
                              data-testid="describe-use-as-prompt"
                            >
                              <Wand2 className="size-3.5" />
                              Use as prompt
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs"
                              onClick={() => setGenerateOpen(true)}
                              title="Generate an image from this description"
                              data-testid="describe-generate-open"
                            >
                              <ImagePlus className="size-3.5" />
                              Generate
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs"
                              onClick={handleCopy}
                              data-testid="describe-copy"
                            >
                              <Copy className="size-3.5" />
                              {copied ? 'Copied!' : 'Copy'}
                            </Button>
                          </div>
                        </div>
                        <div className="rounded-xl border border-border bg-muted/30 px-4 py-4">
                          <MarkdownContent>{selectedJob.result}</MarkdownContent>
                        </div>
                      </section>
                    ) : selectedJob.status === 'failed' ? (
                      <JobErrorBanner
                        message={selectedJob.error || 'Task failed'}
                        testId="describe-job-failed"
                      />
                    ) : selectedJob.status === 'canceled' ? (
                      <p className="text-xs text-muted-foreground">Task canceled.</p>
                    ) : (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {selectedJob.stage || selectedJob.status || 'Running…'}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    Could not load this analysis.
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
          onSelectMany={onPickInputs}
          token={token}
        />
      )}
      {generateOpen && token && selectedJob?.result && (
        <QuickGenerateDialog
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          prompt={selectedJob.result}
          token={token}
        />
      )}
    </div>
  )
}
