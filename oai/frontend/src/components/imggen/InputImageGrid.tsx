import { X } from 'lucide-react'
import { LoadingImage } from '@/components/LoadingImage'
import { imageThumbnailUrl } from '../../api/images'
import type { UploadedImage } from '../../api/images'

interface InputImageGridProps {
  images: UploadedImage[]
  token: string | null
  onRemove: (imageId: string) => void
  onClear: () => void
  /** `{prefix}-input-grid`, `{prefix}-input-thumb-{id}`, `{prefix}-input-remove-{id}`, `{prefix}-input-clear`. */
  testIdPrefix: string
  disabled?: boolean
}

/** Thumbnails of a multi-image input set (one job per image), each removable. */
export function InputImageGrid({
  images,
  token,
  onRemove,
  onClear,
  testIdPrefix,
  disabled = false,
}: InputImageGridProps) {
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-input-grid`}>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
        {images.map(img => (
          <div
            key={img.image_id}
            className="relative aspect-square overflow-hidden rounded-lg bg-muted/30"
            title={`${img.filename} (${img.width}×${img.height})`}
            data-testid={`${testIdPrefix}-input-thumb-${img.image_id}`}
          >
            <LoadingImage
              src={imageThumbnailUrl(img.image_id, token)}
              alt={img.filename}
              className="size-full object-cover"
            />
            <button
              type="button"
              className="absolute right-1 top-1 rounded-md bg-background/80 p-1 text-foreground backdrop-blur transition-colors hover:bg-background disabled:opacity-50"
              onClick={() => onRemove(img.image_id)}
              disabled={disabled}
              aria-label={`Remove ${img.filename}`}
              data-testid={`${testIdPrefix}-input-remove-${img.image_id}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        onClick={onClear}
        disabled={disabled}
        data-testid={`${testIdPrefix}-input-clear`}
      >
        Clear all
      </button>
    </div>
  )
}
