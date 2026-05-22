import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export type ImageLightboxProps = {
  src: string
  alt: string
  caption?: ReactNode
  triggerClassName?: string
  testId?: string
  children: ReactNode
}

/** Click-to-zoom image viewer (in-app overlay, no new tab). */
export function ImageLightbox({
  src,
  alt,
  caption,
  triggerClassName,
  testId,
  children,
}: ImageLightboxProps) {
  return (
    <Dialog>
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
          'flex w-[min(96vw,1200px)] max-w-none flex-col gap-0 border-0 bg-transparent p-0 shadow-none',
          'max-h-[min(96dvh,100%)]',
        )}
        onOpenAutoFocus={e => e.preventDefault()}
        data-testid={testId ? `${testId}-lightbox` : 'image-lightbox'}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="relative flex min-h-0 w-full items-center justify-center">
          <img
            src={src}
            alt={alt}
            className="max-h-[min(88dvh,900px)] max-w-full object-contain"
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
      </DialogContent>
    </Dialog>
  )
}
