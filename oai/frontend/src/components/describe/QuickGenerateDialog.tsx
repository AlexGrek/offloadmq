import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
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
import { Input } from '../ui/input'

const SIZE_PRESETS = [
  [512, 512],
  [768, 768],
  [1024, 1024],
  [1024, 768],
  [768, 1024],
] as const

const MAX_GENERATE_MULTIPLE = 10
const DEFAULT_GENERATE_MULTIPLE = 1

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
  const [promptInput, setPromptInput] = useState(prompt)
  const [countInput, setCountInput] = useState(String(DEFAULT_GENERATE_MULTIPLE))
  const [submitting, setSubmitting] = useState(false)
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

  function parseCount(raw: string): number {
    const count = parseInt(raw, 10)
    if (!Number.isFinite(count)) return DEFAULT_GENERATE_MULTIPLE
    return Math.min(MAX_GENERATE_MULTIPLE, Math.max(1, count))
  }

  const canGenerate =
    capabilitiesStatus === 'ready' &&
    isListedCapability(capability, capabilities) &&
    Boolean(promptInput.trim()) &&
    !submitting

  async function onGenerate() {
    if (!canGenerate) return
    setSubmitting(true)
    setError(null)
    const text = promptInput.trim()
    const count = parseCount(countInput)
    try {
      for (let index = 0; index < count; index += 1) {
        await startImageJob(token, {
          capability,
          prompt: text,
          prompt_template: text,
          width: size[0],
          height: size[1],
          workflow: 'txt2img',
          override_negative: false,
        })
      }
      void recordRecentPrompt(token, 'imggen-prompt', text).catch(() => {})
      void refreshRunningImageJobs()
      onOpenChange(false)
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
          <>
            <div className="space-y-1.5">
              <Label htmlFor="describe-generate-prompt">Prompt</Label>
              <textarea
                id="describe-generate-prompt"
                value={promptInput}
                onChange={event => setPromptInput(event.target.value)}
                rows={5}
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="describe-generate-prompt"
              />
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

            <div className="space-y-1.5">
              <Label htmlFor="describe-generate-count">Number of images</Label>
              <Input
                id="describe-generate-count"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_GENERATE_MULTIPLE}
                value={countInput}
                onChange={e => setCountInput(e.target.value)}
                onBlur={() => setCountInput(String(parseCount(countInput)))}
                className="min-h-11 font-mono tabular-nums"
                data-testid="describe-generate-count"
              />
              <p className="text-xs text-muted-foreground">
                Up to {MAX_GENERATE_MULTIPLE} separate runs appear in Progress.
              </p>
            </div>
            {error && <JobErrorBanner message={error} testId="describe-generate-error" />}
          </>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="min-h-11 w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onGenerate()}
            disabled={!canGenerate}
            className="min-h-11 w-full sm:w-auto"
            data-testid="describe-generate-submit"
          >
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {submitting
              ? 'Starting…'
              : `Generate ${parseCount(countInput)} ${parseCount(countInput) === 1 ? 'image' : 'images'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
