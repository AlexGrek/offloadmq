import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Download, ImagePlus, ShieldAlert, Star, Trash2, X } from 'lucide-react'
import {
  deleteImage,
  getImageStarred,
  setImageStarred,
} from '@/api/images'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type ImageLightboxActions = {
  imageId: string
  filename: string
  /** `output` enables delete; all images can be starred. */
  direction: string
  token: string
  onDeleted?: () => void | Promise<void>
  onStarredChange?: (starred: boolean) => void
  onSendToImg2Img?: () => void
  onNudeDetect?: () => void
}

export type ImageLightboxProps = {
  src: string
  alt: string
  caption?: ReactNode
  triggerClassName?: string
  testId?: string
  children: ReactNode
  actions?: ImageLightboxActions
}

/** Idle delay before the floating chrome fades away. */
const AUTO_HIDE_MS = 2000

const glassButton =
  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium ' +
  'text-white/85 transition-colors hover:bg-white/12 hover:text-white ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/** Full-screen image viewer with an auto-hiding liquid-glass action bar. */
export function ImageLightbox({
  src,
  alt,
  caption,
  triggerClassName,
  testId,
  children,
  actions,
}: ImageLightboxProps) {
  const [open, setOpen] = useState(false)
  const [starred, setStarred] = useState(false)
  const [starLoading, setStarLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const hideTimer = useRef<number | null>(null)

  const canDelete = actions?.direction === 'output'

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    clearHideTimer()
    hideTimer.current = window.setTimeout(() => {
      setChromeVisible(false)
      hideTimer.current = null
    }, AUTO_HIDE_MS)
  }, [clearHideTimer])

  const revealChrome = useCallback(() => {
    setChromeVisible(true)
    scheduleHide()
  }, [scheduleHide])

  // Reveal chrome immediately on open, then let it fade after the idle delay.
  useEffect(() => {
    if (open) {
      revealChrome()
    }
    return () => clearHideTimer()
  }, [open, revealChrome, clearHideTimer])

  const onPointerActivity = useCallback(() => {
    revealChrome()
  }, [revealChrome])

  useEffect(() => {
    if (!open || !actions?.token) return
    let cancelled = false
    setActionError(null)
    setStarLoading(true)
    getImageStarred(actions.token, actions.imageId)
      .then(res => {
        if (!cancelled) setStarred(res.starred)
      })
      .catch((e: Error) => {
        if (!cancelled) setActionError(e.message)
      })
      .finally(() => {
        if (!cancelled) setStarLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, actions?.token, actions?.imageId])

  const onDownload = useCallback(() => {
    const a = document.createElement('a')
    a.href = src
    a.download = actions?.filename ?? alt
    a.rel = 'noopener'
    a.click()
  }, [src, actions?.filename, alt])

  const onToggleStar = useCallback(async () => {
    if (!actions?.token) return
    setActionError(null)
    setStarLoading(true)
    const next = !starred
    try {
      const res = await setImageStarred(actions.token, actions.imageId, next)
      setStarred(res.starred)
      actions.onStarredChange?.(res.starred)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update star')
    } finally {
      setStarLoading(false)
    }
  }, [actions, starred])

  const onDelete = useCallback(async () => {
    if (!actions?.token || !canDelete) return
    if (!window.confirm(`Delete "${actions.filename}"? This cannot be undone.`)) return
    setActionError(null)
    setDeleteLoading(true)
    try {
      await deleteImage(actions.token, actions.imageId)
      setOpen(false)
      await actions.onDeleted?.()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to delete image')
    } finally {
      setDeleteLoading(false)
    }
  }, [actions, canDelete])

  const stop = useCallback((e: { stopPropagation: () => void }) => e.stopPropagation(), [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'cursor-zoom-in border-0 bg-transparent p-0 text-left outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            triggerClassName,
          )}
          data-testid={testId}
          aria-label={`View full size: ${alt}`}
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        showClose={false}
        overlayClassName="bg-black/95 backdrop-blur-none"
        className={cn(
          // Important overrides beat default centered dialog layout (max-h, translate, etc.)
          '!fixed !inset-0 !left-0 !top-0 !z-50 flex !h-dvh !max-h-dvh !w-dvw !max-w-none',
          '!translate-x-0 !translate-y-0',
          'items-center justify-center overflow-hidden rounded-none border-0 bg-black p-0 shadow-none',
          'data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
        )}
        onOpenAutoFocus={e => e.preventDefault()}
        onClick={() => setOpen(false)}
        onPointerMove={onPointerActivity}
        onPointerDown={onPointerActivity}
        onTouchStart={onPointerActivity}
        data-testid={testId ? `${testId}-lightbox` : 'image-lightbox'}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>

        <img
          src={src}
          alt={alt}
          onClick={stop}
          className="max-h-dvh max-w-full select-none object-contain"
          data-testid={testId ? `${testId}-lightbox-image` : 'image-lightbox-image'}
        />

        {/* Top-right close — part of the auto-hiding chrome */}
        <div
          className={cn(
            'absolute right-3 top-3 z-10 transition-opacity duration-300 sm:right-4 sm:top-4',
            chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <DialogClose
            onClick={stop}
            className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/85 shadow-[0_4px_24px_rgba(0,0,0,0.5)] transition-colors hover:bg-black/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {/* Bottom floating chrome: caption, error, action bar */}
        <div
          onClick={stop}
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-1.5',
            'px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12',
            'transition-opacity duration-300',
            chromeVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          {caption ? (
            <p className="pointer-events-auto max-w-2xl px-2 text-center text-[10px] leading-tight text-white/55">
              {caption}
            </p>
          ) : null}
          {actionError ? (
            <p
              className="pointer-events-auto px-2 text-center text-xs text-red-300"
              data-testid={testId ? `${testId}-lightbox-error` : 'image-lightbox-error'}
            >
              {actionError}
            </p>
          ) : null}
          {actions ? (
            <div
              className="pointer-events-auto flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-white/15 bg-black/70 p-1 shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
              data-testid={testId ? `${testId}-lightbox-actions` : 'image-lightbox-actions'}
            >
              {actions.onNudeDetect ? (
                <button
                  type="button"
                  className={glassButton}
                  onClick={() => {
                    actions.onNudeDetect!()
                    setOpen(false)
                  }}
                  data-testid={testId ? `${testId}-nude-detect` : 'image-lightbox-nude-detect'}
                >
                  <ShieldAlert className="size-3" />
                  NSFW Scan
                </button>
              ) : null}
              {actions.onSendToImg2Img ? (
                <button
                  type="button"
                  className={glassButton}
                  onClick={() => {
                    actions.onSendToImg2Img!()
                    setOpen(false)
                  }}
                  data-testid={testId ? `${testId}-send-to-img2img` : 'image-lightbox-send-to-img2img'}
                >
                  <ImagePlus className="size-3" />
                  Use in Img2Img
                </button>
              ) : null}
              <button
                type="button"
                className={glassButton}
                onClick={onDownload}
                data-testid={testId ? `${testId}-download` : 'image-lightbox-download'}
              >
                <Download className="size-3" />
                Download
              </button>
              <button
                type="button"
                className={cn(glassButton, starred && 'text-amber-300 hover:text-amber-200')}
                disabled={starLoading}
                onClick={() => void onToggleStar()}
                data-testid={testId ? `${testId}-star` : 'image-lightbox-star'}
                aria-pressed={starred}
              >
                <Star className={cn('size-3', starred && 'fill-current')} />
                {starred ? 'Starred' : 'Star'}
              </button>
              {canDelete ? (
                <button
                  type="button"
                  className={cn(
                    glassButton,
                    'text-red-300 hover:bg-red-500/15 hover:text-red-200',
                  )}
                  disabled={deleteLoading}
                  onClick={() => void onDelete()}
                  data-testid={testId ? `${testId}-delete` : 'image-lightbox-delete'}
                >
                  <Trash2 className="size-3" />
                  Delete
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
