import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Box,
  Check,
  Copy,
  Glasses,
  Loader2,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import {
  cancelWorldJob,
  deleteWorldJob,
  formatMiB,
  getWorldJob,
  listWorldCapabilities,
  listWorldJobs,
  pollWorldJob,
  retryWorldJob,
  shareWorldJob,
  startWorldJob,
  SHARP_CAPABILITY,
  worldGeneratorLabel,
  worldModeLabel,
  worldPreviewUrl,
  worldSceneUrl,
  type ShareLink,
  type WorldCapability,
  type WorldJob,
  type WorldMode,
  type WorldsRouteState,
} from '../api/worlds'
import { imageFileUrl } from '../api/images'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { ToolSidebar } from '../components/ToolSidebar'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { JobProgressBar } from '../components/imggen/JobProgressBar'
import { ImagePickerModal } from '../components/imggen/ImagePickerModal'
import { ImageSlot } from '../components/imgutils/ImageSlot'
import { WORLDS_NEW_PANEL, WorldsHistorySidebar } from '../components/worlds/WorldsHistorySidebar'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useImageSlot } from '../hooks/useImageSlot'
import { useIsMobile } from '../hooks/useIsMobile'
import { useToolSidebarOpen } from '../hooks/useToolSidebarOpen'
import { pickListedCapability } from '../lib/capability-picker'
import { formatDuration, imageJobStatusLabel } from '../lib/imggen'

const SplatViewer = lazy(() => import('../components/worlds/SplatViewer'))

const POLL_INTERVAL_MS = 3000
const LIST_REFRESH_INTERVAL_MS = 5000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

const BUDGETS = [
  { value: 1024, label: 'Quest', hint: '≈0.6 M splats — smooth on the headset' },
  { value: 2048, label: 'Full', hint: '≈2.3 M splats — sharper; PC VR / desktop' },
]

/** Field of view of the picture; `null` = the generator's own default. */
const FOVS: { value: number | null; label: string }[] = [
  { value: null, label: 'Auto' },
  { value: 40, label: '40° (tele)' },
  { value: 55, label: '55°' },
  { value: 70, label: '70°' },
  { value: 90, label: '90° (wide)' },
]

const selectClass =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9'

/** "Auto" resolves by aspect on the agent; show what it will pick. */
function autoModeHint(width?: number, height?: number): string | null {
  if (!width || !height) return null
  const aspect = width / height
  return aspect >= 1.9 && aspect <= 2.1
    ? `${width}×${height} is 2:1 — Auto treats it as a 360° panorama`
    : `${width}×${height} — Auto treats it as a window you can lean into`
}

export default function WorldsPage() {
  const { token } = useAuth()
  const location = useLocation()
  const routeImage = (location.state as WorldsRouteState | null)?.worldImage
  const appliedRouteKey = useRef<string | null>(null)
  const { refreshRunningImageJobs, setForegroundJob } = useProgress()
  const input = useImageSlot(token)
  const { pickStored } = input
  const [pickerOpen, setPickerOpen] = useState(false)

  const [capabilities, setCapabilities] = useState<WorldCapability[]>([])
  const [capsLoading, setCapsLoading] = useState(true)
  const [capability, setCapability] = useState('')
  const [mode, setMode] = useState<WorldMode>('auto')
  const [maxWidth, setMaxWidth] = useState(1024)
  const [fillLean, setFillLean] = useState(0.25)
  const [fov, setFov] = useState<number | null>(null)
  const isSharp = capability === SHARP_CAPABILITY

  const [jobs, setJobs] = useState<WorldJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(WORLDS_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<WorldJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [share, setShare] = useState<ShareLink | null>(null)
  const [copied, setCopied] = useState(false)

  const [busy, setBusy] = useState<null | 'submit' | 'poll' | 'cancel' | 'retry' | 'delete' | 'share'>(null)
  const [error, setError] = useState<string | null>(null)

  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useToolSidebarOpen(isMobile)
  const viewingJob = activePanel !== WORLDS_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  useEffect(() => {
    if (!token || !routeImage || appliedRouteKey.current === location.key) return
    appliedRouteKey.current = location.key
    pickStored(routeImage)
    setActivePanel(WORLDS_NEW_PANEL)
    setError(null)
    setViewerOpen(false)
  }, [token, routeImage, location.key, pickStored])

  const loadCapabilities = useCallback(async () => {
    if (!token) return
    setCapsLoading(true)
    try {
      const data = await listWorldCapabilities(token)
      setCapabilities(data.capabilities)
      setCapability(prev => pickListedCapability(prev || data.capabilities[0]?.base || '', data.capabilities) ?? '')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCapsLoading(false)
    }
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      setJobs(await listWorldJobs(token))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    void (async () => {
      await Promise.resolve()
      void loadJobs()
      void loadCapabilities()
    })()
  }, [loadJobs, loadCapabilities])

  const upsertJob = useCallback((job: WorldJob) => {
    setSelectedJob(job)
    setJobs(prev => {
      const idx = prev.findIndex(j => j.job_id === job.job_id)
      if (idx < 0) return [job, ...prev]
      const next = [...prev]
      next[idx] = job
      return next
    })
  }, [])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return
      upsertJob(await getWorldJob(token, jobId))
    },
    [token, upsertJob],
  )

  async function selectJob(jobId: string) {
    setActivePanel(jobId)
    setError(null)
    setViewerOpen(false)
    setShare(null)
    setJobDetailLoading(true)
    try {
      await refreshJob(jobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobDetailLoading(false)
    }
  }

  function selectNew() {
    setActivePanel(WORLDS_NEW_PANEL)
    setError(null)
    setViewerOpen(false)
  }

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const inputImage = input.slot?.uploaded ?? null
  const canSubmit = Boolean(token && capability && inputImage && !input.slot?.error) && busy === null

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || !canSubmit || !inputImage) return
    const res = await run('submit', () =>
      startWorldJob(token, {
        capability,
        input_image_id: inputImage.image_id,
        // SHARP has no projection / budget / lean knobs: it predicts the whole splat.
        ...(isSharp ? { mode: 'perspective' as const } : { mode, max_width: maxWidth, fill_lean: fillLean }),
        ...(fov != null ? { hfov: fov } : {}),
      }),
    )
    if (!res) return
    input.clear()
    void refreshRunningImageJobs()
    await loadJobs()
    await selectJob(res.job_id)
  }

  const onPollNow = useCallback(
    async (jobId: string) => {
      if (!token) return
      try {
        upsertJob(await pollWorldJob(token, jobId))
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [token, upsertJob],
  )

  // Foreground auto-poll while viewing an in-flight job; the shell's Progress loop
  // skips it meanwhile so it isn't polled twice.
  useEffect(() => {
    if (!token || !viewedJobId) return
    const status = selectedJob?.status
    if (status && TERMINAL.has(status)) return
    setForegroundJob('worlds', viewedJobId)
    const id = window.setInterval(() => void onPollNow(viewedJobId), POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(id)
      setForegroundJob('worlds', null)
    }
  }, [token, viewedJobId, selectedJob?.status, onPollNow, setForegroundJob])

  const hasPendingJobs = jobs.some(j => !TERMINAL.has(j.status))
  useEffect(() => {
    if (!token || !hasPendingJobs) return
    const id = window.setInterval(() => void loadJobs(), LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, hasPendingJobs, loadJobs])

  async function onDelete(jobId: string) {
    if (!token) return
    const ok = await run('delete', () => deleteWorldJob(token, jobId).then(() => true))
    if (!ok) return
    const next = jobs.filter(j => j.job_id !== jobId)
    setJobs(next)
    if (next.length > 0) await selectJob(next[0].job_id)
    else {
      selectNew()
      setSelectedJob(null)
    }
  }

  async function onShare(jobId: string) {
    if (!token) return
    const link = await run('share', () => shareWorldJob(token, jobId))
    if (link) {
      setShare(link)
      setCopied(false)
    }
  }

  async function copyShare() {
    if (!share) return
    try {
      await navigator.clipboard.writeText(share.viewer_url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const job = selectedJob && selectedJob.job_id === viewedJobId ? selectedJob : null
  const status = job?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const executionSeconds =
    job?.started_at && !isRunning ? (Date.parse(job.updated_at) - Date.parse(job.started_at)) / 1000 : null
  const result = job?.result ?? null

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background" data-testid="worlds-page">
      <ToolSidebar
        title="Worlds"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="worlds-sidebar"
      >
        <WorldsHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          token={token}
          loading={jobsLoading}
          onSelectNew={() => {
            selectNew()
            if (isMobile) setSidebarOpen(false)
          }}
          onSelectJob={id => {
            void selectJob(id)
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
            {job ? worldModeLabel(result?.mode ?? job.mode) : 'New world'}
          </h1>
          {job && !isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(job.job_id)}
              disabled={busy === 'delete'}
              title="Delete world"
              aria-label="Delete world"
              data-testid="worlds-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {busy === 'delete' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {!viewingJob && (
              <section data-testid="worlds-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Orbit className="size-4 text-violet-500" />
                    VR Worlds
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Turn a picture into a place you can stand in. Open it in a Quest 3 and lean, look around, or
                    turn — a 2:1 panorama becomes a full 360° world.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="worlds-capability">Generator</Label>
                    <div className="flex gap-2">
                      <select
                        id="worlds-capability"
                        className={selectClass}
                        value={capability}
                        onChange={e => setCapability(e.target.value)}
                        disabled={capsLoading || capabilities.length === 0}
                        data-testid="worlds-capability"
                      >
                        {capabilities.length === 0 ? (
                          <option value="">{capsLoading ? 'Loading…' : 'No world.* agent online'}</option>
                        ) : (
                          capabilities.map(c => (
                            <option key={c.base} value={c.base}>
                              {worldGeneratorLabel(c.base)}
                            </option>
                          ))
                        )}
                      </select>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11 shrink-0 sm:size-9"
                        onClick={() => void loadCapabilities()}
                        title="Refresh generators"
                        aria-label="Refresh generators"
                      >
                        <RefreshCw className={capsLoading ? 'size-4 animate-spin' : 'size-4'} />
                      </Button>
                    </div>
                    {isSharp ? (
                      <p className="text-xs text-muted-foreground" data-testid="worlds-generator-hint">
                        Learned Gaussians at real-world scale: leaning and short steps stay solid. Covers what the
                        picture shows — no 360°, so panoramas belong to the Lotus generator.
                      </p>
                    ) : null}
                  </div>

                  <ImageSlot
                    label="Picture"
                    hint="A clear view with a level horizon; a 2:1 equirectangular image for 360°"
                    slot={input.slot}
                    testId="worlds-input"
                    onPick={file => void input.pickFile(file)}
                    onPickFromLibrary={() => setPickerOpen(true)}
                    onClear={input.clear}
                  />

                  <div className="space-y-1.5">
                    <Label htmlFor="worlds-fov">Field of view</Label>
                    <select
                      id="worlds-fov"
                      className={selectClass}
                      value={fov ?? ''}
                      onChange={e => setFov(e.target.value === '' ? null : Number(e.target.value))}
                      data-testid="worlds-fov"
                    >
                      {FOVS.map(f => (
                        <option key={f.label} value={f.value ?? ''}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {fov != null
                        ? "How wide the picture's camera was. Wider pushes the scene closer and deeper."
                        : isSharp
                          ? 'Auto: camera EXIF if present, otherwise a 30 mm lens (≈55° on a square image).'
                          : 'Auto: 70°.'}
                    </p>
                  </div>

                  {!isSharp ? (
                  <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="worlds-mode">Projection</Label>
                      <select
                        id="worlds-mode"
                        className={selectClass}
                        value={mode}
                        onChange={e => setMode(e.target.value as WorldMode)}
                        data-testid="worlds-mode"
                      >
                        <option value="auto">Auto (by aspect)</option>
                        <option value="perspective">Window — lean into the picture</option>
                        <option value="pano">360° panorama</option>
                      </select>
                      {mode === 'auto' && inputImage ? (
                        <p className="text-xs text-muted-foreground" data-testid="worlds-mode-hint">
                          {autoModeHint(inputImage.width, inputImage.height)}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <Label>Splat budget</Label>
                      <div className="flex gap-2" role="radiogroup" aria-label="Splat budget">
                        {BUDGETS.map(b => (
                          <Button
                            key={b.value}
                            type="button"
                            role="radio"
                            aria-checked={maxWidth === b.value}
                            variant={maxWidth === b.value ? 'default' : 'outline'}
                            className="min-h-11 flex-1 sm:min-h-9"
                            onClick={() => setMaxWidth(b.value)}
                            data-testid={`worlds-budget-${b.label.toLowerCase()}`}
                          >
                            {b.label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {BUDGETS.find(b => b.value === maxWidth)?.hint}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="worlds-lean">
                      Lean range · {Math.round(fillLean * 100)} cm
                    </Label>
                    <input
                      id="worlds-lean"
                      type="range"
                      min={0}
                      max={0.6}
                      step={0.05}
                      value={fillLean}
                      onChange={e => setFillLean(Number(e.target.value))}
                      className="w-full accent-primary"
                      data-testid="worlds-lean"
                    />
                    <p className="text-xs text-muted-foreground">
                      How far you can lean before the edges of near objects open up. Larger fills more hidden
                      background (blurrier, more splats).
                    </p>
                  </div>
                  </>
                  ) : null}

                  <Button type="submit" disabled={!canSubmit} className="min-h-11 w-full" data-testid="worlds-submit">
                    {busy === 'submit' ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" /> Submitting…
                      </>
                    ) : (
                      <>
                        <Box className="mr-2 size-4" /> Build world
                      </>
                    )}
                  </Button>

                  {error ? <JobErrorBanner message={error} testId="worlds-error" /> : null}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="worlds-job-detail" className="space-y-4">
                {error ? <JobErrorBanner message={error} testId="worlds-job-error" /> : null}
                {jobDetailLoading && !job ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : job && token ? (
                  <>
                    {viewerOpen && job.has_scene ? (
                      <Suspense
                        fallback={
                          <div className="flex aspect-video items-center justify-center rounded-xl bg-black text-white/70">
                            <Loader2 className="mr-2 size-5 animate-spin" /> Loading viewer…
                          </div>
                        }
                      >
                        <SplatViewer
                          url={worldSceneUrl(job.job_id, token)}
                          className="aspect-video w-full rounded-xl"
                        />
                      </Suspense>
                    ) : (
                      <div className="overflow-hidden rounded-xl bg-muted/30">
                        <img
                          src={
                            job.has_preview
                              ? worldPreviewUrl(job.job_id, token)
                              : job.input_image_id
                                ? imageFileUrl(job.input_image_id, token)
                                : ''
                          }
                          alt={job.has_preview ? 'World preview: centre, leans and turn' : 'Source picture'}
                          className="max-h-[60vh] w-full object-contain"
                          data-testid="worlds-preview"
                        />
                      </div>
                    )}

                    <div className="space-y-0.5">
                      <p className="font-mono text-xs text-muted-foreground">
                        {job.capability} · {job.status.replace(/_/g, ' ')}
                      </p>
                      {result ? (
                        <p className="text-xs text-muted-foreground" data-testid="worlds-result-summary">
                          {result.splat_count?.toLocaleString()} splats
                          {result.splats_bg ? ` (${result.splats_bg.toLocaleString()} hidden background)` : ''} ·{' '}
                          {formatMiB(job.ply_bytes)}
                          {result.grid ? ` · ${result.grid.width}×${result.grid.height}` : ''}
                          {result.depth_range_m
                            ? ` · depth ${result.depth_range_m[0].toFixed(1)}–${result.depth_range_m[1].toFixed(0)} m`
                            : ''}
                          {typeof result.settings?.hfov === 'number' ? ` · ${Math.round(result.settings.hfov)}° FOV` : ''}
                        </p>
                      ) : null}
                      {!isRunning ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          Execution time:{' '}
                          {executionSeconds != null && Number.isFinite(executionSeconds) && executionSeconds >= 0
                            ? formatDuration(executionSeconds)
                            : 'Unavailable'}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {job.has_scene ? (
                        <>
                          <Button
                            size="sm"
                            variant={viewerOpen ? 'outline' : 'default'}
                            onClick={() => setViewerOpen(v => !v)}
                            data-testid="worlds-open-viewer"
                          >
                            <Box className="mr-1 size-4" /> {viewerOpen ? 'Show preview' : 'Open 3D'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void onShare(job.job_id)}
                            disabled={busy === 'share'}
                            data-testid="worlds-share"
                          >
                            {busy === 'share' ? (
                              <Loader2 className="mr-1 size-4 animate-spin" />
                            ) : (
                              <Glasses className="mr-1 size-4" />
                            )}
                            Open in headset
                          </Button>
                        </>
                      ) : null}
                      {status === 'failed' || status === 'canceled' ? (
                        <Button
                          size="sm"
                          onClick={async () => {
                            if (!token) return
                            const res = await run('retry', () => retryWorldJob(token, job.job_id))
                            if (res) {
                              void refreshRunningImageJobs()
                              await loadJobs()
                              await selectJob(res.job_id)
                            }
                          }}
                          disabled={busy === 'retry'}
                          data-testid="worlds-retry-job"
                        >
                          {busy === 'retry' ? (
                            <Loader2 className="mr-1 size-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 size-4" />
                          )}
                          Retry
                        </Button>
                      ) : null}
                      {isRunning ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void run('poll', () => onPollNow(job.job_id))}
                            disabled={busy === 'poll'}
                            data-testid="worlds-poll-job"
                          >
                            <RefreshCw className="mr-1 size-4" /> Poll now
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={async () => {
                              if (!token) return
                              await run('cancel', () => cancelWorldJob(token, job.job_id))
                              void refreshRunningImageJobs()
                              await refreshJob(job.job_id)
                            }}
                            disabled={busy === 'cancel'}
                            data-testid="worlds-cancel-job"
                          >
                            <Square className="mr-1 size-4 fill-current" /> Cancel
                          </Button>
                          <span className="flex items-center text-xs text-muted-foreground">
                            <Loader2 className="mr-1 size-3 animate-spin" /> Auto-polling…
                          </span>
                        </>
                      ) : null}
                    </div>

                    {share ? (
                      <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm" data-testid="worlds-share-panel">
                        <p className="font-medium">Open this link in the Quest browser, then press Enter VR.</p>
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value={share.viewer_url}
                            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                            onFocus={e => e.currentTarget.select()}
                            data-testid="worlds-share-url"
                          />
                          <Button size="sm" variant="outline" onClick={() => void copyShare()}>
                            {copied ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
                            {copied ? 'Copied' : 'Copy'}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          No login needed; expires {new Date(share.expires_at).toLocaleString()}. Signed in on the
                          Quest already? Just open VR Worlds there.
                        </p>
                      </div>
                    ) : null}

                    {job.status === 'failed' ? (
                      <JobErrorBanner message={job.error || 'World generation failed'} testId="worlds-job-failed" />
                    ) : job.status === 'canceled' ? (
                      <p className="text-xs text-muted-foreground">Task canceled.</p>
                    ) : isRunning ? (
                      <div className="flex justify-center rounded-md bg-muted/30 px-3 py-4">
                        <JobProgressBar
                          status={job.status}
                          stage={job.stage}
                          startedAt={job.started_at}
                          typicalRuntimeSeconds={job.typical_runtime_seconds}
                          submittedAt={job.created_at}
                          label={imageJobStatusLabel(job.status)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">Could not load this world.</p>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {token && (
        <ImagePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={input.pickStored} token={token} />
      )}
    </div>
  )
}
