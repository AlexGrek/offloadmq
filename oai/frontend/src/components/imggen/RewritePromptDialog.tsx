import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import { listRewriteModels, rewritePrompt } from '@/api/promptRewrite'
import { CapabilityModelPicker } from '@/components/CapabilityModelPicker'
import { PromptTextarea } from '@/components/PromptTextarea'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { isListedCapability } from '@/lib/capability-picker'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import { isVideoMode, type ImgGenMode } from '@/lib/imggen'
import { firstSelectableModel } from '@/lib/modelAvailability'
import type { LlmCapabilityInfo } from '@/types/ws'

const SYSTEM_BUCKET = 'imggen-prompt-modification-system'
const USER_BUCKET = 'imggen-prompt-modification-user'
const MODEL_KEY = 'oai_prompt_rewrite_model'
const DEFAULT_SYSTEM = 'You rewrite generation prompts according to the user’s instructions. Preserve the original intent and any placeholders such as {?} or {color}. Return only the rewritten prompt, without commentary, alternatives, or quotation marks.'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: string
  mode: ImgGenMode
  token: string | null
  onUsePrompt: (prompt: string) => void
}

export function RewritePromptDialog(props: Props) {
  // Each opening captures the current form prompt and clears previous results.
  return props.open ? <RewritePromptPopup {...props} /> : null
}

function RewritePromptPopup({ onOpenChange, prompt, mode, token, onUsePrompt }: Props) {
  const [input] = useState(prompt)
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem(`oai_${SYSTEM_BUCKET}`) ?? DEFAULT_SYSTEM)
  const [userPrompt, setUserPrompt] = useState(() => localStorage.getItem(`oai_${USER_BUCKET}_${mode}`) ??
    `Rewrite this ${isVideoMode(mode) ? 'video' : 'image'} generation prompt with clearer, more vivid visual details while preserving its meaning:\n\n{}`)
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? '')
  const [models, setModels] = useState<LlmCapabilityInfo[]>([])
  const [modelsStatus, setModelsStatus] = useState<CapabilitiesStatus>('loading')
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const modelsRequestRef = useRef<AbortController | null>(null)

  const loadModels = useCallback(() => {
    if (!token) return
    modelsRequestRef.current?.abort()
    const controller = new AbortController()
    modelsRequestRef.current = controller
    void listRewriteModels(token, controller.signal).then(capabilities => {
      if (controller.signal.aborted) return
      setModels(capabilities)
      setModelsError(null)
      setModel(previous => isListedCapability(previous, capabilities) ? previous : firstSelectableModel(capabilities) ?? '')
      setModelsStatus('ready')
    }).catch(e => {
      if (controller.signal.aborted) return
      setModelsStatus('error')
      setModelsError(e instanceof Error ? e.message : 'Failed to load models')
    })
  }, [token])

  useEffect(() => {
    void loadModels()
    return () => {
      modelsRequestRef.current?.abort()
      requestRef.current?.abort()
    }
  }, [loadModels])

  const canRewrite = !!token && !running && modelsStatus === 'ready' && isListedCapability(model, models) &&
    !!input.trim() && !!systemPrompt.trim() && !!userPrompt.trim()

  async function generate() {
    if (!canRewrite || !token || requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    setRunning(true)
    setError(null)
    setResult('')
    localStorage.setItem(MODEL_KEY, model)
    localStorage.setItem(`oai_${SYSTEM_BUCKET}`, systemPrompt)
    localStorage.setItem(`oai_${USER_BUCKET}_${mode}`, userPrompt)
    try {
      const response = await rewritePrompt(token, {
        capability: model, prompt: input, system_prompt: systemPrompt, user_prompt: userPrompt,
      }, controller.signal)
      if (!controller.signal.aborted) setResult(response.text)
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Prompt rewrite failed')
    } finally {
      if (!controller.signal.aborted) {
        requestRef.current = null
        setRunning(false)
      }
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="imggen-rewrite-dialog">
        <DialogHeader>
          <DialogTitle>Rewrite prompt</DialogTitle>
          <DialogDescription>Modify your current prompt, then review the result before using it.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rewrite-current-prompt">Current prompt</Label>
            <textarea id="rewrite-current-prompt" readOnly value={input} rows={3}
              className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm"
              data-testid="imggen-rewrite-input" />
          </div>
          <div className="space-y-1.5">
            <Label>Model</Label>
            <CapabilityModelPicker capabilities={models} selected={model} onSelect={setModel}
              onRefresh={() => { setModelsStatus('loading'); setModelsError(null); void loadModels() }}
              capabilitiesStatus={modelsStatus} capabilitiesError={modelsError}
              testIdPrefix="imggen-rewrite-model" />
            {modelsStatus === 'ready' && models.length === 0 && (
              <p className="text-sm text-muted-foreground">No LLM models are online. Refresh the model list to try again.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rewrite-system-prompt">Prompt modification system prompt</Label>
            <PromptTextarea id="rewrite-system-prompt" value={systemPrompt} onChange={setSystemPrompt}
              bucket={SYSTEM_BUCKET} token={token} rows={3} disabled={running} data-testid="imggen-rewrite-system" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rewrite-user-prompt">Prompt modification user prompt</Label>
            <PromptTextarea id="rewrite-user-prompt" value={userPrompt} onChange={setUserPrompt}
              bucket={USER_BUCKET} token={token} rows={3} disabled={running} data-testid="imggen-rewrite-user" />
            <p className="text-xs text-muted-foreground">{'{} is replaced with your current prompt. If omitted, the current prompt is appended.'}</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="imggen-rewrite-error">{error}</p>}
          {result && (
            <div className="space-y-1.5">
              <Label htmlFor="rewrite-result">Rewritten prompt</Label>
              <textarea id="rewrite-result" value={result} onChange={e => setResult(e.target.value)} rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="imggen-rewrite-result" />
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="button" variant={result ? 'outline' : 'default'} disabled={!canRewrite}
            onClick={() => void generate()} data-testid="imggen-rewrite-generate">
            {running ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
            {running ? 'Rewriting…' : result ? 'Rewrite again' : 'Rewrite'}
          </Button>
          {result && <Button type="button" disabled={running || !result.trim()}
            onClick={() => { onUsePrompt(result.trim()); onOpenChange(false) }} data-testid="imggen-rewrite-apply">
            Use prompt
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
