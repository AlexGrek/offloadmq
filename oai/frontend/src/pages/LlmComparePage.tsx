import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Columns2,
  GitCompareArrows,
  Loader2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows2,
  Send,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import {
  cancelLlmCompareJob,
  deleteLlmCompareJob,
  getLlmCompareJob,
  listLlmCompareCapabilities,
  listLlmCompareJobs,
  pollLlmCompareJob,
  retryLlmCompareJob,
  startLlmCompareJob,
  type LlmCompareCapability,
  type LlmCompareJob,
} from '../api/llmCompare'
import { CapabilityModelPicker } from '../components/CapabilityModelPicker'
import {
  CompareResultsGrid,
} from '../components/llmcompare/CompareResultsGrid'
import {
  LLM_COMPARE_NEW_PANEL,
  LlmCompareHistorySidebar,
} from '../components/llmcompare/LlmCompareHistorySidebar'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { PromptTextarea } from '../components/PromptTextarea'
import { ToolSidebar } from '../components/ToolSidebar'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import type { CapabilitiesStatus } from '../lib/capabilitiesStatus'
import { capabilityBaseLabel, firstSelectableModel } from '../lib/modelAvailability'
import {
  LLM_COMPARE_SYSTEM_BUCKET,
  LLM_COMPARE_USER_BUCKET,
} from '../lib/llmPromptBuckets'
import { cn } from '../lib/utils'

const POLL_INTERVAL_MS = 3000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const MIN_SLOTS = 2
const MAX_SLOTS = 6
const DEFAULT_SYSTEM = 'You are a helpful AI assistant.'

const BURST_SPARKS = [
  { x: -28, y: -22, delay: 0 },
  { x: 30, y: -18, delay: 0.04 },
  { x: -20, y: 20, delay: 0.08 },
  { x: 24, y: 24, delay: 0.02 },
]

function jobTitle(prompt: string, limit = 56): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Compare'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function LlmComparePage() {
  const { token } = useAuth()
  const isMobile = useIsMobile()

  const [capabilities, setCapabilities] = useState<LlmCompareCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('idle')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)

  const [slots, setSlots] = useState<string[]>(['', ''])
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM)
  const [userPrompt, setUserPrompt] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [layout, setLayout] = useState<'columns' | 'rows'>('columns')
  const [submitBurst, setSubmitBurst] = useState(false)

  const [jobs, setJobs] = useState<LlmCompareJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(LLM_COMPARE_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<LlmCompareJob | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

  const viewingJob = activePanel !== LLM_COMPARE_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  const loadCapabilities = useCallback(() => {
    if (!token) return
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    listLlmCompareCapabilities(token)
      .then(data => {
        setCapabilities(data.capabilities)
        setCapabilitiesStatus('ready')
        const first = firstSelectableModel(data.capabilities)
        const second = data.capabilities.find(c => c.base !== first)?.base ?? first
        setSlots(prev => {
          const next = [...prev]
          if (!next[0] && first) next[0] = first
          if (!next[1] && second) next[1] = second
          return next
        })
      })
      .catch((e: Error) => {
        setCapabilitiesError(e.message)
        setCapabilitiesStatus('error')
      })
  }, [token])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listLlmCompareJobs(token)
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
      const job = await getLlmCompareJob(token, jobId)
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
    setActivePanel(LLM_COMPARE_NEW_PANEL)
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

  function setSlotModel(idx: number, model: string) {
    setSlots(prev => prev.map((s, i) => (i === idx ? model : s)))
  }

  function addSlot() {
    if (slots.length >= MAX_SLOTS) return
    const fallback = firstSelectableModel(capabilities) ?? ''
    setSlots(prev => [...prev, fallback])
  }

  function removeSlot(idx: number) {
    if (slots.length <= MIN_SLOTS) return
    setSlots(prev => prev.filter((_, i) => i !== idx))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || submitting) return
    const models = slots.filter(Boolean)
    if (!userPrompt.trim() || models.length < MIN_SLOTS) {
      setError(`Pick at least ${MIN_SLOTS} models and enter a prompt.`)
      return
    }
    setError(null)
    setSubmitting(true)
    setSubmitBurst(true)
    window.setTimeout(() => setSubmitBurst(false), 900)
    setJobDetailLoading(true)
    try {
      const res = await startLlmCompareJob(token, {
        models,
        system_prompt: systemPrompt.trim() || undefined,
        user_prompt: userPrompt.trim(),
      })
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      await loadJobs()
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
      const job = await pollLlmCompareJob(token, jobId)
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
      await cancelLlmCompareJob(token, jobId)
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
      const res = await retryLlmCompareJob(token, jobId)
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
      await deleteLlmCompareJob(token, jobId)
      setJobs(prev => {
        const next = prev.filter(j => j.job_id !== jobId)
        if (next.length > 0) void selectJob(next[0].job_id)
        else {
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
    setSlots(selectedJob.slots.map(s => s.model))
    setSystemPrompt(selectedJob.system_prompt)
    setUserPrompt(selectedJob.user_prompt)
    setActivePanel(LLM_COMPARE_NEW_PANEL)
    setError(null)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      slots.filter(Boolean).length >= MIN_SLOTS &&
      Boolean(userPrompt.trim()) &&
      !submitting,
    [slots, userPrompt, submitting, capabilitiesStatus],
  )

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'
  const resultsLayout = isMobile ? 'rows' : layout

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="llm-compare-page"
    >
      <ToolSidebar
        title="Compare"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="llm-compare-sidebar"
      >
        <LlmCompareHistorySidebar
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
            {viewingJob && selectedJob ? jobTitle(selectedJob.user_prompt) : 'New comparison'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'mx-auto space-y-5 px-3 py-4 sm:px-6 sm:py-5',
              activePanel === LLM_COMPARE_NEW_PANEL ? 'max-w-3xl' : 'max-w-6xl',
            )}
          >
            <AnimatePresence mode="wait">
              {activePanel === LLM_COMPARE_NEW_PANEL ? (
                <motion.section
                  key="new"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22 }}
                  data-testid="llm-compare-new-panel"
                  className="space-y-5"
                >
                  <header className="space-y-1">
                    <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                      <GitCompareArrows className="size-4 text-sky-400" />
                      LLM Compare
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Send one prompt to multiple models side by side.
                    </p>
                  </header>

                  <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label>Models</Label>
                        <div className="flex gap-1">
                          {!isMobile && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setLayout(l => (l === 'columns' ? 'rows' : 'columns'))}
                              title="Toggle layout preview"
                            >
                              {layout === 'columns' ? <Rows2 className="size-4" /> : <Columns2 className="size-4" />}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={addSlot}
                            disabled={slots.length >= MAX_SLOTS}
                          >
                            <Plus className="size-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {slots.map((model, idx) => (
                          <motion.div
                            key={idx}
                            layout
                            initial={{ opacity: 0, scale: 0.96 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex flex-col gap-2 rounded-xl border border-border/80 bg-gradient-to-br from-muted/30 to-transparent p-2 sm:flex-row sm:items-center"
                          >
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-500/90 text-[10px] font-bold text-white">
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <CapabilityModelPicker
                                capabilities={capabilities}
                                selected={model}
                                onSelect={m => setSlotModel(idx, m)}
                                onRefresh={loadCapabilities}
                                capabilitiesStatus={capabilitiesStatus}
                                capabilitiesError={capabilitiesError}
                                formatLabel={cap => capabilityBaseLabel(cap.base)}
                                testIdPrefix={`compare-slot-picker-${idx}`}
                              />
                            </div>
                            {slots.length > MIN_SLOTS && (
                              <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeSlot(idx)}>
                                <Minus className="size-3.5" />
                              </Button>
                            )}
                          </motion.div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => setShowSystem(v => !v)}
                        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Sparkles className="size-3.5" />
                        System prompt
                      </button>
                      <AnimatePresence>
                        {showSystem && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="space-y-1.5 overflow-hidden"
                          >
                            <Label htmlFor="llm-compare-system-prompt">System prompt</Label>
                            <PromptTextarea
                              id="llm-compare-system-prompt"
                              value={systemPrompt}
                              onChange={setSystemPrompt}
                              bucket={LLM_COMPARE_SYSTEM_BUCKET}
                              token={token}
                              rows={2}
                              placeholder="Shared system prompt for all models"
                              data-testid="llm-compare-system-prompt"
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                      <div className="space-y-1.5">
                        <Label htmlFor="llm-compare-user-prompt">Prompt</Label>
                        <PromptTextarea
                          id="llm-compare-user-prompt"
                          value={userPrompt}
                          onChange={setUserPrompt}
                          bucket={LLM_COMPARE_USER_BUCKET}
                          token={token}
                          rows={4}
                          placeholder="Enter your prompt — sent to every model at once"
                          data-testid="llm-compare-prompt"
                        />
                      </div>
                    </div>

                    <div className="relative flex w-full justify-stretch sm:w-auto sm:justify-start">
                      <motion.div
                        animate={submitBurst ? { scale: [1, 1.05, 0.98, 1] } : {}}
                        transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <Button type="submit" disabled={!canSubmit} className="relative w-full overflow-hidden sm:w-auto" data-testid="llm-compare-submit">
                          <AnimatePresence>
                            {submitBurst && (
                              <motion.span
                                key="shimmer"
                                aria-hidden
                                className="pointer-events-none absolute inset-y-0 left-0 w-1/2 skew-x-12 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                                initial={{ x: '-100%' }}
                                animate={{ x: '320%' }}
                                transition={{ duration: 0.42, ease: 'easeInOut' }}
                              />
                            )}
                          </AnimatePresence>
                          {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
                          Compare
                        </Button>
                      </motion.div>
                      <AnimatePresence>
                        {submitBurst &&
                          BURST_SPARKS.map((p, i) => (
                            <motion.span
                              key={i}
                              aria-hidden
                              className="pointer-events-none absolute left-24 top-1/2 text-sky-400"
                              style={{ fontSize: '11px', fontWeight: 700 }}
                              initial={{ x: 0, y: 0, opacity: 1, scale: 0 }}
                              animate={{ x: p.x, y: p.y, opacity: 0, scale: 1.5 }}
                              transition={{ duration: 0.55, delay: p.delay }}
                            >
                              ✦
                            </motion.span>
                          ))}
                      </AnimatePresence>
                    </div>

                    {error && <JobErrorBanner message={error} testId="llm-compare-error" />}
                  </form>
                </motion.section>
              ) : (
                <motion.section
                  key="detail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  data-testid="llm-compare-job-detail"
                  className="space-y-4"
                >
                  {error && <JobErrorBanner message={error} testId="llm-compare-job-error" />}
                  {jobDetailLoading && !selectedJob ? (
                    <div className="flex min-h-[40vh] items-center justify-center">
                      <Loader2 className="size-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                    <>
                      <div className="space-y-1">
                        <h2 className="font-display text-base font-semibold">{jobTitle(selectedJob.user_prompt, 200)}</h2>
                        <p className="font-mono text-xs text-muted-foreground capitalize">
                          {selectedJob.status.replace(/_/g, ' ')}
                          {polling ? ' · syncing…' : ''}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                        <Button variant="outline" size="sm" className="min-h-10" onClick={editFromJob}>
                          <Pencil className="mr-1 size-4" />
                          <span className="truncate">Edit</span>
                        </Button>
                        {canRetry && (
                          <Button variant="outline" size="sm" className="min-h-10" disabled={retrying} onClick={() => void onRetry(selectedJob.job_id)}>
                            {retrying ? <Loader2 className="mr-1 size-4 animate-spin" /> : <RotateCcw className="mr-1 size-4" />}
                            Retry
                          </Button>
                        )}
                        <Button variant="outline" size="sm" className="min-h-10" disabled={polling} onClick={() => void onPollNow(selectedJob.job_id)}>
                          {polling ? <Loader2 className="mr-1 size-4 animate-spin" /> : <RefreshCw className="mr-1 size-4" />}
                          Poll
                        </Button>
                        {isRunning && (
                          <Button variant="destructive" size="sm" className="min-h-10" disabled={canceling} onClick={() => void onCancel(selectedJob.job_id)}>
                            {canceling ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Square className="mr-1 size-4" />}
                            Stop
                          </Button>
                        )}
                        {!isMobile && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-h-10"
                            onClick={() => setLayout(l => (l === 'columns' ? 'rows' : 'columns'))}
                          >
                            {layout === 'columns' ? <Rows2 className="mr-1 size-4" /> : <Columns2 className="mr-1 size-4" />}
                            {layout === 'columns' ? 'Rows' : 'Columns'}
                          </Button>
                        )}
                      </div>

                      {selectedJob.system_prompt.trim() && (
                        <details className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-sm">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">System prompt</summary>
                          <p className="mt-2 whitespace-pre-wrap text-xs">{selectedJob.system_prompt}</p>
                        </details>
                      )}

                      <CompareResultsGrid slots={selectedJob.slots} layout={resultsLayout} stacked={isMobile} />

                      {selectedJob.error && (
                        <p className="text-sm text-destructive">{selectedJob.error}</p>
                      )}
                    </>
                  ) : null}
                </motion.section>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  )
}
