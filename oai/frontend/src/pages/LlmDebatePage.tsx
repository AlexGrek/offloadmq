import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Gavel,
  Loader2,
  MessageCircleMore,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import {
  cancelLlmDebateJob,
  deleteLlmDebateJob,
  getLlmDebateJob,
  listLlmDebateJobs,
  pollLlmDebateJob,
  retryLlmDebateJob,
  startLlmDebateJob,
  type LlmDebateJob,
} from '../api/llmDebate'
import { CapabilityModelPicker } from '../components/CapabilityModelPicker'
import { DebateTranscript } from '../components/llmdebate/DebateTranscript'
import {
  LLM_DEBATE_NEW_PANEL,
  LlmDebateHistorySidebar,
} from '../components/llmdebate/LlmDebateHistorySidebar'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { PromptTextarea } from '../components/PromptTextarea'
import { ToolSidebar } from '../components/ToolSidebar'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { nextDebateReqId, useWsDebate } from '../hooks/useWsDebate'
import { capabilityBaseLabel, firstSelectableModel } from '../lib/modelAvailability'
import { pickListedCapability } from '../lib/capability-picker'
import {
  LLM_DEBATE_INITIAL_BUCKET,
  LLM_DEBATE_REFEREE_COMMAND_BUCKET,
  LLM_DEBATE_REFEREE_SYSTEM_BUCKET,
  LLM_DEBATE_SYSTEM_A_BUCKET,
  LLM_DEBATE_SYSTEM_B_BUCKET,
} from '../lib/llmPromptBuckets'
import { cn } from '../lib/utils'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const DEFAULT_SYSTEM = 'You are a helpful AI assistant.'
const DEFAULT_INITIAL = "Hello! Let's have a conversation."
const DEFAULT_REFEREE_SYSTEM =
  'You are an impartial debate referee. Analyze the debate between Model A and Model B and declare a winner with brief justification.'
const DEFAULT_REFEREE_COMMAND =
  'The debate has concluded. Review the transcript and declare who won (Model A, Model B, or draw) in 2–3 sentences.'

const BURST_SPARKS = [
  { x: -24, y: -20, delay: 0 },
  { x: 26, y: -16, delay: 0.05 },
  { x: -18, y: 18, delay: 0.09 },
]

function jobTitle(prompt: string, limit = 56): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Debate'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function LlmDebatePage() {
  const { token } = useAuth()
  const isMobile = useIsMobile()
  const ws = useWsDebate(token)
  const watchReqRef = useRef<string | null>(null)

  const capabilities = ws.capabilities
  const capabilitiesStatus = ws.capabilitiesStatus
  const capabilitiesError = ws.capabilitiesError

  const [modelA, setModelA] = useState('')
  const [modelB, setModelB] = useState('')
  const [systemA, setSystemA] = useState(DEFAULT_SYSTEM)
  const [systemB, setSystemB] = useState(DEFAULT_SYSTEM)
  const [initialPrompt, setInitialPrompt] = useState(DEFAULT_INITIAL)

  const [refereeEnabled, setRefereeEnabled] = useState(false)
  const [modelRef, setModelRef] = useState('')
  const [systemRef, setSystemRef] = useState(DEFAULT_REFEREE_SYSTEM)
  const [commandRef, setCommandRef] = useState(DEFAULT_REFEREE_COMMAND)
  const [refereeTurns, setRefereeTurns] = useState(6)
  const [submitBurst, setSubmitBurst] = useState(false)

  const [jobs, setJobs] = useState<LlmDebateJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(LLM_DEBATE_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<LlmDebateJob | null>(null)
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

  const viewingJob = activePanel !== LLM_DEBATE_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  useEffect(() => {
    if (ws.capabilitiesStatus !== 'ready' || capabilities.length === 0) return
    const first = firstSelectableModel(capabilities)
    const second = capabilities.find(c => c.base !== first)?.base ?? first ?? ''
    setModelA(prev => pickListedCapability(prev, capabilities) ?? first ?? '')
    setModelB(prev => {
      const picked = pickListedCapability(prev, capabilities)
      if (picked) return picked
      return second
    })
    setModelRef(prev => pickListedCapability(prev, capabilities) ?? first ?? '')
  }, [capabilities, ws.capabilitiesStatus])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listLlmDebateJobs(token)
      setJobs(list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  const applyJobUpdate = useCallback((job: LlmDebateJob, activeId?: string | null) => {
    if (activeId && job.job_id === activeId) {
      setSelectedJob(job)
    } else {
      setSelectedJob(prev => (prev?.job_id === job.job_id ? job : prev))
    }
    setJobs(prev => {
      const idx = prev.findIndex(j => j.job_id === job.job_id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = job
        return next
      }
      return [job, ...prev]
    })
  }, [])

  useEffect(() => {
    return ws.subscribe(event => {
      if (event.type === 'debate:update') {
        if (event.req_id === watchReqRef.current) {
          setPolling(false)
        }
        if (viewedJobId && event.job.job_id === viewedJobId) {
          applyJobUpdate(event.job, viewedJobId)
        }
      } else if (
        event.type === 'error' &&
        event.req_id != null &&
        event.req_id === watchReqRef.current
      ) {
        setPolling(false)
        setError(event.message)
      }
    })
  }, [ws.subscribe, applyJobUpdate, viewedJobId])

  const viewedJobTerminal =
    selectedJob?.job_id === viewedJobId &&
    selectedJob.status != null &&
    TERMINAL.has(selectedJob.status)

  useEffect(() => {
    if (!viewedJobId || ws.status !== 'connected' || viewedJobTerminal) return
    const reqId = nextDebateReqId('watch')
    watchReqRef.current = reqId
    ws.send({ type: 'watch_job', req_id: reqId, job_id: viewedJobId })
  }, [viewedJobId, ws.status, viewedJobTerminal, ws.send])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getLlmDebateJob(token, jobId)
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
    setActivePanel(LLM_DEBATE_NEW_PANEL)
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
    if (!token || submitting) return
    if (!modelA || !modelB || !initialPrompt.trim()) {
      setError('Pick two models and an opening prompt.')
      return
    }
    if (refereeEnabled && !modelRef) {
      setError('Pick a referee model or disable the referee.')
      return
    }
    setError(null)
    setSubmitting(true)
    setSubmitBurst(true)
    window.setTimeout(() => setSubmitBurst(false), 900)
    setJobDetailLoading(true)
    try {
      const res = await startLlmDebateJob(token, {
        model_a: modelA,
        model_b: modelB,
        system_a: systemA,
        system_b: systemB,
        initial_prompt: initialPrompt.trim(),
        referee_enabled: refereeEnabled,
        model_ref: refereeEnabled ? modelRef : undefined,
        system_ref: refereeEnabled ? systemRef : undefined,
        command_ref: refereeEnabled ? commandRef : undefined,
        referee_turns: refereeTurns,
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
    setPolling(true)
    setError(null)
    if (ws.status === 'connected') {
      const reqId = nextDebateReqId('watch')
      watchReqRef.current = reqId
      if (ws.send({ type: 'watch_job', req_id: reqId, job_id: jobId })) {
        return
      }
    }
    if (!token) {
      setPolling(false)
      return
    }
    try {
      const job = await pollLlmDebateJob(token, jobId)
      applyJobUpdate(job, viewedJobId)
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
      await cancelLlmDebateJob(token, jobId)
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
      const res = await retryLlmDebateJob(token, jobId)
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
      await deleteLlmDebateJob(token, jobId)
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

  function editFromJob() {
    if (!selectedJob) return
    setModelA(selectedJob.model_a)
    setModelB(selectedJob.model_b)
    setSystemA(selectedJob.system_a)
    setSystemB(selectedJob.system_b)
    setInitialPrompt(selectedJob.initial_prompt)
    setRefereeEnabled(selectedJob.referee_enabled)
    setModelRef(selectedJob.model_ref ?? '')
    setSystemRef(selectedJob.system_ref ?? DEFAULT_REFEREE_SYSTEM)
    setCommandRef(selectedJob.command_ref ?? DEFAULT_REFEREE_COMMAND)
    setRefereeTurns(selectedJob.referee_turns)
    setActivePanel(LLM_DEBATE_NEW_PANEL)
    setError(null)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(modelA && modelB && initialPrompt.trim()) &&
      (!refereeEnabled || Boolean(modelRef)) &&
      !submitting,
    [modelA, modelB, initialPrompt, refereeEnabled, modelRef, submitting, capabilitiesStatus],
  )

  const status = selectedJob?.status
  const isRunning = status != null && !TERMINAL.has(status)
  const canRetry = status === 'failed' || status === 'canceled'
  const debateCount = selectedJob?.messages.filter(m => m.side !== 'REF').length ?? 0

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="llm-debate-page"
    >
      <ToolSidebar
        title="Debate"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="llm-debate-sidebar"
      >
        <LlmDebateHistorySidebar
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
          <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(v => !v)}>
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <h1 className="min-w-0 flex-1 truncate font-display text-sm font-semibold">
            {viewingJob && selectedJob ? jobTitle(selectedJob.initial_prompt) : 'New debate'}
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

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait">
            {activePanel === LLM_DEBATE_NEW_PANEL ? (
              <motion.div
                key="new"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <div className="mx-auto max-w-3xl space-y-5 px-3 py-4 sm:px-6 sm:py-5" data-testid="llm-debate-new-panel">
                  <header className="space-y-1">
                    <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                      <MessageCircleMore className="size-4 text-emerald-400" />
                      LLM Debate
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Two models converse turn by turn; optionally a referee judges the outcome.
                    </p>
                  </header>

                  <form onSubmit={e => void onSubmit(e)} className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(['A', 'B'] as const).map(side => (
                        <motion.div
                          key={side}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: side === 'B' ? 0.06 : 0 }}
                          className={cn(
                            'space-y-2 rounded-2xl border p-3',
                            side === 'A'
                              ? 'border-sky-500/30 bg-gradient-to-br from-sky-500/8 to-transparent'
                              : 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/8 to-transparent',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-white',
                                side === 'A' ? 'bg-sky-500' : 'bg-emerald-500',
                              )}
                            >
                              {side}
                            </span>
                            <Label>Model {side}</Label>
                          </div>
                          <CapabilityModelPicker
                            capabilities={capabilities}
                            selected={side === 'A' ? modelA : modelB}
                            onSelect={side === 'A' ? setModelA : setModelB}
                            onRefresh={ws.refreshCapabilities}
                            capabilitiesStatus={capabilitiesStatus}
                            capabilitiesError={capabilitiesError}
                            formatLabel={cap => capabilityBaseLabel(cap.base)}
                            testIdPrefix={`debate-model-${side}`}
                          />
                          <PromptTextarea
                            value={side === 'A' ? systemA : systemB}
                            onChange={side === 'A' ? setSystemA : setSystemB}
                            bucket={side === 'A' ? LLM_DEBATE_SYSTEM_A_BUCKET : LLM_DEBATE_SYSTEM_B_BUCKET}
                            token={token}
                            rows={2}
                            placeholder={`System prompt for ${side}`}
                            data-testid={`llm-debate-system-${side}`}
                            textareaClassName="text-xs"
                          />
                        </motion.div>
                      ))}
                    </div>

                    <motion.div
                      layout
                      className={cn(
                        'space-y-3 rounded-2xl border p-3 transition-colors',
                        refereeEnabled
                          ? 'border-violet-500/35 bg-gradient-to-br from-violet-500/8 to-transparent'
                          : 'border-border bg-muted/15',
                      )}
                    >
                      <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          checked={refereeEnabled}
                          onChange={e => setRefereeEnabled(e.target.checked)}
                          className="accent-violet-500"
                        />
                        <Gavel className="size-4 text-violet-500" />
                        <span className="text-sm font-medium">Referee</span>
                        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                          after
                          <input
                            type="number"
                            min={2}
                            max={100}
                            value={refereeTurns}
                            onChange={e =>
                              setRefereeTurns(Math.max(2, parseInt(e.target.value, 10) || 2))
                            }
                            disabled={!refereeEnabled}
                            className="min-h-10 w-14 rounded border border-input bg-background px-1.5 py-2 text-center font-mono text-sm"
                          />
                          turns
                        </span>
                      </label>
                      {refereeEnabled && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="space-y-2"
                        >
                          <CapabilityModelPicker
                            capabilities={capabilities}
                            selected={modelRef}
                            onSelect={setModelRef}
                            onRefresh={ws.refreshCapabilities}
                            capabilitiesStatus={capabilitiesStatus}
                            capabilitiesError={capabilitiesError}
                            formatLabel={cap => capabilityBaseLabel(cap.base)}
                            testIdPrefix="debate-referee"
                          />
                          <div className="grid gap-2">
                            <PromptTextarea
                              value={systemRef}
                              onChange={setSystemRef}
                              bucket={LLM_DEBATE_REFEREE_SYSTEM_BUCKET}
                              token={token}
                              rows={2}
                              placeholder="Referee system prompt"
                              data-testid="llm-debate-referee-system"
                              textareaClassName="text-xs"
                            />
                            <PromptTextarea
                              value={commandRef}
                              onChange={setCommandRef}
                              bucket={LLM_DEBATE_REFEREE_COMMAND_BUCKET}
                              token={token}
                              rows={2}
                              placeholder="Command sent to referee after debate ends"
                              data-testid="llm-debate-referee-command"
                              textareaClassName="text-xs"
                            />
                          </div>
                        </motion.div>
                      )}
                    </motion.div>

                    <div className="space-y-1.5">
                      <Label htmlFor="debate-initial">Opening prompt (to Model A)</Label>
                      <PromptTextarea
                        id="debate-initial"
                        value={initialPrompt}
                        onChange={setInitialPrompt}
                        bucket={LLM_DEBATE_INITIAL_BUCKET}
                        token={token}
                        rows={3}
                        data-testid="llm-debate-initial-prompt"
                      />
                    </div>

                    <div className="relative w-full sm:w-auto">
                      <motion.div
                        animate={submitBurst ? { scale: [1, 1.05, 0.98, 1] } : {}}
                        transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <Button type="submit" disabled={!canSubmit} className="relative w-full overflow-hidden sm:w-auto" data-testid="llm-debate-submit">
                          <AnimatePresence>
                            {submitBurst && (
                              <motion.span
                                key="shimmer"
                                aria-hidden
                                className="pointer-events-none absolute inset-y-0 left-0 w-1/2 skew-x-12 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                                initial={{ x: '-100%' }}
                                animate={{ x: '320%' }}
                                transition={{ duration: 0.42 }}
                              />
                            )}
                          </AnimatePresence>
                          {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
                          Start debate
                        </Button>
                      </motion.div>
                      <AnimatePresence>
                        {submitBurst &&
                          BURST_SPARKS.map((p, i) => (
                            <motion.span
                              key={i}
                              aria-hidden
                              className="pointer-events-none absolute left-36 top-1/2 text-emerald-400"
                              initial={{ opacity: 1, scale: 0 }}
                              animate={{ x: p.x, y: p.y, opacity: 0, scale: 1.4 }}
                              transition={{ duration: 0.5, delay: p.delay }}
                            >
                              ✦
                            </motion.span>
                          ))}
                      </AnimatePresence>
                    </div>

                    {error && <JobErrorBanner message={error} testId="llm-debate-error" />}
                  </form>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="detail"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
                data-testid="llm-debate-job-detail"
              >
                {error && (
                  <div className="shrink-0 px-3 pt-3 sm:px-6">
                    <JobErrorBanner message={error} testId="llm-debate-job-error" />
                  </div>
                )}

                {jobDetailLoading && !selectedJob ? (
                  <div className="flex flex-1 items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    <div className="shrink-0 space-y-3 border-b border-border/60 px-3 py-3 sm:px-6">
                      <div className="space-y-1">
                        <h2 className="font-display text-sm font-semibold leading-snug">
                          {capabilityBaseLabel(selectedJob.model_a)} vs{' '}
                          {capabilityBaseLabel(selectedJob.model_b)}
                        </h2>
                        <p className="text-xs text-muted-foreground capitalize">
                          {isRunning
                            ? selectedJob.phase === 'referee'
                              ? 'Referee deliberating…'
                              : `Turn ${debateCount + 1}${selectedJob.referee_enabled ? ` / ${selectedJob.referee_turns}` : ''}`
                            : selectedJob.status.replace(/_/g, ' ')}
                          {isRunning && ws.status === 'connected' ? ' · live' : ''}
                          {polling ? ' · syncing…' : ''}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                        <Button variant="outline" size="sm" className="min-h-10" onClick={editFromJob}>
                          <Pencil className="mr-1 size-3.5" />
                          Edit
                        </Button>
                        {canRetry && (
                          <Button variant="outline" size="sm" className="min-h-10" disabled={retrying} onClick={() => void onRetry(selectedJob.job_id)}>
                            {retrying ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RotateCcw className="mr-1 size-3.5" />}
                            Retry
                          </Button>
                        )}
                        <Button variant="outline" size="sm" className="min-h-10" disabled={polling} onClick={() => void onPollNow(selectedJob.job_id)}>
                          {polling ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RefreshCw className="mr-1 size-3.5" />}
                          Poll
                        </Button>
                        {isRunning && (
                          <Button variant="destructive" size="sm" className="min-h-10" disabled={canceling} onClick={() => void onCancel(selectedJob.job_id)}>
                            {canceling ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Square className="mr-1 size-3.5" />}
                            Stop
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2 sm:px-6">
                      <DebateTranscript job={selectedJob} isRunning={isRunning} />
                    </div>

                    {selectedJob.phase === 'done' && !isRunning && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="shrink-0 border-t border-violet-500/20 bg-violet-500/5 px-3 py-2 text-center text-xs font-semibold text-violet-500 sm:px-6"
                      >
                        Debate concluded
                      </motion.div>
                    )}
                  </>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
