import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ImagePlus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { getSettings } from '../api/admin'
import {
  getImageJob,
  imageFileUrl,
  listImgGenCapabilities,
  listImageJobs,
  pollImageJob,
  startImageJob,
  type ImgGenCapability,
  type ImageJobDetails,
  type PollImageJobResponse,
  type UploadedImage,
  uploadImage,
} from '../api/images'
import RescaleControls from '../components/imggen/RescaleControls'
import { ImageJobHistorySidebar } from '../components/imggen/ImageJobHistorySidebar'
import {
  ToolDebugHeaderButton,
  ToolDebugModal,
  toolDebugReady,
} from '../components/ToolDebugModal'
import {
  MODE_DEFAULTS,
  capabilityLabel,
  filterCapabilitiesByWorkflow,
  pipelineEventsWithoutPolls,
  pipelineStatusLine,
  rescaleDataPrep,
  type ImgGenMode,
  type RescaleState,
} from '../lib/imggen'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const POLL_MS = 5000

const DEFAULT_RESCALE: RescaleState = {
  enabled: true,
  mode: 'exact',
  width: 768,
  height: 768,
  px: '',
  mp: '',
}

export default function ImageGenerationPage() {
  const { token } = useAuth()
  const [mode, setMode] = useState<ImgGenMode>('txt2img')
  const [prompt, setPrompt] = useState(MODE_DEFAULTS.txt2img.prompt)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [capability, setCapability] = useState('imggen.flux')
  const [allCapabilities, setAllCapabilities] = useState<ImgGenCapability[]>([])
  const [width, setWidth] = useState(MODE_DEFAULTS.txt2img.width)
  const [height, setHeight] = useState(MODE_DEFAULTS.txt2img.height)
  const [seed, setSeed] = useState('')
  const [rescale, setRescale] = useState<RescaleState>(DEFAULT_RESCALE)
  const rescaleUserEditedRef = useRef(false)

  const [uploadedInput, setUploadedInput] = useState<UploadedImage | null>(null)
  const [inputPreviewUrl, setInputPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activePoll, setActivePoll] = useState<PollImageJobResponse | null>(null)
  const [jobs, setJobs] = useState<ImageJobDetails[]>([])
  const [selectedJob, setSelectedJob] = useState<ImageJobDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [debugOpen, setDebugOpen] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)

  useEffect(() => {
    setDebugOpen(false)
  }, [selectedJob?.job_id])

  const capabilities = useMemo(
    () => filterCapabilitiesByWorkflow(allCapabilities, mode),
    [allCapabilities, mode],
  )

  const canSubmit = useMemo(() => {
    if (!prompt.trim()) return false
    if (!capability.trim().startsWith('imggen.')) return false
    if (mode === 'img2img' && !uploadedInput) return false
    return true
  }, [prompt, capability, mode, uploadedInput])

  const patchRescale = useCallback((patch: Partial<RescaleState>) => {
    setRescale(prev => ({ ...prev, ...patch }))
  }, [])

  // Keep exact-mode rescale in sync with output dims until user overrides (img2img sandbox behavior).
  useEffect(() => {
    if (mode !== 'img2img') return
    if (rescale.mode === 'exact' && !rescaleUserEditedRef.current) {
      setRescale(prev => ({ ...prev, width, height }))
    }
  }, [width, height, rescale.mode, mode])

  useEffect(() => {
    if (!token) return
    setJobsLoading(true)
    ;(async () => {
      try {
        const settings = await getSettings(token)
        if (!settings.client_api_token) {
          setInfo('Admin should configure OffloadMQ client token in Settings -> Server.')
        }
      } catch {
        // non-fatal
      }
      try {
        const list = await listImageJobs(token)
        setJobs(list)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setJobsLoading(false)
      }
      try {
        const caps = await listImgGenCapabilities(token)
        setAllCapabilities(caps)
      } catch {
        // non-fatal
      }
    })()
  }, [token])

  useEffect(() => {
    if (capabilities.length === 0) return
    if (!capabilities.some(c => c.base === capability)) {
      setCapability(capabilities[0].base)
    }
  }, [capabilities, capability])

  function switchMode(next: ImgGenMode) {
    if (next === mode) return
    setMode(next)
    const defaults = MODE_DEFAULTS[next]
    setPrompt(defaults.prompt)
    setWidth(defaults.width)
    setHeight(defaults.height)
    rescaleUserEditedRef.current = false
    setRescale(prev => ({
      ...prev,
      enabled: next === 'img2img',
      mode: 'exact',
      width: defaults.width,
      height: defaults.height,
      ...defaults.rescale,
    }))
    if (next === 'txt2img') {
      setUploadedInput(null)
      setInputPreviewUrl(null)
    }
  }

  async function onUpload(file: File) {
    if (!token) return
    setUploading(true)
    setError(null)
    setInfo('Uploading and normalizing image (EXIF-aware, max 1920px).')
    const preview = URL.createObjectURL(file)
    setInputPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return preview
    })
    try {
      const img = await uploadImage(token, file)
      setUploadedInput(img)
      setInfo(`Uploaded ${img.filename} as ${img.width}x${img.height}.`)
    } catch (e) {
      setError((e as Error).message)
      setUploadedInput(null)
      setInputPreviewUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    } finally {
      setUploading(false)
    }
  }

  function clearInput() {
    setUploadedInput(null)
    setInputPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const details = await getImageJob(token, jobId)
      setSelectedJob(details)
      setJobs(prev => [details, ...prev.filter(j => j.job_id !== details.job_id)])
      return details
    },
    [token],
  )

  const runPoll = useCallback(
    async (jobId: string) => {
      if (!token) return
      setPolling(true)
      try {
        const poll = await pollImageJob(token, jobId)
        setActivePoll(poll)
        await refreshJob(jobId)
        setInfo(`Job ${jobId}: ${poll.status}${poll.stage ? ` (${poll.stage})` : ''}`)
        if (poll.error) setError(poll.error)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setPolling(false)
      }
    },
    [token, refreshJob],
  )

  async function onSubmit() {
    if (!token || !canSubmit) return
    setSubmitting(true)
    setError(null)
    setInfo('Submitting image generation task to OffloadMQ.')
    const dataPrep = mode === 'img2img' ? rescaleDataPrep(rescale.enabled, rescale) : null
    try {
      const res = await startImageJob(token, {
        capability: capability.trim(),
        prompt: prompt.trim(),
        negative_prompt: overrideNegative ? negativePrompt.trim() || null : null,
        override_negative: overrideNegative,
        width,
        height,
        seed: seed.trim() ? Number(seed) : null,
        workflow: mode,
        input_image_id: uploadedInput?.image_id ?? null,
        data_preparation: dataPrep,
      })
      setActiveJobId(res.job_id)
      await refreshJob(res.job_id)
      setActivePoll({ job_id: res.job_id, status: res.status, stage: null, error: null, output_images: [] })
      setInfo(`Job ${res.job_id} submitted. Polling for results…`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  // Auto-poll while job is in progress (sandbox-style; user can still poll manually).
  useEffect(() => {
    if (!token || !activeJobId) return
    const status = activePoll?.status ?? selectedJob?.status
    if (status && TERMINAL.has(status)) return

    const id = window.setInterval(() => {
      void runPoll(activeJobId)
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [token, activeJobId, activePoll?.status, selectedJob?.status, runPoll])

  useEffect(() => {
    return () => {
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl)
    }
  }, [inputPreviewUrl])

  async function selectJob(jobId: string) {
    if (!token) return
    setActiveJobId(jobId)
    setError(null)
    try {
      const details = await refreshJob(jobId)
      setActivePoll(
        details
          ? {
              job_id: jobId,
              status: details.status,
              stage: null,
              error: details.error,
              output_images: details.files
                .filter(f => f.direction === 'output')
                .map(f => ({
                  image_id: f.image_id,
                  filename: f.filename,
                  width: f.width,
                  height: f.height,
                  content_type: f.content_type,
                  size_bytes: f.size_bytes,
                })),
            }
          : null,
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const displayStatus = activePoll?.status ?? selectedJob?.status
  const isRunning =
    displayStatus != null && !TERMINAL.has(displayStatus) && (submitting || polling || !!activeJobId)

  const pipelineEvents = useMemo(
    () => (selectedJob ? pipelineEventsWithoutPolls(selectedJob.events) : []),
    [selectedJob],
  )

  const pipelineStatus = useMemo(() => {
    if (!selectedJob || !displayStatus) return ''
    return pipelineStatusLine(displayStatus, activePoll?.stage, selectedJob.events)
  }, [selectedJob, displayStatus, activePoll?.stage])

  useEffect(() => {
    setTimelineOpen(false)
  }, [selectedJob?.job_id])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background" data-testid="image-generation-page">
      <aside
        className={cn(
          'flex shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200',
          sidebarOpen ? 'w-64' : 'w-0',
        )}
        data-testid="imggen-pipelines-sidebar"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-sm font-semibold text-sidebar-foreground">Pipelines</span>
        </div>
        <ImageJobHistorySidebar
          jobs={jobs}
          activeJobId={activeJobId}
          loading={jobsLoading}
          onSelect={jobId => void selectJob(jobId)}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
            {selectedJob ? `Job ${selectedJob.job_id}` : 'Image Generation'}
          </h1>
          <ToolDebugHeaderButton
            onClick={() => setDebugOpen(true)}
            disabled={!selectedJob}
            active={toolDebugReady(selectedJob?.offload_cap, selectedJob?.offload_task_id)}
          />
        </header>

        <ToolDebugModal
          open={debugOpen}
          onOpenChange={setDebugOpen}
          cap={selectedJob?.offload_cap}
          taskId={selectedJob?.offload_task_id}
          subject={selectedJob ? `Image job ${selectedJob.job_id}` : undefined}
          disabledReason={
            selectedJob && !toolDebugReady(selectedJob.offload_cap, selectedJob.offload_task_id)
              ? 'No OffloadMQ task linked to this job yet.'
              : !selectedJob
                ? 'Select a job from the sidebar.'
                : undefined
          }
        />

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 sm:px-6">

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4" />
              New Job
            </CardTitle>
            <CardDescription>
              Img2Img uploads your image to a bucket, rescales it with dataPreparation, then runs the workflow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2" data-testid="imggen-mode-tabs">
              <Button
                variant={mode === 'txt2img' ? 'default' : 'outline'}
                size="sm"
                onClick={() => switchMode('txt2img')}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                Txt2Img
              </Button>
              <Button
                variant={mode === 'img2img' ? 'default' : 'outline'}
                size="sm"
                onClick={() => switchMode('img2img')}
                data-testid="imggen-mode-img2img"
              >
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
                Img2Img
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="capability">Model / capability</Label>
                {capabilities.length > 0 ? (
                  <select
                    id="capability"
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="imggen-capability-select"
                  >
                    {capabilities.map(cap => (
                      <option key={cap.raw} value={cap.base}>
                        {capabilityLabel(cap)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="capability"
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    placeholder="imggen.flux"
                    data-testid="imggen-capability"
                  />
                )}
                {capabilities.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No imggen agents online — enter a capability manually or start an agent.
                  </p>
                )}
              </div>

              {mode === 'img2img' && (
                <div className="space-y-3 sm:col-span-2" data-testid="imggen-input-section">
                  <Label>Input image</Label>
                  <div className="flex flex-wrap items-start gap-4">
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-4 py-3 text-sm hover:bg-muted">
                      <Upload className="h-4 w-4" />
                      {uploading ? 'Uploading…' : 'Choose image'}
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
                        data-testid="imggen-upload-input"
                      />
                    </label>
                    {uploadedInput && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {uploadedInput.filename} ({uploadedInput.width}×{uploadedInput.height})
                        </span>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={clearInput}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {(inputPreviewUrl || uploadedInput) && (
                    <div className="relative max-w-xs overflow-hidden rounded-lg border border-border">
                      <img
                        src={uploadedInput ? imageFileUrl(uploadedInput.image_id) : inputPreviewUrl!}
                        alt="Input preview"
                        className="max-h-48 w-full object-contain bg-muted/30"
                        data-testid="imggen-input-preview"
                      />
                    </div>
                  )}
                  <RescaleControls
                    state={rescale}
                    onChange={patch => {
                      if ('width' in patch || 'height' in patch || 'mode' in patch) {
                        rescaleUserEditedRef.current = true
                      }
                      if ('mode' in patch && patch.mode === 'exact') {
                        rescaleUserEditedRef.current = false
                      }
                      patchRescale(patch)
                    }}
                    label="Rescale input image before workflow"
                  />
                </div>
              )}

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="prompt">Prompt</Label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid="imggen-prompt"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="negative-prompt">Negative prompt</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setOverrideNegative(v => !v)}
                    data-testid="imggen-negative-toggle"
                  >
                    {overrideNegative ? 'use model default' : 'override'}
                  </Button>
                </div>
                {overrideNegative ? (
                  <textarea
                    id="negative-prompt"
                    value={negativePrompt}
                    onChange={e => setNegativePrompt(e.target.value)}
                    rows={2}
                    placeholder="e.g. blurry, deformed, low quality"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    data-testid="imggen-negative-prompt"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Using workflow default negative prompt.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="width">Width</Label>
                <Input
                  id="width"
                  type="number"
                  value={width}
                  onChange={e => {
                    if (mode === 'img2img' && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                    setWidth(Number(e.target.value) || 1024)
                  }}
                  data-testid="imggen-width"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="height">Height</Label>
                <Input
                  id="height"
                  type="number"
                  value={height}
                  onChange={e => {
                    if (mode === 'img2img' && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                    setHeight(Number(e.target.value) || 1024)
                  }}
                  data-testid="imggen-height"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="seed">Seed (optional)</Label>
                <Input id="seed" value={seed} onChange={e => setSeed(e.target.value)} placeholder="empty = random" />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void onSubmit()} disabled={!canSubmit || submitting} data-testid="imggen-submit-job">
                {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {mode === 'img2img' ? 'Edit Image' : 'Generate Image'}
              </Button>
              <Button
                variant="outline"
                onClick={() => activeJobId && void runPoll(activeJobId)}
                disabled={!activeJobId || polling}
                data-testid="imggen-poll-job"
              >
                {polling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                Poll now
              </Button>
              {isRunning && (
                <span className="flex items-center text-xs text-muted-foreground">
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Auto-polling every {POLL_MS / 1000}s…
                </span>
              )}
            </div>

            {info && <p className="text-xs text-muted-foreground">{info}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {selectedJob && (
          <Card data-testid="imggen-job-detail">
            <CardHeader>
              <CardTitle>Job {selectedJob.job_id}</CardTitle>
              <CardDescription>{selectedJob.workflow}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedJob.input_image_id && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Input</p>
                  <img
                    src={imageFileUrl(selectedJob.input_image_id)}
                    alt="Job input"
                    className="max-h-40 rounded-lg border border-border object-contain"
                  />
                </div>
              )}
              {!!selectedJob.error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {selectedJob.error}
                </p>
              )}
              <div className="space-y-2" data-testid="imggen-pipeline">
                <button
                  type="button"
                  onClick={() => setTimelineOpen(v => !v)}
                  className="flex w-full items-start gap-2 rounded-lg border border-border p-3 text-left hover:bg-muted/40 transition-colors"
                  aria-expanded={timelineOpen}
                  data-testid="imggen-pipeline-toggle"
                >
                  <ChevronDown
                    className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${
                      timelineOpen ? 'rotate-0' : '-rotate-90'
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <span className="text-xs font-medium text-muted-foreground">Pipeline</span>
                    <p className="text-sm text-foreground" data-testid="imggen-pipeline-status">
                      {pipelineStatus || displayStatus || 'Waiting…'}
                    </p>
                  </div>
                </button>
                {timelineOpen && (
                  <div
                    className="ml-6 rounded-lg border border-border p-3"
                    data-testid="imggen-pipeline-timeline"
                  >
                    {pipelineEvents.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No pipeline steps yet.</p>
                    ) : (
                      <ol className="space-y-2">
                        {pipelineEvents.map((event, idx) => (
                          <li key={`${event.created_at}-${idx}`} className="flex gap-2 text-xs">
                            <div className="mt-1.5 h-2 w-2 rounded-full bg-primary/70" />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{event.step}</span>
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {event.state}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(event.created_at).toLocaleString()}
                                </span>
                              </div>
                              {event.details && (
                                <p className="mt-0.5 text-muted-foreground">{event.details}</p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedJob.files
                  .filter(f => f.direction === 'output')
                  .map(file => (
                    <a
                      key={file.image_id}
                      href={imageFileUrl(file.image_id)}
                      target="_blank"
                      rel="noreferrer"
                      className="group overflow-hidden rounded-lg border border-border"
                    >
                      <img
                        src={imageFileUrl(file.image_id)}
                        alt={file.filename}
                        className="h-52 w-full object-cover transition-transform group-hover:scale-[1.02]"
                      />
                      <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        {file.filename} — {file.width}×{file.height}
                      </div>
                    </a>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}
          </div>
        </main>
      </div>
    </div>
  )
}
