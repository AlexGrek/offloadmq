import { useCallback, useEffect, useRef, useState } from 'react'
import { imageThumbnailUrl, uploadImage, type UploadedImage } from '../api/images'
import { MAX_BATCH_INPUT_IMAGES } from '../lib/imggen'
import type { Slot } from './useImageSlot'

/** One image of the set: a local preview while it uploads, then the stored image. */
export type SetEntry = Slot & { key: string }

/**
 * A set of input images (one job per image) — the multi-image sibling of
 * `useImageSlot`. Uploads run in parallel and each entry settles on its own, so one bad
 * file never blocks the rest. Owns its object URLs. Capped at `max`; duplicates of a
 * stored image are ignored.
 */
export function useImageSet(token: string | null, max = MAX_BATCH_INPUT_IMAGES) {
  const [entries, setEntries] = useState<SetEntry[]>([])
  const [note, setNote] = useState<string | null>(null)
  // Source of truth for synchronous callers (add → clear → add in one handler).
  const entriesRef = useRef<SetEntry[]>([])
  const seq = useRef(0)

  const commit = useCallback((next: SetEntry[]) => {
    entriesRef.current = next
    setEntries(next)
  }, [])

  const patch = useCallback(
    (key: string, change: Partial<Slot>) => {
      // An entry removed while its upload was in flight is simply not found.
      commit(entriesRef.current.map(e => (e.key === key ? { ...e, ...change } : e)))
    },
    [commit],
  )

  useEffect(
    () => () => {
      entriesRef.current.forEach(e => {
        if (e.preview.startsWith('blob:')) URL.revokeObjectURL(e.preview)
      })
    },
    [],
  )

  const addFiles = useCallback(
    (files: File[]) => {
      if (!token || files.length === 0) return
      const room = Math.max(0, max - entriesRef.current.length)
      const batch = files.slice(0, room)
      setNote(batch.length < files.length ? `At most ${max} images — ${files.length - batch.length} skipped.` : null)
      const fresh = batch.map(file => ({
        file,
        entry: { key: `f${++seq.current}`, preview: URL.createObjectURL(file), uploaded: null, error: null } as SetEntry,
      }))
      commit([...entriesRef.current, ...fresh.map(f => f.entry)])
      for (const { file, entry } of fresh) {
        uploadImage(token, file).then(
          uploaded => patch(entry.key, { uploaded, error: null }),
          (e: Error) => patch(entry.key, { error: e.message }),
        )
      }
    },
    [token, max, commit, patch],
  )

  /** Adopt already-stored images (library pick, deep link, a previous result). */
  const addStored = useCallback(
    (images: UploadedImage[]) => {
      if (!token) return
      const next = [...entriesRef.current]
      let skipped = 0
      for (const image of images) {
        if (next.some(e => e.uploaded?.image_id === image.image_id)) continue
        if (next.length >= max) {
          skipped++
          continue
        }
        next.push({
          key: `s${++seq.current}`,
          preview: imageThumbnailUrl(image.image_id, token),
          uploaded: image,
          error: null,
        })
      }
      setNote(skipped > 0 ? `At most ${max} images — ${skipped} skipped.` : null)
      commit(next)
    },
    [token, max, commit],
  )

  const remove = useCallback(
    (key: string) => {
      const gone = entriesRef.current.find(e => e.key === key)
      if (gone?.preview.startsWith('blob:')) URL.revokeObjectURL(gone.preview)
      setNote(null)
      commit(entriesRef.current.filter(e => e.key !== key))
    },
    [commit],
  )

  const clear = useCallback(() => {
    entriesRef.current.forEach(e => {
      if (e.preview.startsWith('blob:')) URL.revokeObjectURL(e.preview)
    })
    setNote(null)
    commit([])
  }, [commit])

  const ready = entries.filter(e => e.uploaded && !e.error)
  return {
    entries,
    note,
    /** Entries whose upload finished — what a submit sends. */
    ready,
    uploading: entries.some(e => !e.uploaded && !e.error),
    max,
    addFiles,
    addStored,
    remove,
    clear,
  }
}
