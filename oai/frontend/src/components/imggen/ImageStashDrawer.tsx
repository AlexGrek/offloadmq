import { memo } from 'react'
import { Archive, Loader2, Play, Trash2, Zap } from 'lucide-react'

import { LoadingImage } from '@/components/LoadingImage'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { imageThumbnailUrl, type ImageStashEntry } from '@/api/images'
import { modelNameFromCapability } from '@/lib/imggen'

const WORKFLOW_LABELS: Record<string, string> = {
  txt2img: 'Text → image',
  img2img: 'Image → image',
  txt2video: 'Text → video',
  img2video: 'Image → video',
}

function stashedAgo(iso: string): string {
  const then = new Date(iso)
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return then.toLocaleDateString()
}

interface ImageStashDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string | null
  entries: ImageStashEntry[]
  loading: boolean
  error: string | null
  /** Entries with a start/delete request in flight. */
  busyIds: ReadonlySet<string>
  startingAll: boolean
  onStart: (id: string) => void
  onDelete: (id: string) => void
  onStartAll: () => void
}

/** Right drawer listing stashed generation requests; each can be started (removed
 *  from the stash and submitted right away) or discarded. */
export function ImageStashDrawer({
  open,
  onOpenChange,
  token,
  entries,
  loading,
  error,
  busyIds,
  startingAll,
  onStart,
  onDelete,
  onStartAll,
}: ImageStashDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="max-w-full sm:max-w-md" data-testid="imggen-stash-drawer">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Archive className="size-4" />
            Stash
            {entries.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground" data-testid="imggen-stash-count">
                {entries.length}
              </span>
            )}
          </SheetTitle>
          <SheetDescription>
            Saved generations that haven't run yet. Starting one removes it from the stash and submits it now;
            placeholders get fresh values at that moment.
          </SheetDescription>
          {entries.length > 1 && (
            <Button
              type="button"
              size="sm"
              className="mt-2 self-start"
              onClick={onStartAll}
              disabled={startingAll || busyIds.size > 0}
              data-testid="imggen-stash-start-all"
            >
              {startingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Start all {entries.length}
            </Button>
          )}
        </SheetHeader>
        <SheetBody className="flex flex-col gap-2 overscroll-contain px-3 py-3 sm:px-4">
          {error && (
            <p className="text-sm text-destructive" data-testid="imggen-stash-error">
              {error}
            </p>
          )}
          {loading && entries.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading stash…
            </p>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="imggen-stash-empty">
              Nothing stashed. Use <span className="font-medium text-foreground">Stash</span> under the Generate
              button to save a request for later.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="imggen-stash-list">
              {entries.map(entry => (
                <StashRow
                  key={entry.id}
                  entry={entry}
                  token={token}
                  busy={busyIds.has(entry.id) || startingAll}
                  onStart={onStart}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

const StashRow = memo(function StashRow({
  entry,
  token,
  busy,
  onStart,
  onDelete,
}: {
  entry: ImageStashEntry
  token: string | null
  busy: boolean
  onStart: (id: string) => void
  onDelete: (id: string) => void
}) {
  const req = entry.request
  const workflow = req.workflow ?? (req.input_image_id ? 'img2img' : 'txt2img')
  const prompt = (req.prompt_template ?? req.prompt ?? '').trim()
  return (
    <li
      className="flex gap-3 rounded-lg bg-muted/40 p-2.5 ring-1 ring-border/60"
      data-testid={`imggen-stash-item-${entry.id}`}
    >
      {req.input_image_id && (
        <LoadingImage
          src={imageThumbnailUrl(req.input_image_id, token)}
          alt="Input image"
          loading="lazy"
          decoding="async"
          className="size-14 shrink-0 rounded-md object-cover"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="line-clamp-3 text-sm break-words" title={prompt}>
          {prompt || <span className="italic text-muted-foreground">No prompt</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{WORKFLOW_LABELS[workflow] ?? workflow}</span>
          <span aria-hidden>·</span>
          <span>{modelNameFromCapability(req.capability)}</span>
          <span aria-hidden>·</span>
          <span>
            {req.width}×{req.height}
          </span>
          {req.high_priority && (
            <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-500">
              <Zap className="size-3" />
              High
            </span>
          )}
          <span aria-hidden>·</span>
          <span title={new Date(entry.created_at).toLocaleString()}>{stashedAgo(entry.created_at)}</span>
        </p>
        <div className="mt-1 flex gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-9"
            onClick={() => onStart(entry.id)}
            disabled={busy}
            data-testid={`imggen-stash-start-${entry.id}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Start now
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-9 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(entry.id)}
            disabled={busy}
            aria-label="Remove from stash"
            title="Remove from stash"
            data-testid={`imggen-stash-delete-${entry.id}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  )
})
