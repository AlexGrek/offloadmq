import { useRef, useState } from 'react'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { ImagePlus, Library, Loader2, Star, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { imageThumbnailUrl, uploadImage, type UploadedImage } from '../../api/images'
import {
  MODEL_SLOTS,
  PERSONA_TOKENS,
  type EffectiveModels,
  type ModelOptions,
  type PersonaImageRef,
  type PersonaInput,
} from '../../api/personas'
import { ImagePickerModal } from '../imggen/ImagePickerModal'

const textareaClass =
  'w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed ' +
  'outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30'

const SOURCE_LABEL: Record<string, string> = {
  preference: 'preferred',
  most_used: 'most used',
  only: 'only one online',
  first_online: 'first online',
}

type Props = {
  token: string
  /** null = a new persona. */
  personaId: string | null
  value: PersonaInput
  onChange: (next: PersonaInput) => void
  /** Face refs known for the current ids (from the server, plus fresh uploads). */
  faceRefs: Record<string, PersonaImageRef>
  onFaceRefs: (refs: PersonaImageRef[]) => void
  options: ModelOptions | null
  effective?: EffectiveModels
  saving: boolean
  dirty: boolean
  error: string | null
  onSave: () => void
  onDelete?: () => void
}

/** The persona editor: faces, look, system prompt, model preferences. */
export function PersonaProfile({
  token,
  personaId,
  value,
  onChange,
  faceRefs,
  onFaceRefs,
  options,
  effective,
  saving,
  dirty,
  error,
  onSave,
  onDelete,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  useResetOnChange(personaId, () => setUploadError(null))

  const set = <K extends keyof PersonaInput>(key: K, v: PersonaInput[K]) => onChange({ ...value, [key]: v })
  const addFaces = (imgs: UploadedImage[]) => {
    onFaceRefs(imgs.map(i => ({ image_id: i.image_id, filename: i.filename, content_type: i.content_type, width: i.width, height: i.height })))
    const ids = [...value.face_image_ids]
    for (const i of imgs) if (!ids.includes(i.image_id)) ids.push(i.image_id)
    set('face_image_ids', ids)
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    setUploadError(null)
    try {
      const uploaded: UploadedImage[] = []
      for (const f of Array.from(files)) uploaded.push(await uploadImage(token, f))
      addFaces(uploaded)
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      data-testid="persona-profile"
      onSubmit={e => {
        e.preventDefault()
        onSave()
      }}
    >
      <section className="flex flex-col gap-2">
        <Label htmlFor="persona-name">Name</Label>
        <Input
          id="persona-name"
          value={value.name}
          onChange={e => set('name', e.target.value)}
          placeholder="e.g. Mira"
          maxLength={100}
          data-testid="persona-name"
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Face references</Label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="persona-face-upload">
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} Upload
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-testid="persona-face-library">
              <Library /> From library
            </Button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => void onUpload(e.target.files)} />
        </div>
        <p className="text-xs text-muted-foreground">The first face is the primary one used for face swap.</p>
        {value.face_image_ids.length === 0 ? (
          <div className="rounded-lg bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
            No faces yet — photos will skip the face swap step.
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="persona-faces">
            {value.face_image_ids.map((id, i) => (
              <li key={id} className="group relative aspect-square overflow-hidden rounded-lg bg-muted" data-testid={`persona-face-${id}`}>
                <img src={imageThumbnailUrl(id, token)} alt={faceRefs[id]?.filename ?? 'face'} className="size-full object-cover" />
                {i === 0 ? (
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">Primary</span>
                ) : (
                  <button
                    type="button"
                    title="Make primary"
                    aria-label="Make primary"
                    className="absolute left-1 top-1 rounded bg-black/60 p-1 text-white opacity-80 hover:opacity-100"
                    onClick={() => set('face_image_ids', [id, ...value.face_image_ids.filter(x => x !== id)])}
                    data-testid={`persona-face-primary-${id}`}
                  >
                    <Star className="size-3" />
                  </button>
                )}
                <button
                  type="button"
                  title="Remove face"
                  aria-label="Remove face"
                  className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-80 hover:opacity-100"
                  onClick={() => set('face_image_ids', value.face_image_ids.filter(x => x !== id))}
                  data-testid={`persona-face-remove-${id}`}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <Label htmlFor="persona-look">Look</Label>
        <textarea
          id="persona-look"
          className={textareaClass}
          rows={3}
          value={value.look}
          onChange={e => set('look', e.target.value)}
          placeholder="Hair, eyes, body, style… — inserted wherever a prompt says {p_look}"
          data-testid="persona-look"
        />
      </section>

      <section className="flex flex-col gap-2">
        <Label htmlFor="persona-system">System prompt</Label>
        <textarea
          id="persona-system"
          className={textareaClass}
          rows={6}
          value={value.system_prompt}
          onChange={e => set('system_prompt', e.target.value)}
          placeholder="You are {p_name}. You look like {p_look}. …"
          data-testid="persona-system"
        />
        <p className="text-xs text-muted-foreground">
          Tokens: {PERSONA_TOKENS.map(t => <code key={t} className="mx-0.5 rounded bg-muted px-1">{t}</code>)} — work in
          the system prompt and in photo prompts.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Label>Preferred models</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          {MODEL_SLOTS.map(({ slot, field, label }) => {
            const current = (value[field] as string | null) ?? ''
            const list = options?.[slot] ?? []
            const eff = effective?.[slot]
            const autoLabel = eff && !value[field]
              ? `Auto — ${eff.capability} (${SOURCE_LABEL[eff.source] ?? eff.source})`
              : 'Auto (most used, else first online)'
            return (
              <label key={slot} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {label}
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  value={current}
                  onChange={e => set(field, (e.target.value || null) as never)}
                  data-testid={`persona-model-${slot}`}
                >
                  <option value="">{autoLabel}</option>
                  {current && !list.some(o => o.capability === current) && (
                    <option value={current}>{current} (offline)</option>
                  )}
                  {list.map(o => (
                    <option key={`${o.capability}|${o.workflow ?? ''}`} value={o.capability}>
                      {o.capability}
                      {o.workflow ? ` [${o.workflow}]` : ''}
                      {o.online ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}
        </div>
      </section>

      {error && <p className="text-sm text-destructive" data-testid="persona-error">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={saving || !value.name.trim() || (!!personaId && !dirty)} data-testid="persona-save">
          {saving && <Loader2 className="animate-spin" />}
          {personaId ? 'Save changes' : 'Create persona'}
        </Button>
        {onDelete && (
          <Button type="button" variant="destructive" className={cn('min-h-11 w-full sm:ml-auto sm:w-auto')} onClick={onDelete} data-testid="persona-delete">
            <Trash2 /> Delete persona
          </Button>
        )}
      </div>

      <ImagePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onSelectMany={addFaces} token={token} />
    </form>
  )
}
