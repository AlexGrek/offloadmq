import { useEffect, useRef } from 'react'
import { pastedImageFiles } from '../lib/clipboardImages'

/**
 * Calls `onFiles` with the images pasted anywhere on the page (⌘/Ctrl+V).
 *
 * Text pastes are left alone (see `pastedImageFiles`), so prompt fields keep working.
 * Disabled while a dialog/sheet is open — a paste there is not meant for the form behind it.
 */
export function usePasteImages(onFiles: (files: File[]) => void, enabled = true) {
  // Latest handler without re-subscribing on every render.
  const handlerRef = useRef(onFiles)
  useEffect(() => {
    handlerRef.current = onFiles
  })

  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      const files = pastedImageFiles(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      handlerRef.current(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [enabled])
}
