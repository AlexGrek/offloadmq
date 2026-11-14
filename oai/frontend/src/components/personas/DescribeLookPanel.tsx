import { useEffect, useRef, useState } from 'react'
import { Loader2, ScanFace, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { cancelDescribeJob, pollDescribeJob } from '../../api/describe'
import { describePersonaLook, type EffectiveChoice, type ModelOption } from '../../api/personas'

const POLL_MS = 2000
const TERMINAL = new Set(['completed', 'failed', 'canceled'])
/** Server-side cap on `look` (services::personas::MAX_LOOK_CHARS). */
const MAX_LOOK_CHARS = 4000

const SOURCE_LABEL: Record<string, string> = {
  preference: 'preferred',
  most_used: 'most used',
  only: 'only one online',
  first_online: 'first online',
}

type Run =
  | { state: 'running'; jobId: string; capability: string; status: string; stage: string | null }
  | { state: 'done'; previousLook: string }
  | { state: 'error'; message: string }

type Props = {
  token: string
  /** null = unsaved persona: the form's values are sent without persona defaults. */
  personaId: string | null
  /** Primary face (first of the form's faces), if any. */
  faceId: string | null
  look: string
  onLook: (look: string) => void
  capability: string | null
  onCapability: (capability: string | null) => void
  /** null = the default prompt. */
  prompt: string | null
  onPrompt: (prompt: string | null) => void
  models: ModelOption[]
  defaultPrompt: string
  effective?: EffectiveChoice | null
}

/**
 * "Describe look": runs a vision model on the primary face (a Describe Image job)
 * and puts its answer into the look field. The model and prompt are persona
 * fields, saved with the rest of the profile.
 */
export function DescribeLookPanel({
  token,
  personaId,
  faceId,
  look,
  onLook,
  capability,
  onCapability,
  prompt,
  onPrompt,
  models,
  defaultPrompt,
  effective,
}: Props) {
  const [run, setRun] = useState<Run | null>(null)
  const [starting, setStarting] = useState(false)
  useResetOnChange(personaId, () => setRun(null))

  // The poll effect reads the latest look / setter without restarting on each keystroke.
  const latest = useRef({ look, onLook })
  useEffect(() => {
    latest.current = { look, onLook }
  })

  const jobId = run?.state === 'running' ? run.jobId : null
  useEffect(() => {
    if (!jobId) return
    let stopped = false
    const tick = async () => {
      try {
        const job = await pollDescribeJob(token, jobId)
        if (stopped) return
        if (!TERMINAL.has(job.status)) {
          setRun(r => (r?.state === 'running' && r.jobId === jobId ? { ...r, status: job.status, stage: job.stage } : r))
          return
        }
        stopped = true
        const text = job.result?.trim() ?? ''
        if (job.status === 'completed' && text) {
          const previousLook = latest.current.look
          latest.current.onLook(text.slice(0, MAX_LOOK_CHARS))
          setRun({ state: 'done', previousLook })
        } else {
          const message =
            job.status === 'canceled' ? 'Canceled.' : job.error || 'The vision model returned nothing.'
          setRun({ state: 'error', message })
        }
      } catch (e) {
        if (!stopped) setRun({ state: 'error', message: (e as Error).message })
        stopped = true
      }
    }
    void tick()
    const timer = window.setInterval(() => {
      if (stopped) window.clearInterval(timer)
      else void tick()
    }, POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [jobId, token])

  async function start() {
    if (!faceId) return
    setStarting(true)
    setRun(null)
    try {
      const started = await describePersonaLook(token, {
        persona_id: personaId ?? undefined,
        image_id: faceId,
        capability: capability ?? undefined,
        prompt: prompt ?? (defaultPrompt || undefined),
      })
      setRun({ state: 'running', jobId: started.job_id, capability: started.capability, status: 'pending', stage: null })
    } catch (e) {
      setRun({ state: 'error', message: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  async function cancel() {
    if (run?.state !== 'running') return
    try {
      await cancelDescribeJob(token, run.jobId)
    } catch (e) {
      setRun({ state: 'error', message: (e as Error).message })
    }
  }

  const promptValue = prompt ?? defaultPrompt
  const autoLabel = effective && !capability
    ? `Auto — ${effective.capability} (${SOURCE_LABEL[effective.source] ?? effective.source})`
    : 'Auto (most used, else first online)'

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3" data-testid="persona-describe-look">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Vision model
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          value={capability ?? ''}
          onChange={e => onCapability(e.target.value || null)}
          data-testid="persona-describe-model"
        >
          <option value="">{autoLabel}</option>
          {capability && !models.some(o => o.capability === capability) && (
            <option value={capability}>{capability} (offline)</option>
          )}
          {models.map(o => (
            <option key={o.capability} value={o.capability}>
              {o.capability}
              {o.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center justify-between gap-2">
          Prompt
          {prompt !== null && (
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => onPrompt(null)}
              data-testid="persona-describe-prompt-reset"
            >
              Reset to default
            </button>
          )}
        </span>
        <textarea
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          rows={4}
          value={promptValue}
          onChange={e => onPrompt(e.target.value === defaultPrompt ? null : e.target.value)}
          data-testid="persona-describe-prompt"
        />
        <span>The model and prompt are saved with the persona. {'{p_name}'} works here.</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {run?.state === 'running' ? (
          <>
            <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="persona-describe-status">
              <Loader2 className="size-4 animate-spin" />
              Describing with {run.capability} — {run.stage || run.status}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void cancel()} data-testid="persona-describe-cancel">
              <X /> Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:min-h-8 sm:w-auto"
            disabled={!faceId || starting || (prompt !== null && !prompt.trim())}
            onClick={() => void start()}
            data-testid="persona-describe-run"
          >
            {starting ? <Loader2 className="animate-spin" /> : <ScanFace />}
            Describe primary face
          </Button>
        )}
        {!faceId && <span className="text-xs text-muted-foreground">Add a face first.</span>}
        {run?.state === 'done' && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="persona-describe-done">
            Look filled in — review it and save.
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              onClick={() => {
                onLook(run.previousLook)
                setRun(null)
              }}
              data-testid="persona-describe-undo"
            >
              <Undo2 className="size-3" /> Undo
            </button>
          </span>
        )}
        {run?.state === 'error' && (
          <span className="text-xs text-destructive" data-testid="persona-describe-error">{run.message}</span>
        )}
      </div>
    </div>
  )
}
