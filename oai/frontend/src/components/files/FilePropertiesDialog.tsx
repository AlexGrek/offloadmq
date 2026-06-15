import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Loader2, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { getFileProperties, type FileProperties } from '../../api/files'
import { pipelineParamsFromStored, storedImggenWorkflow, type ImggenRouteState } from '../../lib/imggen'
import { canGenerateAgainFromTtsStored, type TtsRouteState } from '../../lib/tts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  filename: string | null
  token: string | null
}

/** Ordered key map per source. Keys missing from the response are silently
 *  skipped; unrecognized keys land in the "Other" section. */
const KEY_ORDER: Record<string, string[]> = {
  image: [
    'display_name',
    'prompt',
    'negative_prompt',
    'capability',
    'workflow',
    'width',
    'height',
    'seed',
    'pipeline_params',
    'input_image_id',
    'job_id',
    'created_at',
  ],
  audio: ['text', 'capability', 'model', 'voice', 'content_type', 'job_id', 'created_at'],
}

const LABELS: Record<string, string> = {
  display_name: 'Name',
  prompt: 'Prompt',
  negative_prompt: 'Negative prompt',
  capability: 'Capability',
  workflow: 'Workflow',
  width: 'Width',
  height: 'Height',
  seed: 'Seed',
  pipeline_params: 'Pipeline params',
  input_image_id: 'Input image id',
  text: 'Text',
  model: 'Model',
  voice: 'Voice',
  content_type: 'Content type',
  job_id: 'Job id',
  created_at: 'Generated at',
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function isMultiline(value: unknown): boolean {
  if (typeof value !== 'string') return typeof value === 'object'
  return value.includes('\n') || value.length > 80
}

export function FilePropertiesDialog({ open, onOpenChange, filename, token }: Props) {
  const navigate = useNavigate()
  const [data, setData] = useState<FileProperties | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || !filename || !token) return
    setData(null)
    setError(null)
    setLoading(true)
    getFileProperties(token, filename)
      .then(res => {
        setData(res)
        if (!res) setError('No generation parameters recorded for this file.')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, filename, token])

  function handleGenerateAgain() {
    if (!data) return
    const parameters = data.parameters
    const jobId =
      typeof parameters.job_id === 'string' && parameters.job_id.trim() !== ''
        ? parameters.job_id.trim()
        : undefined
    onOpenChange(false)

    if (data.source === 'image' && storedImggenWorkflow(parameters)) {
      const state: ImggenRouteState = {
        generateAgain: { jobId, parameters },
      }
      navigate('/app/images', { state })
      return
    }

    if (data.source === 'audio' && canGenerateAgainFromTtsStored(parameters)) {
      const state: TtsRouteState = {
        generateAgain: { jobId, parameters },
      }
      navigate('/app/tts', { state })
    }
  }

  function handleCopy() {
    if (!data) return
    void navigator.clipboard
      .writeText(JSON.stringify(data.parameters, null, 2))
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      })
  }

  const params = (data?.parameters ?? {}) as Record<string, unknown>
  const canGenerateAgain =
    (data?.source === 'image' &&
      storedImggenWorkflow(params) != null &&
      pipelineParamsFromStored(params).prompt.trim() !== '') ||
    (data?.source === 'audio' && canGenerateAgainFromTtsStored(params))
  const order = data ? KEY_ORDER[data.source] ?? [] : []
  const knownKeys = new Set(order)
  const otherKeys = Object.keys(params)
    .filter(k => !knownKeys.has(k) && k !== 'source')
    .sort()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,40rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
          <DialogTitle className="truncate pr-6">{filename ?? 'Properties'}</DialogTitle>
          <DialogDescription>
            How this file was generated. This record is preserved even after the file is deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error && !data ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
              {error}
            </p>
          ) : data ? (
            <div className="space-y-4">
              <dl className="space-y-3">
                {order
                  .filter(key => params[key] != null && params[key] !== '')
                  .map(key => (
                    <PropertyRow key={key} label={LABELS[key] ?? key} value={params[key]} />
                  ))}
                {otherKeys.length > 0 && (
                  <>
                    <dt className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Other
                    </dt>
                    {otherKeys.map(key => (
                      <PropertyRow key={key} label={LABELS[key] ?? key} value={params[key]} />
                    ))}
                  </>
                )}
              </dl>
              <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Source: <span className="font-mono">{data.source}</span>
                </span>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-1">
                  {canGenerateAgain ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={handleGenerateAgain}
                      className="min-h-11 w-full gap-1.5 sm:min-h-8 sm:w-auto"
                      data-testid="file-properties-generate-again"
                    >
                      <Sparkles className="size-3.5" />
                      Generate again
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                    className="min-h-11 w-full gap-1.5 sm:min-h-8 sm:w-auto"
                  >
                    <Copy className="size-3.5" />
                    {copied ? 'Copied!' : 'Copy JSON'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function PropertyRow({ label, value }: { label: string; value: unknown }) {
  const formatted = formatValue(value)
  const multiline = isMultiline(value)
  return (
    <div className="space-y-1">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? 'whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono leading-relaxed text-foreground'
            : 'text-sm text-foreground'
        }
      >
        {formatted}
      </dd>
    </div>
  )
}
