import { useCallback, useEffect, useRef, useState } from 'react'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { Ban, Camera, Library, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { imageFileUrl, imageThumbnailUrl, type UploadedImage } from '../../api/images'
import {
  PHOTO_TERMINAL,
  cancelPersonaPhoto,
  deletePersonaPhoto,
  listPersonaPhotos,
  pollPersonaPhoto,
  retryPersonaPhoto,
  startPersonaPhotos,
  type Persona,
  type PersonaPhoto,
  type PhotoStep,
} from '../../api/personas'
import { PromptTextarea } from '../PromptTextarea'
import { ImagePickerModal } from '../imggen/ImagePickerModal'
import { ImageLightbox } from '../ImageLightbox'

/** Shared with Image Generation: prompts picked here come from (and go to) the txt2img pool. */
const PROMPT_BUCKET = 'imggen-prompt'
const POLL_MS = 3000

const STEP_LABEL: Record<PhotoStep['kind'], string> = {
  generate: 'Generate',
  face_swap: 'Face swap',
  upscale: 'Upscale',
}

function stepTone(status: string): string {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'failed' || status === 'canceled') return 'bg-destructive/15 text-destructive'
  if (status === 'pending' || status === 'skipped') return 'bg-muted text-muted-foreground'
  return 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
}

type Props = { token: string; persona: Persona }

/** Persona photos: txt2img/img2img → face swap → upscale, plus the run history. */
export function PersonaPhotos({ token, persona }: Props) {
  const [prompt, setPrompt] = useState('')
  const [workflow, setWorkflow] = useState<'txt2img' | 'img2img'>('txt2img')
  const [input, setInput] = useState<UploadedImage | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [faceId, setFaceId] = useState<string>('')
  const hasFaces = persona.faces.length > 0
  const [faceSwap, setFaceSwap] = useState(true)
  const [upscale, setUpscale] = useState(true)
  const [count, setCount] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PersonaPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const photosRef = useRef(photos)
  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  const refresh = useCallback(() => {
    listPersonaPhotos(token, persona.id)
      .then(setPhotos)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [token, persona.id])

  useResetOnChange(persona.id, () => {
    setLoading(true)
    setPhotos([])
    setFaceId('')
  })
  useEffect(refresh, [refresh])

  // Advance in-flight runs while the tab is open (the worker does it otherwise).
  const inFlight = photos.some(p => !PHOTO_TERMINAL.has(p.status))
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => {
      const running = photosRef.current.filter(p => !PHOTO_TERMINAL.has(p.status)).slice(0, 4)
      void Promise.all(running.map(p => pollPersonaPhoto(token, p.job_id).catch(() => null))).then(updated => {
        const byId = new Map(updated.filter((p): p is PersonaPhoto => !!p).map(p => [p.job_id, p]))
        if (byId.size) setPhotos(prev => prev.map(p => byId.get(p.job_id) ?? p))
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, token])

  const canSubmit = !!prompt.trim() && !submitting && (workflow === 'txt2img' || !!input)

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await startPersonaPhotos(token, persona.id, {
        prompt: prompt.trim(),
        workflow,
        input_image_id: workflow === 'img2img' ? input?.image_id : undefined,
        face_swap: hasFaces ? faceSwap : false,
        face_image_id: hasFaces && faceSwap && faceId ? faceId : undefined,
        upscale,
        scale: 2,
        count,
      })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="persona-photos">
      <section className="flex flex-col gap-4" data-testid="persona-photo-form">
        <div className="flex flex-col gap-2">
          <Label htmlFor="persona-photo-prompt">Prompt</Label>
          <PromptTextarea
            id="persona-photo-prompt"
            value={prompt}
            onChange={setPrompt}
            bucket={PROMPT_BUCKET}
            token={token}
            previews
            rows={3}
            placeholder="{p_look}, portrait of {p_name} on a rooftop at dusk"
            data-testid="persona-photo-prompt"
          />
          <p className="text-xs text-muted-foreground">
            Pick from your saved txt2img prompts (list icon). <code className="rounded bg-muted px-1">{'{p_look}'}</code> and{' '}
            <code className="rounded bg-muted px-1">{'{p_name}'}</code> are filled in from the persona.
          </p>
        </div>

        <div className="flex flex-wrap gap-2" role="tablist">
          {(['txt2img', 'img2img'] as const).map(w => (
            <Button
              key={w}
              type="button"
              variant={workflow === w ? 'default' : 'outline'}
              size="sm"
              className="flex-1 sm:flex-none"
              onClick={() => setWorkflow(w)}
              data-testid={`persona-photo-workflow-${w}`}
            >
              {w === 'txt2img' ? 'From text' : 'From an image'}
            </Button>
          ))}
        </div>

        {workflow === 'img2img' && (
          <div className="flex items-center gap-3">
            {input ? (
              <div className="relative size-20 overflow-hidden rounded-lg bg-muted">
                <img src={imageThumbnailUrl(input.image_id, token)} alt={input.filename} className="size-full object-cover" />
                <button type="button" aria-label="Clear input" className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white" onClick={() => setInput(null)}>
                  <X className="size-3" />
                </button>
              </div>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-testid="persona-photo-input">
              <Library /> {input ? 'Change image' : 'Pick input image'}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hasFaces && faceSwap}
              disabled={!hasFaces}
              onChange={e => setFaceSwap(e.target.checked)}
              data-testid="persona-photo-faceswap"
            />
            Face swap{!hasFaces && <span className="text-xs text-muted-foreground">(add a face first)</span>}
          </label>
          {hasFaces && faceSwap && persona.faces.length > 1 && (
            <div className="flex items-center gap-1.5" data-testid="persona-photo-face-picker">
              {persona.faces.map((f, i) => {
                const selected = (faceId || persona.faces[0].image_id) === f.image_id
                return (
                  <button
                    key={f.image_id}
                    type="button"
                    title={i === 0 ? 'Primary face' : 'Use this face'}
                    onClick={() => setFaceId(f.image_id)}
                    className={cn('size-9 overflow-hidden rounded-md ring-2', selected ? 'ring-primary' : 'ring-transparent opacity-70')}
                  >
                    <img src={imageThumbnailUrl(f.image_id, token)} alt="" className="size-full object-cover" />
                  </button>
                )
              })}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={upscale} onChange={e => setUpscale(e.target.checked)} data-testid="persona-photo-upscale" />
            Upscale ×2
          </label>
          <label className="flex items-center gap-2">
            Photos
            <select
              className="h-8 rounded-md border border-input bg-background px-2"
              value={count}
              onChange={e => setCount(Number(e.target.value))}
              data-testid="persona-photo-count"
            >
              {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="text-sm text-destructive" data-testid="persona-photo-error">{error}</p>}

        <Button className="min-h-11 w-full sm:w-auto sm:self-start" disabled={!canSubmit} onClick={() => void submit()} data-testid="persona-photo-submit">
          {submitting ? <Loader2 className="animate-spin" /> : <Camera />}
          {count > 1 ? `Take ${count} photos` : 'Take photo'}
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-display text-base font-semibold">Photos</h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : photos.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="persona-photos-empty">No photos yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="persona-photo-list">
            {photos.map(p => (
              <PhotoCard
                key={p.job_id}
                token={token}
                photo={p}
                onCancel={() => void act(() => cancelPersonaPhoto(token, p.job_id))}
                onRetry={() => void act(() => retryPersonaPhoto(token, p.job_id))}
                onDelete={() => {
                  if (window.confirm('Delete this photo and its intermediate images?')) void act(() => deletePersonaPhoto(token, p.job_id))
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <ImagePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={img => { setInput(img); setPickerOpen(false) }} token={token} />
    </div>
  )
}

function PhotoCard({
  token,
  photo,
  onCancel,
  onRetry,
  onDelete,
}: {
  token: string
  photo: PersonaPhoto
  onCancel: () => void
  onRetry: () => void
  onDelete: () => void
}) {
  const done = PHOTO_TERMINAL.has(photo.status)
  return (
    <li className="flex flex-col gap-2" data-testid={`persona-photo-${photo.job_id}`}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
        {photo.final_image_id ? (
          <ImageLightbox src={imageFileUrl(photo.final_image_id, token)} alt={photo.prompt} caption={photo.prompt} triggerClassName="block size-full">
            <img src={imageThumbnailUrl(photo.final_image_id, token)} alt={photo.prompt} className="size-full object-cover" />
          </ImageLightbox>
        ) : (
          <div className="flex size-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
            {done ? (photo.error ?? photo.status) : <Loader2 className="size-5 animate-spin" />}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1" data-testid={`persona-photo-steps-${photo.job_id}`}>
        {photo.steps.map(s => (
          <span key={s.kind} title={s.error ?? s.stage ?? s.status} className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', stepTone(s.status))}>
            {STEP_LABEL[s.kind]}
          </span>
        ))}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground" title={photo.prompt}>{photo.prompt}</p>
      <div className="flex gap-1">
        {!done ? (
          <Button variant="ghost" size="icon-sm" title="Cancel" aria-label="Cancel" onClick={onCancel} data-testid={`persona-photo-cancel-${photo.job_id}`}>
            <Ban />
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="icon-sm" title="Run again" aria-label="Run again" onClick={onRetry} data-testid={`persona-photo-retry-${photo.job_id}`}>
              <RotateCcw />
            </Button>
            <Button variant="ghost" size="icon-sm" title="Delete" aria-label="Delete" onClick={onDelete} data-testid={`persona-photo-delete-${photo.job_id}`}>
              <Trash2 />
            </Button>
          </>
        )}
      </div>
    </li>
  )
}
