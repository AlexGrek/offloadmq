import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeftRight,
  ChevronDown,
  Columns2,
  Download,
  FolderOpen,
  ImagePlus,
  Loader2,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Star,
  Trash2,
  Pencil,
  Shuffle,
  Sparkles,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MorphCollapse, MorphIn } from '@/components/Morph'
import { useMorph } from '@/lib/motion'
import { ImageLightbox, type ImageLightboxActions } from '@/components/ImageLightbox'
import { LoadingImage } from '@/components/LoadingImage'
import { PromptTextarea } from '../components/PromptTextarea'
import { SavedPromptsDrawer } from '../components/prompts/SavedPromptsDrawer'
import { RewritePromptDialog } from '../components/imggen/RewritePromptDialog'
import { NudeDetectModal } from '@/components/nudedetect/NudeDetectModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import { getSettings } from '../api/admin'
import {
  externalResizeDefault,
  getExternalResizeInfo,
  getImageJob,
  imageFileUrl,
  listImgGenCapabilities,
  listImageJobs,
  cancelImageJob,
  deleteImageJob,
  pollImageJob,
  retryImageJob,
  startImageJob,
  type ExternalResizeInfo,
  type ImgGenCapability,
  type ImageJobDetails,
  type ImageJobFile,
  type PollImageJobResponse,
  type UploadedImage,
  uploadImage,
} from '../api/images'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { markImageDownloaded, triggerImageDownload } from '../lib/downloadedImages'
import RescaleControls from '../components/imggen/RescaleControls'
import {
  ImageJobHistorySidebar,
  IMGGEN_NEW_PANEL,
} from '../components/imggen/ImageJobHistorySidebar'
import { PipelineJobParamsPanel } from '../components/imggen/PipelineJobParamsPanel'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { ImgGenModelPicker } from '../components/imggen/ImgGenModelPicker'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { InputImageGrid } from '../components/imggen/InputImageGrid'
import { VideoPromptGenerator } from '../components/imggen/VideoPromptGenerator'
import { ToolDebugHeaderButton, ToolDebugModal } from '../components/ToolDebugModal'
import { toolDebugReady } from '../lib/toolDebug'
import { ToolSidebar } from '../components/ToolSidebar'
import {
  MODE_DEFAULTS,
  randomTxt2imgPrompt,
  randomTxt2videoPrompt,
  applyPipelineParamsToNewForm,
  applyStoredGenerationParamsToNewForm,
  DIMENSION_PRESETS,
  filterCapabilitiesByWorkflow,
  fitsOriginalResolution,
  isInputImageMode,
  imageJobFingerprint,
  isVideoMode,
  jobPromptTitle,
  jobTechMeta,
  pipelineParamsFromStored,
  proportionalCounterpart,
  proportionalPresets,
  proportionalSize,
  appendInputs,
  batchInputDims,
  MAX_BATCH_INPUT_IMAGES,

  pipelineEventsWithoutPolls,
  pipelineStatusLine,
  imageJobStatusLabel,
  formatDuration,
  parseVideoLength,
  rescaleDataPrep,
  type ImgGenMode,
  type ImggenRouteState,
  type ApplyPipelineToNewFormHandlers,
  type RescaleState,
} from '../lib/imggen'
import { ExternalResizeToggle } from '../components/ExternalResizeToggle'
import { keepIfUnchanged, mergeJobList, upsertJob } from '../lib/jobMerge'
import { createPlaceholderUsage, expandPromptPlaceholders } from '../lib/promptPlaceholders'
import { listPromptPlaceholders } from '../api/promptPlaceholders'
import { recordRecentPrompt } from '../api/prompts'
import { RecentPlaceholders } from '../components/imggen/RecentPlaceholders'
import { recordPlaceholdersUsed } from '../lib/recentPlaceholders'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import type { ImagePipelineRescaleParams, StartImageJobRequest } from '../api/images'
import {
  ImgUtilsQuickModal,
  type QuickTransformTarget,
} from '@/components/imgutils/ImgUtilsQuickModal'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const MAX_GENERATE_MULTIPLE = 10
const DEFAULT_GENERATE_MULTIPLE = 4

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
/** Silent background refresh of the pipelines sidebar list (no loading UI). */
const JOBS_LIST_REFRESH_MS = 20_000

const MODE_TABS: { mode: ImgGenMode; label: string; icon: LucideIcon }[] = [
  { mode: 'txt2img', label: 'Txt2Img', icon: Sparkles },
  { mode: 'img2img', label: 'Img2Img', icon: ImagePlus },
  { mode: 'txt2video', label: 'Txt2Video', icon: Video },
  { mode: 'img2video', label: 'Img2Video', icon: Video },
]

function submitLabelFor(mode: ImgGenMode, inputCount: number): string {
  switch (mode) {
    case 'img2img':
      return inputCount > 1 ? `Edit ${inputCount} Images` : 'Edit Image'
    case 'txt2video':
      return 'Generate Video'
    case 'img2video':
      return inputCount > 1 ? `Animate ${inputCount} Images` : 'Animate Image'
    default:
      return 'Generate Image'
  }
}

type SlideshowEntry = {
  file: ImageJobFile
  jobId: string
  prompt: string
}

/** Poll-shaped snapshot of a job's stored state (before any live MQ poll). */
function pollSnapshot(details: ImageJobDetails): PollImageJobResponse {
  return {
    job_id: details.job_id,
    status: details.status,
    stage: null,
    error: details.error,
    started_at: details.started_at ?? null,
    typical_runtime_seconds: details.typical_runtime_seconds ?? null,
    submitted_at: details.submitted_at ?? null,
    queued_seconds: details.queued_seconds ?? null,
    execution_seconds: details.execution_seconds ?? null,
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
}

/** `next` unless it is structurally equal to `prev` (avoids no-op re-renders). */
function samePollOr(
  prev: PollImageJobResponse | null,
  next: PollImageJobResponse,
): PollImageJobResponse {
  return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

/** `width`/`height` props for an `<img>`/`<video>`, omitted when unknown. */
function intrinsicSize(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : undefined
}

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
  const { refreshRunningImageJobs, runningImageJobs, setForegroundJob } = useProgress()
  const isMobile = useIsMobile()
  const morph = useMorph()
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<ImgGenMode>('txt2img')
  const [prompt, setPrompt] = useState(() => randomTxt2imgPrompt())
  const [negativePrompt, setNegativePrompt] = useState('')
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [capability, setCapability] = useState('')
  const [allCapabilities, setAllCapabilities] = useState<ImgGenCapability[]>([])
  // Start in 'loading' (not 'idle') so the picker shows its skeleton from the
  // first paint instead of flashing "No models" before the fetch begins.
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>(() =>
    token ? 'loading' : 'idle',
  )
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [width, setWidth] = useState(MODE_DEFAULTS.txt2img.width)
  const [height, setHeight] = useState(MODE_DEFAULTS.txt2img.height)
  const [seed, setSeed] = useState('')
  const [videoLength, setVideoLength] = useState('25')
  const [rescale, setRescale] = useState<RescaleState>(DEFAULT_RESCALE)
  // img2img "original resolution": lock generation dims to the input image and pass it
  // through to the agent un-rescaled. Only offered for sub-4K inputs; default-on after upload.
  const [originalResolution, setOriginalResolution] = useState(false)
  // img2img "keep proportions": lock the output aspect ratio to the input image's and offer
  // proportional dimension presets. Default-on whenever an input is present.
  const [keepProportions, setKeepProportions] = useState(false)
  const rescaleUserEditedRef = useRef(false)

  // External resize: hand the input downscale to an `image_resize` agent rather
  // than decoding it in the backend. Offered only while such an agent is online.
  const [externalResizeInfo, setExternalResizeInfo] = useState<ExternalResizeInfo | null>(null)
  const [externalResize, setExternalResize] = useState(false)

  const [uploadedInputs, setUploadedInputs] = useState<UploadedImage[]>([])
  // The first input drives the form (dims, presets, preview). With several,
  // each one becomes its own job on submit and "Generate multiple" is off.
  const uploadedInput = uploadedInputs[0] ?? null
  const multiInput = uploadedInputs.length > 1
  const largestInputBytes = useMemo(
    () => Math.max(0, ...uploadedInputs.map(img => img.size_bytes)),
    [uploadedInputs],
  )
  const [inputPreviewUrl, setInputPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [activePanel, setActivePanel] = useState<string>(IMGGEN_NEW_PANEL)
  const [activePoll, setActivePoll] = useState<PollImageJobResponse | null>(null)
  const [jobs, setJobs] = useState<ImageJobDetails[]>([])
  const [fetchedJob, setSelectedJob] = useState<ImageJobDetails | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)
  const [debugOpen, setDebugOpen] = useState(false)
  const [deletingJob, setDeletingJob] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [starredPromptsOpen, setStarredPromptsOpen] = useState(false)
  const [rewritePromptOpen, setRewritePromptOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [slideshowOn, setSlideshowOn] = useState(false)
  const [slideshowCurrent, setSlideshowCurrent] = useState<SlideshowEntry | null>(null)
  const slideshowSeenRef = useRef<Set<string>>(new Set())
  const slideshowQueueRef = useRef<SlideshowEntry[]>([])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const filteredJobs = useMemo(() => {
    if (!deferredSearchQuery.trim()) return jobs
    const q = deferredSearchQuery.toLowerCase()
    return jobs.filter(j => j.prompt.toLowerCase().includes(q))
  }, [jobs, deferredSearchQuery])
  const [nudeDetectTarget, setNudeDetectTarget] = useState<{
    imageId: string
    filename: string
  } | null>(null)
  const [imgUtilsTarget, setImgUtilsTarget] = useState<QuickTransformTarget | null>(null)
  const [mediaRevision, setMediaRevision] = useState(0)
  const [submitBurst, setSubmitBurst] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [rescaleOpen, setRescaleOpen] = useState(false)
  const [generateMultipleOpen, setGenerateMultipleOpen] = useState(false)
  const [generateMultipleCountInput, setGenerateMultipleCountInput] = useState(
    String(DEFAULT_GENERATE_MULTIPLE),
  )
  const generateMultipleCountRef = useRef<HTMLInputElement>(null)

  const viewingJob = activePanel !== IMGGEN_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  // The list endpoint returns full job details, so the viewed job renders from
  // the list straight away and is swapped for its own fetch when that lands —
  // switching jobs never flashes a skeleton, a stale job or "Could not load".
  const selectedJob = useMemo(() => {
    if (!viewedJobId || fetchedJob?.job_id === viewedJobId) return fetchedJob
    return jobs.find(j => j.job_id === viewedJobId) ?? null
  }, [viewedJobId, fetchedJob, jobs])
  const jobsRef = useRef(jobs)
  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  useEffect(() => {
    setDebugOpen(false)
  }, [activePanel])

  // Another page (e.g. image analysis "Use as prompt", files "Edit"/"Animate") can route
  // here with state to prefill. Handled after sendOutputToInputMode is defined below.


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

  // "Original resolution" is only meaningful for img2img (not img2video), and
  // needs every input under 4K — each job then runs at its own input's size.
  const canUseOriginalResolution = useMemo(
    () =>
      mode === 'img2img' &&
      uploadedInputs.length > 0 &&
      uploadedInputs.every(img => fitsOriginalResolution(img.width, img.height)),
    [mode, uploadedInputs],
  )

  // Output aspect ratio is locked to the input whenever either toggle is on.
  const ratioLocked = originalResolution || keepProportions

  // Dimension presets: proportional variants of the input while ratio-locked, else square/common sizes.
  const dimensionPresets = useMemo<[number, number][]>(() => {
    if (ratioLocked && uploadedInput) {
      return proportionalPresets(uploadedInput.width, uploadedInput.height)
    }
    return DIMENSION_PRESETS
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

  // Availability + threshold for the External resize option. A failure here is
  // not worth surfacing: the option simply stays hidden.
  const loadExternalResizeInfo = useCallback(async () => {
    if (!token) return
    try {
      setExternalResizeInfo(await getExternalResizeInfo(token))
    } catch {
      setExternalResizeInfo(null)
    }
  }, [token])

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

  const refreshJobs = useCallback(async () => {
    if (!token) return
    setJobsLoading(true)
    try {
      const list = await listImageJobs(token)
      setJobs(prev => mergeJobList(prev, list, imageJobFingerprint))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  // Keep the pipelines list fresh without any loading UI: no `jobsLoading`
  // toggle (which would flash the skeleton / spin the refresh icon) and no error
  // banner — a failed background tick just waits for the next one. Skipped while
  // the tab is hidden, and while the slideshow is on (its own tick already lists jobs).
  useEffect(() => {
    if (!token || slideshowOn) return
    let cancelled = false
    const id = window.setInterval(async () => {
      if (document.hidden) return
      try {
        const list = await listImageJobs(token)
        if (!cancelled) setJobs(prev => mergeJobList(prev, list, imageJobFingerprint))
      } catch {
        // silent
      }
    }, JOBS_LIST_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [token, slideshowOn])

  const toggleSlideshow = useCallback(() => {
    setSlideshowOn(prev => {
      const next = !prev
      if (next) {
        // Seed with everything already known so only genuinely new outputs pop the overlay.
        const seen = new Set<string>()
        for (const job of jobs) {
          for (const f of job.files) {
            if (f.direction === 'output') seen.add(f.image_id)
          }
        }
        slideshowSeenRef.current = seen
        slideshowQueueRef.current = []
      } else {
        slideshowQueueRef.current = []
        setSlideshowCurrent(null)
      }
      return next
    })
  }, [jobs])

  const closeSlideshow = useCallback(() => {
    setSlideshowOn(false)
    slideshowQueueRef.current = []
    setSlideshowCurrent(null)
  }, [])

  // Slideshow: poll for freshly completed output images (not just the viewed job)
  // and surface each one full-screen as it appears, one per tick.
  useEffect(() => {
    if (!slideshowOn || !token) return
    let cancelled = false
    const tick = async () => {
      let list: ImageJobDetails[]
      try {
        list = await listImageJobs(token)
      } catch {
        return
      }
      if (cancelled) return
      setJobs(prev => mergeJobList(prev, list, imageJobFingerprint))
      // Newest-first from the API — walk oldest-to-newest so the queue fills in generation order.
      for (const job of [...list].reverse()) {
        for (const file of job.files) {
          if (file.direction !== 'output') continue
          if (file.content_type.startsWith('video/')) continue
          if (slideshowSeenRef.current.has(file.image_id)) continue
          slideshowSeenRef.current.add(file.image_id)
          slideshowQueueRef.current.push({ file, jobId: job.job_id, prompt: job.prompt })
        }
      }
      if (slideshowQueueRef.current.length > 0) {
        setSlideshowCurrent(slideshowQueueRef.current.shift() ?? null)
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [slideshowOn, token])

  useEffect(() => {
    if (!token) {
      setAllCapabilities([])
      setCapabilitiesStatus('idle')
      setCapabilitiesError(null)
      return
    }
    // Independent fetches run in parallel so every section fills in at once.
    getSettings(token)
      .then(settings => {
        if (!settings.client_api_token) {
          setInfo('Admin should configure OffloadMQ client token in Settings -> Server.')
        }
      })
      .catch(() => {
        // non-fatal
      })
    void refreshJobs()
    void loadCapabilities()
    void loadExternalResizeInfo()
  }, [token, loadCapabilities, loadExternalResizeInfo, refreshJobs])

  const refreshCapabilities = useCallback(() => {
    void loadCapabilities()
  }, [loadCapabilities])

  const capabilityInitialized = useRef(false)

  // Layout effect: the chosen model is in place before paint, so the picker
  // never shows "Pick model" for a frame. The first pick waits for the job list
  // (capabilities and jobs load in parallel) so the last-used model wins.
  useLayoutEffect(() => {
    if (capabilities.length === 0) return

    if (!capabilityInitialized.current) {
      if (jobsLoading) return
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
  }, [capabilities, capability, jobs, jobsLoading])

  // Until a model is picked, keep the picker on its loading skeleton.
  const pickerStatus: CapabilitiesStatus =
    capabilitiesStatus === 'ready' && capabilities.length > 0 && !capability
      ? 'loading'
      : capabilitiesStatus

  // Apply defaults after the input images change. For img2img: lock proportions + use original
  // resolution when every input is sub-4K; dims come from the first input. For video modes: leave
  // output resolution untouched — the user sets it independently. `forMode` defaults to current
  // `mode` but must be passed explicitly when called from switchMode (where React state hasn't
  // flushed yet).
  function applyInputDefaults(imgs: UploadedImage[], forMode: ImgGenMode = mode): boolean {
    const [first] = imgs
    if (!first) {
      setOriginalResolution(false)
      setKeepProportions(false)
      return false
    }
    // Big uploads are the ones the backend stored at full size, so they are
    // exactly the ones worth shrinking on an agent.
    const threshold = externalResizeInfo?.threshold_bytes ?? Infinity
    setExternalResize(
      isInputImageMode(forMode) &&
        imgs.some(img => externalResizeDefault(img.size_bytes, threshold)),
    )
    if (forMode !== 'img2img') {
      setKeepProportions(false)
      setOriginalResolution(false)
      rescaleUserEditedRef.current = false
      return false
    }
    const fits = imgs.every(img => fitsOriginalResolution(img.width, img.height))
    setKeepProportions(true)
    setOriginalResolution(fits)
    rescaleUserEditedRef.current = false
    if (fits) {
      setWidth(first.width)
      setHeight(first.height)
    } else {
      const [w, h] = proportionalSize(first.width, first.height, 1024)
      setWidth(w)
      setHeight(h)
    }
    return fits
  }

  function switchMode(next: ImgGenMode) {
    if (next === mode) return
    setMode(next)
    const defaults = MODE_DEFAULTS[next]
    setPrompt(
      next === 'txt2img'
        ? randomTxt2imgPrompt()
        : next === 'txt2video'
          ? randomTxt2videoPrompt()
          : defaults.prompt,
    )
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
      setUploadedInputs([])
      setInputPreviewUrl(null)
      setOriginalResolution(false)
      setKeepProportions(false)
    } else if (uploadedInputs.length > 0) {
      applyInputDefaults(uploadedInputs, next)
    } else {
      setOriginalResolution(false)
      setKeepProportions(false)
    }
  }

  /** Info line after the input set changed; `skipped` counts files dropped by the cap. */
  function inputSetInfo(imgs: UploadedImage[], original: boolean, skipped: number): string {
    const capNote = skipped > 0
      ? ` ${skipped} more skipped — at most ${MAX_BATCH_INPUT_IMAGES} input images.`
      : ''
    if (imgs.length > 1) return `${imgs.length} input images — one job per image.${capNote}`
    const [img] = imgs
    return (
      (original
        ? `Uploaded ${img.filename} (${img.width}×${img.height}). Generating at original resolution.`
        : `Uploaded ${img.filename} as ${img.width}×${img.height}.`) + capNote
    )
  }

  /** Uploads `files` one by one and appends them to the input set. */
  async function onUpload(files: File[]) {
    if (!token || files.length === 0) return
    const room = MAX_BATCH_INPUT_IMAGES - uploadedInputs.length
    if (room <= 0) {
      setError(`At most ${MAX_BATCH_INPUT_IMAGES} input images — remove one to add another.`)
      return
    }
    const batch = files.slice(0, room)
    setUploading(true)
    setError(null)
    setInfo('Uploading and normalizing image (EXIF-aware, max 1920px).')
    // Instant local preview only for the plain single-image case; a set shows server thumbnails.
    if (uploadedInputs.length === 0 && batch.length === 1) {
      const preview = URL.createObjectURL(batch[0])
      setInputPreviewUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return preview
      })
    }
    let next = uploadedInputs
    const failures: string[] = []
    for (const [i, file] of batch.entries()) {
      setUploadProgress({ done: i + 1, total: batch.length })
      try {
        next = appendInputs(next, [await uploadImage(token, file)])
        setUploadedInputs(next)
      } catch (e) {
        failures.push(batch.length > 1 ? `${file.name}: ${(e as Error).message}` : (e as Error).message)
      }
    }
    setUploading(false)
    setUploadProgress(null)
    if (next.length === 0) {
      clearInput()
    } else {
      setInfo(inputSetInfo(next, applyInputDefaults(next), files.length - batch.length))
    }
    if (failures.length > 0) setError(failures.join('; '))
  }

  /** Appends library picks to the input set. */
  function onPickInputs(picked: UploadedImage[]) {
    const next = appendInputs(uploadedInputs, picked)
    setUploadedInputs(next)
    setInputPreviewUrl(null)
    const original = applyInputDefaults(next)
    if (next.length > 1) {
      const fresh = picked.filter(p => !uploadedInputs.some(img => img.image_id === p.image_id))
      setInfo(inputSetInfo(next, original, fresh.length - (next.length - uploadedInputs.length)))
    }
  }

  function removeInput(imageId: string) {
    const next = uploadedInputs.filter(img => img.image_id !== imageId)
    if (next.length === 0) {
      clearInput()
      return
    }
    setUploadedInputs(next)
    applyInputDefaults(next)
  }

  function clearInput() {
    setUploadedInputs([])
    setOriginalResolution(false)
    setKeepProportions(false)
    setInputPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }

  /**
   * Publishes a fetched job to the selected-job and list state. Unchanged
   * snapshots keep their previous object so idle polls don't re-render
   * anything; a brand-new job (just submitted) is prepended.
   */
  const applyJobDetails = useCallback((details: ImageJobDetails) => {
    setSelectedJob(prev => keepIfUnchanged(prev, details, imageJobFingerprint))
    setJobs(prev => upsertJob(prev, details, imageJobFingerprint))
  }, [])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const details = await getImageJob(token, jobId)
      applyJobDetails(details)
      return details
    },
    [token, applyJobDetails],
  )

  const onImageMutated = useCallback(async () => {
    setMediaRevision(v => v + 1)
    if (viewedJobId) await refreshJob(viewedJobId)
  }, [viewedJobId, refreshJob])

  /** Lightbox action set; `withImgUtils` (job outputs) adds Image Tools. Send-to-img2img/video
   *  handlers are spread in at the call site (they touch refs, so stay out of render-time calls). */
  function lightboxActions(imageId: string, filename: string, direction: string) {
    return token ? lightboxActionsFor(token, imageId, filename, direction) : undefined
  }

  function lightboxActionsFor(
    authToken: string,
    imageId: string,
    filename: string,
    direction: string,
    withImgUtils = false,
  ): ImageLightboxActions {
    return {
      imageId,
      filename,
      direction,
      token: authToken,
      onDeleted: onImageMutated,
      imgUtils: withImgUtils ? { onResult: onImageMutated } : undefined,
      onNudeDetect: () => setNudeDetectTarget({ imageId, filename }),
    }
  }

  function sendOutputToInputMode(
    file: {
      image_id: string
      filename: string
      content_type: string
      width: number
      height: number
      size_bytes: number
      rescaled: boolean
      reencoded: boolean
    },
    targetMode: 'img2img' | 'img2video',
    sourcePrompt?: string,
  ) {
    switchMode(targetMode)
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
    setUploadedInputs([img])
    const original = applyInputDefaults([img], targetMode)
    setInputPreviewUrl(null)
    setActivePanel(IMGGEN_NEW_PANEL)
    if (sourcePrompt) setPrompt(sourcePrompt)
    if (targetMode === 'img2video') {
      setInfo(
        `Input set to "${file.filename}" (${file.width}×${file.height}). Image to Video mode — adjust and submit when ready.`,
      )
    } else {
      setInfo(
        original
          ? `Input set to "${file.filename}" (${file.width}×${file.height}). Generating at original resolution.`
          : `Input set to "${file.filename}" (${file.width}×${file.height}). Adjust settings and submit.`,
      )
    }
    setError(null)
  }

  function sendToImg2Img(file: {
    image_id: string
    filename: string
    content_type: string
    width: number
    height: number
    size_bytes: number
    rescaled: boolean
    reencoded: boolean
  }) {
    sendOutputToInputMode(file, 'img2img')
  }

  function sendToImg2Video(
    file: {
      image_id: string
      filename: string
      content_type: string
      width: number
      height: number
      size_bytes: number
      rescaled: boolean
      reencoded: boolean
    },
    sourcePrompt?: string,
  ) {
    sendOutputToInputMode(file, 'img2video', sourcePrompt)
  }

  function sendToImgUtils(file: { image_id: string; filename: string; width: number; height: number }) {
    setImgUtilsTarget(file)
  }

  const pipelineFormHandlers = useMemo(
    (): ApplyPipelineToNewFormHandlers => ({
      setMode,
      setPrompt,
      setNegativePrompt,
      setOverrideNegative,
      setCapability,
      setWidth,
      setHeight,
      setSeed,
      setVideoLength,
      setRescale,
      setOriginalResolution,
      setKeepProportions,
      // Retry / "Edit prompt" restore a job's single input.
      setUploadedInput: (img: UploadedImage | null) => setUploadedInputs(img ? [img] : []),
      setInputPreviewUrl,
      setExternalResize,
      rescaleUserEditedRef,
    }),
    [],
  )

  const copyPipelineToNewForm = useCallback(
    (job: ImageJobDetails) => {
      const previewUrl =
        job.input_image_id && token ? imageFileUrl(job.input_image_id, token) : null
      applyPipelineParamsToNewForm(job, pipelineFormHandlers, previewUrl, capabilities)
      setActivePanel(IMGGEN_NEW_PANEL)
      setInfo('Pipeline parameters copied to New job. Adjust and submit when ready.')
      setError(null)
    },
    [token, capabilities, pipelineFormHandlers],
  )

  useEffect(() => {
    const state = location.state as ImggenRouteState | null
    if (!state) return

    if (typeof state.usePrompt === 'string') {
      setMode('txt2img')
      setPrompt(state.usePrompt)
      setActivePanel(IMGGEN_NEW_PANEL)
      navigate(location.pathname, { replace: true, state: null })
      return
    }

    if (state.generateAgain) {
      const { jobId, parameters } = state.generateAgain
      navigate(location.pathname, { replace: true, state: null })
      if (!token) return
      void (async () => {
        if (jobId) {
          try {
            const job = await getImageJob(token, jobId)
            copyPipelineToNewForm(job)
            return
          } catch {
            // job removed — fall back to stored metadata
          }
        }
        const p = pipelineParamsFromStored(parameters)
        const previewUrl = p.input_image_id ? imageFileUrl(p.input_image_id, token) : null
        applyStoredGenerationParamsToNewForm(parameters, pipelineFormHandlers, {
          imagePreviewUrl: previewUrl,
          availableCapabilities: capabilities,
        })
        setActivePanel(IMGGEN_NEW_PANEL)
        setInfo('Pipeline parameters copied to New job. Adjust and submit when ready.')
        setError(null)
      })()
      return
    }

    const incoming = state.useInputImage
    if (!incoming?.image?.image_id) return

    sendOutputToInputMode(incoming.image, incoming.mode)
    navigate(location.pathname, { replace: true, state: null })
  }, [
    location.state,
    location.pathname,
    navigate,
    token,
    copyPipelineToNewForm,
    pipelineFormHandlers,
    capabilities,
  ])

  // Job ids with a poll request in flight — auto-poll ticks never stack up
  // behind a slow backend poll.
  const pollInFlightRef = useRef<Set<string>>(new Set())

  /**
   * Polls OffloadMQ for `jobId` and refreshes its details. All state lands in
   * one synchronous batch after the last await (one render per poll); only a
   * manual "Poll now" drives the `polling` spinner.
   */
  const runPoll = useCallback(
    async (jobId: string, opts?: { manual?: boolean }) => {
      if (!token) return
      if (pollInFlightRef.current.has(jobId)) return
      pollInFlightRef.current.add(jobId)
      const manual = opts?.manual ?? false
      if (manual) setPolling(true)
      try {
        const poll = await pollImageJob(token, jobId)
        const details = await getImageJob(token, jobId)
        setActivePoll(prev => samePollOr(prev, poll))
        applyJobDetails(details)
        setInfo(`Job ${jobId}: ${poll.status}${poll.stage ? ` (${poll.stage})` : ''}`)
        if (poll.error) setError(poll.error)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        pollInFlightRef.current.delete(jobId)
        if (manual) setPolling(false)
      }
    },
    [token, applyJobDetails],
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

  async function onResubmitJob(jobId: string, action: 'retry' | 'generate-again') {
    if (!token) return
    setRetrying(true)
    setError(null)
    try {
      const res = await retryImageJob(token, jobId)
      const list = await listImageJobs(token)
      setJobs(prev => mergeJobList(prev, list, imageJobFingerprint))
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      setActivePoll({
        job_id: res.job_id,
        status: res.status,
        stage: null,
        error: null,
        output_images: [],
      })
      setInfo(
        action === 'generate-again'
          ? `Generate again submitted as job ${res.job_id}. Polling for results…`
          : `Retry submitted as job ${res.job_id}. Polling for results…`,
      )
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

  /**
   * Custom placeholder defs are additive — a submission must never fail because
   * this optional fetch failed, so any error falls back to an empty map.
   */
  async function fetchCustomPlaceholderDefs(): Promise<Record<string, string[]>> {
    if (!token) return {}
    try {
      const items = await listPromptPlaceholders(token)
      const defs: Record<string, string[]> = {}
      for (const item of items) {
        defs[item.name.trim().toLowerCase()] = item.variants
      }
      return defs
    } catch {
      return {}
    }
  }

  /**
   * Records the raw (unexpanded) prompt/negative-prompt as recents, once per
   * user submission — not once per generated job — so a "generate multiple"
   * batch doesn't flood recents with per-job placeholder variants. Best-effort:
   * a failure here shouldn't block job submission.
   */
  function recordPromptRecents() {
    if (!token) return
    if (prompt.trim()) void recordRecentPrompt(token, 'imggen-prompt', prompt).catch(() => {})
    if (overrideNegative && negativePrompt.trim()) {
      void recordRecentPrompt(token, 'imggen-negative', negativePrompt).catch(() => {})
    }
    recordPlaceholdersUsed(prompt)
  }

  function insertRecentPlaceholder(token: string) {
    setPrompt(p => (p === '' || /\s$/.test(p) ? p + token : `${p} ${token}`))
  }

  async function onSubmit() {
    if (!token || !canSubmit) return
    if (multiInput) {
      const inputs = uploadedInputs
      await submitBatch(inputs.length, (expandedPrompt, i) => buildSubmitRequest(expandedPrompt, inputs[i]))
      return
    }
    setSubmitting(true)
    setJobDetailLoading(true)
    setError(null)
    setInfo(`Submitting ${isVideoMode(mode) ? 'video generation' : 'image generation'} task to OffloadMQ.`)
    recordPromptRecents()
    try {
      const customDefs = await fetchCustomPlaceholderDefs()
      const expandedPrompt = expandPromptPlaceholders(prompt, createPlaceholderUsage(), customDefs)
      const [res] = await Promise.all([
        startImageJob(token, buildSubmitRequest(expandedPrompt)),
        new Promise<void>(resolve => window.setTimeout(resolve, 600)),
      ])
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      setActivePoll({ job_id: res.job_id, status: res.status, stage: null, error: null, output_images: [] })
      setInfo(`Job ${res.job_id} submitted. Polling for results…`)
      void refreshRunningImageJobs()
      void runPoll(res.job_id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  function parseGenerateMultipleCount(raw: string): number {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return DEFAULT_GENERATE_MULTIPLE
    return Math.min(MAX_GENERATE_MULTIPLE, Math.max(1, n))
  }

  async function onSubmitMultiple() {
    if (!token || !canSubmit) return
    const count = parseGenerateMultipleCount(generateMultipleCountInput)
    setGenerateMultipleOpen(false)
    await submitBatch(count, expandedPrompt => buildSubmitRequest(expandedPrompt))
  }

  /**
   * Submits `count` jobs in sequence — "Generate multiple" (same input) or one
   * job per input image. One placeholder usage map spans the whole batch, so no
   * `{color}`/`{animal}` value repeats across its jobs.
   */
  async function submitBatch(
    count: number,
    requestFor: (expandedPrompt: string, index: number) => StartImageJobRequest,
  ) {
    if (!token) return
    setSubmitting(true)
    setJobDetailLoading(true)
    setError(null)
    recordPromptRecents()
    const submittedIds: string[] = []
    const placeholderUsage = createPlaceholderUsage()
    const customDefs = await fetchCustomPlaceholderDefs()
    try {
      for (let i = 0; i < count; i++) {
        setInfo(`Submitting job ${i + 1} of ${count}…`)
        const expandedPrompt = expandPromptPlaceholders(prompt, placeholderUsage, customDefs)
        const res = await startImageJob(token, requestFor(expandedPrompt, i))
        submittedIds.push(res.job_id)
        await refreshJob(res.job_id)
      }
      const lastId = submittedIds[submittedIds.length - 1]!
      setActivePanel(lastId)
      setActivePoll({
        job_id: lastId,
        status: 'submitted',
        stage: null,
        error: null,
        output_images: [],
      })
      setInfo(
        count === 1
          ? `Job ${lastId} submitted. Polling for results…`
          : `${count} jobs submitted. Showing job ${lastId}. Polling for results…`,
      )
      void refreshRunningImageJobs()
      void runPoll(lastId)
    } catch (e) {
      if (submittedIds.length > 0) {
        const lastId = submittedIds[submittedIds.length - 1]!
        setActivePanel(lastId)
        setActivePoll({
          job_id: lastId,
          status: 'submitted',
          stage: null,
          error: null,
          output_images: [],
        })
        void runPoll(lastId)
      }
      setError(
        submittedIds.length > 0
          ? `Failed after ${submittedIds.length} of ${count} jobs: ${(e as Error).message}`
          : (e as Error).message,
      )
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  useEffect(() => {
    return () => {
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl)
    }
  }, [inputPreviewUrl])

  const selectNew = useCallback(() => {
    setActivePanel(IMGGEN_NEW_PANEL)
    setError(null)
  }, [])

  function editPromptFromJob() {
    if (!selectedJob) return
    copyPipelineToNewForm(selectedJob)
  }

  function rescaleForSubmit(
    jobRescale: RescaleState,
    jobWidth: number,
    jobHeight: number,
  ): ImagePipelineRescaleParams | null {
    if (mode !== 'img2img' && mode !== 'img2video') return null
    // Original-resolution (img2img only): persist rescale as disabled so the job reconstructs as pass-through.
    if (mode === 'img2img' && originalResolution) {
      return { enabled: false, mode: jobRescale.mode, width: jobWidth, height: jobHeight, px: null, mp: null }
    }
    return {
      enabled: jobRescale.enabled,
      mode: jobRescale.mode,
      width: jobRescale.width,
      height: jobRescale.height,
      px: jobRescale.px === '' ? null : Number(jobRescale.px),
      mp: jobRescale.mp === '' ? null : Number(jobRescale.mp),
    }
  }

  function buildSubmitRequest(
    promptOverride?: string,
    input: UploadedImage | null = uploadedInput,
  ): StartImageJobRequest {
    // With several img2img inputs each job is sized from its own image, and an
    // exact rescale the user hasn't edited follows that size. A single input
    // uses the form's dims as-is.
    const perInput = multiInput && mode === 'img2img' && input != null
    const [jobWidth, jobHeight] = perInput
      ? batchInputDims(input, { originalResolution, keepProportions, width, height })
      : [width, height]
    const jobRescale =
      perInput && rescale.mode === 'exact' && !rescaleUserEditedRef.current
        ? { ...rescale, width: jobWidth, height: jobHeight }
        : rescale
    const dataPrep =
      mode === 'img2img' && !originalResolution ? rescaleDataPrep(jobRescale.enabled, jobRescale) : null
    return {
      capability: capability.trim(),
      prompt: (promptOverride ?? prompt).trim(),
      negative_prompt: overrideNegative ? negativePrompt.trim() || null : null,
      override_negative: overrideNegative,
      width: jobWidth,
      height: jobHeight,
      seed: seed.trim() ? Number(seed) : null,
      workflow: mode,
      input_image_id: input?.image_id ?? null,
      data_preparation: dataPrep,
      rescale: rescaleForSubmit(jobRescale, jobWidth, jobHeight),
      video_length: isVideoMode(mode) ? parseVideoLength(videoLength) : null,
      external_resize: isInputImageMode(mode) && externalResize,
      prompt_template: prompt.trim() || null,
    }
  }

  const selectJob = useCallback(async (jobId: string) => {
    if (!token) return
    setActivePanel(jobId)
    setError(null)
    // A job already in the list renders immediately; only an unknown one gets
    // the skeleton while its details load.
    const cached = jobsRef.current.find(j => j.job_id === jobId)
    if (cached) setActivePoll(pollSnapshot(cached))
    else setJobDetailLoading(true)
    try {
      const details = await refreshJob(jobId)
      if (details) setActivePoll(prev => samePollOr(prev, pollSnapshot(details)))
      if (details && !TERMINAL.has(details.status)) {
        void runPoll(jobId)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobDetailLoading(false)
    }
  }, [token, refreshJob, runPoll])

  // Stable so the memoized pipelines sidebar skips re-rendering on unrelated
  // page updates (every prompt keystroke, every poll).
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

  const jobStatusOverrides = useMemo(() => {
    const overrides: Record<string, string> = {}
    for (const row of runningImageJobs) {
      if (row.job_id && row.status) overrides[row.job_id] = row.status
    }
    return overrides
  }, [runningImageJobs])

  // A poll for a job the user has already navigated away from must not leak
  // its status into the one now on screen.
  const viewedPoll = activePoll && activePoll.job_id === viewedJobId ? activePoll : null
  const displayStatus =
    viewingJob && selectedJob?.job_id === viewedJobId
      ? jobStatusOverrides[viewedJobId] ?? viewedPoll?.status ?? selectedJob?.status
      : undefined
  const displayStage = useMemo(() => {
    if (!viewedJobId) return activePoll?.stage ?? null
    const row = runningImageJobs.find(r => r.job_id === viewedJobId)
    return row?.stage ?? viewedPoll?.stage ?? null
  }, [viewedJobId, runningImageJobs, activePoll?.stage, viewedPoll?.stage])
  const progressBarMeta = useMemo(() => {
    if (!viewedJobId) {
      return {
        startedAt: activePoll?.started_at ?? null,
        typicalRuntimeSeconds: activePoll?.typical_runtime_seconds ?? null,
        submittedAt: activePoll?.submitted_at ?? null,
      }
    }
    const poll = activePoll?.job_id === viewedJobId ? activePoll : null
    const row = runningImageJobs.find(r => r.job_id === viewedJobId)
    const job = selectedJob?.job_id === viewedJobId ? selectedJob : null
    return {
      startedAt: poll?.started_at ?? job?.started_at ?? row?.started_at ?? null,
      typicalRuntimeSeconds:
        poll?.typical_runtime_seconds ??
        job?.typical_runtime_seconds ??
        row?.typical_runtime_seconds ??
        null,
      submittedAt: poll?.submitted_at ?? job?.submitted_at ?? row?.submitted_at ?? null,
    }
  }, [viewedJobId, activePoll, runningImageJobs, selectedJob])
  const isRunning =
    viewingJob && displayStatus != null && !TERMINAL.has(displayStatus)
  const canRetryJob =
    viewingJob &&
    selectedJob != null &&
    (selectedJob.status === 'failed' || selectedJob.status === 'canceled')
  const canGenerateAgain =
    viewingJob && selectedJob != null && selectedJob.status === 'completed'

  const pipelineEvents = useMemo(
    () => (selectedJob ? pipelineEventsWithoutPolls(selectedJob.events) : []),
    [selectedJob],
  )

  const pipelineStatus = useMemo(() => {
    if (!selectedJob || !displayStatus) return ''
    return pipelineStatusLine(displayStatus, displayStage, selectedJob.events)
  }, [selectedJob, displayStatus, displayStage])

  // Auto-poll while viewing a job that is still in progress.
  useEffect(() => {
    if (!token || !viewedJobId) return
    if (displayStatus && TERMINAL.has(displayStatus)) return

    // This page polls the viewed job itself; the shell's background loop skips it.
    setForegroundJob('image', viewedJobId)
    const id = window.setInterval(() => {
      if (document.hidden) return
      void runPoll(viewedJobId)
    }, POLL_MS)
    return () => {
      window.clearInterval(id)
      setForegroundJob('image', null)
    }
  }, [token, viewedJobId, displayStatus, runPoll, setForegroundJob])

  const outputFiles = useMemo(
    () => (selectedJob ? selectedJob.files.filter(f => f.direction === 'output') : []),
    [selectedJob],
  )

  // Intrinsic size of the job's input, so its <img> reserves the right box
  // before loading. Falls back to the job's output size (same aspect for img2img).
  const inputDims = useMemo(() => {
    if (!selectedJob?.input_image_id) return undefined
    const f = selectedJob.files.find(x => x.image_id === selectedJob.input_image_id)
    return intrinsicSize(f?.width ?? selectedJob.width, f?.height ?? selectedJob.height)
  }, [selectedJob])

  const downloadJobOutputs = useCallback(() => {
    for (const file of outputFiles) {
      triggerImageDownload(imageFileUrl(file.image_id, token, mediaRevision), file.filename)
      markImageDownloaded(file.image_id)
    }
  }, [outputFiles, token, mediaRevision])

  const animateOutputFile = useMemo(() => {
    const images = outputFiles.filter(f => !f.content_type.startsWith('video/'))
    return images.length > 0 ? images[images.length - 1]! : null
  }, [outputFiles])

  const canAnimateOutput = canGenerateAgain && animateOutputFile != null

  const canCompare =
    selectedJob?.workflow === 'img2img' &&
    Boolean(selectedJob?.input_image_id) &&
    outputFiles.length > 0 &&
    outputFiles.every(f => !f.content_type.startsWith('video/'))

  useEffect(() => {
    setTimelineOpen(false)
    setCompareMode(false)
  }, [selectedJob?.job_id])

  useEffect(() => {
    if (!generateMultipleOpen) return
    const id = window.requestAnimationFrame(() => {
      generateMultipleCountRef.current?.focus()
      generateMultipleCountRef.current?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [generateMultipleOpen])

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
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setIsSearchOpen(v => !v)}
              title="Search pipelines"
              aria-label="Search pipelines"
            >
              <Search className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSlideshow}
              title={slideshowOn ? 'Stop slideshow' : 'Start slideshow'}
              aria-label={slideshowOn ? 'Stop slideshow' : 'Start slideshow'}
              aria-pressed={slideshowOn}
              data-testid="imggen-slideshow-toggle"
              className={slideshowOn ? 'text-primary' : undefined}
            >
              <MonitorPlay className={slideshowOn ? 'animate-pulse' : undefined} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void refreshJobs()}
              disabled={jobsLoading}
              title="Refresh pipelines"
              aria-label="Refresh pipelines"
              data-testid="imggen-pipelines-refresh"
            >
              <RefreshCw className={jobsLoading ? 'animate-spin' : undefined} />
            </Button>
          </div>
        }
      >
        {isSearchOpen && (
          <div className="px-3 py-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search by prompt..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
                autoFocus
              />
            </div>
          </div>
        )}
        <ImageJobHistorySidebar
          jobs={filteredJobs}
          activePanel={activePanel}
          token={token}
          mediaRevision={mediaRevision}
          loading={jobsLoading && jobs.length === 0}
          statusOverrides={jobStatusOverrides}
          runningJobs={runningImageJobs}
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
          {viewingJob && selectedJob && outputFiles.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={downloadJobOutputs}
              title="Download output"
              aria-label="Download output"
              data-testid="imggen-download-job"
            >
              <Download className="size-4" />
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

        <AnimatePresence mode="wait" initial={false}>
        {activePanel === IMGGEN_NEW_PANEL ? (
        <motion.section
          key="imggen-new"
          data-testid="imggen-new-panel"
          className="flex flex-col gap-5"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: morph.reduced ? 0 : 0.1 } }}
          transition={morph.fade}
        >
          <header className="space-y-1">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
              <Wand2 className="h-4 w-4" />
              New Job
            </h2>
            <p className="text-sm text-muted-foreground">
              {isVideoMode(mode)
                ? 'Video generation via ComfyUI. Output is an MP4; a frame thumbnail appears in the job list and file browser.'
                : 'Img2Img uploads your image to a bucket, rescales it with dataPreparation, then runs the workflow.'}
            </p>
          </header>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2" data-testid="imggen-mode-tabs">
              {MODE_TABS.map(tab => {
                const Icon = tab.icon
                const active = mode === tab.mode
                return (
                  <motion.button
                    key={tab.mode}
                    type="button"
                    layout
                    transition={morph.spring}
                    onClick={() => switchMode(tab.mode)}
                    data-testid={`imggen-mode-${tab.mode}`}
                    className={cn(
                      'relative isolate flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg border px-3 text-sm font-medium sm:flex-none',
                      'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-transparent text-primary-foreground'
                        : 'border-border bg-background text-foreground hover:bg-muted',
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="imggen-mode-pill"
                        transition={morph.spring}
                        aria-hidden
                        className="absolute inset-0 -z-10 rounded-lg bg-primary"
                      />
                    )}
                    <Icon className="size-3.5" />
                    {tab.label}
                  </motion.button>
                )
              })}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2" data-testid="imggen-capability-select">
                <Label>Model</Label>
                <ImgGenModelPicker
                  capabilities={capabilities}
                  selected={capability}
                  onSelect={setCapability}
                  onRefresh={refreshCapabilities}
                  capabilitiesStatus={pickerStatus}
                  capabilitiesError={capabilitiesError}
                />
                {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No models found for this mode. Start an imggen agent or check OffloadMQ connection in Settings.
                  </p>
                )}
              </div>

              <MorphCollapse
                show={isInputImageMode(mode)}
                className="sm:col-span-2"
                data-testid="imggen-input-section"
              >
                <div className="space-y-3">
                  <Label>
                    {multiInput
                      ? `Input images (${uploadedInputs.length}) · one job per image`
                      : 'Input image'}
                  </Label>
                  <div className="flex flex-wrap items-start gap-2">
                    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50">
                      <Upload className="h-3.5 w-3.5" />
                      {uploading
                        ? uploadProgress && uploadProgress.total > 1
                          ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                          : 'Uploading…'
                        : uploadedInput
                          ? 'Add'
                          : 'Upload'}
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
                        data-testid="imggen-upload-input"
                      />
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={() => setPickerOpen(true)}
                      disabled={uploading}
                      data-testid="imggen-pick-from-library"
                    >
                      <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                      From library
                    </Button>
                    <MorphIn show={Boolean(uploadedInput) && !multiInput}>
                      {uploadedInput && !multiInput && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            {uploadedInput.filename} ({uploadedInput.width}×{uploadedInput.height})
                          </span>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={clearInput}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </MorphIn>
                  </div>
                  <MorphCollapse show={multiInput}>
                    {multiInput && (
                      <InputImageGrid
                        images={uploadedInputs}
                        token={token}
                        onRemove={removeInput}
                        onClear={clearInput}
                        testIdPrefix="imggen"
                        disabled={uploading || submitting}
                      />
                    )}
                  </MorphCollapse>
                  <MorphCollapse show={!multiInput && Boolean(inputPreviewUrl || uploadedInput)}>
                    {!multiInput && (inputPreviewUrl || uploadedInput) && (
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
                      <LoadingImage
                        src={
                          uploadedInput
                            ? imageFileUrl(uploadedInput.image_id, token, mediaRevision)
                            : inputPreviewUrl!
                        }
                        {...(uploadedInput
                          ? intrinsicSize(uploadedInput.width, uploadedInput.height)
                          : undefined)}
                        alt=""
                        aria-hidden
                        className="max-h-48 w-full object-contain bg-muted/30"
                      />
                    </ImageLightbox>
                    )}
                  </MorphCollapse>
                  <MorphCollapse show={Boolean(externalResizeInfo?.available && uploadedInput)}>
                    {externalResizeInfo?.available && uploadedInput && (
                      <ExternalResizeToggle
                        checked={externalResize}
                        onChange={setExternalResize}
                        sizeBytes={largestInputBytes}
                        imageCount={uploadedInputs.length}
                        thresholdBytes={externalResizeInfo.threshold_bytes}
                        testId="imggen-external-resize"
                      />
                    )}
                  </MorphCollapse>
                  {/* Writes a prompt from one frame — hidden for a set, whose jobs share one prompt. */}
                  <MorphCollapse show={mode === 'img2video' && Boolean(uploadedInput) && !multiInput}>
                    {uploadedInput && !multiInput && (
                      <VideoPromptGenerator
                        token={token}
                        imageId={uploadedInput.image_id}
                        onGenerated={text => {
                          setPrompt(text)
                          setInfo('Video prompt generated from the input frame.')
                          setError(null)
                        }}
                        onError={message => setError(message)}
                      />
                    )}
                  </MorphCollapse>
                </div>
              </MorphCollapse>

              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-0.5">
                    <Label htmlFor="prompt">Prompt</Label>
                    {mode === 'txt2img' || mode === 'txt2video' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          setPrompt(p =>
                            mode === 'txt2video'
                              ? randomTxt2videoPrompt(p)
                              : randomTxt2imgPrompt(p),
                          )
                        }
                        title="Random prompt"
                        aria-label="Random prompt"
                        data-testid="imggen-prompt-randomize"
                      >
                        <Shuffle className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 text-xs"
                      onClick={() => setRewritePromptOpen(true)}
                      disabled={!token || !prompt.trim()}
                      data-testid="imggen-rewrite-open"
                    >
                      <Wand2 className="mr-1 size-3.5" />
                      Rewrite prompt
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setStarredPromptsOpen(true)}
                      disabled={!token}
                      data-testid="imggen-starred-prompts-open"
                    >
                      <Star className="mr-1 size-3.5" />
                      Starred prompts
                    </Button>
                  </div>
                </div>
                <PromptTextarea
                  id="prompt"
                  value={prompt}
                  onChange={setPrompt}
                  bucket="imggen-prompt"
                  token={token}
                  previews
                  rows={4}
                  data-testid="imggen-prompt"
                />
                <RecentPlaceholders onInsert={insertRecentPlaceholder} />
              </div>

              <div className="sm:col-span-2">
                <div className="flex items-center justify-between gap-2 pb-1.5">
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
                <MorphCollapse show={overrideNegative}>
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
                </MorphCollapse>
                <MorphCollapse show={!overrideNegative}>
                  <p className="text-xs text-muted-foreground">Using workflow default negative prompt.</p>
                </MorphCollapse>
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
                  {dimensionPresets.map(([w, h]) => {
                    const activePreset = width === w && height === h
                    return (
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
                          'relative isolate h-7 rounded-md border px-2 text-xs transition-colors',
                          activePreset
                            ? 'border-transparent text-primary'
                            : 'border-input bg-background hover:bg-muted/50',
                          originalResolution && 'cursor-not-allowed opacity-50 hover:bg-background',
                        )}
                        data-testid={`imggen-preset-${w}x${h}`}
                      >
                        {activePreset && (
                          <motion.span
                            layoutId="imggen-preset-pill"
                            transition={morph.spring}
                            aria-hidden
                            className="absolute inset-0 -z-10 rounded-md border border-primary bg-primary/10"
                          />
                        )}
                        {w}×{h}
                      </button>
                    )
                  })}
                </div>
                <MorphCollapse
                  show={mode === 'img2img' && Boolean(uploadedInput)}
                  data-testid="imggen-resolution-toggles"
                >
                  {uploadedInput && (
                  <div className="flex flex-col gap-1.5 pt-0.5">
                    <MorphCollapse show={canUseOriginalResolution}>
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
                        {multiInput
                          ? 'Original resolution (each image)'
                          : `Original resolution (${uploadedInput.width}×${uploadedInput.height})`}
                      </label>
                    </MorphCollapse>
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
                      {originalResolution
                        ? ' (locked to original)'
                        : multiInput && ' (each image)'}
                    </label>
                    {multiInput && (
                      <p className="text-xs text-muted-foreground" data-testid="imggen-multi-input-dims-hint">
                        {originalResolution
                          ? 'Each image is generated at its own size.'
                          : ratioLocked
                            ? `Each image keeps its own aspect ratio at a ${Math.max(width, height)}px long edge.`
                            : `Every image is generated at ${width}×${height}.`}
                      </p>
                    )}
                  </div>
                  )}
                </MorphCollapse>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="seed">Seed (optional)</Label>
                <Input id="seed" value={seed} onChange={e => setSeed(e.target.value)} placeholder="empty = random" />
              </div>
              <MorphCollapse show={isVideoMode(mode)} className="sm:col-span-2">
                <div className="space-y-1.5">
                  <Label htmlFor="video-length">Length (frames)</Label>
                  <Input
                    id="video-length"
                    type="number"
                    min={1}
                    max={300}
                    value={videoLength}
                    onChange={e => setVideoLength(e.target.value)}
                    onBlur={() => setVideoLength(String(parseVideoLength(videoLength)))}
                    data-testid="imggen-video-length"
                  />
                </div>
              </MorphCollapse>
            </div>

            <MorphCollapse
              show={mode === 'img2img' && !originalResolution}
              data-testid="imggen-advanced"
            >
              <button
                type="button"
                onClick={() => setRescaleOpen(v => !v)}
                aria-expanded={rescaleOpen}
                className="flex select-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                data-testid="imggen-advanced-toggle"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform', rescaleOpen ? 'rotate-0' : '-rotate-90')}
                />
                Offload rescaling
              </button>
              <MorphCollapse show={rescaleOpen}>
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
              </MorphCollapse>
            </MorphCollapse>

            <div className="relative flex flex-col items-center gap-1 sm:w-auto">
              <motion.div
                className="flex justify-center sm:w-auto"
                animate={submitBurst ? { scale: [1, 1.06, 0.97, 1] } : {}}
                transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
              >
                <Button asChild className="relative min-h-11 w-full overflow-hidden sm:w-auto">
                  <motion.button
                    type="button"
                    layout
                    transition={morph.spring}
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
                  <AnimatePresence mode="popLayout" initial={false}>
                    {submitting ? (
                      <motion.span
                        key="submitting"
                        layout="position"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-1.5"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Submitting…
                      </motion.span>
                    ) : (
                      <motion.span
                        key={submitLabelFor(mode, uploadedInputs.length)}
                        layout="position"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-1.5"
                      >
                        {submitLabelFor(mode, uploadedInputs.length)}
                      </motion.span>
                    )}
                  </AnimatePresence>
                  </motion.button>
                </Button>
              </motion.div>

              {/* N input images already mean N jobs. The title sits on a wrapper
                  because a disabled button gets no pointer events. */}
              <span title={multiInput ? 'One job per input image — remove extra images to generate multiple' : undefined}>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => setGenerateMultipleOpen(true)}
                  disabled={!canSubmit || submitting || multiInput}
                  data-testid="imggen-generate-multiple-open"
                >
                  Generate multiple
                </Button>
              </span>

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

            <MorphCollapse show={Boolean(info) && activePanel === IMGGEN_NEW_PANEL}>
              <p className="text-xs text-muted-foreground">{info}</p>
            </MorphCollapse>
            <MorphCollapse show={Boolean(error) && activePanel === IMGGEN_NEW_PANEL}>
              {error && <JobErrorBanner message={error} testId="imggen-error" />}
            </MorphCollapse>
          </div>
        </motion.section>
        ) : (
          <motion.div
            key={activePanel}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: morph.reduced ? 0 : 0.1 } }}
            transition={morph.fade}
          >
          {error && <JobErrorBanner message={error} testId="imggen-job-error" />}
          {jobDetailLoading ? (
            <Card
              role="status"
              aria-label="Loading job"
              data-testid="imggen-job-detail-skeleton"
              className="overflow-hidden py-0"
            >
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="space-y-2 px-4 pb-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <div className="flex gap-2 pt-2">
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            </Card>
          ) : selectedJob?.job_id === viewedJobId ? (
          <Card data-testid="imggen-job-detail" className="overflow-hidden">

            {/* ── Output / compare area — full-bleed at top ── */}
            <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
            {compareMode && canCompare ? (
              <motion.div
                key="compare"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={morph.fade}
                className="grid grid-cols-2 gap-px bg-border"
                data-testid="imggen-compare-view"
              >
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
                    <LoadingImage
                      src={imageFileUrl(selectedJob.input_image_id!, token, mediaRevision)}
                      {...inputDims}
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
                    <motion.div
                      key={file.image_id}
                      layoutId={`imggen-output-media-${file.image_id}`}
                      transition={morph.soft}
                    >
                    <ImageLightbox
                      src={imageFileUrl(file.image_id, token, mediaRevision)}
                      alt={file.filename}
                      triggerClassName="group block w-full overflow-hidden"
                      testId={`imggen-compare-output-${file.image_id}`}
                      actions={
                        token
                          ? {
                              ...lightboxActionsFor(token, file.image_id, file.filename, file.direction, true),
                              onSendToImg2Img: () => sendToImg2Img(file),
                              onSendToImg2Video: () => sendToImg2Video(file, selectedJob.prompt),
                            }
                          : undefined
                      }
                    >
                      <LoadingImage
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        {...intrinsicSize(file.width, file.height)}
                        alt=""
                        aria-hidden
                        className="w-full object-contain max-h-[40dvh] sm:max-h-[65vh] transition-opacity group-hover:opacity-95"
                      />
                    </ImageLightbox>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            ) : outputFiles.length > 0 ? (
              <motion.div
                key="outputs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={morph.fade}
                className={outputFiles.length > 1 ? 'grid grid-cols-2 gap-px bg-border' : undefined}
              >
                {outputFiles.map(file =>
                  file.content_type.startsWith('video/') ? (
                    <div key={file.image_id} className="w-full bg-muted/20" data-testid={`imggen-output-${file.image_id}`}>
                      <video
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        controls
                        loop
                        style={
                          file.width > 0 && file.height > 0
                            ? { aspectRatio: `${file.width} / ${file.height}` }
                            : undefined
                        }
                        className="w-full max-h-[70vh] object-contain"
                      />
                    </div>
                  ) : (
                    <motion.div
                      key={file.image_id}
                      layoutId={`imggen-output-media-${file.image_id}`}
                      transition={morph.soft}
                    >
                    <ImageLightbox
                      src={imageFileUrl(file.image_id, token, mediaRevision)}
                      alt={file.filename}
                      caption={`${file.filename} — ${file.width}×${file.height}`}
                      triggerClassName="group block w-full overflow-hidden bg-muted/20"
                      testId={`imggen-output-${file.image_id}`}
                      actions={
                        token
                          ? {
                              ...lightboxActionsFor(token, file.image_id, file.filename, file.direction, true),
                              onSendToImg2Img: () => sendToImg2Img(file),
                              onSendToImg2Video: () => sendToImg2Video(file, selectedJob.prompt),
                            }
                          : undefined
                      }
                    >
                      <LoadingImage
                        src={imageFileUrl(file.image_id, token, mediaRevision)}
                        {...intrinsicSize(file.width, file.height)}
                        alt=""
                        aria-hidden
                        className="w-full object-contain max-h-[70vh] transition-opacity group-hover:opacity-95"
                      />
                    </ImageLightbox>
                    </motion.div>
                  )
                )}
              </motion.div>
            ) : isRunning ? (
              <motion.div
                key="progress"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={morph.fade}
                className="flex aspect-video w-full items-center justify-center bg-muted/30 px-6"
              >
                <JobProgressBar
                  status={displayStatus ?? selectedJob.status}
                  stage={displayStage}
                  startedAt={progressBarMeta.startedAt}
                  typicalRuntimeSeconds={progressBarMeta.typicalRuntimeSeconds}
                  submittedAt={progressBarMeta.submittedAt}
                />
              </motion.div>
            ) : displayStatus === 'failed' && !error ? (
              <motion.div
                key="failed"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={morph.fade}
                className="flex aspect-video w-full items-center justify-center bg-destructive/5 px-6"
              >
                <JobErrorBanner
                  message={selectedJob.error || 'Generation failed'}
                  testId="imggen-job-failed"
                />
              </motion.div>
            ) : null}
            </AnimatePresence>
            </div>

            {/* ── Compact title + meta ── */}
            <div className="border-b border-border px-4 py-3 space-y-0.5">
              <h2 className="text-base font-medium leading-snug text-foreground">
                {jobPromptTitle(selectedJob.prompt, 120)}
              </h2>
              <p className="font-mono text-xs text-muted-foreground" data-testid="imggen-job-tech-meta">
                {jobTechMeta(selectedJob)} · {imageJobStatusLabel(displayStatus ?? selectedJob.status)}
              </p>
              {(selectedJob.queued_seconds != null || selectedJob.execution_seconds != null) && (
                <p className="font-mono text-xs text-muted-foreground" data-testid="imggen-job-timing">
                  {[
                    selectedJob.queued_seconds != null
                      ? `Queued ${formatDuration(selectedJob.queued_seconds)}`
                      : null,
                    selectedJob.execution_seconds != null
                      ? `Ran ${formatDuration(selectedJob.execution_seconds)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>

            <CardContent className="space-y-4 pt-4">

              {/* ── Actions ── */}
              <motion.div layout transition={morph.spring} className="flex flex-wrap items-center gap-2">
                <motion.div layout transition={morph.spring}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={editPromptFromJob}
                    data-testid="imggen-edit-prompt"
                  >
                    <Pencil className="mr-1 h-4 w-4" />
                    Edit prompt
                  </Button>
                </motion.div>
                <MorphIn show={canGenerateAgain}>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => viewedJobId && void onResubmitJob(viewedJobId, 'generate-again')}
                    disabled={!viewedJobId || retrying}
                    data-testid="imggen-generate-again"
                  >
                    {retrying ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1 h-4 w-4" />
                    )}
                    Generate again
                  </Button>
                </MorphIn>
                <MorphIn show={canAnimateOutput}>
                  {animateOutputFile && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => sendToImg2Video(animateOutputFile, selectedJob.prompt)}
                      data-testid="imggen-animate-output"
                    >
                      <Video className="mr-1 h-4 w-4" />
                      Animate
                    </Button>
                  )}
                </MorphIn>
                <MorphIn show={canAnimateOutput}>
                  {animateOutputFile && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => sendToImgUtils(animateOutputFile)}
                      data-testid="imggen-send-to-imgutils"
                    >
                      <Wand2 className="mr-1 h-4 w-4" />
                      Image Tools
                    </Button>
                  )}
                </MorphIn>
                <MorphIn show={canRetryJob}>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => viewedJobId && void onResubmitJob(viewedJobId, 'retry')}
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
                </MorphIn>
                <motion.div layout transition={morph.spring}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => viewedJobId && void runPoll(viewedJobId, { manual: true })}
                    disabled={!viewedJobId || polling}
                    data-testid="imggen-poll-job"
                  >
                    {polling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                    Poll now
                  </Button>
                </motion.div>
                <MorphIn show={isRunning}>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => viewedJobId && void onCancelJob(viewedJobId)}
                    data-testid="imggen-cancel-job"
                  >
                    <Square className="mr-1 h-4 w-4 fill-current" />
                    Cancel
                  </Button>
                </MorphIn>
                <MorphIn show={isRunning}>
                  <span className="flex items-center text-xs text-muted-foreground">
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Auto-polling every {POLL_MS / 1000}s…
                  </span>
                </MorphIn>
                <MorphIn show={canCompare}>
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
                </MorphIn>
              </motion.div>
              <MorphCollapse show={Boolean(info)}>
                <p className="text-xs text-muted-foreground">{info}</p>
              </MorphCollapse>

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
                <MorphCollapse show={timelineOpen}>
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
                </MorphCollapse>
              </div>

              {/* ── Prompt ── */}
              <section className="space-y-1.5" data-testid="imggen-job-prompt">
                <h3 className="text-xs font-medium text-muted-foreground">Prompt</h3>
                <p className="whitespace-pre-wrap text-sm text-foreground">{selectedJob.prompt.trim() || '—'}</p>
              </section>

              {/* ── Params ── */}
              <PipelineJobParamsPanel job={selectedJob} />

              {/* ── Input image (compact param row) ── */}
              <MorphCollapse show={Boolean(selectedJob.input_image_id)}>
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
                    <LoadingImage
                      src={imageFileUrl(selectedJob.input_image_id, token, mediaRevision)}
                      alt=""
                      aria-hidden
                      className="h-14 w-14 rounded-md object-cover bg-muted/40"
                    />
                  </ImageLightbox>
                </div>
                )}
              </MorphCollapse>

            </CardContent>
          </Card>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Could not load this job.</p>
          )}
          </motion.div>
        )}
        </AnimatePresence>
          </div>
        </main>
      </div>
    </div>

    {token && (
      <ImagePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelectMany={onPickInputs}
        token={token}
      />
    )}
    <SavedPromptsDrawer
      open={starredPromptsOpen}
      onOpenChange={setStarredPromptsOpen}
      bucket="imggen-prompt"
      token={token}
      value={prompt}
      onPick={setPrompt}
      previews
      initialKind="starred"
    />
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
    <ImgUtilsQuickModal
      open={imgUtilsTarget != null}
      onOpenChange={open => {
        if (!open) setImgUtilsTarget(null)
      }}
      token={token}
      image={imgUtilsTarget}
      onResult={onImageMutated}
    />
    {slideshowOn && slideshowCurrent && token ? (
      <ImageLightbox
        open
        onOpenChange={next => {
          if (!next) closeSlideshow()
        }}
        src={imageFileUrl(slideshowCurrent.file.image_id, token, mediaRevision)}
        alt={slideshowCurrent.file.filename}
        caption={`${jobPromptTitle(slideshowCurrent.prompt, 72)} — ${slideshowCurrent.file.width}×${slideshowCurrent.file.height}`}
        testId="imggen-slideshow"
        actions={{
          ...lightboxActionsFor(
            token,
            slideshowCurrent.file.image_id,
            slideshowCurrent.file.filename,
            slideshowCurrent.file.direction,
            true,
          ),
          onSendToImg2Img: () => {
            closeSlideshow()
            sendToImg2Img(slideshowCurrent.file)
          },
          onSendToImg2Video: () => {
            closeSlideshow()
            sendToImg2Video(slideshowCurrent.file, slideshowCurrent.prompt)
          },
        }}
      />
    ) : null}
    <RewritePromptDialog open={rewritePromptOpen} onOpenChange={setRewritePromptOpen}
      prompt={prompt} mode={mode} token={token} onUsePrompt={setPrompt} />

    <Dialog open={generateMultipleOpen} onOpenChange={setGenerateMultipleOpen}>
      <DialogContent className="sm:max-w-sm" data-testid="imggen-generate-multiple-dialog">
        <DialogHeader>
          <DialogTitle>Generate multiple</DialogTitle>
          <DialogDescription>
            Submit the same settings as separate jobs, one after another.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-2">
            <Label htmlFor="imggen-generate-multiple-count">Number of images</Label>
            <Input
              ref={generateMultipleCountRef}
              id="imggen-generate-multiple-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_GENERATE_MULTIPLE}
              value={generateMultipleCountInput}
              onChange={e => setGenerateMultipleCountInput(e.target.value)}
              onBlur={() =>
                setGenerateMultipleCountInput(String(parseGenerateMultipleCount(generateMultipleCountInput)))
              }
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void onSubmitMultiple()
                }
              }}
              className="font-mono tabular-nums ring-2 ring-primary/40"
              data-testid="imggen-generate-multiple-count"
            />
            <p className="text-xs text-muted-foreground">
              Up to {MAX_GENERATE_MULTIPLE} separate runs in the pipeline sidebar.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setGenerateMultipleOpen(false)}
            data-testid="imggen-generate-multiple-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onSubmitMultiple()}
            disabled={!canSubmit || submitting}
            data-testid="imggen-generate-multiple-submit"
          >
            Generate {parseGenerateMultipleCount(generateMultipleCountInput)}{' '}
            {parseGenerateMultipleCount(generateMultipleCountInput) === 1 ? 'image' : 'images'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
