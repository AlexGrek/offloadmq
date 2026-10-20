import { useCallback, useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  Columns2,
  FolderOpen,
  ImageIcon,
  Loader2,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { imageCycleApi, type ImageCycleJob } from '../api/imageCycles'
import { listDescribeCapabilities } from '../api/describe'
import {
  imageFileUrl,
  imageThumbnailUrl,
  listImgGenCapabilities,
  uploadImage,
  type UploadedImage,
} from '../api/images'
import { CapabilityModelPicker } from '../components/CapabilityModelPicker'
import { ImageLightbox } from '../components/ImageLightbox'
import { LoadingImage } from '../components/LoadingImage'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { RunModelsEditor } from '../components/imagecycles/RunModelsEditor'
import { RunVisionPromptEditor } from '../components/imagecycles/RunVisionPromptEditor'
import { MarkdownContent } from '../components/MarkdownContent'
import { PromptTextarea } from '../components/PromptTextarea'
import { ToolSidebar } from '../components/ToolSidebar'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { useResetOnChange } from '../hooks/useResetOnChange'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import { isListedCapability } from '../lib/capability-picker'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import {
  DEFAULT_IMPROVER_PROMPT,
  DEFAULT_DESCRIBE_PROMPT,
  DESCRIBE_PROMPT_BUCKET,
} from '../lib/describe'
import { pastedImageFiles } from '../lib/clipboardImages'
import { cn } from '../lib/utils'
import type { ImageCycleRouteState } from '../lib/imageCycles'
import type { LlmCapabilityInfo } from '../types/ws'

const terminal = (status: string) =>
  ['completed', 'failed', 'canceled'].includes(status)
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Request failed'

/** Shared persistent image-run UI; each app has separate endpoints and history. */
export default function ImageCyclesPage({
  improver = false,
}: {
  improver?: boolean
}) {
  const title = improver ? 'Generator Improver' : 'Image Cycles'
  const defaultPrompt = improver
    ? DEFAULT_IMPROVER_PROMPT
    : DEFAULT_DESCRIBE_PROMPT
  const {
    listImageCycles,
    getImageCycle,
    pollImageCycle,
    cancelImageCycle,
    deleteImageCycle,
    restartImageCycle,
    restartImageCycleFromStep,
    pauseImageCycle,
    resumeImageCycle,
    updateImageCycleModels,
    updateImageCycleVisionPrompt,
    startImageCycle,
  } = imageCycleApi(improver)
  const { token } = useAuth()
  const location = useLocation()
  const routeImage = (location.state as ImageCycleRouteState | null)?.cycleImage
  const [search, setSearch] = useSearchParams()
  const panel = search.get('job') ?? 'new'
  const [jobs, setJobs] = useState<ImageCycleJob[]>([])
  const job = jobs.find((j) => j.job_id === panel)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [mode, setMode] = useState<'image' | 'text'>('image')
  const [input, setInput] = useState<UploadedImage | null>(null)
  const [prompt, setPrompt] = useState('')
  const [describePrompt, setDescribePrompt] = useState(defaultPrompt)
  const [cycles, setCycles] = useState('3')
  const [expectedQuality, setExpectedQuality] = useState('95')
  const [bootstrapModels, setBootstrapModels] = useState<LlmCapabilityInfo[]>(
    [],
  )
  const [bootstrap, setBootstrap] = useState('')
  const [width, setWidth] = useState('1024')
  const [height, setHeight] = useState('1024')
  const [visionModels, setVisionModels] = useState<LlmCapabilityInfo[]>([])
  const [imageModels, setImageModels] = useState<LlmCapabilityInfo[]>([])
  const [vision, setVision] = useState('')
  const [image, setImage] = useState('')
  const [capsStatus, setCapsStatus] = useState<CapabilitiesStatus>('loading')
  const [capsError, setCapsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [viewer, setViewer] = useState<{
    panel: string
    imageId: string
  } | null>(null)
  const [deletedImages, setDeletedImages] = useState<Set<string>>(
    () => new Set(),
  )
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)

  useResetOnChange(panel, () => setCompareMode(false))

  useResetOnChange(routeImage ? location.key : null, (key) => {
    if (!key || !routeImage) return
    setInput(routeImage)
    setMode('image')
    setCompareMode(false)
    setViewer(null)
    setError(null)
    if (isMobile) setSidebarOpen(false)
  })

  const put = useCallback((next: ImageCycleJob) => {
    setJobs((prev) =>
      [next, ...prev.filter((j) => j.job_id !== next.job_id)].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    )
  }, [])
  const select = (id: string) => {
    setViewer(null)
    setSearch(id === 'new' ? {} : { job: id })
    setError(null)
    if (isMobile) setSidebarOpen(false)
  }
  const loadModels = useCallback(
    () =>
      Promise.all([
        listDescribeCapabilities(token!),
        listImgGenCapabilities(token!),
      ]),
    [token],
  )
  const applyModels = useCallback(
    ([v, imgs]: Awaited<ReturnType<typeof loadModels>>) => {
      const eligible = imgs.filter(
        (c) =>
          c.tags.length === 0 ||
          c.tags.includes(improver ? 'img2img' : 'txt2img'),
      )
      const seeds = imgs.filter(
        (c) => c.tags.length === 0 || c.tags.includes('txt2img'),
      )
      setBootstrapModels(seeds)
      setBootstrap((prev) =>
        isListedCapability(prev, seeds) ? prev : (seeds[0]?.base ?? ''),
      )
      setVisionModels(v.capabilities)
      setImageModels(eligible)
      setVision((prev) =>
        isListedCapability(prev, v.capabilities)
          ? prev
          : (v.capabilities[0]?.base ?? ''),
      )
      setImage((prev) =>
        isListedCapability(prev, eligible) ? prev : (eligible[0]?.base ?? ''),
      )
      setCapsStatus('ready')
      setCapsError(null)
    },
    [improver],
  )
  function refreshModels() {
    setCapsStatus('loading')
    setCapsError(null)
    void loadModels()
      .then(applyModels)
      .catch((e) => {
        setCapsError(message(e))
        setCapsStatus('error')
      })
  }
  useEffect(() => {
    if (!token) return
    let live = true
    loadModels()
      .then((data) => {
        if (live) applyModels(data)
      })
      .catch((e) => {
        if (live) {
          setCapsError(message(e))
          setCapsStatus('error')
        }
      })
    return () => {
      live = false
    }
  }, [token, loadModels, applyModels])
  useEffect(() => {
    if (!token) return
    let live = true
    listImageCycles(token)
      .then((data) => {
        if (live) setJobs(data)
      })
      .catch((e) => {
        if (live) setError(message(e))
      })
      .finally(() => {
        if (live) setHistoryLoading(false)
      })
    return () => {
      live = false
    }
  }, [token, listImageCycles])

  // Chained timeouts never overlap. Leaving a job stops foreground requests;
  // its persisted backend worker continues running independently.
  useEffect(() => {
    if (!token || panel === 'new') return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick(first: boolean) {
      try {
        const next = await (first
          ? getImageCycle(token!, panel)
          : pollImageCycle(token!, panel))
        if (!live) return
        put(next)
        if (!terminal(next.status))
          timer = setTimeout(() => {
            void tick(false)
          }, 3000)
      } catch (e) {
        if (live) {
          setError(message(e))
          timer = setTimeout(() => {
            void tick(false)
          }, 5000)
        }
      }
    }
    void tick(true)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [panel, token, put, getImageCycle, pollImageCycle, job?.status])

  async function upload(file: File) {
    if (!token) return
    setUploading(true)
    setError(null)
    try {
      setInput(await uploadImage(token, file))
    } catch (e) {
      setError(message(e))
    } finally {
      setUploading(false)
    }
  }
  async function action(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const validNumber = (v: string, min: number, max: number) =>
    Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max
  const canStart =
    !!token &&
    !busy &&
    !uploading &&
    capsStatus === 'ready' &&
    (mode === 'image' ? !!input : !!prompt.trim()) &&
    !!describePrompt.trim() &&
    isListedCapability(vision, visionModels) &&
    isListedCapability(image, imageModels) &&
    validNumber(cycles, 1, 50) &&
    validNumber(width, 128, 2048) &&
    validNumber(height, 128, 2048) &&
    (!improver ||
      (validNumber(expectedQuality, 1, 100) &&
        (mode !== 'text' || isListedCapability(bootstrap, bootstrapModels))))

  const viewerImages = (() => {
    const images: {
      id: string
      src: string
      alt: string
      filename: string
      direction: string
      prompt: string | null
    }[] = []
    if (!token) return images
    const add = (
      id: string,
      alt: string,
      direction: string,
      prompt: string | null,
      filename = `image-${id}.jpg`,
    ) => {
      if (!deletedImages.has(id) && !images.some((image) => image.id === id))
        images.push({
          id,
          src: imageFileUrl(id, token),
          alt,
          filename,
          direction,
          prompt,
        })
    }
    if (panel === 'new') {
      if (input)
        add(input.image_id, 'Starting image', 'input', null, input.filename)
    } else if (job) {
      if (job.params.input_image_id)
        add(job.params.input_image_id, 'Original starting image', 'input', null)
      for (const step of job.steps) {
        if (step.output_image_id)
          add(
            step.output_image_id,
            step.cycle === 0
              ? 'Starting image'
              : `${improver ? 'Improvement' : 'Cycle'} ${step.cycle}`,
            'output',
            step.prompt,
          )
      }
    }
    return images
  })()
  const viewerIndex =
    viewer?.panel === panel
      ? viewerImages.findIndex((image) => image.id === viewer.imageId)
      : -1
  const viewedImage = viewerImages[viewerIndex]
  const comparisonStart = viewerImages[0]
  const comparisonLatest = viewerImages
    .filter((image) => image.direction === 'output')
    .at(-1)
  const canCompare =
    panel !== 'new' &&
    comparisonStart &&
    comparisonLatest &&
    comparisonStart.id !== comparisonLatest.id
  const firstIncompleteStep =
    job?.steps.findIndex((step) => step.status !== 'completed') ?? -1

  function preview(id: string, alt: string, testId?: string) {
    if (deletedImages.has(id))
      return <p className="text-sm text-muted-foreground">Image deleted.</p>
    return (
      <button
        type="button"
        onClick={() => setViewer({ panel, imageId: id })}
        className="block cursor-zoom-in rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`View full size: ${alt}`}
      >
        <img
          src={imageFileUrl(id, token!)}
          alt={alt}
          loading="lazy"
          data-testid={testId}
          className="max-h-[32rem] w-auto max-w-full rounded-lg bg-muted/30 object-contain"
        />
      </button>
    )
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden"
      data-testid={improver ? 'generator-improver-page' : 'image-cycles-page'}
    >
      <ToolSidebar
        title={title}
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="cycles-history"
      >
        <div className="shrink-0 p-3">
          <Button
            className="min-h-11 w-full"
            onClick={() => select('new')}
            data-testid="cycles-new"
          >
            <Plus /> New run
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {historyLoading && (
            <p className="p-2 text-sm text-muted-foreground">
              Loading history…
            </p>
          )}
          {!historyLoading && jobs.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              Your runs will appear here.
            </p>
          )}
          {jobs.map((j) => {
            const previewId = [
              j.params.input_image_id,
              ...j.steps.map((step) => step.output_image_id),
            ].find((id) => id && !deletedImages.has(id))
            return (
              <button
                key={j.job_id}
                onClick={() => select(j.job_id)}
                data-testid={`cycles-item-${j.job_id}`}
                className={cn(
                  'mb-2 flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/70',
                  panel === j.job_id
                    ? 'bg-muted ring-1 ring-primary/30'
                    : 'bg-muted/30',
                )}
              >
                {previewId && token ? (
                  <LoadingImage
                    key={previewId}
                    src={imageThumbnailUrl(previewId, token)}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    data-testid={`cycles-item-preview-${j.job_id}`}
                    className="size-12 shrink-0 rounded-md bg-muted object-cover"
                  />
                ) : (
                  <span
                    className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                    aria-hidden
                  >
                    <ImageIcon className="size-5" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {j.params.initial_prompt || 'Image seed'} ·{' '}
                    {j.params.cycles} {improver ? 'max steps' : 'cycles'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {j.status} · {new Date(j.created_at).toLocaleString()}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </ToolSidebar>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle run history"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelLeft />
          </Button>
          <Repeat2 className="size-5 text-primary" />
          <h1 className="font-display text-lg font-semibold">{title}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto max-w-4xl space-y-6">
            {error && <JobErrorBanner message={error} testId="cycles-error" />}
            {panel === 'new' ? (
              <form
                className="space-y-6"
                data-testid="cycles-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!canStart) return
                  void action(async () => {
                    const started = await startImageCycle(token!, {
                      initial_prompt: mode === 'text' ? prompt : null,
                      input_image_id: mode === 'image' ? input!.image_id : null,
                      describe_prompt: describePrompt,
                      vision_model: vision,
                      image_model: image,
                      cycles: Number(cycles),
                      ...(improver
                        ? {
                            expected_quality: Number(expectedQuality),
                            max_steps: Number(cycles),
                            bootstrap_model: mode === 'text' ? bootstrap : null,
                          }
                        : {}),
                      width: Number(width),
                      height: Number(height),
                    })
                    select(started.job_id)
                  })
                }}
                onPaste={(e) => {
                  if (mode !== 'image' || uploading) return
                  const files = pastedImageFiles(e.clipboardData)
                  if (files[0]) {
                    e.preventDefault()
                    void upload(files[0])
                  }
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {improver
                    ? 'Score an image with vision AI, improve it with img2img, and repeat until the expected quality or maximum steps is reached. Every score, prompt, and image is saved.'
                    : 'Describe an image, generate a new one from the description, and repeat. Every image and intermediate prompt is saved.'}
                </p>
                <div
                  className="flex gap-2"
                  role="group"
                  aria-label="Starting input"
                >
                  {(['image', 'text'] as const).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      variant={mode === m ? 'default' : 'outline'}
                      aria-pressed={mode === m}
                      className="min-h-11 flex-1 sm:flex-none"
                      onClick={() => setMode(m)}
                      data-testid={`cycles-mode-${m}`}
                    >
                      {m === 'image' ? 'Start from image' : 'Start from text'}
                    </Button>
                  ))}
                </div>
                {mode === 'image' ? (
                  <section
                    className="space-y-3 rounded-lg bg-muted/30 p-4"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (!uploading && e.dataTransfer.files[0])
                        void upload(e.dataTransfer.files[0])
                    }}
                  >
                    <Label htmlFor="cycles-upload">Starting image</Label>
                    <Input
                      id="cycles-upload"
                      type="file"
                      accept="image/*"
                      disabled={uploading}
                      data-testid="cycles-upload"
                      onChange={(e) => {
                        if (e.target.files?.[0]) void upload(e.target.files[0])
                        e.target.value = ''
                      }}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setPickerOpen(true)}
                        disabled={uploading}
                      >
                        <FolderOpen /> Choose from files
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Upload, paste, or drop an image.
                      </span>
                    </div>
                    {uploading && (
                      <p role="status" className="text-sm">
                        Uploading image…
                      </p>
                    )}
                    {input && (
                      <div className="space-y-2">
                        {preview(
                          input.image_id,
                          'Starting image',
                          'cycles-input-preview',
                        )}
                        <p className="break-all text-xs text-muted-foreground">
                          {input.filename}
                        </p>
                      </div>
                    )}
                  </section>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="cycles-initial-prompt">
                      Starting text prompt
                    </Label>
                    <PromptTextarea
                      id="cycles-initial-prompt"
                      value={prompt}
                      onChange={setPrompt}
                      token={token}
                      bucket="imggen-prompt"
                      previews
                      data-testid="cycles-initial-prompt"
                      placeholder="Describe the image to generate first…"
                    />
                    <p className="text-xs text-muted-foreground">
                      {improver
                        ? 'Generates a starting image with txt2img, then improves it with img2img.'
                        : 'Generates a starting image before the describe → generate cycles.'}
                    </p>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Vision model</Label>
                    <CapabilityModelPicker
                      capabilities={visionModels}
                      selected={vision}
                      onSelect={setVision}
                      onRefresh={refreshModels}
                      capabilitiesStatus={capsStatus}
                      capabilitiesError={capsError}
                      testIdPrefix="cycles-vision-model"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {improver
                        ? 'Improvement model · img2img'
                        : 'Image generation model'}
                    </Label>
                    <CapabilityModelPicker
                      capabilities={imageModels}
                      selected={image}
                      onSelect={setImage}
                      onRefresh={refreshModels}
                      capabilitiesStatus={capsStatus}
                      capabilitiesError={capsError}
                      testIdPrefix="cycles-image-model"
                    />
                  </div>
                </div>
                {improver && mode === 'text' && (
                  <div className="space-y-2">
                    <Label>Starting image model · txt2img</Label>
                    <CapabilityModelPicker
                      capabilities={bootstrapModels}
                      selected={bootstrap}
                      onSelect={setBootstrap}
                      onRefresh={refreshModels}
                      capabilitiesStatus={capsStatus}
                      capabilitiesError={capsError}
                      testIdPrefix="improver-bootstrap-model"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="cycles-describe-prompt">
                      {improver
                        ? 'Quality assessment instructions'
                        : 'Describe prompt · used for every cycle'}
                    </Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDescribePrompt(defaultPrompt)}
                    >
                      Reset to default
                    </Button>
                  </div>
                  <PromptTextarea
                    id="cycles-describe-prompt"
                    value={describePrompt}
                    onChange={setDescribePrompt}
                    token={token}
                    bucket={DESCRIBE_PROMPT_BUCKET}
                    rows={7}
                    data-testid="cycles-describe-prompt"
                  />
                  <p className="text-xs text-muted-foreground">
                    {improver
                      ? 'Vision output is forced to JSON: {"quality": 95, "improve_prompt": "…"}. Quality is an integer out of 100.'
                      : 'Uses the same saved prompt library as Describe Image.'}
                  </p>
                </div>
                {improver && (
                  <div className="space-y-2">
                    <Label htmlFor="improver-quality">
                      Expected quality (1–100)
                    </Label>
                    <Input
                      id="improver-quality"
                      data-testid="improver-quality"
                      type="number"
                      min={1}
                      max={100}
                      value={expectedQuality}
                      onChange={(e) => setExpectedQuality(e.target.value)}
                    />
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="cycles-count">
                      {improver ? 'Max steps (1–50)' : 'Cycles (1–50)'}
                    </Label>
                    <Input
                      id="cycles-count"
                      type="number"
                      min={1}
                      max={50}
                      value={cycles}
                      onChange={(e) => setCycles(e.target.value)}
                      data-testid="cycles-count"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cycles-width">Width</Label>
                    <Input
                      id="cycles-width"
                      type="number"
                      min={128}
                      max={2048}
                      value={width}
                      onChange={(e) => setWidth(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cycles-height">Height</Label>
                    <Input
                      id="cycles-height"
                      type="number"
                      min={128}
                      max={2048}
                      value={height}
                      onChange={(e) => setHeight(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {improver
                    ? `Up to ${cycles || '…'} img2img improvements; the starting and final images are also assessed.`
                    : validNumber(cycles, 1, 50)
                      ? `${cycles} descriptions + ${Number(cycles) + (mode === 'text' ? 1 : 0)} generated images`
                      : 'Choose between 1 and 50 cycles'}
                </p>
                <Button
                  type="submit"
                  disabled={!canStart}
                  className="min-h-11 w-full sm:w-auto"
                  data-testid="cycles-start"
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Repeat2 />}{' '}
                  {improver ? 'Start improving' : 'Start cycles'}
                </Button>
              </form>
            ) : job ? (
              <section className="space-y-6" data-testid="cycles-detail">
                <div className="space-y-3">
                  <h2 className="font-display text-xl font-semibold">
                    {improver
                      ? `Target quality: ${job.params.expected_quality}/100 · max ${job.params.max_steps} improvements`
                      : `${job.params.cycles} describe → generate cycles`}
                  </h2>
                  <p
                    className="text-sm"
                    role="status"
                    data-testid="cycles-status"
                  >
                    {job.status} ·{' '}
                    {
                      job.steps.filter(
                        (s) =>
                          s.kind === 'generate' &&
                          s.cycle > 0 &&
                          s.status === 'completed',
                      ).length
                    }
                    /{job.params.cycles} {improver ? 'improvements' : 'cycles'}{' '}
                    complete
                  </p>
                  {improver && job.stop_reason && (
                    <p
                      className="text-sm font-medium"
                      data-testid="improver-stop-reason"
                    >
                      {job.stop_reason === 'target_reached'
                        ? 'Expected quality reached'
                        : 'Maximum improvements reached'}
                      {' · Final quality: '}
                      {
                        job.steps.filter((s) => s.quality != null).at(-1)
                          ?.quality
                      }
                      /100
                    </p>
                  )}
                  <p className="break-all text-xs text-muted-foreground">
                    Vision: {job.params.vision_model} · Images:{' '}
                    {job.params.image_model} · {job.params.width} ×{' '}
                    {job.params.height}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {job.status === 'running' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        data-testid="cycles-pause"
                        onClick={() => {
                          void action(async () =>
                            put(await pauseImageCycle(token!, job.job_id)),
                          )
                        }}
                      >
                        <Pause /> Pause
                      </Button>
                    )}
                    {job.status === 'paused' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        data-testid="cycles-resume"
                        onClick={() => {
                          void action(async () =>
                            put(await resumeImageCycle(token!, job.job_id)),
                          )
                        }}
                      >
                        <Play /> Resume
                      </Button>
                    )}
                    {job.status === 'failed' &&
                      job.steps.some(
                        (s) =>
                          s.status === 'failed' &&
                          s.kind === 'describe' &&
                          s.result,
                      ) && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          data-testid="cycles-retry-parsing"
                          onClick={() => {
                            void action(async () =>
                              put(await resumeImageCycle(token!, job.job_id)),
                            )
                          }}
                        >
                          <RefreshCw /> Retry assessment parsing
                        </Button>
                      )}
                    <Button
                      variant="outline"
                      disabled={busy}
                      data-testid="cycles-restart"
                      onClick={() => {
                        void action(async () => {
                          const next = await restartImageCycle(
                            token!,
                            job.job_id,
                          )
                          select(next.job_id)
                        })
                      }}
                    >
                      <RotateCcw /> Restart from beginning
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        void action(async () =>
                          put(await pollImageCycle(token!, job.job_id)),
                        )
                      }}
                      data-testid="cycles-poll"
                    >
                      <RefreshCw /> Refresh
                    </Button>
                    {canCompare && (
                      <Button
                        type="button"
                        variant={compareMode ? 'default' : 'outline'}
                        onClick={() => setCompareMode((value) => !value)}
                        aria-pressed={compareMode}
                        aria-controls="cycles-compare-view"
                        data-testid="cycles-compare-toggle"
                      >
                        <Columns2 />
                        {compareMode ? 'Hide comparison' : 'Compare'}
                      </Button>
                    )}
                    {!terminal(job.status) ? (
                      <Button
                        variant="outline"
                        disabled={busy || job.status === 'cancelRequested'}
                        onClick={() => {
                          void action(async () =>
                            put(await cancelImageCycle(token!, job.job_id)),
                          )
                        }}
                        data-testid="cycles-cancel"
                      >
                        <Square /> Cancel run
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            void action(async () => {
                              await deleteImageCycle(token!, job.job_id)
                              setJobs((prev) =>
                                prev.filter((j) => j.job_id !== job.job_id),
                              )
                              select('new')
                            })
                          }}
                          data-testid="cycles-delete"
                        >
                          <Trash2 /> Delete run and outputs
                        </Button>
                      </>
                    )}
                  </div>
                  {job.status === 'paused' && (
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid="cycles-pause-note"
                    >
                      Paused. The current task may finish; no next step starts
                      until you resume.
                    </p>
                  )}
                  <div className="flex flex-wrap items-start gap-3 [&>section]:w-full">
                    <RunModelsEditor
                      key={job.job_id}
                      job={job}
                      visionModels={visionModels}
                      imageModels={imageModels}
                      bootstrapModels={bootstrapModels}
                      status={capsStatus}
                      error={capsError}
                      busy={busy}
                      onRefresh={refreshModels}
                      onSave={async (models) => {
                        setBusy(true)
                        setError(null)
                        try {
                          put(
                            await updateImageCycleModels(
                              token!,
                              job.job_id,
                              models,
                            ),
                          )
                          return true
                        } catch (e) {
                          setError(message(e))
                          return false
                        } finally {
                          setBusy(false)
                        }
                      }}
                    />
                    <RunVisionPromptEditor
                      key={`vision-prompt-${job.job_id}`}
                      job={job}
                      token={token}
                      busy={busy}
                      onSave={async (prompt) => {
                        setBusy(true)
                        setError(null)
                        try {
                          put(
                            await updateImageCycleVisionPrompt(
                              token!,
                              job.job_id,
                              prompt,
                            ),
                          )
                          return true
                        } catch (e) {
                          setError(message(e))
                          return false
                        } finally {
                          setBusy(false)
                        }
                      }}
                    />
                  </div>
                  {job.error && (
                    <JobErrorBanner
                      message={job.error}
                      testId="cycles-job-error"
                    />
                  )}
                </div>
                {compareMode && canCompare && (
                  <section
                    className="space-y-3"
                    aria-label="Starting image and latest result"
                  >
                    <h3 className="font-semibold">
                      Starting image and latest result
                    </h3>
                    <div
                      id="cycles-compare-view"
                      data-testid="cycles-compare-view"
                      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border"
                    >
                      {[
                        {
                          image: comparisonStart,
                          label: 'Before',
                          side: 'before',
                        },
                        {
                          image: comparisonLatest,
                          label: 'Latest',
                          side: 'latest',
                        },
                      ].map(({ image, label, side }) => (
                        <div
                          key={side}
                          className="relative min-w-0 overflow-hidden bg-background"
                        >
                          <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                            {label}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setViewer({ panel, imageId: image.id })
                            }
                            aria-label={`View full size: ${image.alt}`}
                            data-testid={`cycles-compare-${side}`}
                            className="group block w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <LoadingImage
                              src={image.src}
                              alt={image.alt}
                              className="max-h-[40dvh] w-full object-contain transition-opacity group-hover:opacity-95 sm:max-h-[65vh]"
                            />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <section className="space-y-3">
                  <h3 className="font-semibold">Starting point</h3>
                  {job.params.input_image_id ? (
                    preview(
                      job.params.input_image_id,
                      'Original starting image',
                    )
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {job.params.initial_prompt}
                    </p>
                  )}
                </section>
                <ol className="space-y-8" data-testid="cycles-timeline">
                  {job.steps.map((step, i) => (
                    <li
                      key={i}
                      className="space-y-3 border-t pt-5"
                      data-testid={`cycles-step-${i}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">
                          {step.cycle === 0
                            ? 'Starting image'
                            : improver
                              ? step.kind === 'describe'
                                ? `Quality check ${step.cycle}`
                                : `Improvement ${step.cycle} · img2img`
                              : `Cycle ${step.cycle} · ${step.kind === 'describe' ? 'Describe' : 'Generate'}`}
                        </h3>
                        <span className="rounded bg-muted px-2 py-0.5 text-xs">
                          {step.status}
                        </span>
                        {step.reused && (
                          <span className="text-xs text-muted-foreground">
                            Reused result
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:ml-auto"
                          disabled={
                            busy ||
                            (firstIncompleteStep >= 0 &&
                              i > firstIncompleteStep)
                          }
                          title={
                            firstIncompleteStep >= 0 && i > firstIncompleteStep
                              ? 'Earlier steps must finish first'
                              : 'Create a new run from this step using the current models'
                          }
                          data-testid={`cycles-restart-step-${i}`}
                          onClick={() => {
                            void action(async () => {
                              const next = await restartImageCycleFromStep(
                                token!,
                                job.job_id,
                                i,
                              )
                              select(next.job_id)
                            })
                          }}
                        >
                          <RotateCcw /> Restart from this step
                        </Button>
                      </div>
                      {step.model && (
                        <p
                          className="break-all text-xs text-muted-foreground"
                          data-testid={`cycles-step-model-${i}`}
                        >
                          Model: {step.model}
                        </p>
                      )}
                      {step.quality != null && (
                        <p
                          className="text-lg font-semibold"
                          data-testid={`improver-quality-${i}`}
                        >
                          Quality: {step.quality}/100
                        </p>
                      )}
                      {step.improve_prompt && (
                        <div className="space-y-1">
                          <h4 className="text-xs font-medium text-muted-foreground">
                            Improvement prompt
                          </h4>
                          <p
                            className="whitespace-pre-wrap break-words text-sm"
                            data-testid={`improver-prompt-${i}`}
                          >
                            {step.improve_prompt}
                          </p>
                        </div>
                      )}
                      {step.stage && (
                        <p className="text-xs text-muted-foreground">
                          {step.stage}
                        </p>
                      )}
                      {step.prompt && (
                        <div className="space-y-1">
                          <h4 className="text-xs font-medium text-muted-foreground">
                            {step.kind === 'describe'
                              ? improver
                                ? 'Quality assessment prompt'
                                : 'Describe prompt'
                              : 'Generation prompt'}
                          </h4>
                          <p
                            className="whitespace-pre-wrap break-words text-sm"
                            data-testid={`cycles-step-prompt-${i}`}
                          >
                            {step.prompt}
                          </p>
                        </div>
                      )}
                      {step.result && (
                        <div
                          className="space-y-2"
                          data-testid={`cycles-step-result-${i}`}
                        >
                          <h4 className="text-xs font-medium text-muted-foreground">
                            {improver
                              ? 'Vision JSON assessment'
                              : 'Description → next generation prompt'}
                          </h4>
                          <MarkdownContent>{step.result}</MarkdownContent>
                          {improver && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer">
                                Raw vision response
                              </summary>
                              <pre
                                className="mt-2 whitespace-pre-wrap break-words"
                                data-testid={`improver-raw-${i}`}
                              >
                                {step.result}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                      {step.output_image_id &&
                        preview(
                          step.output_image_id,
                          `Generated image ${step.cycle}`,
                          `cycles-step-image-${i}`,
                        )}
                      {step.error && <JobErrorBanner message={step.error} />}
                    </li>
                  ))}
                </ol>
              </section>
            ) : (
              <p role="status">Loading run…</p>
            )}
          </div>
        </div>
      </main>
      {token && viewedImage && (
        <ImageLightbox
          open
          onOpenChange={(open) => {
            if (!open) setViewer(null)
          }}
          src={viewedImage.src}
          alt={viewedImage.alt}
          caption={viewedImage.alt}
          slides={viewerImages}
          index={viewerIndex}
          onIndexChange={(index) => {
            const image = viewerImages[index]
            if (image) setViewer({ panel, imageId: image.id })
          }}
          promptPanel={
            viewedImage.prompt ? (
              <p className="whitespace-pre-wrap break-words text-sm">
                {viewedImage.prompt}
              </p>
            ) : undefined
          }
          actions={{
            imageId: viewedImage.id,
            filename: viewedImage.filename,
            direction: viewedImage.direction,
            token,
            imgUtils: {},
            onDeleted: () => {
              setDeletedImages((previous) =>
                new Set(previous).add(viewedImage.id),
              )
              setViewer(null)
            },
          }}
        />
      )}
      {token && (
        <ImagePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          token={token}
          onSelect={(picked) => {
            setInput(picked)
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
