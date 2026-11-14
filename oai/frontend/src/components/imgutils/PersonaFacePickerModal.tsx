import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { imageThumbnailUrl, type UploadedImage } from '../../api/images'
import { listPersonas, type Persona, type PersonaImageRef } from '../../api/personas'

interface PersonaFacePickerModalProps {
  open: boolean
  onClose: () => void
  /** Called with the chosen face (the picker closes itself afterwards). */
  onSelect: (image: UploadedImage) => void
  token: string
}

/** A persona face is already a stored image — adopt it as-is, nothing is re-uploaded. */
function faceToUploadedImage(face: PersonaImageRef): UploadedImage {
  return {
    image_id: face.image_id,
    filename: face.filename,
    content_type: face.content_type,
    width: face.width,
    height: face.height,
    size_bytes: 0,
    rescaled: false,
    reencoded: false,
  }
}

/** "Use from persona": pick one of a persona's face images as a face reference. */
export function PersonaFacePickerModal({ open, onClose, onSelect, token }: PersonaFacePickerModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.18 } }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
          <PickerPanel
            token={token}
            onClose={onClose}
            onSelect={face => {
              onSelect(faceToUploadedImage(face))
              onClose()
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Mounted only while open, so every open starts empty and refetches (new faces show up). */
function PickerPanel({
  token,
  onClose,
  onSelect,
}: {
  token: string
  onClose: () => void
  onSelect: (face: PersonaImageRef) => void
}) {
  const [personas, setPersonas] = useState<Persona[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listPersonas(token)
      .then(list => {
        if (!cancelled) setPersonas(list)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const withFaces = personas?.filter(p => p.faces.length > 0) ?? []

  return (
    <motion.div
      className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 30 } }}
      exit={{ opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.15 } }}
      data-testid="persona-face-picker-modal"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-4">
        <UserRound className="size-4 text-muted-foreground" />
        <h2 className="font-display text-base font-semibold">Use a persona's face</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="persona-face-picker-list">
        {error ? (
          <p className="text-sm text-destructive" data-testid="persona-face-picker-error">{error}</p>
        ) : personas === null ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : withFaces.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="persona-face-picker-empty">
            <p className="text-sm text-muted-foreground">
              {personas.length === 0 ? 'You have no personas yet.' : 'None of your personas has a face image yet.'}
            </p>
            <Button asChild variant="outline" size="sm" onClick={onClose}>
              <Link to="/app/personas">Open Personas</Link>
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-5">
            {withFaces.map(persona => (
              <li key={persona.id} className="flex flex-col gap-2" data-testid={`persona-face-picker-persona-${persona.id}`}>
                <h3 className="text-sm font-medium">{persona.name}</h3>
                <div className="flex flex-wrap gap-2">
                  {persona.faces.map((face, i) => (
                    <button
                      key={face.image_id}
                      type="button"
                      onClick={() => onSelect(face)}
                      title={i === 0 ? `${persona.name} — primary face` : persona.name}
                      aria-label={`Use ${persona.name}${i === 0 ? ' (primary face)' : ` face ${i + 1}`}`}
                      className={cn(
                        'size-20 overflow-hidden rounded-lg bg-muted ring-2 ring-transparent transition',
                        'hover:ring-primary focus-visible:outline-none focus-visible:ring-primary',
                      )}
                      data-testid={`persona-face-pick-${face.image_id}`}
                    >
                      <img src={imageThumbnailUrl(face.image_id, token)} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="persona-face-picker-cancel">
          Cancel
        </Button>
      </div>
    </motion.div>
  )
}
