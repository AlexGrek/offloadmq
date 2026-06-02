import { useEffect, useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
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
  const order = data ? KEY_ORDER[data.source] ?? [] : []
  const knownKeys = new Set(order)
  const otherKeys = Object.keys(params)
    .filter(k => !knownKeys.has(k) && k !== 'source')
    .sort()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{filename ?? 'Properties'}</DialogTitle>
          <DialogDescription>
            How this file was generated. This record is preserved even after the file is deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] overflow-y-auto">
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
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-[11px] text-muted-foreground">
                  Source: <span className="font-mono">{data.source}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  className="gap-1.5"
                >
                  <Copy className="size-3.5" />
                  {copied ? 'Copied!' : 'Copy JSON'}
                </Button>
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
