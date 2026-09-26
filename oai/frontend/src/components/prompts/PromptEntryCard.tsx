import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, ImageIcon, Loader2, Pencil, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { promptPreviewUrl, type PromptEntry } from '@/api/prompts'

export type PromptViewMode = 'gallery' | 'mixed' | 'text'

type PromptEntryCardProps = {
  entry: PromptEntry
  mode: PromptViewMode
  token: string | null
  /** Active search text — matches are highlighted. */
  query: string
  busy: boolean
  onPick: (entry: PromptEntry) => void
  onStar: (entry: PromptEntry) => void
  onSave: (entry: PromptEntry, content: string) => Promise<boolean>
  onDelete: (entry: PromptEntry) => void
}

/** Collapsed line clamp per mode; "Show more" lifts it. */
const CLAMP: Record<PromptViewMode, string> = {
  gallery: 'line-clamp-2',
  mixed: 'line-clamp-5',
  text: 'line-clamp-8',
}

/**
 * One saved prompt in the library drawer, rendered for the active view mode:
 * Gallery (large preview tile, short text), Mixed (thumbnail beside a longer
 * excerpt) or Text (mostly text, tiny thumbnail). Clicking the preview or text
 * picks the prompt; star/edit/delete sit outside the pick button so buttons
 * never nest.
 */
export function PromptEntryCard({
  entry,
  mode,
  token,
  query,
  busy,
  onPick,
  onStar,
  onSave,
  onDelete,
}: PromptEntryCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [imageBroken, setImageBroken] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  const overflowing = useClampOverflow(textRef, [entry.content, mode, expanded])

  const previewSrc =
    token && entry.preview_version && !imageBroken
      ? promptPreviewUrl(entry.id, token, entry.preview_version)
      : null
  const testId = `prompt-${entry.kind}-${entry.id}`

  if (editing) {
    return (
      <div className={cn('rounded-lg bg-muted/30 p-2.5', mode === 'gallery' && 'col-span-full')}>
        <textarea
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          rows={6}
          autoFocus
          className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          data-testid={`prompt-edit-input-${entry.id}`}
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !editValue.trim()}
            onClick={async () => {
              if (await onSave(entry, editValue)) setEditing(false)
            }}
            data-testid={`prompt-edit-save-${entry.id}`}
          >
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Check className="mr-1.5 size-3.5" />}
            Save
          </Button>
        </div>
      </div>
    )
  }

  const text = (
    <p
      ref={textRef}
      className={cn(
        'whitespace-pre-wrap break-words text-left leading-relaxed text-foreground/90',
        mode === 'gallery' ? 'text-xs' : 'text-[13px]',
        !expanded && CLAMP[mode],
      )}
    >
      {highlight(entry.content, query)}
    </p>
  )

  const actions = (
    <div className="flex shrink-0 items-center gap-0.5">
      {(overflowing || expanded) && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setExpanded(v => !v)}
          title={expanded ? 'Show less' : 'Show more'}
          aria-label={expanded ? 'Show less' : 'Show more'}
          aria-expanded={expanded}
          data-testid={`prompt-expand-${entry.id}`}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
      )}
      {entry.kind === 'recent' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={() => onStar(entry)}
          title="Add to favorites"
          aria-label="Add to favorites"
          data-testid={`prompt-star-${entry.id}`}
          className="text-muted-foreground hover:text-amber-500"
        >
          <Star className="size-3.5" />
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            onClick={() => {
              setEditValue(entry.content)
              setEditing(true)
            }}
            title="Edit"
            aria-label="Edit"
            data-testid={`prompt-edit-${entry.id}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            onClick={() => onDelete(entry)}
            title="Delete"
            aria-label="Delete"
            data-testid={`prompt-delete-${entry.id}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  )

  const image = (className: string) =>
    previewSrc ? (
      <img
        src={previewSrc}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setImageBroken(true)}
        className={cn('size-full object-cover', className)}
      />
    ) : null

  if (mode === 'gallery') {
    return (
      <div
        className={cn(
          'group relative flex flex-col overflow-hidden rounded-lg bg-muted/30 ring-1 ring-border/60 transition-shadow hover:ring-ring/50',
          expanded && 'col-span-full sm:col-span-2',
        )}
        data-testid={testId}
      >
        <button type="button" onClick={() => onPick(entry)} className="flex flex-col text-left">
          <div className="aspect-square w-full overflow-hidden bg-muted/60">
            {image('transition-transform duration-300 group-hover:scale-[1.03]') ?? (
              // No image yet: the tile shows the prompt itself instead.
              <p className="line-clamp-9 whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-muted-foreground">
                {highlight(entry.content, query)}
              </p>
            )}
          </div>
          {previewSrc && <div className="px-2.5 pt-2 pb-1">{text}</div>}
        </button>
        <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5 pt-0.5">
          <span className="truncate pl-1 text-[11px] text-muted-foreground">{relativeTime(entry)}</span>
          {actions}
        </div>
      </div>
    )
  }

  if (mode === 'mixed') {
    return (
      <div className="group flex flex-col gap-1 rounded-lg px-2 py-2 transition-colors hover:bg-muted/40" data-testid={testId}>
        <button type="button" onClick={() => onPick(entry)} className="flex items-start gap-3 text-left">
          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60 sm:size-24">
            {image('') ?? <ImageIcon className="size-5 text-muted-foreground/40" />}
          </div>
          <div className="min-w-0 flex-1">{text}</div>
        </button>
        <div className="flex items-center justify-between gap-2 pl-23 sm:pl-27">
          <span className="truncate text-[11px] text-muted-foreground">{relativeTime(entry)}</span>
          {actions}
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/40" data-testid={testId}>
      <button type="button" onClick={() => onPick(entry)} className="flex items-start gap-3 text-left">
        <div className="min-w-0 flex-1">{text}</div>
        {previewSrc && (
          <div className="size-10 shrink-0 overflow-hidden rounded bg-muted/60">{image('')}</div>
        )}
      </button>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{relativeTime(entry)}</span>
        {actions}
      </div>
    </div>
  )
}

/** Whether the clamped paragraph hides text (re-measured on resize). */
function useClampOverflow(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): boolean {
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return overflowing
}

/** Wraps case-insensitive occurrences of `query` in <mark>. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-amber-300/40 px-0.5 text-inherit dark:bg-amber-400/30">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/** "used 3d ago" / "saved 2mo ago" — recents by last use, favorites by last edit. */
function relativeTime(entry: PromptEntry): string {
  const iso = entry.kind === 'recent' ? entry.last_used_at : entry.updated_at
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'y'],
    [60 * 60 * 24 * 30, 'mo'],
    [60 * 60 * 24 * 7, 'w'],
    [60 * 60 * 24, 'd'],
    [60 * 60, 'h'],
    [60, 'm'],
  ]
  const verb = entry.kind === 'recent' ? 'used' : 'saved'
  for (const [size, label] of units) {
    if (secs >= size) return `${verb} ${Math.floor(secs / size)}${label} ago`
  }
  return `${verb} just now`
}
