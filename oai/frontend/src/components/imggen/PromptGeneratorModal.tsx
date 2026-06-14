import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownToLine, Check, Loader2, RotateCcw, Square, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { CapabilityModelPicker } from '@/components/CapabilityModelPicker'
import { PromptTextarea } from '@/components/PromptTextarea'
import { useIsMobile } from '@/hooks/useIsMobile'
import { nextPromptGenReqId, useWsPromptGen } from '@/hooks/useWsPromptGen'
import { cancelOffloadTask } from '@/api/tasks'
import { pickListedCapability } from '@/lib/capability-picker'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import type { PromptGenTaskId } from '@/types/ws-promptgen'
import { isVideoMode, type ImgGenMode } from '@/lib/imggen'

/** `{}` in the query template is replaced with the user's idea server-side. */
const PLACEHOLDER = '{}'

const MAX_LOG_LINES = 40
const MODEL_STORAGE_KEY = 'oai_promptgen_model'
const queryStorageKey = (mode: ImgGenMode) => `oai_promptgen_query_${mode}`

function formatLogTime(d = new Date()): string {
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function defaultQuery(mode: ImgGenMode): string {
  return isVideoMode(mode)
    ? 'Create a video generation prompt from this: {}'
    : 'Create an image generation prompt from this: {}'
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting for an agent…',
  assigned: 'Agent picked up the task…',
  running: 'Generating…',
  cancelRequested: 'Stopping…',
}

const MORPH_SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const

type Phase = 'idle' | 'running' | 'done'

interface PromptGeneratorModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ImgGenMode
  /** Current prompt from the generation form — the idea fed into `{}`. */
  prompt: string
  token: string | null
  /** Called with the generated prompt when the user accepts it. */
  onUsePrompt: (prompt: string) => void
}

/**
 * "Prompt generator" — rewrites a rough idea into a polished generation prompt
 * via an LLM over WebSocket (same task event flow as chat). Centered dialog on
 * desktop, bottom sheet on mobile.
 */
export function PromptGeneratorModal(props: PromptGeneratorModalProps) {
  if (!props.open) return null
  return <PromptGeneratorDialog {...props} />
}

function PromptGeneratorDialog({
  onOpenChange,
  mode,
  prompt,
  token,
  onUsePrompt,
}: PromptGeneratorModalProps) {
  const isMobile = useIsMobile()
  const ws = useWsPromptGen(token)
  const [idea, setIdea] = useState(() => prompt)
  const [query, setQuery] = useState(
    () => localStorage.getItem(queryStorageKey(mode)) || defaultQuery(mode),
  )
  const [capability, setCapability] = useState(
    () => localStorage.getItem(MODEL_STORAGE_KEY) ?? '',
  )
  const [phase, setPhase] = useState<Phase>('idle')
  const [statusLabel, setStatusLabel] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const taskRef = useRef<PromptGenTaskId | null>(null)
  const reqIdRef = useRef<string | null>(null)
  const aliveRef = useRef(true)
  const capsLoggedRef = useRef<CapabilitiesStatus>('idle')

  function appendLog(message: string) {
    if (!aliveRef.current) return
    const line = `${formatLogTime()} ${message}`
    setLogs(prev => [line, ...prev.slice(0, MAX_LOG_LINES - 1)])
  }

  function clearActiveTask() {
    taskRef.current = null
    reqIdRef.current = null
  }

  function requestTaskCancel(task: PromptGenTaskId, reason: string) {
    if (!token) return
    appendLog(`${reason} → cancel ${task.cap}/${task.id}`)
    void cancelOffloadTask(token, task.cap, task.id)
      .then(() => { if (aliveRef.current) appendLog('cancel request sent') })
      .catch(e => {
        if (aliveRef.current) {
          appendLog(`cancel failed: ${e instanceof Error ? e.message : 'unknown error'}`)
        }
      })
  }

  function cancelTaskSilently(task: PromptGenTaskId) {
    if (!token) return
    void cancelOffloadTask(token, task.cap, task.id).catch(() => {})
  }

  function dismiss() {
    aliveRef.current = false
    const task = taskRef.current
    clearActiveTask()
    if (task) cancelTaskSilently(task)
    onOpenChange(false)
  }

  const queryValid = query.includes(PLACEHOLDER)
  const canGenerate =
    ws.status === 'connected' &&
    phase !== 'running' &&
    queryValid &&
    !!idea.trim() &&
    !!capability &&
    ws.capabilitiesStatus === 'ready'

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const task = taskRef.current
      taskRef.current = null
      reqIdRef.current = null
      if (token && task) void cancelOffloadTask(token, task.cap, task.id).catch(() => {})
    }
  }, [token])

  useEffect(() => {
    if (ws.capabilitiesStatus !== 'ready' || ws.capabilities.length === 0) return
    setCapability(prev =>
      pickListedCapability(prev, ws.capabilities) ?? ws.capabilities[0]?.base ?? '',
    )
  }, [ws.capabilities, ws.capabilitiesStatus])

  useEffect(() => {
    if (ws.capabilitiesStatus === capsLoggedRef.current) return
    capsLoggedRef.current = ws.capabilitiesStatus
    if (ws.capabilitiesStatus === 'loading') {
      appendLog('loading prompt-gen capabilities…')
    } else if (ws.capabilitiesStatus === 'ready') {
      appendLog(`capabilities ready (${ws.capabilities.length} models)`)
    } else if (ws.capabilitiesStatus === 'error' && ws.capabilitiesError) {
      appendLog(`capabilities failed: ${ws.capabilitiesError}`)
    }
  }, [ws.capabilitiesStatus, ws.capabilities.length, ws.capabilitiesError])

  useEffect(() => {
    if (ws.status === 'connecting') appendLog('ws connecting…')
    else if (ws.status === 'connected') appendLog('ws connected')
    else if (ws.status === 'disconnected' && phase === 'running') {
      appendLog('ws disconnected during generation')
      const task = taskRef.current
      if (task) cancelTaskSilently(task)
      if (aliveRef.current) {
        setError('Connection lost')
        setPhase('idle')
        setStopping(false)
        clearActiveTask()
      }
    }
  }, [ws.status, phase, token])

  // Persist the query draft per mode as the user types.
  useEffect(() => {
    localStorage.setItem(queryStorageKey(mode), query)
  }, [mode, query])

  // Stream task events from the prompt-gen WebSocket.
  useEffect(() => {
    return ws.subscribe(event => {
      if (!aliveRef.current) return
      const reqId = reqIdRef.current
      if (!reqId) return
      if ('req_id' in event && event.req_id !== reqId) return

      switch (event.type) {
        case 'task:queued':
          appendLog(`queued ${event.cap}/${event.id}`)
          taskRef.current = { cap: event.cap, id: event.id }
          setStatusLabel(STATUS_LABELS.pending ?? 'Queued…')
          break
        case 'task:progress': {
          const stage = event.stage ? ` stage=${event.stage}` : ''
          appendLog(`progress status=${event.status}${stage}`)
          setStatusLabel(STATUS_LABELS[event.status] ?? event.status)
          break
        }
        case 'task:result':
          appendLog(`completed (${event.text.length} chars)`)
          setResult(event.text)
          setPhase('done')
          clearActiveTask()
          break
        case 'task:failed':
          appendLog(`failed: ${event.error}`)
          setError(event.error === 'Task was canceled' ? null : event.error)
          setPhase('idle')
          setStopping(false)
          clearActiveTask()
          break
        case 'error':
          appendLog(`error: ${event.message}`)
          setError(event.message)
          setPhase('idle')
          setStopping(false)
          clearActiveTask()
          break
      }
    })
  }, [ws.subscribe])

  function handleGenerate() {
    if (!canGenerate) return
    setError(null)
    setResult('')
    setStopping(false)
    clearActiveTask()
    setStatusLabel('Submitting…')
    setPhase('running')
    localStorage.setItem(MODEL_STORAGE_KEY, capability)

    const reqId = nextPromptGenReqId('promptgen')
    reqIdRef.current = reqId
    appendLog(`ws send → mode=${mode} cap=${capability}`)
    const sent = ws.send({
      type: 'generate_prompt',
      req_id: reqId,
      mode,
      capability,
      query: query.trim(),
      prompt: idea.trim(),
    })
    if (!sent) {
      appendLog('ws send failed: socket not open')
      setError('WebSocket not connected')
      setPhase('idle')
      clearActiveTask()
    }
  }

  function handleStop() {
    const task = taskRef.current
    if (!token || !task || stopping) return
    setStopping(true)
    setStatusLabel('Stopping…')
    requestTaskCancel(task, 'stop')
  }

  function handleUse() {
    const text = result.trim()
    if (!text) return
    onUsePrompt(text)
    onOpenChange(false)
  }

  const modeNoun = isVideoMode(mode) ? 'video' : 'image'

  return (
    <Dialog open onOpenChange={next => { if (!next) dismiss() }}>
      <DialogContent
        data-testid="promptgen-modal"
        className={cn(
          'max-w-xl',
          isMobile &&
            'bottom-0 left-0 top-auto w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 max-h-[92dvh]' +
            ' data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100' +
            ' data-[state=open]:slide-in-from-bottom-10 data-[state=closed]:slide-out-to-bottom-10',
        )}
      >
        {isMobile && (
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
        )}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-primary" />
            Prompt generator
          </DialogTitle>
          <DialogDescription>
            Turn a rough idea into a polished {modeNoun} prompt with an LLM.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4 pb-5">
          <div className="space-y-1.5">
            <Label htmlFor="promptgen-idea">Your idea</Label>
            <textarea
              id="promptgen-idea"
              value={idea}
              onChange={e => setIdea(e.target.value)}
              rows={3}
              placeholder="e.g. a cozy cabin in a snowy forest at night"
              disabled={phase === 'running'}
              data-testid="promptgen-idea"
              className={cn(
                'w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed',
                'outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="promptgen-query">Generator query</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                disabled={phase === 'running' || query === defaultQuery(mode)}
                onClick={() => setQuery(defaultQuery(mode))}
                data-testid="promptgen-reset-query"
              >
                <RotateCcw className="mr-1 size-3" />
                Reset
              </Button>
            </div>
            <PromptTextarea
              id="promptgen-query"
              value={query}
              onChange={setQuery}
              bucket={`imggen-promptgen-${mode}`}
              token={token}
              rows={3}
              disabled={phase === 'running'}
              placeholder={defaultQuery(mode)}
              textareaClassName="font-mono text-xs"
              data-testid="promptgen-query"
            />
            {queryValid ? (
              <p className="text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{'{}'}</code>{' '}
                is replaced with your idea. Queries are saved per mode.
              </p>
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  The query must contain <code className="font-mono">{'{}'}</code>.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-xs"
                  onClick={() => setQuery(q => `${q.trimEnd()} {}`)}
                  data-testid="promptgen-insert-placeholder"
                >
                  <ArrowDownToLine className="mr-1 size-3" />
                  Insert {'{}'}
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Model</Label>
            <CapabilityModelPicker
              capabilities={ws.capabilities}
              selected={capability}
              onSelect={setCapability}
              onRefresh={ws.refreshCapabilities}
              capabilitiesStatus={ws.capabilitiesStatus}
              capabilitiesError={ws.capabilitiesError}
              testIdPrefix="promptgen-model"
            />
          </div>

          <AnimatePresence initial={false}>
            {error && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                data-testid="promptgen-error"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          <div className="flex flex-col items-stretch gap-2">
            <motion.div
              layout
              transition={MORPH_SPRING}
              style={{ borderRadius: 12 }}
              className={cn('overflow-hidden', phase === 'running' ? 'self-center' : 'self-stretch')}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {phase === 'idle' ? (
                  <motion.button
                    key="generate"
                    type="button"
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    disabled={!canGenerate}
                    onClick={handleGenerate}
                    data-testid="promptgen-generate"
                    className={cn(
                      'flex min-h-11 w-full items-center justify-center gap-2 bg-primary px-5 text-sm font-medium text-primary-foreground',
                      'transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:pointer-events-none disabled:opacity-50',
                    )}
                  >
                    <Wand2 className="size-4" />
                    Generate
                  </motion.button>
                ) : phase === 'running' ? (
                  <motion.div
                    key="loader"
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex min-h-11 items-center gap-3 bg-muted px-5 text-sm text-muted-foreground"
                    data-testid="promptgen-status"
                  >
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    <span className="whitespace-nowrap">{statusLabel}</span>
                    <button
                      type="button"
                      disabled={stopping}
                      onClick={handleStop}
                      title="Stop"
                      aria-label="Stop"
                      data-testid="promptgen-stop"
                      className="ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Square className="size-3.5" />
                    </button>
                  </motion.div>
                ) : (
                  <motion.button
                    key="result"
                    type="button"
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={handleUse}
                    data-testid="promptgen-result"
                    className={cn(
                      'group w-full border border-primary/40 bg-primary/5 px-4 py-3 text-left',
                      'transition-colors hover:border-primary/70 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <span className="block whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {result}
                    </span>
                    <span className="mt-2 flex items-center gap-1.5 text-xs font-medium text-primary opacity-80 transition-opacity group-hover:opacity-100">
                      <Check className="size-3.5" />
                      Use this prompt
                    </span>
                  </motion.button>
                )}
              </AnimatePresence>
            </motion.div>

            {logs.length > 0 && (
              <div
                className="max-h-28 overflow-y-auto overscroll-contain rounded-md bg-muted/40 px-2.5 py-2 font-mono leading-relaxed text-muted-foreground"
                data-testid="promptgen-logs"
                aria-live="polite"
              >
                {logs.map((line, i) => (
                  <div
                    key={`${i}-${line}`}
                    className={i === 0 ? 'text-xs text-foreground/85' : 'text-[10px]'}
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}

            <AnimatePresence initial={false}>
              {phase === 'done' && (
                <motion.div
                  key="regenerate"
                  initial={{ opacity: 0, y: -6, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, y: -6, height: 0 }}
                  transition={MORPH_SPRING}
                  className="overflow-hidden"
                >
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:min-h-9"
                    disabled={!canGenerate}
                    onClick={handleGenerate}
                    data-testid="promptgen-regenerate"
                  >
                    <RotateCcw className="mr-1.5 size-3.5" />
                    Regenerate
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
