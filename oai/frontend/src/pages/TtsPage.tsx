import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Download,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react'
import {
  cancelTtsJob,
  deleteTtsJob,
  getTtsJob,
  listTtsCapabilities,
  listTtsJobs,
  pollTtsJob,
  retryTtsJob,
  startTtsJob,
  ttsAudioUrl,
  type TtsCapability,
  type TtsJob,
} from '../api/tts'
import { CapabilityModelPicker, type PickerCapability } from '../components/CapabilityModelPicker'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import { capabilityBaseLabel } from '../lib/modelAvailability'
import { pickListedCapability } from '../lib/capability-picker'
import {
  applyStoredTtsParamsToNewForm,
  applyTtsParamsToNewForm,
  type TtsRouteState,
} from '../lib/tts'
import { TtsHistorySidebar, TTS_NEW_PANEL } from '../components/tts/TtsHistorySidebar'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'

const DEFAULT_TEXT = 'Hello from OAI. This is a text-to-speech test.'
const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])

function ttsPickerCapabilities(caps: TtsCapability[]): PickerCapability[] {
  return caps.map(c => ({
    base: c.base,
    tags: [],
    raw: c.raw,
    online: c.online,
    last_available_at: c.last_available_at,
  }))
}

function jobTitle(text: string, limit = 56): string {
  const trimmed = text.trim()
  if (!trimmed) return 'Speech'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

function audioExt(contentType: string | null): string {
  if (!contentType) return 'wav'
  if (contentType.includes('mpeg')) return 'mp3'
  if (contentType.includes('ogg')) return 'ogg'
  if (contentType.includes('flac')) return 'flac'
  if (contentType.includes('aac')) return 'aac'
  return 'wav'
}

/** Mirror of `sanitize_filename_slug` in services/tts.rs: alnum + `-` only;
 *  everything else collapses into a single `_`; trimmed; max 50 chars. */
function sanitizeFilenameSlug(input: string, maxChars = 50): string {
  let out = ''
  let prevUnderscore = false
  for (const ch of input) {
    if (out.length >= maxChars) break
    if (/[A-Za-z0-9-]/.test(ch)) {
      out += ch
      prevUnderscore = false
    } else if (!prevUnderscore) {
      out += '_'
      prevUnderscore = true
    }
  }
  const trimmed = out.replace(/^_+|_+$/g, '')
  return trimmed || 'speech'
}

export default function TtsPage() {
  const { token } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [capabilities, setCapabilities] = useState<TtsCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const [selectedCap, setSelectedCap] = useState('')
  const [selectedVoice, setSelectedVoice] = useState('')
  const [text, setText] = useState(DEFAULT_TEXT)

  const [jobs, setJobs] = useState<TtsJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(TTS_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<TtsJob | null>(null)
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
  const [error, setError] = useState<string | null>(null)

  const viewingJob = activePanel !== TTS_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const voicesForSelected = useMemo<string[]>(() => {
    const cap = capabilities.find(c => c.base === selectedCap)
    return cap?.voices ?? []
  }, [capabilities, selectedCap])

  const loadCapabilities = useCallback(() => {
    if (!token) return
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    listTtsCapabilities(token)
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
      const list = await listTtsJobs(token)
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

  // Keep voice in sync with the available list for the chosen capability.
  useEffect(() => {
    if (voicesForSelected.length === 0) return
    setSelectedVoice(prev => (prev && voicesForSelected.includes(prev) ? prev : voicesForSelected[0]))
  }, [voicesForSelected])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getTtsJob(token, jobId)
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
    setActivePanel(TTS_NEW_PANEL)
    setError(null)
  }

  const ttsFormHandlers = useMemo(
    () => ({
      setText,
      setSelectedCap,
      setSelectedVoice,
    }),
    [],
  )

  const copyTtsToNewForm = useCallback(
    (job: Pick<TtsJob, 'text' | 'capability' | 'voice'>) => {
      applyTtsParamsToNewForm(
        {
          text: job.text,
          capability: job.capability,
          voice: job.voice,
        },
        ttsFormHandlers,
        capabilities,
      )
      setActivePanel(TTS_NEW_PANEL)
      setError(null)
    },
    [capabilities, ttsFormHandlers],
  )

  useEffect(() => {
    const state = location.state as TtsRouteState | null
    if (!state?.generateAgain || !token) return

    const { jobId, parameters } = state.generateAgain
    navigate(location.pathname, { replace: true, state: null })

    void (async () => {
      if (jobId) {
        try {
          const job = await getTtsJob(token, jobId)
          copyTtsToNewForm(job)
          return
        } catch {
          // job removed — fall back to stored metadata
        }
      }
      applyStoredTtsParamsToNewForm(parameters, ttsFormHandlers, capabilities)
      setActivePanel(TTS_NEW_PANEL)
      setError(null)
    })()
  }, [location.state, location.pathname, navigate, token, copyTtsToNewForm, ttsFormHandlers, capabilities])

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
    if (!token || !selectedCap || !selectedVoice || submitting) return
    if (!text.trim()) {
      setError('Enter some text to synthesize.')
      return
    }
    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    try {
      const res = await startTtsJob(token, {
        capability: selectedCap,
        voice: selectedVoice,
        text: text.trim(),
      })
      setActivePanel(res.job_id)
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
      const job = await pollTtsJob(token, jobId)
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
      await cancelTtsJob(token, jobId)
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
      const res = await retryTtsJob(token, jobId)
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
      await deleteTtsJob(token, jobId)
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
    copyTtsToNewForm(selectedJob)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(selectedCap && selectedVoice && text.trim() && !submitting),
    [selectedCap, selectedVoice, text, submitting, capabilitiesStatus],
  )

  const pickerCapabilities = useMemo(
    () => ttsPickerCapabilities(capabilities),
    [capabilities],
  )

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'
  const downloadName = useMemo(() => {
    if (!selectedJob) return 'audio.wav'
    const slug = sanitizeFilenameSlug(selectedJob.text)
    return `${slug}-${selectedJob.job_id}.${audioExt(selectedJob.audio_content_type)}`
  }, [selectedJob])

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="tts-page"
    >
      <ToolSidebar
        title="Speech"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="tts-sidebar"
      >
        <TtsHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
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
            {viewingJob && selectedJob ? jobTitle(selectedJob.text) : 'New speech'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              title="Delete speech"
              aria-label="Delete speech"
              data-testid="tts-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-5 px-3 py-4 sm:px-6 sm:py-5">
            {activePanel === TTS_NEW_PANEL && (
              <section data-testid="tts-new-panel" className="flex flex-col gap-5">
                <header className="space-y-1">
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <Volume2 className="h-4 w-4 text-violet-400" />
                    New Speech
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Choose a model and voice, then type text to synthesize as audio.
                  </p>
                </header>

                <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                  <div className="space-y-1.5" data-testid="tts-capability-select">
                    <Label>Model</Label>
                    <CapabilityModelPicker
                      capabilities={pickerCapabilities}
                      selected={selectedCap}
                      onSelect={setSelectedCap}
                      onRefresh={loadCapabilities}
                      capabilitiesStatus={capabilitiesStatus}
                      capabilitiesError={capabilitiesError}
                      formatLabel={cap => capabilityBaseLabel(cap.base)}
                      testIdPrefix="tts-model-picker"
                    />
                    {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No TTS models online. Start a `tts.*` agent (e.g., kokoro) or check the
                        OffloadMQ connection in Settings.
                      </p>
                    )}
                  </div>

                  {/* Voice selector */}
                  <div className="space-y-1.5" data-testid="tts-voice-select">
                    <Label htmlFor="tts-voice">Voice</Label>
                    {voicesForSelected.length === 0 ? (
                      <input
                        id="tts-voice"
                        type="text"
                        value={selectedVoice}
                        onChange={e => setSelectedVoice(e.target.value)}
                        placeholder="e.g., af_heart"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    ) : (
                      <select
                        id="tts-voice"
                        value={selectedVoice}
                        onChange={e => setSelectedVoice(e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {voicesForSelected.map(v => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Text */}
                  <div className="space-y-1.5" data-testid="tts-text">
                    <Label htmlFor="tts-text-input">Text</Label>
                    <textarea
                      id="tts-text-input"
                      value={text}
                      onChange={e => setText(e.target.value)}
                      rows={6}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Type something to synthesize…"
                      data-testid="tts-text-input"
                    />
                  </div>

                  {/* Submit */}
                  <Button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full"
                    data-testid="tts-submit"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      <>
                        <Volume2 className="mr-2 size-4" />
                        Synthesize
                      </>
                    )}
                  </Button>

                  {error && (
                    <JobErrorBanner message={error} testId="tts-error" />
                  )}
                </form>
              </section>
            )}

            {viewingJob && (
              <section data-testid="tts-job-detail" className="space-y-4">
                {error && <JobErrorBanner message={error} testId="tts-job-error" />}
                {jobDetailLoading && !selectedJob ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    {/* Meta */}
                    <div className="space-y-0.5">
                      <h2 className="font-display text-base font-semibold leading-snug">
                        {jobTitle(selectedJob.text, 200)}
                      </h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {capabilityBaseLabel(selectedJob.capability)} · {selectedJob.voice} ·{' '}
                        {selectedJob.status.replace(/_/g, ' ')}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={editFromJob} data-testid="tts-edit">
                        <Pencil className="mr-1 h-4 w-4" />
                        Edit
                      </Button>
                      {canRetry && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void onRetry(selectedJob.job_id)}
                          disabled={retrying}
                          data-testid="tts-retry-job"
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
                        data-testid="tts-poll-job"
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
                          data-testid="tts-cancel-job"
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

                    {/* Text */}
                    <section className="space-y-1.5">
                      <h3 className="text-xs font-medium text-muted-foreground">Text</h3>
                      <p className="whitespace-pre-wrap rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                        {selectedJob.text.trim() || '—'}
                      </p>
                    </section>

                    {/* Audio / pending / error */}
                    {selectedJob.status === 'completed' && selectedJob.audio_content_type ? (
                      <section className="space-y-2" data-testid="tts-result">
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-medium text-muted-foreground">Audio</h3>
                          <a
                            href={ttsAudioUrl(selectedJob.job_id, token)}
                            download={downloadName}
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            data-testid="tts-download"
                          >
                            <Download className="size-3.5" />
                            Download
                          </a>
                        </div>
                        <audio
                          key={selectedJob.job_id}
                          controls
                          src={ttsAudioUrl(selectedJob.job_id, token)}
                          className="w-full"
                          data-testid="tts-audio-player"
                        />
                        {selectedJob.audio_size_bytes != null && (
                          <p className="text-[11px] text-muted-foreground">
                            {selectedJob.audio_content_type} ·{' '}
                            {(selectedJob.audio_size_bytes / 1024).toFixed(1)} KB
                          </p>
                        )}
                      </section>
                    ) : selectedJob.status === 'failed' ? (
                      <JobErrorBanner
                        message={selectedJob.error || 'Task failed'}
                        testId="tts-job-failed"
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
                    Could not load this speech.
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
