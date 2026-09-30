import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, RefreshCw } from 'lucide-react'
import { listImgGenCapabilities, startImageJob, type ImgGenCapability } from '../../api/images'
import { recordRecentPrompt } from '../../api/prompts'
import { useProgress } from '../../contexts/ProgressContext'
import { filterCapabilitiesByWorkflow, MODE_DEFAULTS } from '../../lib/imggen'
import { isListedCapability } from '../../lib/capability-picker'
import type { CapabilitiesStatus } from '../../lib/capabilitiesStatus'
import { capabilityBaseLabel, sortCapabilitiesForPicker } from '../../lib/modelAvailability'
import { cn } from '../../lib/utils'
import { JobErrorBanner } from '../JobErrorBanner'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Label } from '../ui/label'

const SIZE_PRESETS = [
  [512, 512],
  [768, 768],
  [1024, 1024],
  [1024, 768],
  [768, 1024],
] as const

type QuickGenerateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: string
  token: string
}

/** Start a txt2img job from a completed image description without leaving the page. */
export function QuickGenerateDialog({ open, onOpenChange, prompt, token }: QuickGenerateDialogProps) {
  const { refreshRunningImageJobs } = useProgress()
  const [allCapabilities, setAllCapabilities] = useState<ImgGenCapability[]>([])
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>('loading')
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [capability, setCapability] = useState('')
  const [size, setSize] = useState<readonly [number, number]>([
    MODE_DEFAULTS.txt2img.width,
    MODE_DEFAULTS.txt2img.height,
  ])
  const [submitting, setSubmitting] = useState(false)
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const capabilities = useMemo(
    () => sortCapabilitiesForPicker(filterCapabilitiesByWorkflow(allCapabilities, 'txt2img')),
    [allCapabilities],
  )

  const onCapabilitiesLoaded = useCallback((listed: ImgGenCapability[]) => {
    const eligible = filterCapabilitiesByWorkflow(listed, 'txt2img')
    setAllCapabilities(listed)
    setCapability(prev =>
      eligible.some(cap => cap.base === prev)
        ? prev
        : eligible.find(cap => cap.online)?.base ?? eligible[0]?.base ?? '',
    )
    setCapabilitiesStatus('ready')
  }, [])

  const onCapabilitiesError = useCallback((e: unknown) => {
    setCapabilitiesError(e instanceof Error ? e.message : 'Failed to load models')
    setCapabilitiesStatus('error')
  }, [])

  useEffect(() => {
    if (!open) return
    let current = true
    void listImgGenCapabilities(token)
      .then(listed => { if (current) onCapabilitiesLoaded(listed) })
      .catch(e => { if (current) onCapabilitiesError(e) })
    return () => { current = false }
  }, [open, token, onCapabilitiesLoaded, onCapabilitiesError])

  function refreshCapabilities() {
    setCapabilitiesStatus('loading')
    setCapabilitiesError(null)
    void listImgGenCapabilities(token)
      .then(onCapabilitiesLoaded)
      .catch(onCapabilitiesError)
  }

  const canGenerate =
    capabilitiesStatus === 'ready' &&
    isListedCapability(capability, capabilities) &&
    Boolean(prompt.trim()) &&
    !submitting &&
    !submittedJobId

  async function onGenerate() {
    if (!canGenerate) return
    setSubmitting(true)
    setError(null)
    const text = prompt.trim()
    try {
      const result = await startImageJob(token, {
        capability,
        prompt: text,
        prompt_template: text,
        width: size[0],
        height: size[1],
        workflow: 'txt2img',
        override_negative: false,
      })
      setSubmittedJobId(result.job_id)
      void recordRecentPrompt(token, 'imggen-prompt', text).catch(() => {})
      void refreshRunningImageJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start image generation')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenChange(next: boolean) {
    if (submitting && !next) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="describe-generate-dialog">
        <DialogHeader>
          <DialogTitle>Generate image</DialogTitle>
          <DialogDescription>
            Use this description as the prompt for a new image.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {submittedJobId ? (
            <div className="flex items-start gap-3 rounded-lg bg-primary/10 px-3 py-3 text-sm" role="status" data-testid="describe-generate-success">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>Image generation started. Follow the job in Progress.</span>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Prompt</Label>
                <p className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="describe-generate-prompt">
                  {prompt.trim()}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="describe-generate-model">Model</Label>
                <div className="flex gap-2">
                  <select
                    id="describe-generate-model"
                    value={capability}
                    onChange={e => setCapability(e.target.value)}
                    disabled={capabilitiesStatus !== 'ready' || capabilities.length === 0}
                    className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    data-testid="describe-generate-model"
                  >
                    {capabilities.length === 0 && (
                      <option value="">
                        {capabilitiesStatus === 'loading' ? 'Loading models…' : 'No models'}
                      </option>
                    )}
                    {capabilities.map(cap => (
                      <option key={cap.raw} value={cap.base}>
                        {capabilityBaseLabel(cap.base)}{cap.online ? '' : ' (offline)'}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={refreshCapabilities}
                    disabled={capabilitiesStatus === 'loading'}
                    title="Refresh models"
                    aria-label="Refresh models"
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </div>
                {capabilitiesStatus === 'error' && capabilitiesError && (
                  <JobErrorBanner message={capabilitiesError} testId="describe-generate-model-error" />
                )}
                {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No text-to-image models found. Start an imggen agent or check the OffloadMQ connection in Settings.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Size</Label>
                <div className="flex flex-wrap gap-2" data-testid="describe-generate-sizes">
                  {SIZE_PRESETS.map(([width, height]) => (
                    <button
                      key={`${width}x${height}`}
                      type="button"
                      aria-pressed={size[0] === width && size[1] === height}
                      onClick={() => setSize([width, height])}
                      className={cn(
                        'min-h-11 rounded-md border px-3 text-xs transition-colors',
                        size[0] === width && size[1] === height
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input bg-background hover:bg-muted/50',
                      )}
                      data-testid={`describe-generate-size-${width}x${height}`}
                    >
                      {width}×{height}
                    </button>
                  ))}
                </div>
              </div>
              {error && <JobErrorBanner message={error} testId="describe-generate-error" />}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="min-h-11 w-full sm:w-auto"
          >
            {submittedJobId ? 'Done' : 'Cancel'}
          </Button>
          {!submittedJobId && (
            <Button
              type="button"
              onClick={() => void onGenerate()}
              disabled={!canGenerate}
              className="min-h-11 w-full sm:w-auto"
              data-testid="describe-generate-submit"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? 'Starting…' : 'Generate'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
