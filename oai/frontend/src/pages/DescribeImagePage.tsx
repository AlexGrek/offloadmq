import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Copy,
  Eye,
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
import { imageFileUrl, uploadImage, type UploadedImage } from '../api/images'
import { CapabilityModelPicker } from '../components/CapabilityModelPicker'
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
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import RescaleControls from '../components/imggen/RescaleControls'
import { rescaleDataPrep, type RescaleState } from '../lib/imggen'
import { cn } from '../lib/utils'

const DEFAULT_PROMPT = 'Describe this image in detail'
const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

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

function jobTitle(prompt: string, limit = 56): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Analysis'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function DescribeImagePage() {
  const { token } = useAuth()
  const navigate = useNavigate()

  const [capabilities, setCapabilities] = useState<DescribeCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const [selectedCap, setSelectedCap] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [rescale, setRescale] = useState<RescaleState>(DEFAULT_RESCALE)

  const [uploadedInput, setUploadedInput] = useState<UploadedImage | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

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
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  // Mobile: the sidebar is a full-screen overlay — collapse it on entering a narrow viewport.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])
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

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listDescribeJobs(token)
      setJobs(list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    loadCapabilities()
    void loadJobs()
  }, [loadCapabilities, loadJobs])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getDescribeJob(token, jobId)
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
    setActivePanel(DESCRIBE_NEW_PANEL)
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

  function clearInput() {
    setUploadedInput(null)
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setImagePreview(null)
  }

  async function onUpload(file: File) {
    if (!token) return
    setError(null)
    setUploading(true)
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const preview = URL.createObjectURL(file)
    previewUrlRef.current = preview
    setImagePreview(preview)
    try {
      const img = await uploadImage(token, file)
      setUploadedInput(img)
    } catch (e) {
      setError((e as Error).message)
      clearInput()
    } finally {
      setUploading(false)
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || !uploadedInput || !selectedCap || submitting) return
    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    try {
      const res = await startDescribeJob(token, {
        capability: selectedCap,
        prompt: prompt.trim() || DEFAULT_PROMPT,
        image_id: uploadedInput.image_id,
        // null -> send the OAI-normalized upload without extra agent-side rescale.
        data_preparation: rescaleDataPrep(rescale.enabled, rescale),
      })
      setActivePanel(res.job_id)
      clearInput()
      await refreshJob(res.job_id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  async function onPollNow(jobId: string) {
    if (!token) return
    setPolling(true)
    setError(null)
    try {
      const job = await pollDescribeJob(token, jobId)
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

  // Auto-poll while viewing a non-terminal job
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
    setActivePanel(DESCRIBE_NEW_PANEL)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(uploadedInput && selectedCap && !submitting && !uploading),
    [uploadedInput, selectedCap, submitting, uploading, capabilitiesStatus],
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
                    Upload an image, choose a vision model, and run a description in the background.
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
                    <Label>Image</Label>
                    {imagePreview ? (
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
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={uploading}
                            onChange={e => {
                              const file = e.target.files?.[0]
                              if (file) void onUpload(file)
                              e.target.value = ''
                            }}
                          />
                          Change image
                        </label>
                      </div>
                    ) : (
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
                          const file = e.dataTransfer.files[0]
                          if (file?.type.startsWith('image/')) void onUpload(file)
                        }}
                        data-testid="describe-drop-zone"
                      >
                        <ImageUp className="size-8 text-muted-foreground/60" />
                        <span className="text-sm font-medium">Click or drag an image here</span>
                        <span className="text-xs">PNG, JPEG, WebP, GIF…</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={uploading}
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (file) void onUpload(file)
                            e.target.value = ''
                          }}
                        />
                      </label>
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
                      rows={2}
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
                        Analyze
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
                        onClick={() => void onPollNow(selectedJob.job_id)}
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
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-medium text-muted-foreground">Result</h3>
                          <div className="flex items-center gap-0.5">
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
    </div>
  )
}
