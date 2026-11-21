import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { Ban, Braces, Camera, Check, Copy, ImagePlus, Library, Loader2, Pencil, RotateCcw, Trash2, UserRound, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ImageSizePicker } from '@/components/ImageSizePicker'
import { rememberedImageSize, validImageSize } from '@/lib/imageSizes'
import { cn } from '@/lib/utils'
import { imageFileUrl, imageThumbnailUrl, uploadImage, type UploadedImage } from '../../api/images'
import {
  PHOTO_TERMINAL,
  cancelPersonaPhoto,
  deletePersonaPhoto,
  listPersonaPhotos,
  pollPersonaPhoto,
  refacePersonaPhoto,
  retryPersonaPhoto,
  startPersonaPhotos,
  type Persona,
  type PersonaPhoto,
  type PhotoStep,
  type PhotoWorkflow,
} from '../../api/personas'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { PromptTextarea } from '../PromptTextarea'
import { ImagePickerModal } from '../imggen/ImagePickerModal'
import { ImageLightbox, type LightboxSlide } from '../ImageLightbox'
import { NudeDetectModal } from '../nudedetect/NudeDetectModal'
import { distinctPromptTemplate, type ImggenRouteState } from '../../lib/imggen'

/** Shared with Image Generation: prompts picked here come from (and go to) the txt2img pool. */
const PROMPT_BUCKET = 'imggen-prompt'
const POLL_MS = 3000
const MAX_PHOTOS = 24
const COUNT_PRESETS = [1, 2, 3, 4, 5, 8] as const
const SCALES = [1.5, 2, 3] as const
const PROMPT_TOKENS = ['{p_name}', '{p_look}', '{p_system}'] as const

function clampCount(raw: string): number {
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? Math.min(MAX_PHOTOS, Math.max(1, n)) : 1
}

/** A `{p_*}` token: click inserts it into the prompt, the icon copies it. */
function TokenChip({ token, onInsert }: { token: string; onInsert: (t: string) => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <span className="inline-flex items-center gap-0.5 rounded-2xl bg-muted/60 py-0.5 pr-1 pl-2.5">
      <button
        type="button"
        onClick={() => onInsert(token)}
        className="rounded-sm font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        title={`Insert ${token}`}
        data-testid={`persona-photo-token-${token}`}
      >
        {token}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title={copied ? 'Copied' : `Copy ${token}`}
        aria-label={copied ? 'Copied' : `Copy ${token}`}
        onClick={() => void navigator.clipboard.writeText(token).then(() => setCopied(true)).catch(() => undefined)}
        className={cn('rounded-full text-muted-foreground', copied && 'text-emerald-600 dark:text-emerald-400')}
        data-testid={`persona-photo-token-copy-${token}`}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </span>
  )
}

const WORKFLOW_LABEL: Record<PhotoWorkflow, string> = {
  txt2img: 'From text',
  img2img: 'From an image',
  existing: 'Existing photo',
}

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

/**
 * Persona photos: txt2img/img2img → face swap → upscale, or an existing photo →
 * face swap → upscale (no generation), plus the run history.
 */
export function PersonaPhotos({ token, persona }: Props) {
  const [prompt, setPrompt] = useState('')
  const [workflow, setWorkflow] = useState<PhotoWorkflow>('txt2img')
  const existing = workflow === 'existing'
  const [input, setInput] = useState<UploadedImage | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [faceId, setFaceId] = useState<string>('')
  const hasFaces = persona.faces.length > 0
  const [faceSwap, setFaceSwap] = useState(true)
  const [upscale, setUpscale] = useState(true)
  const [count, setCount] = useState(1)
  const [countInput, setCountInput] = useState('1')
  const [scale, setScale] = useState<number>(2)
  const [size, setSize] = useState<readonly [number, number]>(() => rememberedImageSize([1024, 1024]))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PersonaPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  // The open image, by id: polling replaces `photos` under an open viewer.
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [nudeTarget, setNudeTarget] = useState<{ imageId: string; filename: string } | null>(null)
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
    setViewerId(null)
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

  // Finished photos, in grid order: the lightbox's swipe track.
  const viewable = useMemo(() => photos.filter(p => !!p.final_image_id), [photos])
  const slides = useMemo<LightboxSlide[]>(
    () =>
      viewable.map(p => ({
        id: p.final_image_id!,
        src: imageFileUrl(p.final_image_id!, token),
        alt: photoCaption(p),
      })),
    [viewable, token],
  )
  const viewerIndex = viewerId ? viewable.findIndex(p => p.final_image_id === viewerId) : -1
  const current = viewerIndex >= 0 ? viewable[viewerIndex] : undefined
  const currentId = current?.final_image_id ?? null

  const sendToGenerator = useCallback(
    (p: PersonaPhoto, mode: 'img2img' | 'img2video') => {
      const ref = p.final_image
      const image: UploadedImage = {
        image_id: p.final_image_id!,
        filename: ref?.filename ?? `${p.job_id}.jpg`,
        // Images served by the viewer are normalized to JPEG by OAI.
        content_type: 'image/jpeg',
        width: ref?.width ?? 0,
        height: ref?.height ?? 0,
        size_bytes: 0,
        rescaled: false,
        reencoded: false,
      }
      const state: ImggenRouteState = { useInputImage: { mode, image } }
      navigate('/app/images', { state })
    },
    [navigate],
  )

  const sizeOk = existing || validImageSize(size[0], size[1])
  const canSubmit = !submitting && sizeOk && (existing ? hasFaces && !!input : !!prompt.trim() && (workflow === 'txt2img' || !!input))

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await startPersonaPhotos(
        token,
        persona.id,
        existing
          ? { workflow, input_image_id: input?.image_id, face_image_id: faceId || undefined, upscale, scale }
          : {
              prompt: prompt.trim(),
              workflow,
              input_image_id: workflow === 'img2img' ? input?.image_id : undefined,
              face_swap: hasFaces ? faceSwap : false,
              face_image_id: hasFaces && faceSwap && faceId ? faceId : undefined,
              width: size[0],
              height: size[1],
              upscale,
              scale,
              count,
            },
      )
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  /** Uploads straight into the library and uses it as the input photo. */
  async function onUpload(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      setInput(await uploadImage(token, file))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
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
        {!existing && <div className="flex flex-col gap-2">
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
            Pick from your saved txt2img prompts (list icon). Persona tokens are filled in on submit.
          </p>
          <div className="flex flex-wrap gap-1.5" data-testid="persona-photo-tokens">
            {PROMPT_TOKENS.map(t => (
              <TokenChip key={t} token={t} onInsert={tok => setPrompt(v => (v && !/\s$/.test(v) ? `${v} ${tok}` : `${v}${tok}`))} />
            ))}
          </div>
        </div>}

        <div className="flex flex-wrap gap-2" role="tablist">
          {(['txt2img', 'img2img', 'existing'] as const).map(w => (
            <Button
              key={w}
              type="button"
              variant={workflow === w ? 'default' : 'outline'}
              size="sm"
              className="flex-1 sm:flex-none"
              onClick={() => setWorkflow(w)}
              data-testid={`persona-photo-workflow-${w}`}
            >
              {WORKFLOW_LABEL[w]}
            </Button>
          ))}
        </div>

        {existing && (
          <p className="text-xs text-muted-foreground" data-testid="persona-photo-existing-hint">
            No generation: the persona's face is swapped into a photo you upload or pick from your library{hasFaces ? '' : ' — add a face first'}.
          </p>
        )}

        {workflow !== 'txt2img' && (
          <div className="flex flex-wrap items-center gap-3">
            {input ? (
              <div className="relative size-20 overflow-hidden rounded-lg bg-muted">
                <img src={imageThumbnailUrl(input.image_id, token)} alt={input.filename} className="size-full object-cover" />
                <button type="button" aria-label="Clear input" className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white" onClick={() => setInput(null)}>
                  <X className="size-3" />
                </button>
              </div>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="persona-photo-upload">
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} Upload
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-testid="persona-photo-input">
              <Library /> {input ? 'Pick another' : 'From library'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={e => void onUpload(e.target.files?.[0])}
              data-testid="persona-photo-upload-input"
            />
          </div>
        )}

        {!existing && (
          <ImageSizePicker
            width={size[0]}
            height={size[1]}
            testIdPrefix="persona-photo"
            onChange={setSize}
            onWidthChange={v => setSize([Number(v) || 0, size[1]])}
            onHeightChange={v => setSize([size[0], Number(v) || 0])}
          />
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hasFaces && (existing || faceSwap)}
              disabled={!hasFaces || existing}
              onChange={e => setFaceSwap(e.target.checked)}
              data-testid="persona-photo-faceswap"
            />
            Face swap{!hasFaces && <span className="text-xs text-muted-foreground">(add a face first)</span>}
          </label>
          {hasFaces && (existing || faceSwap) && persona.faces.length > 1 && (
            <div className="flex min-w-0 max-w-full basis-full flex-wrap items-center gap-1.5 sm:basis-auto" data-testid="persona-photo-face-picker">
              {persona.faces.map((f, i) => {
                const selected = (faceId || persona.faces[0].image_id) === f.image_id
                return (
                  <button
                    key={f.image_id}
                    type="button"
                    title={i === 0 ? 'Primary face' : 'Use this face'}
                    onClick={() => setFaceId(f.image_id)}
                    className={cn('size-9 shrink-0 overflow-hidden rounded-md ring-2', selected ? 'ring-primary' : 'ring-transparent opacity-70')}
                  >
                    <img src={imageThumbnailUrl(f.image_id, token)} alt="" className="size-full object-cover" />
                  </button>
                )
              })}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={upscale} onChange={e => setUpscale(e.target.checked)} data-testid="persona-photo-upscale" />
            Upscale
          </label>
          {upscale && (
            <label className="flex items-center gap-2">
              Scale
              <select
                className="h-8 rounded-md border border-input bg-background px-2"
                value={scale}
                onChange={e => setScale(Number(e.target.value))}
                data-testid="persona-photo-scale"
              >
                {SCALES.map(n => <option key={n} value={n}>×{n}</option>)}
              </select>
            </label>
          )}
        </div>

        {!existing && (
          <div className="space-y-2" data-testid="persona-photo-count-group">
            <Label htmlFor="persona-photo-count">Number of photos</Label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Number of photos presets">
              {COUNT_PRESETS.map(n => (
                <Button
                  key={n}
                  type="button"
                  variant={count === n ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={count === n}
                  className="min-w-10 flex-1 font-mono tabular-nums"
                  onClick={() => { setCount(n); setCountInput(String(n)) }}
                  data-testid={`persona-photo-count-preset-${n}`}
                >
                  {n}
                </Button>
              ))}
            </div>
            <Input
              id="persona-photo-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_PHOTOS}
              value={countInput}
              onChange={e => {
                setCountInput(e.target.value)
                if (e.target.value.trim() !== '') setCount(clampCount(e.target.value))
              }}
              onBlur={() => setCountInput(String(count))}
              className="font-mono tabular-nums"
              data-testid="persona-photo-count"
            />
          </div>
        )}

        {error && <p className="text-sm text-destructive" data-testid="persona-photo-error">{error}</p>}

        <Button className="min-h-11 w-full sm:w-auto sm:self-start" disabled={!canSubmit} onClick={() => void submit()} data-testid="persona-photo-submit">
          {submitting ? <Loader2 className="animate-spin" /> : <Camera />}
          {existing ? 'Swap face' : count > 1 ? `Take ${count} photos` : 'Take photo'}
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
                faces={persona.faces}
                onOpen={() => setViewerId(p.final_image_id)}
                onCancel={() => void act(() => cancelPersonaPhoto(token, p.job_id))}
                onRetry={() => void act(() => retryPersonaPhoto(token, p.job_id))}
                onReface={faceId => void act(() => refacePersonaPhoto(token, p.job_id, faceId))}
                onDelete={() => setDeleteTarget(p.job_id)}
              />
            ))}
          </ul>
        )}
      </section>

      {current && currentId ? (
        <ImageLightbox
          open
          onOpenChange={open => {
            if (!open) setViewerId(null)
          }}
          src={imageFileUrl(currentId, token)}
          alt={photoCaption(current)}
          caption={current.prompt || undefined}
          slides={slides}
          index={viewerIndex}
          onIndexChange={i => setViewerId(viewable[i]?.final_image_id ?? null)}
          promptPanel={
            current.prompt ? (
              <PhotoPromptSheet
                photo={current}
                onEdit={text => {
                  // Back to the form above with this run's prompt; the photo's own
                  // workflow (txt2img / img2img) is kept as the user left it.
                  setPrompt(text)
                  setViewerId(null)
                }}
              />
            ) : undefined
          }
          actions={{
            imageId: currentId,
            filename: current.final_image?.filename ?? `${current.job_id}.jpg`,
            // Not 'output': the lightbox's Delete would orphan the run's final image.
            // Photos are deleted from their card, which also cleans up the child jobs.
            direction: 'persona-photo',
            token,
            onNudeDetect: () => setNudeTarget({ imageId: currentId, filename: current.final_image?.filename ?? `${current.job_id}.jpg` }),
            onSendToImg2Img: () => sendToGenerator(current, 'img2img'),
            onSendToImg2Video: () => sendToGenerator(current, 'img2video'),
            imgUtils: {},
          }}
        />
      ) : null}

      {nudeTarget ? (
        <NudeDetectModal
          open
          onOpenChange={open => {
            if (!open) setNudeTarget(null)
          }}
          token={token}
          imageId={nudeTarget.imageId}
          imageUrl={imageFileUrl(nudeTarget.imageId, token)}
          filename={nudeTarget.filename}
        />
      ) : null}

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title="Delete this photo?"
        description="The photo and its intermediate images are permanently deleted."
        testIdPrefix="persona-photo-delete"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const id = deleteTarget
          setDeleteTarget(null)
          if (id) void act(() => deletePersonaPhoto(token, id))
        }}
      />

      <ImagePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={img => { setInput(img); setPickerOpen(false) }} token={token} />
    </div>
  )
}

function photoCaption(photo: PersonaPhoto): string {
  return photo.prompt || (photo.params.workflow === 'existing' ? 'From an existing photo' : '')
}

/** The lightbox prompt sheet: the prompt sent to the model, the original
 *  (`{p_*}` / placeholders intact) when it differs, and buttons to edit either. */
function PhotoPromptSheet({ photo, onEdit }: { photo: PersonaPhoto; onEdit: (prompt: string) => void }) {
  const original = distinctPromptTemplate(photo.prompt_template, photo.prompt)
  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/85 hover:bg-white/12 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
  return (
    <div className="flex flex-col gap-2 px-2 pt-1">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/95 select-text" data-testid="persona-photo-prompt-text">
        {photo.prompt}
      </p>
      {original ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-white/70 select-text" data-testid="persona-photo-prompt-original">
          <span className="font-medium text-white/80">Original · </span>
          {original}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={btn} onClick={() => onEdit(photo.prompt)} data-testid="persona-photo-edit-prompt">
          <Pencil className="size-3.5" /> Edit prompt
        </button>
        {original ? (
          <button
            type="button"
            className={btn}
            onClick={() => onEdit(original)}
            title="Edit the prompt as written, before placeholders were filled in"
            data-testid="persona-photo-edit-original"
          >
            <Braces className="size-3.5" /> Edit original
          </button>
        ) : null}
      </div>
    </div>
  )
}

function PhotoCard({
  token,
  photo,
  faces,
  onOpen,
  onCancel,
  onRetry,
  onReface,
  onDelete,
}: {
  token: string
  photo: PersonaPhoto
  faces: Persona['faces']
  onOpen: () => void
  onCancel: () => void
  onRetry: () => void
  onReface: (faceImageId: string) => void
  onDelete: () => void
}) {
  const done = PHOTO_TERMINAL.has(photo.status)
  const caption = photoCaption(photo)
  const [facesOpen, setFacesOpen] = useState(false)
  // Needs a base image: a generated one, or the photo the face swap started from.
  const canReface =
    done &&
    faces.length > 0 &&
    photo.steps.some(s => (s.kind !== 'upscale' && !!s.output_image_id) || (s.kind === 'face_swap' && !!s.input_image_id))
  return (
    <li className="flex flex-col gap-2" data-testid={`persona-photo-${photo.job_id}`}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
        {photo.final_image_id ? (
          <button
            type="button"
            onClick={onOpen}
            className="block size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`View full size: ${caption}`}
            data-testid={`persona-photo-open-${photo.job_id}`}
          >
            <img src={imageThumbnailUrl(photo.final_image_id, token)} alt={caption} className="size-full object-cover" />
          </button>
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
      <p className="line-clamp-2 text-xs text-muted-foreground" title={caption}>{caption}</p>
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
            {canReface && (
              <Button
                variant={facesOpen ? 'secondary' : 'ghost'}
                size="icon-sm"
                title="Re-generate with another face"
                aria-label="Re-generate with another face"
                aria-expanded={facesOpen}
                onClick={() => setFacesOpen(o => !o)}
                data-testid={`persona-photo-reface-${photo.job_id}`}
              >
                <UserRound />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" title="Delete" aria-label="Delete" onClick={onDelete} data-testid={`persona-photo-delete-${photo.job_id}`}>
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {canReface && facesOpen && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid={`persona-photo-reface-faces-${photo.job_id}`}>
          {faces.map((f, i) => (
            <button
              key={f.image_id}
              type="button"
              title={i === 0 ? 'Primary face — use this face' : 'Use this face'}
              aria-label={i === 0 ? 'Use primary face' : `Use face ${i + 1}`}
              onClick={() => {
                setFacesOpen(false)
                onReface(f.image_id)
              }}
              className="size-9 overflow-hidden rounded-md ring-2 ring-transparent hover:ring-primary focus-visible:ring-primary"
              data-testid={`persona-photo-reface-face-${f.image_id}`}
            >
              <img src={imageThumbnailUrl(f.image_id, token)} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </li>
  )
}
