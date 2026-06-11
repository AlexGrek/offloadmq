import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  Columns2,
  FolderOpen,
  ImagePlus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Pencil,
  Sparkles,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ImageLightbox } from '@/components/ImageLightbox'
import { PromptTextarea } from '../components/PromptTextarea'
import { NudeDetectModal } from '@/components/nudedetect/NudeDetectModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { getSettings } from '../api/admin'
import {
  getImageJob,
  imageFileUrl,
  listImgGenCapabilities,
  listImageJobs,
  cancelImageJob,
  deleteImageJob,
  pollImageJob,
  retryImageJob,
  startImageJob,
  type ImgGenCapability,
  type ImageJobDetails,
  type PollImageJobResponse,
  type UploadedImage,
  uploadImage,
} from '../api/images'
import { JobErrorBanner } from '../components/JobErrorBanner'
import RescaleControls from '../components/imggen/RescaleControls'
import {
  ImageJobHistorySidebar,
  IMGGEN_NEW_PANEL,
} from '../components/imggen/ImageJobHistorySidebar'
import { PipelineJobParamsPanel } from '../components/imggen/PipelineJobParamsPanel'
import { ImgGenModelPicker } from '../components/imggen/ImgGenModelPicker'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import {
  ToolDebugHeaderButton,
  ToolDebugModal,
  toolDebugReady,
} from '../components/ToolDebugModal'
import { ToolSidebar } from '../components/ToolSidebar'
import {
  MODE_DEFAULTS,
  applyPipelineParamsToNewForm,
  filterCapabilitiesByWorkflow,
  fitsOriginalResolution,
  isInputImageMode,
  isVideoMode,
  jobPromptTitle,
  jobTechMeta,
  proportionalCounterpart,
  proportionalPresets,
  proportionalSize,

  pipelineEventsWithoutPolls,
  pipelineStatusLine,
  rescaleDataPrep,
  type ImgGenMode,
  type RescaleState,
} from '../lib/imggen'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import type { ImagePipelineRescaleParams } from '../api/images'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])

const BURST_SPARKS = [
  { x: -62, y: -28, delay: 0 },
  { x: -38, y: -58, delay: 0.06 },
  { x: 6, y: -70, delay: 0.03 },
  { x: 50, y: -55, delay: 0.09 },
  { x: 68, y: -18, delay: 0.02 },
  { x: 58, y: 28, delay: 0.07 },
  { x: -60, y: 25, delay: 0.04 },
]
const POLL_MS = 5000

const DEFAULT_RESCALE: RescaleState = {
  enabled: false,
  mode: 'exact',
  width: 768,
  height: 768,
  px: '',
  mp: '',
}

export default function ImageGenerationPage() {
  const { token } = useAuth()
  const { refreshRunningImageJobs } = useProgress()
  const isMobile = useIsMobile()
  const [mode, setMode] = useState<ImgGenMode>('txt2img')
  const [prompt, setPrompt] = useState(MODE_DEFAULTS.txt2img.prompt)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [capability, setCapability] = useState('')
  const [allCapabilities, setAllCapabilities] = useState<ImgGenCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [width, setWidth] = useState(MODE_DEFAULTS.txt2img.width)
  const [height, setHeight] = useState(MODE_DEFAULTS.txt2img.height)
  const [seed, setSeed] = useState('')
  const [rescale, setRescale] = useState<RescaleState>(DEFAULT_RESCALE)
  // img2img "original resolution": lock generation dims to the input image and pass it
  // through to the agent un-rescaled. Only offered for sub-4K inputs; default-on after upload.
  const [originalResolution, setOriginalResolution] = useState(false)
  // img2img "keep proportions": lock the output aspect ratio to the input image's and offer
  // proportional dimension presets. Default-on whenever an input is present.
  const [keepProportions, setKeepProportions] = useState(false)
  const rescaleUserEditedRef = useRef(false)

  const [uploadedInput, setUploadedInput] = useState<UploadedImage | null>(null)
  const [inputPreviewUrl, setInputPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [activePanel, setActivePanel] = useState<string>(IMGGEN_NEW_PANEL)
  const [activePoll, setActivePoll] = useState<PollImageJobResponse | null>(null)
  const [jobs, setJobs] = useState<ImageJobDetails[]>([])
  const [selectedJob, setSelectedJob] = useState<ImageJobDetails | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  const [debugOpen, setDebugOpen] = useState(false)
  const [deletingJob, setDeletingJob] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [nudeDetectTarget, setNudeDetectTarget] = useState<{
    imageId: string
    filename: string
  } | null>(null)
  const [mediaRevision, setMediaRevision] = useState(0)
  const [submitBurst, setSubmitBurst] = useState(false)
  const [compareMode, setCompareMode] = useState(false)

  const viewingJob = activePanel !== IMGGEN_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  useEffect(() => {
    setDebugOpen(false)
  }, [activePanel])

  // On mobile the pipelines sidebar is a full-screen overlay — collapse it when
  // we cross into a narrow viewport so it never starts covering the workspace.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

  const capabilities = useMemo(
    () => filterCapabilitiesByWorkflow(allCapabilities, mode),
    [allCapabilities, mode],
  )

  const canSubmit = useMemo(() => {
    if (capabilitiesStatus !== 'ready') return false
    if (!prompt.trim()) return false
    if (!capability) return false
    if (isInputImageMode(mode) && !uploadedInput) return false
    return true
  }, [prompt, capability, mode, uploadedInput, capabilitiesStatus])

  // "Original resolution" is only meaningful for img2img (not img2video).
  const canUseOriginalResolution = useMemo(
    () =>
      mode === 'img2img' &&
      uploadedInput != null &&
      fitsOriginalResolution(uploadedInput.width, uploadedInput.height),
    [mode, uploadedInput],
  )

  // Output aspect ratio is locked to the input whenever either toggle is on.
  const ratioLocked = originalResolution || keepProportions

  // Dimension presets: proportional variants of the input while ratio-locked, else square/common sizes.
  const dimensionPresets = useMemo<[number, number][]>(() => {
    if (ratioLocked && uploadedInput) {
      return proportionalPresets(uploadedInput.width, uploadedInput.height)
    }
    return [
      [512, 512], [768, 768], [1024, 1024], [1024, 768], [768, 1024],
    ]
  }, [ratioLocked, uploadedInput])

  const patchRescale = useCallback((patch: Partial<RescaleState>) => {
    setRescale(prev => ({ ...prev, ...patch }))
  }, [])

  // Keep exact-mode rescale in sync with output dims until user overrides.
  useEffect(() => {
    if (!isInputImageMode(mode)) return
    if (rescale.mode === 'exact' && !rescaleUserEditedRef.current) {
      setRescale(prev => ({ ...prev, width, height }))
    }
  }, [width, height, rescale.mode, mode])

  const loadCapabilities = useCallback(async () => {
    if (!token) return
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    try {
      const caps = await listImgGenCapabilities(token)
      setAllCapabilities(caps)
      setCapabilitiesStatus('ready')
    } catch (e) {
      setCapabilitiesStatus('error')
      setCapabilitiesError(
        e instanceof Error ? e.message : 'Failed to load models',
      )
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setAllCapabilities([])
      setCapabilitiesStatus('idle')
      setCapabilitiesError(null)
      return
    }
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
      await loadCapabilities()
    })()
  }, [token, loadCapabilities])

  const refreshCapabilities = useCallback(() => {
    void loadCapabilities()
  }, [loadCapabilities])

  const capabilityInitialized = useRef(false)

  useEffect(() => {
    if (capabilities.length === 0) return

    if (!capabilityInitialized.current) {
      capabilityInitialized.current = true
      const lastJobCap = jobs[0]?.capability
      if (lastJobCap && capabilities.some(c => c.base === lastJobCap)) {
        setCapability(lastJobCap)
        return
      }
      const firstOnline = capabilities.find(c => c.online)
      setCapability(firstOnline?.base ?? capabilities[0].base)
      return
    }

    // Mode switch: re-select if current cap is no longer in the filtered list
    if (!capabilities.some(c => c.base === capability)) {
      const firstOnline = capabilities.find(c => c.online)
      setCapability(firstOnline?.base ?? capabilities[0].base)
    }
  }, [capabilities, capability, jobs])

  // Default a freshly set img2img input: keep proportions on, and use original resolution when
  // it fits under 4K (locks dims to the input). Larger inputs default to a proportional 1024 long
  // edge. Returns whether original resolution was enabled.
  function applyInputDefaults(img: UploadedImage): boolean {
    const fits = fitsOriginalResolution(img.width, img.height)
    setKeepProportions(true)
    setOriginalResolution(fits)
    rescaleUserEditedRef.current = false
    if (fits) {
      setWidth(img.width)
      setHeight(img.height)
    } else {
      const [w, h] = proportionalSize(img.width, img.height, 1024)
      setWidth(w)
      setHeight(h)
    }
    return fits
  }

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
      enabled: next === 'img2img' || next === 'img2video',
      mode: 'exact',
      width: defaults.width,
      height: defaults.height,
      ...defaults.rescale,
    }))
    if (!isInputImageMode(next)) {
      setUploadedInput(null)
      setInputPreviewUrl(null)
      setOriginalResolution(false)
      setKeepProportions(false)
    } else if (uploadedInput) {
      applyInputDefaults(uploadedInput)
    } else {
      setOriginalResolution(false)
      setKeepProportions(false)
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
      const original = applyInputDefaults(img)
      setInfo(
        original
          ? `Uploaded ${img.filename} (${img.width}×${img.height}). Generating at original resolution.`
          : `Uploaded ${img.filename} as ${img.width}×${img.height}.`,
      )
    } catch (e) {
      setError((e as Error).message)
      setUploadedInput(null)
      setOriginalResolution(false)
      setKeepProportions(false)
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
    setOriginalResolution(false)
    setKeepProportions(false)
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
      setJobs(prev => {
        const idx = prev.findIndex(j => j.job_id === details.job_id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = details
          return next
        }
        // Brand-new job (e.g. just submitted) — prepend once to match newest-first list.
        return [details, ...prev]
      })
      return details
    },
    [token],
  )

  const onImageMutated = useCallback(async () => {
    setMediaRevision(v => v + 1)
    if (viewedJobId) await refreshJob(viewedJobId)
  }, [viewedJobId, refreshJob])

  const lightboxActions = useCallback(
    (imageId: string, filename: string, direction: string, onSendToImg2Img?: () => void) =>
      token
        ? {
            imageId,
            filename,
            direction,
            token,
            onDeleted: onImageMutated,
            onSendToImg2Img,
            onNudeDetect: () => setNudeDetectTarget({ imageId, filename }),
          }
        : undefined,
    [token, onImageMutated],
  )

  function sendToImg2Img(file: { image_id: string; filename: string; content_type: string; width: number; height: number; size_bytes: number; rescaled: boolean; reencoded: boolean }) {
    switchMode('img2img')
    const img: UploadedImage = {
      image_id: file.image_id,
      filename: file.filename,
      content_type: file.content_type,
      width: file.width,
      height: file.height,
      size_bytes: file.size_bytes,
      rescaled: file.rescaled,
      reencoded: file.reencoded,
    }
    setUploadedInput(img)
    const original = applyInputDefaults(img)
    setInputPreviewUrl(null)
    setActivePanel(IMGGEN_NEW_PANEL)
    setInfo(
      original
        ? `Input set to "${file.filename}" (${file.width}×${file.height}). Generating at original resolution.`
        : `Input set to "${file.filename}" (${file.width}×${file.height}). Adjust settings and submit.`,
    )
    setError(null)
  }

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

  async function onDeleteJob(jobId: string) {
    if (!token) return
    setDeletingJob(true)
    setError(null)
    try {
      await deleteImageJob(token, jobId)
      setDebugOpen(false)
      setJobs(prev => {
        const next = prev.filter(j => j.job_id !== jobId)
        if (activePanel === jobId) {
          if (next.length > 0) {
            setActivePanel(next[0].job_id)
            void refreshJob(next[0].job_id)
          } else {
            selectNew()
            setSelectedJob(null)
            setActivePoll(null)
          }
        }
        return next
      })
      setInfo('Pipeline removed.')
      void refreshRunningImageJobs()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeletingJob(false)
    }
  }

  async function onRetryJob(jobId: string) {
    if (!token) return
    setRetrying(true)
    setError(null)
    try {
      const res = await retryImageJob(token, jobId)
      const list = await listImageJobs(token)
      setJobs(list)
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      setActivePoll({
        job_id: res.job_id,
        status: res.status,
        stage: null,
        error: null,
        output_images: [],
      })
      setInfo(`Retry submitted as job ${res.job_id}. Polling for results…`)
      void refreshRunningImageJobs()
      void runPoll(res.job_id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }

  async function onCancelJob(jobId: string) {
    if (!token) return
    setError(null)
    try {
      const res = await cancelImageJob(token, jobId)
      setInfo(res.message)
      setActivePoll(prev =>
        prev
          ? { ...prev, status: res.status, error: null }
          : { job_id: jobId, status: res.status, stage: null, error: null, output_images: [] },
      )
      await refreshJob(jobId)
      void runPoll(jobId)
      void refreshRunningImageJobs()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onSubmit() {
    if (!token || !canSubmit) return
    setSubmitting(true)
    setJobDetailLoading(true)
    setError(null)
    setInfo(`Submitting ${isVideoMode(mode) ? 'video generation' : 'image generation'} task to OffloadMQ.`)
    // dataPreparation: only for img2img (not txt2img, not video modes).
    const dataPrep =
      mode === 'img2img' && !originalResolution ? rescaleDataPrep(rescale.enabled, rescale) : null
    try {
      const [res] = await Promise.all([
        startImageJob(token, {
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
          rescale: rescaleForSubmit(),
        }),
        new Promise<void>(resolve => window.setTimeout(resolve, 600)),
      ])
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      setActivePoll({ job_id: res.job_id, status: res.status, stage: null, error: null, output_images: [] })
      setInfo(`Job ${res.job_id} submitted. Polling for results…`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  // Auto-poll while viewing a job that is still in progress.
  useEffect(() => {
    if (!token || !viewedJobId) return
    const status = activePoll?.status ?? selectedJob?.status
    if (status && TERMINAL.has(status)) return

    const id = window.setInterval(() => {
      void runPoll(viewedJobId)
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [token, viewedJobId, activePoll?.status, selectedJob?.status, runPoll])

  useEffect(() => {
    return () => {
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl)
    }
  }, [inputPreviewUrl])

  function selectNew() {
    setActivePanel(IMGGEN_NEW_PANEL)
    setError(null)
  }

  function editPromptFromJob() {
    if (!selectedJob) return
    const previewUrl =
      selectedJob.input_image_id && token
        ? imageFileUrl(selectedJob.input_image_id, token)
        : null
    applyPipelineParamsToNewForm(
      selectedJob,
      {
        setMode,
        setPrompt,
        setNegativePrompt,
        setOverrideNegative,
        setCapability,
        setWidth,
        setHeight,
        setSeed,
        setRescale,
        setOriginalResolution,
        setKeepProportions,
        setUploadedInput,
        setInputPreviewUrl,
        rescaleUserEditedRef,
      },
      previewUrl,
      capabilities,
    )
    setActivePanel(IMGGEN_NEW_PANEL)
    setInfo('Pipeline parameters copied to New job. Adjust and submit when ready.')
    setError(null)
  }

  function rescaleForSubmit(): ImagePipelineRescaleParams | null {
    if (mode !== 'img2img' && mode !== 'img2video') return null
    // Original-resolution (img2img only): persist rescale as disabled so the job reconstructs as pass-through.
    if (mode === 'img2img' && originalResolution) {
      return { enabled: false, mode: rescale.mode, width, height, px: null, mp: null }
    }
    return {
      enabled: rescale.enabled,
      mode: rescale.mode,
      width: rescale.width,
      height: rescale.height,
      px: rescale.px === '' ? null : Number(rescale.px),
      mp: rescale.mp === '' ? null : Number(rescale.mp),
    }
  }

  async function selectJob(jobId: string) {
    if (!token) return
    setActivePanel(jobId)
    setError(null)
    setJobDetailLoading(true)
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
    } finally {
      setJobDetailLoading(false)
    }
  }

  const displayStatus =
    viewingJob && selectedJob?.job_id === viewedJobId
      ? activePoll?.status ?? selectedJob?.status
      : undefined
  const isRunning =
    viewingJob && displayStatus != null && !TERMINAL.has(displayStatus)
  const canRetryJob =
    viewingJob &&
    selectedJob != null &&
    (selectedJob.status === 'failed' || selectedJob.status === 'canceled')

  const pipelineEvents = useMemo(
    () => (selectedJob ? pipelineEventsWithoutPolls(selectedJob.events) : []),
    [selectedJob],
  )

  const pipelineStatus = useMemo(() => {
    if (!selectedJob || !displayStatus) return ''
    return pipelineStatusLine(displayStatus, activePoll?.stage, selectedJob.events)
  }, [selectedJob, displayStatus, activePoll?.stage])

  const outputFiles = useMemo(
    () => (selectedJob ? selectedJob.files.filter(f => f.direction === 'output') : []),
    [selectedJob],
  )

  const canCompare =
    selectedJob?.workflow === 'img2img' &&
    Boolean(selectedJob?.input_image_id) &&
    outputFiles.length > 0 &&
    outputFiles.every(f => !f.content_type.startsWith('video/'))

  useEffect(() => {
    setTimelineOpen(false)
    setCompareMode(false)
  }, [selectedJob?.job_id])

  return (
    <>
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="image-generation-page"
    >
      <ToolSidebar
        title="Pipelines"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="imggen-pipelines-sidebar"
      >
        <ImageJobHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          token={token}
          mediaRevision={mediaRevision}
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
            {viewingJob && selectedJob ? jobPromptTitle(selectedJob.prompt, 56) : 'New'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDeleteJob(selectedJob.job_id)}
              disabled={deletingJob}
              title="Delete pipeline"
              aria-label="Delete pipeline"
              data-testid="imggen-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deletingJob ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          )}
          <ToolDebugHeaderButton
            onClick={() => setDebugOpen(true)}
            disabled={!viewingJob || !selectedJob}
            active={toolDebugReady(selectedJob?.offload_cap, selectedJob?.offload_task_id)}
          />
        </header>

        <ToolDebugModal
          open={debugOpen}
          onOpenChange={setDebugOpen}
          cap={selectedJob?.offload_cap}
          taskId={selectedJob?.offload_task_id}
          subject={selectedJob ? jobPromptTitle(selectedJob.prompt, 48) : undefined}
          disabledReason={
            selectedJob && !toolDebugReady(selectedJob.offload_cap, selectedJob.offload_task_id)
              ? 'No OffloadMQ task linked to this job yet.'
              : !selectedJob
                ? 'Select a job from the sidebar.'
                : undefined
          }
        />

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">

        {activePanel === IMGGEN_NEW_PANEL && (
        <section data-testid="imggen-new-panel" className="flex flex-col gap-5">
          <header className="space-y-1">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
              <Wand2 className="h-4 w-4" />
              New Job
            </h2>
            <p className="text-sm text-muted-foreground">
              {isVideoMode(mode)
                ? 'Video generation via ComfyUI. Output is an MP4 with no thumbnail preview.'
                : 'Img2Img uploads your image to a bucket, rescales it with dataPreparation, then runs the workflow.'}
            </p>
          </header>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2" data-testid="imggen-mode-tabs">
              <Button
                variant={mode === 'txt2img' ? 'default' : 'outline'}
                size="sm"
                className="min-h-10 flex-1 sm:flex-none"
                onClick={() => switchMode('txt2img')}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                Txt2Img
              </Button>
              <Button
                variant={mode === 'img2img' ? 'default' : 'outline'}
                size="sm"
                className="min-h-10 flex-1 sm:flex-none"
                onClick={() => switchMode('img2img')}
                data-testid="imggen-mode-img2img"
              >
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
                Img2Img
              </Button>
              <Button
                variant={mode === 'txt2video' ? 'default' : 'outline'}
                size="sm"
                className="min-h-10 flex-1 sm:flex-none"
                onClick={() => switchMode('txt2video')}
                data-testid="imggen-mode-txt2video"
              >
                <Video className="mr-1 h-3.5 w-3.5" />
                Txt2Video
              </Button>
              <Button
                variant={mode === 'img2video' ? 'default' : 'outline'}
                size="sm"
                className="min-h-10 flex-1 sm:flex-none"
                onClick={() => switchMode('img2video')}
                data-testid="imggen-mode-img2video"
              >
                <Video className="mr-1 h-3.5 w-3.5" />
                Img2Video
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2" data-testid="imggen-capability-select">
                <Label>Model</Label>
                <ImgGenModelPicker
                  capabilities={capabilities}
                  selected={capability}
                  onSelect={setCapability}
                  onRefresh={refreshCapabilities}
                  capabilitiesStatus={capabilitiesStatus}
                  capabilitiesError={capabilitiesError}
                />
                {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No models found for this mode. Start an imggen agent or check OffloadMQ connection in Settings.
                  </p>
                )}
              </div>

              {isInputImageMode(mode) && (
                <div className="space-y-3 sm:col-span-2" data-testid="imggen-input-section">
                  <Label>Input image</Label>
                  <div className="flex flex-wrap items-start gap-2">
                    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50">
                      <Upload className="h-3.5 w-3.5" />
                      {uploading ? 'Uploading…' : 'Upload'}
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={() => setPickerOpen(true)}
                      data-testid="imggen-pick-from-library"
                    >
                      <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                      From library
                    </Button>
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
                    <ImageLightbox
                      src={
                        uploadedInput
                          ? imageFileUrl(uploadedInput.image_id, token, mediaRevision)
                          : inputPreviewUrl!
                      }
                      alt="Input preview"
                      triggerClassName="relative block w-full max-w-xs overflow-hidden rounded-lg bg-muted/30"
                      testId="imggen-input-preview"
                      actions={
                        uploadedInput
                          ? lightboxActions(
                              uploadedInput.image_id,
                              uploadedInput.filename,
                              'input',
                            )
                          : undefined
                      }
                    >
                      <img
                        src={
                          uploadedInput
                            ? imageFileUrl(uploadedInput.image_id, token, mediaRevision)
                            : inputPreviewUrl!
                        }
                        alt=""
                        aria-hidden
                        className="max-h-48 w-full object-contain bg-muted/30"
                      />
                    </ImageLightbox>
                  )}
                </div>
              )}

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="prompt">Prompt</Label>
                <PromptTextarea
                  id="prompt"
                  value={prompt}
                  onChange={setPrompt}
                  bucket="imggen-prompt"
                  token={token}
                  rows={4}
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
                  <PromptTextarea
                    id="negative-prompt"
                    value={negativePrompt}
                    onChange={setNegativePrompt}
                    bucket="imggen-negative"
                    token={token}
                    rows={2}
                    placeholder="e.g. blurry, deformed, low quality"
                    data-testid="imggen-negative-prompt"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Using workflow default negative prompt.</p>
                )}
              </div>

              <div className="space-y-2 sm:col-span-2" data-testid="imggen-dimensions">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="width">Width</Label>
                    <Input
                      id="width"
                      type="number"
                      value={width}
                      disabled={originalResolution}
                      onChange={e => {
                        if (isInputImageMode(mode) && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                        const w = Number(e.target.value) || 1024
                        setWidth(w)
                        if (keepProportions && uploadedInput) {
                          setHeight(proportionalCounterpart('width', w, uploadedInput.width, uploadedInput.height))
                        }
                      }}
                      data-testid="imggen-width"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="mb-0.5 shrink-0"
                    disabled={ratioLocked}
                    onClick={() => {
                      if (mode === 'img2img' && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                      setWidth(height)
                      setHeight(width)
                    }}
                    title={ratioLocked ? 'Disabled while proportions are locked' : 'Swap width and height'}
                    data-testid="imggen-swap-dims"
                  >
                    <ArrowLeftRight className="size-4" />
                  </Button>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="height">Height</Label>
                    <Input
                      id="height"
                      type="number"
                      value={height}
                      disabled={originalResolution}
                      onChange={e => {
                        if (isInputImageMode(mode) && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                        const h = Number(e.target.value) || 1024
                        setHeight(h)
                        if (keepProportions && uploadedInput) {
                          setWidth(proportionalCounterpart('height', h, uploadedInput.width, uploadedInput.height))
                        }
                      }}
                      data-testid="imggen-height"
                    />
                  </div>
                  {isInputImageMode(mode) && uploadedInput && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mb-0.5 shrink-0 text-xs"
                      disabled={originalResolution}
                      onClick={() => {
                        if (rescale.mode === 'exact') rescaleUserEditedRef.current = false
                        setWidth(uploadedInput.width)
                        setHeight(uploadedInput.height)
                      }}
                      title={`Use input dimensions: ${uploadedInput.width}×${uploadedInput.height}`}
                      data-testid="imggen-copy-from-input"
                    >
                      <ImagePlus className="mr-1 size-3.5" />
                      Input
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {dimensionPresets.map(([w, h]) => (
                    <button
                      key={`${w}x${h}`}
                      type="button"
                      disabled={originalResolution}
                      onClick={() => {
                        if (isInputImageMode(mode) && rescale.mode === 'exact') rescaleUserEditedRef.current = false
                        setWidth(w)
                        setHeight(h)
                      }}
                      className={cn(
                        'h-7 rounded-md border border-input bg-background px-2 text-xs transition-colors hover:bg-muted/50',
                        width === w && height === h && 'border-primary bg-primary/10 text-primary',
                        originalResolution && 'cursor-not-allowed opacity-50 hover:bg-background',
                      )}
                      data-testid={`imggen-preset-${w}x${h}`}
                    >
                      {w}×{h}
                    </button>
                  ))}
                </div>
                {mode === 'img2img' && uploadedInput && (
                  <div className="flex flex-col gap-1.5 pt-0.5" data-testid="imggen-resolution-toggles">

                    {canUseOriginalResolution && (
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={originalResolution}
                          onChange={e => {
                            const next = e.target.checked
                            setOriginalResolution(next)
                            if (next) {
                              setWidth(uploadedInput.width)
                              setHeight(uploadedInput.height)
                            }
                          }}
                          className="rounded border-border"
                          data-testid="imggen-original-resolution"
                        />
                        Original resolution ({uploadedInput.width}×{uploadedInput.height})
                      </label>
                    )}
                    <label
                      className={cn(
                        'flex w-fit items-center gap-2 text-sm text-muted-foreground',
                        originalResolution ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={ratioLocked}
                        disabled={originalResolution}
                        onChange={e => {
                          const next = e.target.checked
                          setKeepProportions(next)
                          if (next && uploadedInput) {
                            rescaleUserEditedRef.current = false
                            setHeight(
                              proportionalCounterpart('width', width, uploadedInput.width, uploadedInput.height),
                            )
                          }
                        }}
                        className="rounded border-border"
                        data-testid="imggen-keep-proportions"
                      />
                      Keep proportions
                      {originalResolution && ' (locked to original)'}
                    </label>
                  </div>
                )}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="seed">Seed (optional)</Label>
                <Input id="seed" value={seed} onChange={e => setSeed(e.target.value)} placeholder="empty = random" />
              </div>
            </div>

            {mode === 'img2img' && !originalResolution && (
              <details className="group" data-testid="imggen-advanced">

                <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronDown className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
                  Offload rescaling
                </summary>
                <div className="mt-2">
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
                    label="Rescale before workflow"
                  />
                </div>
              </details>
            )}

            <div className="relative sm:w-auto">
              <motion.div
                className="flex justify-center sm:w-auto"
                animate={submitBurst ? { scale: [1, 1.06, 0.97, 1] } : {}}
                transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
              >
                <Button
                  className="relative min-h-11 w-full overflow-hidden sm:w-auto"
                  onClick={() => {
                    setSubmitBurst(true)
                    window.setTimeout(() => setSubmitBurst(false), 900)
                    void onSubmit()
                  }}
                  disabled={!canSubmit || submitting}
                  data-testid="imggen-submit-job"
                >
                  <AnimatePresence>
                    {submitBurst && (
                      <motion.span
                        key="shimmer"
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 left-0 w-1/2 skew-x-12"
                        style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)' }}
                        initial={{ x: '-100%' }}
                        animate={{ x: '320%' }}
                        transition={{ duration: 0.42, ease: 'easeInOut' }}
                      />
                    )}
                  </AnimatePresence>
                  {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  {mode === 'img2img' ? 'Edit Image'
                    : mode === 'txt2video' ? 'Generate Video'
                    : mode === 'img2video' ? 'Animate Image'
                    : 'Generate Image'}
                </Button>
              </motion.div>

              <AnimatePresence>
                {submitBurst &&
                  BURST_SPARKS.map((p, i) => (
                    <motion.span
                      key={i}
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-1/2 text-primary"
                      style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1, filter: 'drop-shadow(0 0 3px currentColor)' }}
                      initial={{ x: 0, y: 0, opacity: 1, scale: 0 }}
                      animate={{ x: p.x, y: p.y, opacity: 0, scale: 1.6 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.55, delay: p.delay, ease: [0.22, 1, 0.36, 1] }}
                    >
                      ✦
                    </motion.span>
                  ))}
              </AnimatePresence>
            </div>

            {info && activePanel === IMGGEN_NEW_PANEL && (
              <p className="text-xs text-muted-foreground">{info}</p>
            )}
            {error && activePanel === IMGGEN_NEW_PANEL && (
              <JobErrorBanner message={error} testId="imggen-error" />
            )}
          </div>
        </section>
        )}

        {viewingJob && (
          <motion.div
            key={activePanel}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
          {error && <JobErrorBanner message={error} testId="imggen-job-error" />}
          {jobDetailLoading ? (
            <div className="flex min-h-[40vh] items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : selectedJob?.job_id === viewedJobId ? (
          <Card data-testid="imggen-job-detail" className="overflow-hidden">

            {/* ── Output / compare area — full-bleed at top ── */}
            {compareMode && canCompare ? (
              <div className="grid grid-cols-2 gap-px bg-border" data-testid="imggen-compare-view">
                <div className="relative overflow-hidden bg-muted/10">
                  <span className="absolute left-2 top-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                    Before
                  </span>
                  <ImageLightbox
                    src={imageFileUrl(selectedJob.input_image_id!, token, mediaRevision)}
                    alt="Input"
                    triggerClassName="group block w-full overflow-hidden"
                    testId="imggen-compare-input"
                    actions={lightboxActions(selectedJob.input_image_id!, 'Input', 'input')}
                  >
                    <img
                      src={imageFileUrl(selectedJob.input_image_id!, token, mediaRevision)}
                      alt=""
                      aria-hidden
                      className="w-full object-contain max-h-[40dvh] sm:max-h-[65vh] transition-opacity group-hover:opacity-95"
                    />
                  </ImageLightbox>
                </div>
                <div className="relative overflow-hidden bg-muted/10">
                  <span className="absolute left-2 top-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                    After
                  </span>
                  {outputFiles.map(file => (
                    <ImageLightbox
                      key={file.image_id}
                      src={imageFileUrl(file.image_id, token, mediaRevision)}
                      alt={file.filename}
                      triggerClassName="group block w-full overflow-hidden"
                      testId={`imggen-compare-output-${file.image_id}`}
                      actions={lightboxActions(
                        file.image_id,
                        file.filename,
                        file.direction,
                        () => sendToImg2Img(file),
                      )}
                    >
                      <img
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        alt=""
                        aria-hidden
                        className="w-full object-contain max-h-[40dvh] sm:max-h-[65vh] transition-opacity group-hover:opacity-95"
                      />
                    </ImageLightbox>
                  ))}
                </div>
              </div>
            ) : outputFiles.length > 0 ? (
              <div className={outputFiles.length > 1 ? 'grid grid-cols-2 gap-px bg-border' : undefined}>
                {outputFiles.map(file =>
                  file.content_type.startsWith('video/') ? (
                    <div key={file.image_id} className="w-full bg-muted/20" data-testid={`imggen-output-${file.image_id}`}>
                      <video
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        controls
                        loop
                        className="w-full max-h-[70vh] object-contain"
                      />
                    </div>
                  ) : (
                    <ImageLightbox
                      key={file.image_id}
                      src={imageFileUrl(file.image_id, token, mediaRevision)}
                      alt={file.filename}
                      caption={`${file.filename} — ${file.width}×${file.height}`}
                      triggerClassName="group block w-full overflow-hidden bg-muted/20"
                      testId={`imggen-output-${file.image_id}`}
                      actions={lightboxActions(
                        file.image_id,
                        file.filename,
                        file.direction,
                        () => sendToImg2Img(file),
                      )}
                    >
                      <img
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        alt=""
                        aria-hidden
                        className="w-full object-contain max-h-[70vh] transition-opacity group-hover:opacity-95"
                      />
                    </ImageLightbox>
                  )
                )}
              </div>
            ) : isRunning ? (
              <div className="flex aspect-video w-full items-center justify-center bg-muted/30">
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <Loader2 className="size-10 animate-spin opacity-40" />
                  <p className="text-sm font-medium capitalize">
                    {activePoll?.stage ?? displayStatus ?? 'Generating…'}
                  </p>
                </div>
              </div>
            ) : displayStatus === 'failed' ? (
              !error ? (
                <div className="flex aspect-video w-full items-center justify-center bg-destructive/5 px-6">
                  <JobErrorBanner
                    message={selectedJob.error || 'Generation failed'}
                    testId="imggen-job-failed"
                  />
                </div>
              ) : null
            ) : null}

            {/* ── Compact title + meta ── */}
            <div className="border-b border-border px-4 py-3 space-y-0.5">
              <h2 className="font-display text-base font-semibold leading-snug">
                {jobPromptTitle(selectedJob.prompt, 120)}
              </h2>
              <p className="font-mono text-xs text-muted-foreground" data-testid="imggen-job-tech-meta">
                {jobTechMeta(selectedJob)} · {selectedJob.status.replace(/_/g, ' ')}
              </p>
            </div>

            <CardContent className="space-y-4 pt-4">

              {/* ── Actions ── */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={editPromptFromJob}
                  data-testid="imggen-edit-prompt"
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  Edit prompt
                </Button>
                {canRetryJob && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => viewedJobId && void onRetryJob(viewedJobId)}
                    disabled={!viewedJobId || retrying}
                    data-testid="imggen-retry-job"
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
                  onClick={() => viewedJobId && void runPoll(viewedJobId)}
                  disabled={!viewedJobId || polling}
                  data-testid="imggen-poll-job"
                >
                  {polling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  Poll now
                </Button>
                {isRunning && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => viewedJobId && void onCancelJob(viewedJobId)}
                    data-testid="imggen-cancel-job"
                  >
                    <Square className="mr-1 h-4 w-4 fill-current" />
                    Cancel
                  </Button>
                )}
                {isRunning && (
                  <span className="flex items-center text-xs text-muted-foreground">
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Auto-polling every {POLL_MS / 1000}s…
                  </span>
                )}
                {canCompare && (
                  <Button
                    type="button"
                    variant={compareMode ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setCompareMode(v => !v)}
                    data-testid="imggen-compare-toggle"
                  >
                    <Columns2 className="mr-1 h-4 w-4" />
                    {compareMode ? 'Result' : 'Compare'}
                  </Button>
                )}
              </div>
              {info && <p className="text-xs text-muted-foreground">{info}</p>}

              {/* ── Pipeline accordion ── */}
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

              {/* ── Prompt ── */}
              <section className="space-y-1.5" data-testid="imggen-job-prompt">
                <h3 className="text-xs font-medium text-muted-foreground">Prompt</h3>
                <p className="whitespace-pre-wrap text-sm text-foreground">{selectedJob.prompt.trim() || '—'}</p>
              </section>

              {/* ── Params ── */}
              <PipelineJobParamsPanel job={selectedJob} />

              {/* ── Input image (compact param row) ── */}
              {selectedJob.input_image_id && (
                <div className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
                    Input image
                  </span>
                  <ImageLightbox
                    src={imageFileUrl(selectedJob.input_image_id, token, mediaRevision)}
                    alt="Job input"
                    triggerClassName="block shrink-0"
                    testId="imggen-job-input"
                    actions={lightboxActions(selectedJob.input_image_id, 'Job input', 'input')}
                  >
                    <img
                      src={imageFileUrl(selectedJob.input_image_id, token, mediaRevision)}
                      alt=""
                      aria-hidden
                      className="h-14 w-14 rounded-md object-cover bg-muted/40"
                    />
                  </ImageLightbox>
                </div>
              )}

            </CardContent>
          </Card>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Could not load this job.</p>
          )}
          </motion.div>
        )}
          </div>
        </main>
      </div>
    </div>

    {token && (
      <ImagePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={img => {
          setUploadedInput(img)
          applyInputDefaults(img)
          setInputPreviewUrl(null)
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
    </>
  )
}
