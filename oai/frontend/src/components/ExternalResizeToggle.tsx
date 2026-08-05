import { Server } from 'lucide-react'

import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ExternalResizeToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Stored size of the picked input, used to explain why the box is ticked. */
  sizeBytes?: number | null
  /** Size above which the option is ticked automatically. */
  thresholdBytes: number
  disabled?: boolean
  testId?: string
}

/**
 * "External resize" — hand the input-image downscale to an `image_resize` agent
 * instead of decoding it in the OAI backend.
 *
 * Only worth showing when an agent offering `image_resize` is online; callers
 * gate on that. It matters most for uploads the backend stored at full size,
 * which is why anything over the threshold ticks it by default.
 */
export function ExternalResizeToggle({
  checked,
  onChange,
  sizeBytes,
  thresholdBytes,
  disabled,
  testId = 'external-resize-toggle',
}: ExternalResizeToggleProps) {
  const isLarge = sizeBytes != null && sizeBytes > thresholdBytes

  return (
    <div
      className={cn(
        'space-y-1 rounded-lg border border-border p-3',
        disabled && 'opacity-60',
      )}
      data-testid={testId}
    >
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          className="rounded border-border"
          data-testid={`${testId}-checkbox`}
        />
        <Server className="size-3.5 text-muted-foreground" />
        External resize
      </label>
      <p className="pl-6 text-xs text-muted-foreground">
        {isLarge
          ? `This image is ${formatBytes(sizeBytes)} — larger than ${formatBytes(
              thresholdBytes,
            )}, so it was stored at full size. An agent will shrink it first.`
          : `Shrinks the image on an agent before the job runs, instead of in the server. On by default above ${formatBytes(
              thresholdBytes,
            )}.`}
      </p>
    </div>
  )
}
