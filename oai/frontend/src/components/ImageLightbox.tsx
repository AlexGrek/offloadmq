import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  MessageSquareText,
  Pencil,
  ShieldAlert,
  Star,
  Trash2,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import {
  deleteImage,
  getImageStarred,
  setImageStarred,
} from '@/api/images'
import type { JobImageRef } from '@/api/imgUtils'
import { ImgUtilsQuickModal } from '@/components/imgutils/ImgUtilsQuickModal'
import {
  markImageDownloaded,
  triggerImageDownload,
  useDownloadedImages,
} from '@/lib/downloadedImages'
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
  onSendToImg2Video?: () => void
  /** Enables the in-place Image Tools popup (upscale, face swap, depth, resize).
   *  `onResult` fires with whatever the transform produced. */
  imgUtils?: { onResult?: (image: JobImageRef) => void | Promise<void> }
  onNudeDetect?: () => void
}

/** One page of the horizontal swipe track (gallery mode). */
export type LightboxSlide = { id: string; src: string; alt: string }

export type ImageLightboxProps = {
  src: string
  alt: string
  caption?: ReactNode
  triggerClassName?: string
  testId?: string
  /** Omit when using controlled mode (`open`/`onOpenChange`) — no trigger is rendered then. */
  children?: ReactNode
  actions?: ImageLightboxActions
  /** Controlled mode: drive the dialog externally (e.g. slideshow auto-advance). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Gallery mode: a horizontally scrollable (swipe / arrow keys) track of images.
   *  `src`, `alt` and `actions` must still describe `slides[index]`; the parent
   *  owns `index` and updates it from `onIndexChange`. */
  slides?: LightboxSlide[]
  index?: number
  onIndexChange?: (index: number) => void
  /** Content of the prompt sheet that slides up over the dimmed bottom of the
   *  image. Providing it adds a Prompt button (and the `p` key) to toggle it. */
  promptPanel?: ReactNode
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
  open: controlledOpen,
  onOpenChange,
  slides,
  index = 0,
  onIndexChange,
  promptPanel,
}: ImageLightboxProps) {
  const navigate = useNavigate()
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = useState(false)
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) onOpenChange?.(next)
      else setInternalOpen(next)
    },
    [isControlled, onOpenChange],
  )
  const [starred, setStarred] = useState(false)
  const [starLoading, setStarLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [imgUtilsOpen, setImgUtilsOpen] = useState(false)
  // Stays open while swiping, so prompts can be read image after image.
  const [promptOpen, setPromptOpen] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const settleTimer = useRef<number | null>(null)
  const indexRef = useRef(index)
  const slideCount = slides?.length ?? 0
  const showPrompt = promptOpen && promptPanel != null

  const canDelete = actions?.direction === 'output'
  const downloadedImages = useDownloadedImages()
  const downloaded = actions ? downloadedImages.has(actions.imageId) : false

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
  // Also re-fires when the displayed image changes without a close/reopen
  // (controlled mode, e.g. slideshow auto-advance), so the action bar resurfaces
  // for each new image.
  useResetOnChange(open ? (actions?.imageId ?? '') : null, shown => {
    if (shown !== null) setChromeVisible(true)
  })
  useEffect(() => {
    if (open) scheduleHide()
    return () => clearHideTimer()
  }, [open, actions?.imageId, scheduleHide, clearHideTimer])

  const onPointerActivity = useCallback(() => {
    revealChrome()
  }, [revealChrome])

  useResetOnChange(open && actions?.token ? actions.imageId : null, imageId => {
    if (imageId === null) return
    setActionError(null)
    setStarLoading(true)
  })
  useEffect(() => {
    if (!open || !actions?.token) return
    let cancelled = false
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
    triggerImageDownload(src, actions?.filename ?? alt)
    if (actions?.imageId) markImageDownloaded(actions.imageId)
  }, [src, actions, alt])

  const onDescribe = useCallback(() => {
    if (!actions) return
    setOpen(false)
    navigate('/app/describe', {
      state: {
        describeImage: {
          image_id: actions.imageId,
          filename: actions.filename,
          // Images served by this lightbox are normalized to JPEG by OAI.
          content_type: 'image/jpeg',
          width: 0,
          height: 0,
          size_bytes: 0,
          rescaled: false,
          reencoded: false,
        },
      },
    })
  }, [actions, navigate, setOpen])

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
  }, [actions, canDelete, setOpen])

  // --- gallery track: keep scroll position and `index` in sync ---------------
  useEffect(() => {
    indexRef.current = index
  }, [index])

  // Callback ref: the dialog content mounts after `open` flips, so position the
  // track the moment it exists (instant — no scroll animation on open).
  const setTrack = useCallback((el: HTMLDivElement | null) => {
    trackRef.current = el
    if (el) el.scrollLeft = indexRef.current * el.clientWidth
  }, [])

  // Programmatic moves (arrow keys, buttons, parent changes) scroll smoothly.
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el || !open) return
    const target = index * el.clientWidth
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollTo({ left: target, behavior: 'smooth' })
  }, [index, open])

  // A swipe reports its destination only once the scroll has settled.
  const onTrackScroll = useCallback(() => {
    if (!onIndexChange) return
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      const el = trackRef.current
      if (!el || el.clientWidth === 0) return
      const next = Math.round(el.scrollLeft / el.clientWidth)
      if (next !== indexRef.current && next >= 0 && next < slideCount) onIndexChange(next)
    }, 90)
  }, [onIndexChange, slideCount])

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    },
    [],
  )

  const goTo = useCallback(
    (next: number) => {
      if (next >= 0 && next < slideCount) onIndexChange?.(next)
    },
    [onIndexChange, slideCount],
  )

  useEffect(() => {
    if (!open || slideCount === 0) return
    const onResize = () => {
      const el = trackRef.current
      if (el) el.scrollLeft = indexRef.current * el.clientWidth
    }
    const onKey = (e: KeyboardEvent) => {
      if (imgUtilsOpen || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') goTo(indexRef.current - 1)
      else if (e.key === 'ArrowRight') goTo(indexRef.current + 1)
      else if ((e.key === 'p' || e.key === 'i') && promptPanel != null) setPromptOpen(v => !v)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, slideCount, goTo, imgUtilsOpen, promptPanel])

  const stop = useCallback((e: { stopPropagation: () => void }) => e.stopPropagation(), [])

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      {children ? (
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
      ) : null}
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

        {slides && slides.length > 0 ? (
          <div
            ref={setTrack}
            onScroll={onTrackScroll}
            className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="image-lightbox-track"
          >
            {slides.map((slide, i) => (
              <div
                key={slide.id}
                className="flex h-full min-w-full snap-center snap-always items-center justify-center"
                data-testid={`image-lightbox-slide-${slide.id}`}
              >
                {/* Only the neighbours of the current slide hold a decoded image. */}
                {Math.abs(i - index) <= 1 ? (
                  <img
                    src={slide.src}
                    alt={slide.alt}
                    draggable={false}
                    onClick={e => {
                      e.stopPropagation()
                      if (promptOpen) setPromptOpen(false)
                    }}
                    className="max-h-dvh max-w-full select-none object-contain"
                    data-testid={i === index ? 'image-lightbox-image' : undefined}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            onClick={stop}
            className="max-h-dvh max-w-full select-none object-contain"
            data-testid={testId ? `${testId}-lightbox-image` : 'image-lightbox-image'}
          />
        )}

        {/* Dims the lower part of the image while the prompt sheet is up */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-3/4',
            'bg-gradient-to-t from-black/95 via-black/70 to-transparent',
            'transition-opacity duration-300',
            showPrompt ? 'opacity-100' : 'opacity-0',
          )}
        />

        {slides && slides.length > 1 ? (
          <>
            <div
              className={cn(
                'pointer-events-none absolute left-3 top-3 z-10 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-xs tabular-nums text-white/85 transition-opacity duration-300 sm:left-4 sm:top-4',
                chromeVisible ? 'opacity-100' : 'opacity-0',
              )}
              data-testid="image-lightbox-counter"
            >
              {index + 1} / {slides.length}
            </div>
            {(['prev', 'next'] as const).map(dir => {
              const target = dir === 'prev' ? index - 1 : index + 1
              if (target < 0 || target >= slides.length) return null
              const Icon = dir === 'prev' ? ChevronLeft : ChevronRight
              return (
                <button
                  key={dir}
                  type="button"
                  aria-label={dir === 'prev' ? 'Previous image' : 'Next image'}
                  onClick={e => {
                    e.stopPropagation()
                    goTo(target)
                  }}
                  className={cn(
                    'absolute top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full sm:flex',
                    'border border-white/15 bg-black/50 text-white/85 transition-[opacity,background-color] duration-300 hover:bg-black/75 hover:text-white',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                    dir === 'prev' ? 'left-4' : 'right-4',
                    chromeVisible ? 'opacity-100' : 'opacity-0 hover:opacity-100',
                  )}
                  data-testid={`image-lightbox-${dir}`}
                >
                  <Icon className="size-5" />
                </button>
              )
            })}
          </>
        ) : null}

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
          )}
        >
          {caption ? (
            <p
              className={cn(
                'pointer-events-auto max-w-2xl px-2 text-center text-[10px] leading-tight text-white/55 transition-opacity duration-300',
                chromeVisible ? 'opacity-100' : 'opacity-0',
              )}
            >
              {caption}
            </p>
          ) : null}
          {promptPanel != null ? (
            // Height animates 0 → content via grid rows; not part of the idle fade.
            <div
              className={cn(
                'grid w-full max-w-2xl transition-[grid-template-rows,opacity] duration-300 ease-out',
                showPrompt ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0',
              )}
              aria-hidden={!showPrompt}
              data-testid="image-lightbox-prompt"
            >
              <div className="min-h-0 overflow-hidden">
                <div className="pointer-events-auto max-h-[42dvh] overflow-y-auto overscroll-contain px-1 pb-1 text-white">
                  {promptPanel}
                </div>
              </div>
            </div>
          ) : null}
          {actionError ? (
            <p
              className={cn(
                'pointer-events-auto px-2 text-center text-xs text-red-300 transition-opacity duration-300',
                chromeVisible ? 'opacity-100' : 'opacity-0',
              )}
              data-testid={testId ? `${testId}-lightbox-error` : 'image-lightbox-error'}
            >
              {actionError}
            </p>
          ) : null}
          {actions ? (
            <div
              className={cn(
                'pointer-events-auto flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-white/15 bg-black/70 p-1 shadow-[0_8px_40px_rgba(0,0,0,0.6)] transition-opacity duration-300',
                // The prompt sheet keeps the toolbar on screen while it is open.
                chromeVisible || showPrompt ? 'opacity-100' : 'opacity-0',
              )}
              data-testid={testId ? `${testId}-lightbox-actions` : 'image-lightbox-actions'}
            >
              {promptPanel != null ? (
                <button
                  type="button"
                  className={cn(glassButton, showPrompt && 'bg-white/15 text-white')}
                  onClick={() => setPromptOpen(v => !v)}
                  aria-pressed={showPrompt}
                  data-testid="image-lightbox-prompt-toggle"
                >
                  <MessageSquareText className="size-3" />
                  Prompt
                </button>
              ) : null}
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
              <button
                type="button"
                className={glassButton}
                onClick={onDescribe}
                data-testid={testId ? `${testId}-describe` : 'image-lightbox-describe'}
              >
                <Eye className="size-3" />
                Describe
              </button>
              {actions.onSendToImg2Img ? (
                <button
                  type="button"
                  className={glassButton}
                  onClick={() => {
                    actions.onSendToImg2Img!()
                    setOpen(false)
                  }}
                  data-testid={testId ? `${testId}-edit` : 'image-lightbox-edit'}
                >
                  <Pencil className="size-3" />
                  Edit
                </button>
              ) : null}
              {actions.onSendToImg2Video ? (
                <button
                  type="button"
                  className={glassButton}
                  onClick={() => {
                    actions.onSendToImg2Video!()
                    setOpen(false)
                  }}
                  data-testid={testId ? `${testId}-animate` : 'image-lightbox-animate'}
                >
                  <Video className="size-3" />
                  Animate
                </button>
              ) : null}
              {actions.imgUtils ? (
                <button
                  type="button"
                  className={glassButton}
                  // Deliberately leaves the lightbox open — the popup stacks on
                  // top of it, so closing it returns to the same image.
                  onClick={() => setImgUtilsOpen(true)}
                  data-testid={testId ? `${testId}-imgutils` : 'image-lightbox-imgutils'}
                >
                  <Wand2 className="size-3" />
                  Image Tools
                </button>
              ) : null}
              <button
                type="button"
                className={cn(glassButton, downloaded && 'text-emerald-300 hover:text-emerald-200')}
                onClick={onDownload}
                data-testid={testId ? `${testId}-download` : 'image-lightbox-download'}
              >
                <Download className="size-3" />
                {downloaded ? 'Downloaded' : 'Download'}
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

    {/* Sibling of the lightbox dialog on purpose: rendered inside it, clicks in
        the popup would bubble through React's tree to the backdrop handler that
        closes the lightbox. */}
    {actions?.imgUtils && actions.token ? (
      <ImgUtilsQuickModal
        open={imgUtilsOpen}
        onOpenChange={setImgUtilsOpen}
        token={actions.token}
        image={{ image_id: actions.imageId, filename: actions.filename }}
        onResult={actions.imgUtils.onResult}
      />
    ) : null}
    </>
  )
}
