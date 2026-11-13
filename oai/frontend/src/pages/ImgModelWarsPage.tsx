import { ImageSizePicker } from '@/components/ImageSizePicker'
import { rememberedImageSize } from '@/lib/imageSizes'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Check,
  ImageIcon,
  Loader2,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Swords,
  Trash2,
  Zap,
} from 'lucide-react'
import {
  cancelImgModelWar,
  deleteImgModelWar,
  getImgModelWar,
  listImgModelWars,
  retryImgModelWar,
  startImgModelWar,
  type ImgModelWarJob,
  type ImgModelWarSlot,
} from '../api/imgModelWars'
import {
  imageFileUrl,
  imageThumbnailUrl,
  listImgGenCapabilities,
  type ImgGenCapability,
} from '../api/images'
import { recordRecentPrompt } from '../api/prompts'
import { listPromptPlaceholders } from '../api/promptPlaceholders'
import { ModelAvailabilityDot } from '../components/chat/ModelAvailabilityDot'
import { ImageLightbox } from '../components/ImageLightbox'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { LoadingImage } from '../components/LoadingImage'
import { PromptTextarea } from '../components/PromptTextarea'
import { ToolSidebar } from '../components/ToolSidebar'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { RecentPlaceholders } from '../components/imggen/RecentPlaceholders'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { useResetOnChange } from '../hooks/useResetOnChange'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import {
  filterCapabilitiesByWorkflow,
  formatDuration,
  imageJobStatusLabel,
  modelNameFromCapability,
  promptExcerpt,
} from '../lib/imggen'
import { sortCapabilitiesForPicker } from '../lib/modelAvailability'
import { createPlaceholderUsage, expandPromptPlaceholders } from '../lib/promptPlaceholders'
import { recordPlaceholdersUsed } from '../lib/recentPlaceholders'
import { cn } from '../lib/utils'

export const MIN_WAR_MODELS = 2
export const MAX_WAR_MODELS = 8
const POLL_MS = 3000
const MODELS_STORAGE_KEY = 'oai_img_model_wars_models'

const terminal = (status: string) => ['completed', 'failed', 'canceled'].includes(status)
const message = (e: unknown) => (e instanceof Error ? e.message : 'Request failed')
const isEdge = (v: string) => Number.isInteger(Number(v)) && Number(v) >= 128 && Number(v) <= 4096

function storedModels(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODELS_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}

/** The slot that finished first on the agent, if at least two finished. */
function fastestSlot(slots: ImgModelWarSlot[]): string | null {
  const timed = slots.filter(s => s.status === 'completed' && s.execution_seconds != null)
  if (timed.length < 2) return null
  return timed.reduce((a, b) => (b.execution_seconds! < a.execution_seconds! ? b : a)).model
}

/** Img Model Wars: one prompt, several imggen models, results side by side. */
export default function ImgModelWarsPage() {
  const { token } = useAuth()
  const { refreshRunningImageJobs } = useProgress()
  const [search, setSearch] = useSearchParams()
  const panel = search.get('job') ?? 'new'
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)

  const [jobs, setJobs] = useState<ImgModelWarJob[]>([])
  const job = jobs.find(j => j.job_id === panel)
  const [historyLoading, setHistoryLoading] = useState(true)

  const [capabilities, setCapabilities] = useState<ImgGenCapability[]>([])
  const [capsStatus, setCapsStatus] = useState<CapabilitiesStatus>('loading')
  const [capsError, setCapsError] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>(storedModels)

  const [prompt, setPrompt] = useState('')
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [width, setWidth] = useState(() => String(rememberedImageSize([1024, 1024], 4096, 128)[0]))
  const [height, setHeight] = useState(() => String(rememberedImageSize([1024, 1024], 4096, 128)[1]))
  const [seed, setSeed] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ panel: string; imageId: string } | null>(null)
  const [deletedImages, setDeletedImages] = useState<Set<string>>(() => new Set())

  useResetOnChange(panel, () => setViewer(null))

  const put = useCallback((next: ImgModelWarJob) => {
    setJobs(prev =>
      [next, ...prev.filter(j => j.job_id !== next.job_id)].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    )
  }, [])

  const select = (id: string) => {
    setSearch(id === 'new' ? {} : { job: id })
    setError(null)
    if (isMobile) setSidebarOpen(false)
  }

  // ── Models ────────────────────────────────────────────────────────────────
  const eligible = useMemo(
    () => sortCapabilitiesForPicker(filterCapabilitiesByWorkflow(capabilities, 'txt2img')) as ImgGenCapability[],
    [capabilities],
  )
  const applyCapabilities = useCallback((load: Promise<ImgGenCapability[]>, live: () => boolean) => {
    load
      .then(caps => {
        if (!live()) return
        setCapabilities(caps)
        setCapsStatus('ready')
        setCapsError(null)
      })
      .catch(e => {
        if (!live()) return
        setCapsError(message(e))
        setCapsStatus('error')
      })
  }, [])
  function refreshCapabilities() {
    if (!token) return
    setCapsStatus('loading')
    setCapsError(null)
    applyCapabilities(listImgGenCapabilities(token), () => true)
  }
  useEffect(() => {
    if (!token) return
    let live = true
    applyCapabilities(listImgGenCapabilities(token), () => live)
    return () => {
      live = false
    }
  }, [token, applyCapabilities])

  // Drop remembered models that are no longer offered; preselect the two most
  // relevant ones on first use.
  const listed = new Set(eligible.map(c => c.base))
  const selected = models.filter(m => listed.has(m))
  const selectedOrDefault =
    capsStatus === 'ready' && selected.length === 0 && models.length === 0
      ? eligible.filter(c => c.online).slice(0, MIN_WAR_MODELS).map(c => c.base)
      : selected

  function toggleModel(base: string) {
    const current = selectedOrDefault
    const next = current.includes(base)
      ? current.filter(m => m !== base)
      : current.length >= MAX_WAR_MODELS
        ? current
        : [...current, base]
    setModels(next)
    localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(next))
  }

  // ── History + polling ───────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return
    let live = true
    listImgModelWars(token)
      .then(data => {
        if (live) setJobs(data)
      })
      .catch(e => {
        if (live) setError(message(e))
      })
      .finally(() => {
        if (live) setHistoryLoading(false)
      })
    return () => {
      live = false
    }
  }, [token])

  // Child image jobs are advanced by the shell's progress loop and the backend
  // worker; this only re-reads the derived run. Chained timeouts never overlap.
  useEffect(() => {
    if (!token || panel === 'new') return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      try {
        const next = await getImgModelWar(token!, panel)
        if (!live) return
        put(next)
        if (!terminal(next.status)) timer = setTimeout(() => void tick(), POLL_MS)
      } catch (e) {
        if (live) {
          setError(message(e))
          timer = setTimeout(() => void tick(), POLL_MS * 2)
        }
      }
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [panel, token, put, job?.status])

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

  async function customPlaceholderDefs(): Promise<Record<string, string[]>> {
    try {
      const items = await listPromptPlaceholders(token!)
      return Object.fromEntries(items.map(i => [i.name.trim().toLowerCase(), i.variants]))
    } catch {
      return {}
    }
  }

  const canStart =
    !!token &&
    !busy &&
    capsStatus === 'ready' &&
    !!prompt.trim() &&
    selectedOrDefault.length >= MIN_WAR_MODELS &&
    selectedOrDefault.length <= MAX_WAR_MODELS &&
    isEdge(width) &&
    isEdge(height) &&
    (!seed.trim() || Number.isInteger(Number(seed)))

  const start = () =>
    action(async () => {
      if (!token) return
      if (prompt.trim()) void recordRecentPrompt(token, 'imggen-prompt', prompt).catch(() => {})
      if (overrideNegative && negativePrompt.trim()) {
        void recordRecentPrompt(token, 'imggen-negative', negativePrompt).catch(() => {})
      }
      recordPlaceholdersUsed(prompt)
      // Expanded once: every model gets the same {color}/{animal}/custom values.
      // `{?}` stays in the text and is substituted server-side per image job.
      const expanded = expandPromptPlaceholders(prompt, createPlaceholderUsage(), await customPlaceholderDefs())
      const res = await startImgModelWar(token, {
        models: selectedOrDefault,
        prompt: expanded.trim(),
        prompt_template: prompt.trim() || null,
        negative_prompt: overrideNegative ? negativePrompt.trim() || null : null,
        override_negative: overrideNegative,
        width: Number(width),
        height: Number(height),
        seed: seed.trim() ? Number(seed) : null,
      })
      put(await getImgModelWar(token, res.job_id))
      void refreshRunningImageJobs()
      select(res.job_id)
    })

  function editFrom(j: ImgModelWarJob) {
    const p = j.params
    setModels(p.models)
    setPrompt(p.prompt_template ?? p.prompt)
    setOverrideNegative(p.override_negative)
    setNegativePrompt(p.negative_prompt ?? '')
    setWidth(String(p.width))
    setHeight(String(p.height))
    setSeed(p.seed != null ? String(p.seed) : '')
    select('new')
  }

  // ── Viewer ──────────────────────────────────────────────────────────────
  const viewerImages =
    token && job
      ? job.slots
          .filter(s => s.output_image_id && !deletedImages.has(s.output_image_id))
          .map(s => ({
            id: s.output_image_id!,
            src: imageFileUrl(s.output_image_id!, token),
            alt: modelNameFromCapability(s.model),
            prompt: s.prompt,
            filename: `${modelNameFromCapability(s.model)}-${s.output_image_id}.jpg`,
          }))
      : []
  const viewerIndex =
    viewer?.panel === panel ? viewerImages.findIndex(i => i.id === viewer.imageId) : -1
  const viewed = viewerImages[viewerIndex]
  const fastest = job ? fastestSlot(job.slots) : null

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid="img-model-wars-page">
      <ToolSidebar
        title="Img Model Wars"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="wars-history"
      >
        <div className="shrink-0 p-3">
          <Button className="min-h-11 w-full" onClick={() => select('new')} data-testid="wars-new">
            <Plus /> New war
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {historyLoading && <p className="p-2 text-sm text-muted-foreground">Loading history…</p>}
          {!historyLoading && jobs.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">Your wars will appear here.</p>
          )}
          {jobs.map(j => (
              <button
                key={j.job_id}
                onClick={() => select(j.job_id)}
                data-testid={`wars-item-${j.job_id}`}
                className={cn(
                  'mb-2 flex w-full flex-col gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/70',
                  panel === j.job_id ? 'bg-muted ring-1 ring-primary/30' : 'bg-muted/30',
                )}
              >
                <div className="flex gap-1">
                  {j.slots.slice(0, 4).map(s => {
                    const id = s.output_image_id && !deletedImages.has(s.output_image_id) ? s.output_image_id : null
                    return id && token ? (
                      <LoadingImage
                        key={s.model}
                        src={imageThumbnailUrl(id, token)}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        decoding="async"
                        className="size-10 shrink-0 rounded-md bg-muted object-cover"
                      />
                    ) : (
                      <span
                        key={s.model}
                        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                      >
                        {terminal(s.status) ? <ImageIcon className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
                      </span>
                    )
                  })}
                </div>
                <span className="line-clamp-2 break-words">{promptExcerpt(j.params.prompt, 80)}</span>
                <span className="text-xs text-muted-foreground">
                  {j.slots.length} models · {imageJobStatusLabel(j.status)}
                </span>
              </button>
          ))}
        </div>
      </ToolSidebar>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto space-y-5 px-3 py-4 sm:px-6 sm:py-5', panel === 'new' ? 'max-w-3xl' : 'max-w-6xl')}>
          <header className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            >
              <PanelLeft />
            </Button>
            <Swords className="size-5 text-primary" />
            <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">
              {panel === 'new' ? 'Img Model Wars' : job ? promptExcerpt(job.params.prompt, 60) : 'Loading…'}
            </h1>
            {job && !terminal(job.status) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => action(async () => put(await cancelImgModelWar(token!, job.job_id)))}
                data-testid="wars-stop"
              >
                <Square /> Stop
              </Button>
            )}
            {job && (
              <Button variant="outline" size="sm" onClick={() => editFrom(job)} data-testid="wars-edit">
                <Pencil /> Edit
              </Button>
            )}
            {job && terminal(job.status) && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const res = await retryImgModelWar(token!, job.job_id)
                      put(await getImgModelWar(token!, res.job_id))
                      void refreshRunningImageJobs()
                      select(res.job_id)
                    })
                  }
                  data-testid="wars-retry"
                >
                  <RotateCcw /> Run again
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  title="Delete war and its images"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    action(async () => {
                      await deleteImgModelWar(token!, job.job_id)
                      setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
                      select('new')
                    })
                  }
                  data-testid="wars-delete"
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </header>

          {error && <JobErrorBanner message={error} testId="wars-error" />}

          {panel === 'new' ? (
            <section className="space-y-5" data-testid="wars-new-panel">
              <p className="text-sm text-muted-foreground">
                Pick {MIN_WAR_MODELS}–{MAX_WAR_MODELS} txt2img models. Every model renders exactly the same prompt,
                size and seed, and the results land side by side.
              </p>

              <div className="space-y-2" data-testid="wars-models">
                <div className="flex items-center justify-between gap-2">
                  <Label>
                    Models{' '}
                    <span className="font-normal text-muted-foreground" data-testid="wars-models-count">
                      ({selectedOrDefault.length}/{MAX_WAR_MODELS})
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={refreshCapabilities}
                    title="Refresh models"
                    disabled={capsStatus === 'loading'}
                  >
                    <RefreshCw className={cn(capsStatus === 'loading' && 'animate-spin')} />
                  </Button>
                </div>
                {capsStatus === 'error' && <JobErrorBanner message={capsError ?? 'Failed to load models'} />}
                {capsStatus === 'ready' && eligible.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No txt2img models found. Start an imggen agent or check the OffloadMQ connection in Settings.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {capsStatus === 'loading' && eligible.length === 0 && (
                    <span className="text-sm text-muted-foreground">Loading models…</span>
                  )}
                  {eligible.map(cap => {
                    const on = selectedOrDefault.includes(cap.base)
                    const full = !on && selectedOrDefault.length >= MAX_WAR_MODELS
                    return (
                      <button
                        key={cap.base}
                        type="button"
                        aria-pressed={on}
                        disabled={full}
                        onClick={() => toggleModel(cap.base)}
                        data-testid={`wars-model-${cap.base}`}
                        className={cn(
                          'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm transition-colors',
                          on
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-input bg-background hover:bg-muted/50',
                          full && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        {on ? <Check className="size-3.5" /> : <ModelAvailabilityDot cap={cap} />}
                        {modelNameFromCapability(cap.base)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="wars-prompt">Prompt</Label>
                <PromptTextarea
                  id="wars-prompt"
                  value={prompt}
                  onChange={setPrompt}
                  bucket="imggen-prompt"
                  token={token}
                  previews
                  rows={4}
                  data-testid="wars-prompt"
                />
                <RecentPlaceholders
                  onInsert={t => setPrompt(p => (p === '' || /\s$/.test(p) ? p + t : `${p} ${t}`))}
                />
                <p className="text-xs text-muted-foreground">
                  Placeholders like {'{color}'} are filled in once, so every model gets the same text. {'{?}'} is
                  substituted by the server for each image.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 pb-1.5">
                  <Label htmlFor="wars-negative">Negative prompt</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setOverrideNegative(v => !v)}
                    data-testid="wars-negative-toggle"
                  >
                    {overrideNegative ? 'use model default' : 'override'}
                  </Button>
                </div>
                {overrideNegative ? (
                  <PromptTextarea
                    id="wars-negative"
                    value={negativePrompt}
                    onChange={setNegativePrompt}
                    bucket="imggen-negative"
                    token={token}
                    rows={2}
                    placeholder="e.g. blurry, deformed, low quality"
                    data-testid="wars-negative-prompt"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Each model uses its workflow's default negative prompt.</p>
                )}
              </div>

              <ImageSizePicker width={width} height={height} testIdPrefix="wars" min={128} max={4096} onWidthChange={setWidth} onHeightChange={setHeight} onChange={([w,h]) => { setWidth(String(w)); setHeight(String(h)) }} />

              <div className="space-y-1.5">
                <Label htmlFor="wars-seed">Seed (optional)</Label>
                <Input
                  id="wars-seed"
                  value={seed}
                  onChange={e => setSeed(e.target.value)}
                  placeholder="empty = random per model"
                  data-testid="wars-seed"
                />
              </div>

              <Button className="min-h-11 w-full" disabled={!canStart} onClick={() => void start()} data-testid="wars-submit">
                {busy ? <Loader2 className="animate-spin" /> : <Swords />}
                Start war ({selectedOrDefault.length} models)
              </Button>
            </section>
          ) : job ? (
            <section className="space-y-4" data-testid="wars-detail">
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
                <p className="whitespace-pre-wrap break-words" data-testid="wars-detail-prompt">
                  {job.params.prompt}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {job.params.width}×{job.params.height}
                  {job.params.seed != null && ` · seed ${job.params.seed}`}
                  {job.params.override_negative && job.params.negative_prompt && ` · negative: ${job.params.negative_prompt}`}
                  {' · '}
                  <span data-testid="wars-status">{imageJobStatusLabel(job.status)}</span>
                </p>
              </div>
              {job.error && <JobErrorBanner message={job.error} />}
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="wars-slots">
                {job.slots.map(slot => {
                  const image =
                    slot.output_image_id && !deletedImages.has(slot.output_image_id) ? slot.output_image_id : null
                  return (
                    <li
                      key={slot.model}
                      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
                      data-testid={`wars-slot-${slot.model}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{modelNameFromCapability(slot.model)}</span>
                        {fastest === slot.model && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500"
                            data-testid="wars-fastest"
                          >
                            <Zap className="size-3" /> fastest
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground" data-testid="wars-slot-status">
                          {slot.status === 'completed' && slot.execution_seconds != null
                            ? formatDuration(slot.execution_seconds)
                            : imageJobStatusLabel(slot.status)}
                        </span>
                      </div>
                      {image && token ? (
                        <button
                          type="button"
                          onClick={() => setViewer({ panel, imageId: image })}
                          className="block cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`View full size: ${slot.model}`}
                        >
                          <LoadingImage
                            src={imageFileUrl(image, token)}
                            alt={slot.model}
                            width={slot.output_width ?? job.params.width}
                            height={slot.output_height ?? job.params.height}
                            loading="lazy"
                            decoding="async"
                            className="h-auto w-full rounded-lg bg-muted/30 object-contain"
                            data-testid={`wars-slot-image-${slot.model}`}
                          />
                        </button>
                      ) : !terminal(slot.status) ? (
                        <div
                          className="flex items-center justify-center rounded-lg bg-muted/30 p-4"
                          style={{ aspectRatio: `${job.params.width} / ${job.params.height}` }}
                        >
                          <JobProgressBar
                            status={slot.status}
                            stage={slot.stage}
                            startedAt={slot.started_at}
                            typicalRuntimeSeconds={slot.typical_runtime_seconds}
                            submittedAt={slot.submitted_at}
                          />
                        </div>
                      ) : slot.status === 'completed' ? (
                        <p className="text-sm text-muted-foreground">Image deleted.</p>
                      ) : null}
                      {slot.error && <JobErrorBanner message={slot.error} />}
                      {slot.prompt && slot.prompt !== job.params.prompt && (
                        <p className="text-xs break-words text-muted-foreground" title="Prompt sent to this model">
                          {slot.prompt}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : (
            <p role="status">Loading war…</p>
          )}
        </div>
      </main>

      {token && viewed && (
        <ImageLightbox
          open
          onOpenChange={open => {
            if (!open) setViewer(null)
          }}
          src={viewed.src}
          alt={viewed.alt}
          caption={viewed.alt}
          slides={viewerImages}
          index={viewerIndex}
          onIndexChange={index => {
            const image = viewerImages[index]
            if (image) setViewer({ panel, imageId: image.id })
          }}
          promptPanel={
            viewed.prompt ? <p className="whitespace-pre-wrap break-words text-sm">{viewed.prompt}</p> : undefined
          }
          actions={{
            imageId: viewed.id,
            filename: viewed.filename,
            direction: 'output',
            token,
            imgUtils: {},
            onDeleted: () => {
              setDeletedImages(prev => new Set(prev).add(viewed.id))
              setViewer(null)
            },
          }}
        />
      )}
    </div>
  )
}
