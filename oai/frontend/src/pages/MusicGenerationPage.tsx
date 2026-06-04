import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import {
  cancelMusicJob,
  deleteMusicJob,
  getMusicJob,
  listMusicCapabilities,
  listMusicJobs,
  musicAudioUrl,
  pollMusicJob,
  retryMusicJob,
  startMusicJob,
  type MusicCapability,
  type MusicJob,
} from '../api/music_generation'
import { CapabilityModelPicker, type PickerCapability } from '../components/CapabilityModelPicker'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import { capabilityBaseLabel } from '../lib/modelAvailability'
import { pickListedCapability } from '../lib/capability-picker'
import { MusicHistorySidebar, MUSIC_NEW_PANEL } from '../components/music/MusicHistorySidebar'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 4000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

function musicPickerCapabilities(caps: MusicCapability[]): PickerCapability[] {
  return caps.map(c => ({
    base: c.base,
    tags: c.tags,
    raw: c.raw,
    online: c.online,
    last_available_at: c.last_available_at,
  }))
}

function jobTitle(tags: string, limit = 56): string {
  const trimmed = tags.trim()
  if (!trimmed) return 'Music'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function MusicGenerationPage() {
  const { token } = useAuth()

  const [capabilities, setCapabilities] = useState<MusicCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const [selectedCap, setSelectedCap] = useState('')
  const [tags, setTags] = useState('pop, upbeat, electronic')
  const [lyrics, setLyrics] = useState('')
  const [duration, setDuration] = useState(30)
  const [bpm, setBpm] = useState('')
  const [seed, setSeed] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [language, setLanguage] = useState('')
  const [keyscale, setKeyscale] = useState('')
  const [cfgScale, setCfgScale] = useState('')
  const [temperature, setTemperature] = useState('')

  const [jobs, setJobs] = useState<MusicJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(MUSIC_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<MusicJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const viewingJob = activePanel !== MUSIC_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const loadCapabilities = useCallback(() => {
    if (!token) return
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    listMusicCapabilities(token)
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
      const list = await listMusicJobs(token)
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

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getMusicJob(token, jobId)
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
    setActivePanel(MUSIC_NEW_PANEL)
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || !selectedCap || submitting) return
    if (!tags.trim()) {
      setError('Enter style tags (e.g. pop, upbeat, electronic).')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const req = {
        capability: selectedCap,
        tags: tags.trim(),
        duration,
        ...(lyrics.trim() && { lyrics: lyrics.trim() }),
        ...(bpm && !isNaN(Number(bpm)) && { bpm: parseInt(bpm) }),
        ...(seed && !isNaN(Number(seed)) && { seed: parseInt(seed) }),
        ...(language.trim() && { language: language.trim() }),
        ...(keyscale.trim() && { keyscale: keyscale.trim() }),
        ...(cfgScale !== '' && !isNaN(Number(cfgScale)) && { cfg_scale: parseFloat(cfgScale) }),
        ...(temperature !== '' && !isNaN(Number(temperature)) && {
          temperature: parseFloat(temperature),
        }),
      }
      const res = await startMusicJob(token, req)
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
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
      const job = await pollMusicJob(token, jobId)
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
      await cancelMusicJob(token, jobId)
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
      const res = await retryMusicJob(token, jobId)
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
      await deleteMusicJob(token, jobId)
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

  function editFromJob() {
    if (!selectedJob) return
    setTags(selectedJob.tags)
    setLyrics(selectedJob.lyrics ?? '')
    setDuration(selectedJob.duration)
    setBpm(selectedJob.bpm != null ? String(selectedJob.bpm) : '')
    setSeed(selectedJob.seed != null ? String(selectedJob.seed) : '')
    setLanguage(selectedJob.language ?? '')
    setKeyscale(selectedJob.keyscale ?? '')
    setCfgScale(selectedJob.cfg_scale != null ? String(selectedJob.cfg_scale) : '')
    setTemperature(selectedJob.temperature != null ? String(selectedJob.temperature) : '')
    if (selectedJob.capability && capabilities.some(c => c.base === selectedJob.capability)) {
      setSelectedCap(selectedJob.capability)
    }
    setActivePanel(MUSIC_NEW_PANEL)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(selectedCap && tags.trim() && !submitting),
    [selectedCap, tags, submitting, capabilitiesStatus],
  )

  const pickerCapabilities = useMemo(() => musicPickerCapabilities(capabilities), [capabilities])

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="music-page"
    >
      <aside
        className={cn(
          'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200',
          sidebarOpen ? 'w-64' : 'w-0',
        )}
        data-testid="music-sidebar"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-sm font-semibold text-sidebar-foreground">Music</span>
        </div>
        <MusicHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
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
            {viewingJob && selectedJob ? jobTitle(selectedJob.tags) : 'New track'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete track"
              aria-label="Delete track"
              data-testid="music-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === MUSIC_NEW_PANEL && (
              <section data-testid="music-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Music className="h-4 w-4 text-fuchsia-400" />
                    New Track
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Choose a model, enter style tags and optional lyrics, then generate.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  {/* Model */}
                  <div className="space-y-1.5" data-testid="music-capability-select">
                    <Label>Model</Label>
                    <CapabilityModelPicker
                      capabilities={pickerCapabilities}
                      selected={selectedCap}
                      onSelect={setSelectedCap}
                      onRefresh={loadCapabilities}
                      capabilitiesStatus={capabilitiesStatus}
                      capabilitiesError={capabilitiesError}
                      formatLabel={cap => capabilityBaseLabel(cap.base)}
                      testIdPrefix="music-model-picker"
                    />
                    {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No music models online. Start a `txt2music.*` agent or check the OffloadMQ
                        connection in Settings.
                      </p>
                    )}
                  </div>

                  {/* Tags */}
                  <div className="space-y-1.5" data-testid="music-tags">
                    <Label htmlFor="music-tags-input">Style tags</Label>
                    <textarea
                      id="music-tags-input"
                      value={tags}
                      onChange={e => setTags(e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="pop, upbeat, electronic, female vocal"
                      data-testid="music-tags-input"
                    />
                  </div>

                  {/* Lyrics */}
                  <div className="space-y-1.5" data-testid="music-lyrics">
                    <Label htmlFor="music-lyrics-input">
                      Lyrics{' '}
                      <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <textarea
                      id="music-lyrics-input"
                      value={lyrics}
                      onChange={e => setLyrics(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Leave empty for instrumental"
                      data-testid="music-lyrics-input"
                    />
                  </div>

                  {/* Duration / BPM / Seed */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="music-duration">Duration (s)</Label>
                      <input
                        id="music-duration"
                        type="number"
                        min={5}
                        max={600}
                        value={duration}
                        onChange={e => setDuration(Number(e.target.value))}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="music-duration"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="music-bpm">
                        BPM{' '}
                        <span className="text-xs font-normal text-muted-foreground">(opt)</span>
                      </Label>
                      <input
                        id="music-bpm"
                        type="number"
                        min={40}
                        max={300}
                        value={bpm}
                        onChange={e => setBpm(e.target.value)}
                        placeholder="e.g. 120"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="music-bpm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="music-seed">
                        Seed{' '}
                        <span className="text-xs font-normal text-muted-foreground">(opt)</span>
                      </Label>
                      <input
                        id="music-seed"
                        type="number"
                        value={seed}
                        onChange={e => setSeed(e.target.value)}
                        placeholder="Random"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="music-seed"
                      />
                    </div>
                  </div>

                  {/* Advanced (model-specific) */}
                  <div className="rounded-lg border border-border px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen(v => !v)}
                      className="flex items-center gap-2 text-sm font-medium text-foreground"
                    >
                      {advancedOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                      Model-specific settings
                      <span className="ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] bg-muted text-muted-foreground">
                        ACE Step + compatible
                      </span>
                    </button>
                    {advancedOpen && (
                      <div className="mt-3 space-y-3">
                        <p className="text-xs text-muted-foreground">
                          These fields are forwarded as-is to the agent. Unsupported fields for a
                          given model are silently ignored.
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="music-language">Language</Label>
                            <input
                              id="music-language"
                              type="text"
                              value={language}
                              onChange={e => setLanguage(e.target.value)}
                              placeholder="e.g. en, zh, fr"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="music-keyscale">Key &amp; scale</Label>
                            <input
                              id="music-keyscale"
                              type="text"
                              value={keyscale}
                              onChange={e => setKeyscale(e.target.value)}
                              placeholder="e.g. C major"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="music-cfg">CFG scale</Label>
                            <input
                              id="music-cfg"
                              type="number"
                              step="0.1"
                              min="0"
                              max="30"
                              value={cfgScale}
                              onChange={e => setCfgScale(e.target.value)}
                              placeholder="e.g. 7.0"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="music-temperature">Temperature</Label>
                            <input
                              id="music-temperature"
                              type="number"
                              step="0.05"
                              min="0"
                              max="2"
                              value={temperature}
                              onChange={e => setTemperature(e.target.value)}
                              placeholder="e.g. 1.0"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Submit */}
                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full"
                    data-testid="music-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <Music className="mr-2 size-4" />
                        Generate
                      </>
                    )}
                  </Button>

                  {error && (
                    <p className="text-xs text-destructive" data-testid="music-error">
                      {error}
                    </p>
                  )}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="music-job-detail" className="space-y-4">
                {jobDetailLoading && !selectedJob ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    {/* Meta */}
                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold leading-snug">
                        {jobTitle(selectedJob.tags, 200)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {capabilityBaseLabel(selectedJob.capability)} · {selectedJob.duration}s ·{' '}
                        {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={editFromJob} data-testid="music-edit">
                        <Pencil className="mr-1 h-4 w-4" />
                        Edit
                      </Button>
                      {canRetry && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onRetry(selectedJob.job_id)}
                          disabled={retrying}
                          data-testid="music-retry-job"
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
                        data-testid="music-poll-job"
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
                          data-testid="music-cancel-job"
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

                    {error && (
                      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {error}
                      </p>
                    )}

                    {/* Style tags */}
                    <section className="space-y-1.5">
                      <h3 className="text-xs font-medium text-muted-foreground">Style</h3>
                      <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                        {selectedJob.tags}
                      </p>
                    </section>

                    {selectedJob.lyrics && (
                      <section className="space-y-1.5">
                        <h3 className="text-xs font-medium text-muted-foreground">Lyrics</h3>
                        <p className="whitespace-pre-wrap rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                          {selectedJob.lyrics}
                        </p>
                      </section>
                    )}

                    {/* Audio / pending / error */}
                    {selectedJob.status === 'completed' && selectedJob.audio_tracks.length > 0 ? (
                      <section className="space-y-3" data-testid="music-result">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {selectedJob.audio_tracks.length > 1
                            ? `Generated tracks (${selectedJob.audio_tracks.length})`
                            : 'Generated audio'}
                        </h3>
                        {selectedJob.result_seed != null && (
                          <p className="font-mono text-[11px] text-muted-foreground">
                            Seed: {selectedJob.result_seed}
                          </p>
                        )}
                        <div className="space-y-3">
                          {selectedJob.audio_tracks.map(track => (
                            <div key={track.track} className="space-y-1">
                              {selectedJob.audio_tracks.length > 1 && (
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Track {track.track + 1}
                                  </span>
                                  <a
                                    href={musicAudioUrl(selectedJob.job_id, track.track, token)}
                                    download={track.filename}
                                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    <Download className="size-3.5" />
                                    Download
                                  </a>
                                </div>
                              )}
                              {selectedJob.audio_tracks.length === 1 && (
                                <div className="flex justify-end">
                                  <a
                                    href={musicAudioUrl(selectedJob.job_id, track.track, token)}
                                    download={track.filename}
                                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                    data-testid="music-download"
                                  >
                                    <Download className="size-3.5" />
                                    Download
                                  </a>
                                </div>
                              )}
                              <audio
                                key={`${selectedJob.job_id}-${track.track}`}
                                controls
                                src={musicAudioUrl(selectedJob.job_id, track.track, token)}
                                className="w-full"
                                data-testid={`music-audio-player-${track.track}`}
                              />
                              <p className="text-[11px] text-muted-foreground">
                                {track.content_type} · {(track.size_bytes / 1024).toFixed(1)} KB
                              </p>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : selectedJob.status === 'failed' ? (
                      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {selectedJob.error || 'Task failed'}
                      </p>
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
                    Could not load this track.
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
