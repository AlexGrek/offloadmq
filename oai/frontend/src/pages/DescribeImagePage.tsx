import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Eye, ImageUp, Loader2, RefreshCw, X } from 'lucide-react'
import {
  listDescribeCapabilities,
  pollDescribeTask,
  submitDescribeTask,
  type DescribeCapability,
} from '../api/describe'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '../lib/utils'

const DEFAULT_PROMPT = 'Describe this image in detail'
const POLL_INTERVAL_MS = 2500

function extractText(output: unknown): string {
  if (!output) return ''
  if (typeof output === 'string') return output
  const o = output as Record<string, unknown>
  const choices = o['choices']
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as Record<string, unknown>)['message']
    if (msg) {
      const content = (msg as Record<string, unknown>)['content']
      if (typeof content === 'string') return content
    }
  }
  if (typeof o['content'] === 'string') return o['content']
  return JSON.stringify(output, null, 2)
}

function capLabel(cap: DescribeCapability): string {
  const model = cap.base.replace(/^llm\./, '')
  const extra = cap.tags.filter(t => t.toLowerCase() !== 'vision').join(', ')
  return extra ? `${model} [${extra}]` : model
}

export default function DescribeImagePage() {
  const { token } = useAuth()

  const [capabilities, setCapabilities] = useState<DescribeCapability[]>([])
  const [capsLoading, setCapsLoading] = useState(true)
  const [capsError, setCapsError] = useState<string | null>(null)

  const [selectedCap, setSelectedCap] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const [taskId, setTaskId] = useState<{ cap: string; id: string } | null>(null)
  const [polling, setPolling] = useState(false)
  const [pollingStatus, setPollingStatus] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const loadCapabilities = useCallback(() => {
    if (!token) return
    setCapsLoading(true)
    setCapsError(null)
    listDescribeCapabilities(token)
      .then(data => {
        setCapabilities(data.capabilities)
        if (data.capabilities.length > 0) setSelectedCap(data.capabilities[0].base)
      })
      .catch((e: Error) => setCapsError(e.message))
      .finally(() => setCapsLoading(false))
  }, [token])

  useEffect(() => {
    loadCapabilities()
  }, [loadCapabilities])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  function setImage(file: File | null) {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setImageFile(file)
    if (file) {
      const url = URL.createObjectURL(file)
      previewUrlRef.current = url
      setImagePreview(url)
    } else {
      setImagePreview(null)
    }
    setResult(null)
    setError(null)
  }

  useEffect(() => {
    if (!taskId || !token) return
    setPolling(true)
    let cancelled = false

    const run = async () => {
      while (!cancelled) {
        try {
          const res = await pollDescribeTask(token, taskId.cap, taskId.id)
          if (cancelled) break
          if (res.output != null || res.status === 'completed') {
            setResult(extractText(res.output))
            setPolling(false)
            setTaskId(null)
            setPollingStatus('')
            break
          }
          if (res.status === 'failed') {
            setError('Task failed')
            setPolling(false)
            setTaskId(null)
            setPollingStatus('')
            break
          }
          setPollingStatus(res.stage ?? res.status ?? 'running…')
          await new Promise<void>(r => window.setTimeout(r, POLL_INTERVAL_MS))
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : 'Polling failed')
            setPolling(false)
            setTaskId(null)
            setPollingStatus('')
          }
          break
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [taskId, token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || !imageFile || !selectedCap || isSubmitting || polling) return
    setError(null)
    setResult(null)
    setIsSubmitting(true)
    try {
      const res = await submitDescribeTask(token, selectedCap, prompt.trim() || DEFAULT_PROMPT, imageFile)
      setTaskId({ cap: res.cap, id: res.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleCopy() {
    if (!result) return
    void navigator.clipboard.writeText(result).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const busy = isSubmitting || polling

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="describe-page"
    >
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Eye className="size-5 text-sky-400" />
          <h1 className="font-display text-2xl font-bold">Describe Image</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Analyze images with a vision-capable AI model
        </p>
      </div>

      <form onSubmit={e => void handleSubmit(e)} className="space-y-5">
        {/* Model selector */}
        <div className="space-y-1.5" data-testid="describe-capability-select">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="describe-cap">Model</Label>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={loadCapabilities}
              disabled={capsLoading}
              data-testid="describe-refresh-caps"
            >
              <RefreshCw className={cn('size-3', capsLoading && 'animate-spin')} />
              Refresh
            </button>
          </div>
          {capsError ? (
            <p className="text-xs text-destructive">{capsError}</p>
          ) : capsLoading ? (
            <div className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading models…
            </div>
          ) : capabilities.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No vision models found. Start a vision-capable LLM agent or check OffloadMQ connection
              in Settings.
            </p>
          ) : (
            <select
              id="describe-cap"
              value={selectedCap}
              onChange={e => setSelectedCap(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="describe-cap-select"
            >
              {capabilities.map(c => (
                <option key={c.base} value={c.base}>
                  {capLabel(c)}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Image upload */}
        <div className="space-y-1.5" data-testid="describe-image-upload">
          <Label>Image</Label>
          {imagePreview ? (
            <div className="relative inline-block">
              <img
                src={imagePreview}
                alt="Selected"
                className="max-h-64 max-w-full rounded-lg border border-border object-contain"
                data-testid="describe-image-preview"
              />
              <button
                type="button"
                className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1 text-foreground backdrop-blur hover:bg-background transition-colors"
                onClick={() => setImage(null)}
                aria-label="Remove image"
                data-testid="describe-remove-image"
              >
                <X className="size-3.5" />
              </button>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => setImage(e.target.files?.[0] ?? null)}
                />
                Change image
              </label>
            </div>
          ) : (
            <label
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 text-muted-foreground transition-colors hover:bg-muted/50',
                dragOver && 'border-primary bg-primary/5',
              )}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault()
                setDragOver(false)
                const file = e.dataTransfer.files[0]
                if (file?.type.startsWith('image/')) setImage(file)
              }}
              data-testid="describe-drop-zone"
            >
              <ImageUp className="size-8 text-muted-foreground/60" />
              <span className="text-sm font-medium">Click or drag an image here</span>
              <span className="text-xs">PNG, JPEG, WebP, GIF…</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => setImage(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>

        {/* Prompt */}
        <div className="space-y-1.5" data-testid="describe-prompt">
          <Label htmlFor="describe-prompt">Prompt</Label>
          <textarea
            id="describe-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={DEFAULT_PROMPT}
            data-testid="describe-prompt-input"
          />
        </div>

        {/* Submit */}
        <Button
          type="submit"
          disabled={busy || !imageFile || !selectedCap || capsLoading}
          className="w-full"
          data-testid="describe-submit"
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              {isSubmitting ? 'Submitting…' : pollingStatus || 'Running…'}
            </>
          ) : (
            <>
              <Eye className="mr-2 size-4" />
              Describe
            </>
          )}
        </Button>
      </form>

      {/* Error */}
      {error ? (
        <div
          className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="describe-error"
        >
          {error}
        </div>
      ) : null}

      {/* Result */}
      {result != null ? (
        <div className="mt-6 space-y-2" data-testid="describe-result">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Result</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleCopy}
              data-testid="describe-copy"
            >
              <Copy className="size-3.5" />
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-4">
            <p
              className="whitespace-pre-wrap text-sm leading-relaxed"
              data-testid="describe-result-text"
            >
              {result}
            </p>
          </div>
        </div>
      ) : null}
    </main>
  )
}
