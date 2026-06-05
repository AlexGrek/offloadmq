import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from './ui/button'
import { useVersionCheck } from '../hooks/useVersionCheck'

/**
 * Transient bottom toast shown when the server reports a newer build than the
 * one currently loaded (see `useVersionCheck`). Offers a hard reload to pick up
 * the new assets. Dismissable for the session; renders nothing in dev or when
 * already up to date.
 */
export function UpdateBanner() {
  const { updateAvailable, reload } = useVersionCheck()
  const [dismissed, setDismissed] = useState(false)

  if (!updateAvailable || dismissed) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-testid="update-banner"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl bg-background/95 p-3 shadow-lg ring-1 ring-border backdrop-blur sm:gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <RefreshCw className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold text-foreground">
            A new version is available
          </p>
          <p className="text-xs text-muted-foreground">
            Reload to get the latest update.
          </p>
        </div>
        <Button
          onClick={reload}
          className="min-h-10 shrink-0"
          data-testid="update-banner-reload"
        >
          Reload
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notification"
          title="Dismiss"
          className="shrink-0"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
