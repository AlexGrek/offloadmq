import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Download, Star, Trash2, X } from 'lucide-react'
import {
  deleteImage,
  getImageStarred,
  setImageStarred,
} from '@/api/images'
import { Button } from '@/components/ui/button'
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

/** Click-to-zoom image viewer with optional download / star / delete actions. */
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

  const canDelete = actions?.direction === 'output'

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
        className={cn(
          'fixed inset-0 left-0 top-0 z-50 flex h-dvh w-full max-w-none translate-x-0 translate-y-0',
          'items-center justify-center border-0 bg-transparent p-4 shadow-none',
        )}
        onOpenAutoFocus={e => e.preventDefault()}
        onClick={() => setOpen(false)}
        data-testid={testId ? `${testId}-lightbox` : 'image-lightbox'}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div
          className="flex max-h-full max-w-full flex-col items-center"
          onClick={e => e.stopPropagation()}
        >
          <div className="relative flex min-h-0 w-full items-center justify-center">
            <img
              src={src}
              alt={alt}
              className="max-h-[min(72dvh,900px)] max-w-full object-contain"
              data-testid={testId ? `${testId}-lightbox-image` : 'image-lightbox-image'}
            />
            <DialogClose
              className="absolute top-0 right-0 rounded-md bg-background/80 p-2 text-foreground opacity-90 backdrop-blur transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close"
            >
              <X className="size-5" />
            </DialogClose>
          </div>
          {caption ? (
            <p className="mt-3 px-2 text-center text-sm text-muted-foreground">{caption}</p>
          ) : null}
          {actionError ? (
            <p
              className="mt-2 px-2 text-center text-xs text-destructive"
              data-testid={testId ? `${testId}-lightbox-error` : 'image-lightbox-error'}
            >
              {actionError}
            </p>
          ) : null}
          {actions ? (
            <div
              className="mt-4 flex flex-wrap items-center justify-center gap-2 rounded-xl bg-background/90 px-3 py-3 backdrop-blur sm:gap-3"
              data-testid={testId ? `${testId}-lightbox-actions` : 'image-lightbox-actions'}
            >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-h-11 gap-1.5"
              onClick={onDownload}
              data-testid={testId ? `${testId}-download` : 'image-lightbox-download'}
            >
              <Download className="size-4" />
              Download
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={cn(
                'min-h-11 gap-1.5',
                starred && 'text-amber-600 dark:text-amber-400',
              )}
              disabled={starLoading}
              onClick={() => void onToggleStar()}
              data-testid={testId ? `${testId}-star` : 'image-lightbox-star'}
              aria-pressed={starred}
            >
              <Star className={cn('size-4', starred && 'fill-current')} />
              {starred ? 'Starred' : 'Star'}
            </Button>
            {canDelete ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-h-11 gap-1.5"
                disabled={deleteLoading}
                onClick={() => void onDelete()}
                data-testid={testId ? `${testId}-delete` : 'image-lightbox-delete'}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
