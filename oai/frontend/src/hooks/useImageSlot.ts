import { useCallback, useEffect, useRef, useState } from 'react'
import { imageFileUrl, uploadImage, type UploadedImage } from '../api/images'

/** One upload slot: local preview while the file uploads, then the stored image. */
export type Slot = {
  preview: string
  uploaded: UploadedImage | null
  error: string | null
}

/** Slot state plus the three ways to fill it. Owns its object URLs, revoking
 *  them on clear and on unmount, so callers never leak a preview. */
export function useImageSlot(token: string | null) {
  const [slot, setSlotState] = useState<Slot | null>(null)
  const previewsRef = useRef<string[]>([])
  // Mirror of `slot` so `clear` can revoke the live preview without doing side
  // effects inside a state updater (updaters must stay pure).
  const slotRef = useRef<Slot | null>(null)
  const setSlot = useCallback((next: Slot | null) => {
    slotRef.current = next
    setSlotState(next)
  }, [])

  useEffect(() => {
    const previews = previewsRef.current
    return () => previews.forEach(URL.revokeObjectURL)
  }, [])

  const pickFile = useCallback(
    async (file: File) => {
      if (!token) return
      const preview = URL.createObjectURL(file)
      previewsRef.current.push(preview)
      setSlot({ preview, uploaded: null, error: null })
      try {
        setSlot({ preview, uploaded: await uploadImage(token, file), error: null })
      } catch (e) {
        setSlot({ preview, uploaded: null, error: (e as Error).message })
      }
    },
    [token, setSlot],
  )

  /** Adopt an already-stored image (library pick, deep link, previous result).
   *  Creates no object URL, so it is safe to call during render. */
  const pickStored = useCallback(
    (image: UploadedImage) => {
      if (!token) return
      setSlot({ preview: imageFileUrl(image.image_id, token), uploaded: image, error: null })
    },
    [token, setSlot],
  )

  const clear = useCallback(() => {
    const prev = slotRef.current
    if (prev?.preview.startsWith('blob:')) {
      URL.revokeObjectURL(prev.preview)
      previewsRef.current = previewsRef.current.filter(p => p !== prev.preview)
    }
    setSlot(null)
  }, [setSlot])

  return { slot, pickFile, pickStored, clear }
}
