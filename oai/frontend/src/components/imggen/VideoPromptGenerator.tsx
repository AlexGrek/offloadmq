import { useEffect, useRef, useState } from 'react'
import { Clapperboard, Loader2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CapabilityModelPicker } from '@/components/CapabilityModelPicker'
import { capabilityBaseLabel } from '@/lib/modelAvailability'
import { nextPromptGenReqId, useWsPromptGen } from '@/hooks/useWsPromptGen'
import { cancelOffloadTask } from '@/api/tasks'
import type { PromptGenTaskId, LlmCapabilityInfo } from '@/types/ws-promptgen'

const MODEL_STORAGE_KEY = 'oai_video_promptgen_model'

/** Prefixed console logging so this feature's activity is easy to filter for
 * in DevTools (`console.debug`/`console.error`, filter on "[video-promptgen]"). */
function log(...args: unknown[]) {
  console.debug('[video-promptgen]', ...args)
}
function logError(...args: unknown[]) {
  console.error('[video-promptgen]', ...args)
}

/** Restore the saved model if still online; otherwise prefer gemma4 (this
 * deployment's default vision model) before falling back to the first one. */
function pickDefaultCapability(preferred: string, capabilities: LlmCapabilityInfo[]): string {
  const trimmed = preferred.trim()
  if (trimmed && capabilities.some(c => c.base === trimmed)) return trimmed
  const gemma = capabilities.find(c => c.base.toLowerCase().includes('gemma4'))
  return gemma?.base ?? capabilities[0]?.base ?? ''
}

/**
 * "Video prompt generator" (img2video mode): sends the uploaded frame to a
 * vision LLM with a fixed system prompt asking what happens next, and applies
 * the result straight to the Prompt field. Inline control, no dialog — the
 * model picker's own dropdown is the only popover involved.
 */
export function VideoPromptGenerator({
  token,
  imageId,
  onGenerated,
  onError,
}: {
  token: string | null
  imageId: string
  onGenerated: (text: string) => void
  onError: (message: string) => void
}) {
  const ws = useWsPromptGen(token)
  const [capability, setCapability] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) ?? '')
  const [running, setRunning] = useState(false)
  // Shown right under the button so a failure (e.g. the model returning an
  // empty response — occasional with some vision models) can't be missed by
  // scrolling past the page-level error banner further down the form.
  const [localError, setLocalError] = useState<string | null>(null)
  const taskRef = useRef<PromptGenTaskId | null>(null)
  const reqIdRef = useRef<string | null>(null)
  const aliveRef = useRef(true)

  const visionCapabilities = ws.capabilities.filter(c =>
    c.tags.some(t => t.toLowerCase() === 'vision'),
  )

  useEffect(() => {
    log('ws status changed:', ws.status)
  }, [ws.status])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const task = taskRef.current
      taskRef.current = null
      reqIdRef.current = null
      if (token && task) {
        log('unmounting mid-run, canceling task', task)
        void cancelOffloadTask(token, task.cap, task.id).catch(() => {})
      }
    }
  }, [token])

  useEffect(() => {
    if (ws.capabilitiesStatus !== 'ready' || visionCapabilities.length === 0) return
    setCapability(prev => pickDefaultCapability(prev, visionCapabilities))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.capabilities, ws.capabilitiesStatus])

  useEffect(() => {
    return ws.subscribe(event => {
      if (!aliveRef.current) return
      const reqId = reqIdRef.current
      if (!reqId) return
      if ('req_id' in event && event.req_id !== reqId) return

      log('event', event)
      switch (event.type) {
        case 'task:queued':
          taskRef.current = { cap: event.cap, id: event.id }
          break
        case 'task:result':
          setRunning(false)
          taskRef.current = null
          reqIdRef.current = null
          setLocalError(null)
          onGenerated(event.text)
          break
        case 'task:failed':
          setRunning(false)
          taskRef.current = null
          reqIdRef.current = null
          if (event.error !== 'Task was canceled') {
            logError('task failed:', event.error)
            setLocalError(event.error)
            onError(event.error)
          }
          break
        case 'error':
          setRunning(false)
          taskRef.current = null
          reqIdRef.current = null
          logError('ws error event:', event.message)
          setLocalError(event.message)
          onError(event.message)
          break
      }
    })
  }, [ws.subscribe, onGenerated, onError])

  const canGenerate =
    ws.status === 'connected' && !running && !!capability && !!imageId && ws.capabilitiesStatus === 'ready'

  function handleGenerate() {
    if (!canGenerate) return
    setRunning(true)
    setLocalError(null)
    localStorage.setItem(MODEL_STORAGE_KEY, capability)
    const reqId = nextPromptGenReqId('vidprompt')
    reqIdRef.current = reqId
    const cmd = {
      type: 'generate_video_prompt' as const,
      req_id: reqId,
      capability,
      image_id: imageId,
    }
    log('sending', cmd)
    const sent = ws.send(cmd)
    if (!sent) {
      logError('ws.send returned false — socket not open (status was', ws.status, ')')
      setRunning(false)
      reqIdRef.current = null
      setLocalError('WebSocket not connected')
      onError('WebSocket not connected')
    }
  }

  function handleStop() {
    const task = taskRef.current
    if (!token || !task) return
    log('stop requested for', task)
    void cancelOffloadTask(token, task.cap, task.id).catch(() => {})
    setRunning(false)
    taskRef.current = null
    reqIdRef.current = null
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="imggen-video-promptgen">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <CapabilityModelPicker
            capabilities={visionCapabilities}
            selected={capability}
            onSelect={setCapability}
            onRefresh={ws.refreshCapabilities}
            capabilitiesStatus={ws.capabilitiesStatus}
            capabilitiesError={ws.capabilitiesError}
            formatLabel={cap => capabilityBaseLabel(cap.base)}
            filterTags={tags => tags.filter(t => t.toLowerCase() !== 'vision')}
            testIdPrefix="video-promptgen-model"
          />
        </div>
        {running ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={handleStop}
            data-testid="video-promptgen-stop"
          >
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            Analyzing frame…
            <Square className="ml-1.5 size-3 fill-current" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            disabled={!canGenerate}
            onClick={handleGenerate}
            title={
              ws.capabilitiesStatus === 'ready' && visionCapabilities.length === 0
                ? 'No vision-capable models online'
                : undefined
            }
            data-testid="video-promptgen-generate"
          >
            <Clapperboard className="mr-1.5 size-3.5" />
            {localError ? 'Try again' : 'Video prompt generator'}
          </Button>
        )}
      </div>
      {localError && (
        <p className="text-xs text-destructive" data-testid="video-promptgen-error">
          {localError}
        </p>
      )}
    </div>
  )
}
