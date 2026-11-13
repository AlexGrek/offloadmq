import { useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { DIMENSION_PRESETS, MODE_DEFAULTS } from '../../lib/imggen'
import { capabilityBaseLabel } from '../../lib/modelAvailability'
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
import { clampGenerateCount, MAX_QUICK_GENERATE, useQuickTxt2Img } from './useQuickTxt2Img'

const MAX_GENERATE_MULTIPLE = MAX_QUICK_GENERATE
const DEFAULT_GENERATE_MULTIPLE = 1

type QuickGenerateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: string
  token: string
  description?: string
  /** `data-testid` prefix; Describe Image keeps `describe-generate`. */
  testIdPrefix?: string
}

/**
 * Start txt2img jobs from a prompt without leaving the page (Describe Image result,
 * Prompt Studio). The prompt is editable but deliberately not focused on open — the
 * usual next step is picking a size, not rewriting the text.
 */
export function QuickGenerateDialog({
  open,
  onOpenChange,
  prompt,
  token,
  description = 'Use this description as the prompt for a new image.',
  testIdPrefix = 'describe-generate',
}: QuickGenerateDialogProps) {
  const models = useQuickTxt2Img(token, open)
  const {
    capabilities,
    status: capabilitiesStatus,
    error: capabilitiesError,
    capability,
    setCapability,
    refresh: refreshCapabilities,
  } = models
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<readonly [number, number]>([
    MODE_DEFAULTS.txt2img.width,
    MODE_DEFAULTS.txt2img.height,
  ])
  const [promptInput, setPromptInput] = useState(prompt)
  const [countInput, setCountInput] = useState(String(DEFAULT_GENERATE_MULTIPLE))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tid = (suffix: string) => `${testIdPrefix}-${suffix}`
  const parseCount = clampGenerateCount

  const canGenerate =
    models.ready &&
    Boolean(promptInput.trim()) &&
    !submitting

  async function onGenerate() {
    if (!canGenerate) return
    setSubmitting(true)
    setError(null)
    try {
      await models.generate({
        prompt: promptInput,
        width: size[0],
        height: size[1],
        count: parseCount(countInput),
      })
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
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        data-testid={tid('dialog')}
        onOpenAutoFocus={event => {
          // Radix focuses the first field (the prompt) by default — keep focus on the dialog.
          event.preventDefault()
          contentRef.current?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle>Generate image</DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <>
            <div className="space-y-1.5">
              <Label htmlFor={tid('prompt')}>Prompt</Label>
              <textarea
                id={tid('prompt')}
                value={promptInput}
                onChange={event => setPromptInput(event.target.value)}
                rows={5}
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={tid('prompt')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={tid('model')}>Model</Label>
              <div className="flex gap-2">
                <select
                  id={tid('model')}
                  value={capability}
                  onChange={e => setCapability(e.target.value)}
                  disabled={capabilitiesStatus !== 'ready' || capabilities.length === 0}
                  className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  data-testid={tid('model')}
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
                <JobErrorBanner message={capabilitiesError} testId={tid('model-error')} />
              )}
              {capabilitiesStatus === 'ready' && capabilities.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No text-to-image models found. Start an imggen agent or check the OffloadMQ connection in Settings.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Size</Label>
              <div className="flex flex-wrap gap-2" data-testid={tid('sizes')}>
                {DIMENSION_PRESETS.map(([width, height]) => (
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
                    data-testid={tid(`size-${width}x${height}`)}
                  >
                    {width}×{height}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={tid('count')}>Number of images</Label>
              <Input
                id={tid('count')}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_GENERATE_MULTIPLE}
                value={countInput}
                onChange={e => setCountInput(e.target.value)}
                onBlur={() => setCountInput(String(parseCount(countInput)))}
                className="min-h-11 font-mono tabular-nums"
                data-testid={tid('count')}
              />
              <p className="text-xs text-muted-foreground">
                Up to {MAX_GENERATE_MULTIPLE} separate runs appear in Progress.
              </p>
            </div>
            {error && <JobErrorBanner message={error} testId={tid('error')} />}
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
            data-testid={tid('submit')}
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
