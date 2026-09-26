import { useCallback, useEffect, useRef, useState } from 'react'
import { AlignLeft, Clock, LayoutGrid, Loader2, Rows3, Search, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/useIsMobile'
import { usePromptLibrary } from '@/hooks/usePromptLibrary'
import { deletePrompt, starPrompt, updatePrompt, type PromptEntry, type PromptKind } from '@/api/prompts'
import { PromptEntryCard, type PromptViewMode } from './PromptEntryCard'

const VIEW_MODES: { mode: PromptViewMode; label: string; icon: typeof LayoutGrid }[] = [
  { mode: 'gallery', label: 'Gallery — large previews', icon: LayoutGrid },
  { mode: 'mixed', label: 'Mixed — preview and text', icon: Rows3 },
  { mode: 'text', label: 'Text — mostly text', icon: AlignLeft },
]

const viewModeKey = (bucket: string) => `oai_prompt_view_${bucket}`

function readViewMode(bucket: string): PromptViewMode {
  const stored = localStorage.getItem(viewModeKey(bucket))
  return stored === 'gallery' || stored === 'mixed' || stored === 'text' ? stored : 'mixed'
}

type SavedPromptsDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Storage namespace, e.g. `llm-system` or `imggen-prompt`. */
  bucket: string
  token: string | null
  /** Current textarea content — used for the "Add to favorites" action. */
  value: string
  /** Called with the picked prompt's content; the drawer closes itself. */
  onPick: (content: string) => void
  /** The bucket's prompts can carry image previews — enables the view modes. */
  previews?: boolean
  /** Tab to show each time the drawer opens; omit to keep the last-used tab. */
  initialKind?: PromptKind
}

/**
 * Right-side drawer opened by PromptTextarea's list-icon trigger: Recent
 * (auto-kept history) and Starred (favorites) tabs over the saved-prompts
 * library, with server-side search, infinite scroll, inline star/edit/delete
 * and an "Add to favorites" action for the caller's current text. Buckets with
 * image previews add Gallery / Mixed / Text view modes. Recents are recorded
 * server-side on submit, so this component never records them itself.
 */
export function SavedPromptsDrawer({
  open,
  onOpenChange,
  bucket,
  token,
  value,
  onPick,
  previews = false,
  initialKind,
}: SavedPromptsDrawerProps) {
  const isMobile = useIsMobile()
  const [kind, setKind] = useState<PromptKind>(initialKind ?? 'recent')
  // Jump to `initialKind` on every open (state adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && initialKind) setKind(initialKind)
  }
  const [query, setQuery] = useState('')
  const [storedMode, setStoredMode] = useState<PromptViewMode>(() => readViewMode(bucket))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const mode: PromptViewMode = previews ? storedMode : 'text'
  const library = usePromptLibrary({ token, bucket, kind, query, enabled: open })
  const { loadMore } = library

  function changeMode(next: PromptViewMode) {
    setStoredMode(next)
    localStorage.setItem(viewModeKey(bucket), next)
  }

  // Infinite scroll: fetch the next page as the sentinel nears the viewport.
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!open || !root || !sentinel) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadMore()
      },
      { root, rootMargin: '400px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [open, loadMore, library.items.length])

  const run = useCallback(async (action: () => Promise<void>, fallback: string): Promise<boolean> => {
    if (!token) return false
    setBusy(true)
    setActionError(null)
    try {
      await action()
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : fallback)
      return false
    } finally {
      setBusy(false)
    }
  }, [token])

  function showStarred() {
    if (kind === 'starred') library.reload()
    else setKind('starred')
  }

  function pick(entry: PromptEntry) {
    onPick(entry.content)
    onOpenChange(false)
  }

  async function addFavorite() {
    const content = value.trim()
    if (!token || !content) return
    if (await run(() => starPrompt(token, bucket, content).then(() => {}), 'Failed to save favorite')) {
      showStarred()
    }
  }

  async function star(entry: PromptEntry) {
    if (!token) return
    if (await run(() => starPrompt(token, bucket, entry.content).then(() => {}), 'Failed to save favorite')) {
      showStarred()
    }
  }

  function save(entry: PromptEntry, content: string): Promise<boolean> {
    const trimmed = content.trim()
    if (!token || !trimmed) return Promise.resolve(false)
    return run(async () => {
      library.patchItem(await updatePrompt(token, entry.id, trimmed))
    }, 'Failed to save')
  }

  async function remove(entry: PromptEntry) {
    if (!token || !window.confirm('Delete this saved prompt?')) return
    await run(async () => {
      await deletePrompt(token, entry.id)
      library.removeItem(entry.id)
    }, 'Failed to delete')
  }

  const error = actionError ?? library.error
  const searching = library.activeQuery.trim() !== ''
  const canAddFavorite = !!token && !!value.trim() && !busy

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="max-w-full sm:max-w-xl lg:max-w-2xl"
        data-testid="prompt-library-drawer"
        onOpenAutoFocus={e => {
          // Desktop: jump straight into search. Mobile: don't pop the keyboard.
          e.preventDefault()
          if (!isMobile) searchRef.current?.focus()
        }}
      >
        <SheetHeader className="gap-3">
          <SheetTitle>Saved prompts</SheetTitle>
          <SheetDescription className="sr-only">
            Browse, search and pick a saved prompt.
          </SheetDescription>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5">
              <TabButton active={kind === 'recent'} onClick={() => setKind('recent')} testId="prompt-tab-recent">
                <Clock className="size-3.5" />
                Recent
              </TabButton>
              <TabButton active={kind === 'starred'} onClick={() => setKind('starred')} testId="prompt-tab-starred">
                <Star className="size-3.5" />
                Starred
              </TabButton>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canAddFavorite}
              onClick={() => void addFavorite()}
              data-testid="prompt-add-favorite"
            >
              <Star className="mr-1.5 size-3.5" />
              Add to favorites
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={kind === 'recent' ? 'Search recent prompts…' : 'Search favorites…'}
                aria-label="Search saved prompts"
                className="h-9 pr-8 pl-8"
                data-testid="prompt-search"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  data-testid="prompt-search-clear"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {previews && (
              <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted/50 p-0.5" role="group" aria-label="View mode">
                {VIEW_MODES.map(({ mode: m, label, icon: Icon }) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => changeMode(m)}
                    title={label}
                    aria-label={label}
                    aria-pressed={mode === m}
                    data-testid={`prompt-view-${m}`}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-md transition-colors',
                      mode === m
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </SheetHeader>

        <SheetBody ref={scrollRef} className="flex flex-col gap-3 overscroll-contain px-3 sm:px-4">
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {library.loading && library.items.length === 0 ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : library.items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground" data-testid="prompt-library-empty">
              {searching
                ? 'No prompts match your search.'
                : kind === 'recent'
                  ? 'No recent prompts yet — they appear here after you use them.'
                  : 'No favorites yet. Use “Add to favorites” to save the current text.'}
            </p>
          ) : (
            <div
              className={cn(
                mode === 'gallery'
                  ? 'grid grid-cols-2 gap-3 lg:grid-cols-3'
                  : 'flex flex-col divide-y divide-border/60',
                library.loading && 'opacity-60 transition-opacity',
              )}
              data-testid={`prompt-list-${mode}`}
            >
              {library.items.map(entry => (
                <PromptEntryCard
                  key={entry.id}
                  entry={entry}
                  mode={mode}
                  token={token}
                  query={library.activeQuery}
                  busy={busy}
                  onPick={pick}
                  onStar={e => void star(e)}
                  onSave={save}
                  onDelete={e => void remove(e)}
                />
              ))}
            </div>
          )}

          <div ref={sentinelRef} className="h-px shrink-0" data-testid="prompt-load-more-sentinel" />
          {library.loadingMore && (
            <div className="flex justify-center py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {library.done && library.items.length > 20 && (
            <p className="py-2 text-center text-[11px] text-muted-foreground">End of list</p>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function TabButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean
  onClick: () => void
  testId: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
