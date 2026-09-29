import { useCallback, useState, type ImgHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const DEFAULT_PLACEHOLDER = 'animate-pulse bg-muted motion-reduce:animate-none'
const FADE_IN = 'animate-in fade-in duration-300 motion-reduce:animate-none'

type LoadingImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** Classes applied only until the first frame is decoded (the placeholder look). */
  placeholderClassName?: string
}

/**
 * `<img>` that never pops in. Pass the intrinsic `width`/`height` so the box is
 * reserved at the right aspect ratio before any bytes arrive (preflight's
 * `height: auto` turns the attributes into an aspect ratio); until the first
 * frame decodes it shows a pulsing placeholder, then fades in.
 *
 * Images already in the memory cache (switching back to a job) are `complete`
 * when the element mounts and skip both the placeholder and the fade. Later
 * `src` changes (cache-bust revisions) keep the old frame on screen until the
 * new one decodes — that's the browser's default, so the placeholder is only
 * ever shown for the first load.
 */
export function LoadingImage({
  className,
  placeholderClassName = DEFAULT_PLACEHOLDER,
  onLoad,
  onError,
  ...props
}: LoadingImageProps) {
  const [phase, setPhase] = useState<'pending' | 'cached' | 'loaded'>('pending')

  const detectCached = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth > 0) setPhase(p => (p === 'pending' ? 'cached' : p))
  }, [])

  return (
    <img
      ref={detectCached}
      {...props}
      onLoad={e => {
        setPhase(p => (p === 'pending' ? 'loaded' : p))
        onLoad?.(e)
      }}
      onError={e => {
        // Stop pulsing; there is nothing to fade in.
        setPhase(p => (p === 'pending' ? 'cached' : p))
        onError?.(e)
      }}
      className={cn(
        className,
        phase === 'pending' && placeholderClassName,
        phase === 'loaded' && FADE_IN,
      )}
    />
  )
}
