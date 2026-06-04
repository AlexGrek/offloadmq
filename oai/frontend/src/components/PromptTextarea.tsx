import { useCallback, useState } from 'react'
import { Check, Clock, List, Loader2, Pencil, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  deletePrompt,
  listPrompts,
  starPrompt,
  updatePrompt,
  type PromptItem,
  type PromptLibrary,
} from '@/api/prompts'

type Tab = 'recent' | 'starred'

type PromptTextareaProps = {
  value: string
  onChange: (value: string) => void
  /** Storage namespace, e.g. `llm-system` or `describe-image-user`. */
  bucket: string
  token: string | null
  placeholder?: string
  rows?: number
  disabled?: boolean
  id?: string
  /** Wrapper classes. */
  className?: string
  /** Extra classes merged onto the textarea. */
  textareaClassName?: string
  'data-testid'?: string
}

const EMPTY_LIBRARY: PromptLibrary = { recent: [], starred: [] }

/**
 * A textarea with a built-in saved-prompts picker. The list icon opens a modal
 * with two tabs — Recent (auto-kept history) and Starred (favorites) — plus an
 * "Add to favorites" action for the current text. Prompts are loaded only when
 * the modal opens. Recents are recorded server-side on submit, so this component
 * never needs to record them itself.
 */
export function PromptTextarea({
  value,
  onChange,
  bucket,
  token,
  placeholder,
  rows = 4,
  disabled,
  id,
  className,
  textareaClassName,
  'data-testid': testId,
}: PromptTextareaProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('recent')
  const [library, setLibrary] = useState<PromptLibrary>(EMPTY_LIBRARY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      setLibrary(await listPrompts(token, bucket))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prompts')
    } finally {
      setLoading(false)
    }
  }, [token, bucket])

  // Load only when the modal opens (and reset transient row state).
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setEditingId(null)
      void refresh()
    }
  }

  function pick(item: PromptItem) {
    onChange(item.content)
    setOpen(false)
  }

  async function addFavorite() {
    if (!token) return
    const content = value.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await starPrompt(token, bucket, content)
      setTab('starred')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save favorite')
    } finally {
      setBusy(false)
    }
  }

  async function starRecent(item: PromptItem) {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      await starPrompt(token, bucket, item.content)
      setTab('starred')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save favorite')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(item: PromptItem) {
    if (!token) return
    const content = editValue.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await updatePrompt(token, item.id, content)
      setEditingId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: PromptItem) {
    if (!token) return
    if (!window.confirm('Delete this saved prompt?')) return
    setBusy(true)
    setError(null)
    try {
      await deletePrompt(token, item.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  const items = tab === 'recent' ? library.recent : library.starred
  const canAddFavorite = !!token && !!value.trim() && !busy

  return (
    <div className={cn('relative', className)}>
      <textarea
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          'w-full resize-y rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm leading-relaxed',
          'outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
          textareaClassName,
        )}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled || !token}
        onClick={() => handleOpenChange(true)}
        title="Saved prompts"
        aria-label="Saved prompts"
        data-testid="prompt-list-open"
        className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
      >
        <List className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[min(85dvh,640px)]" data-testid="prompt-library-modal">
          <DialogHeader className="gap-3">
            <DialogTitle>Saved prompts</DialogTitle>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5">
                <TabButton active={tab === 'recent'} onClick={() => setTab('recent')} testId="prompt-tab-recent">
                  <Clock className="size-3.5" />
                  Recent
                </TabButton>
                <TabButton active={tab === 'starred'} onClick={() => setTab('starred')} testId="prompt-tab-starred">
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
          </DialogHeader>

          <DialogBody className="flex flex-col gap-2">
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            {loading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {tab === 'recent'
                  ? 'No recent prompts yet — they appear here after you use them.'
                  : 'No favorites yet. Use “Add to favorites” to save the current text.'}
              </p>
            ) : (
              items.map(item =>
                editingId === item.id ? (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border bg-card/60 p-2"
                  >
                    <textarea
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      rows={4}
                      autoFocus
                      className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                      data-testid={`prompt-edit-input-${item.id}`}
                    />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || !editValue.trim()}
                        onClick={() => void saveEdit(item)}
                        data-testid={`prompt-edit-save-${item.id}`}
                      >
                        {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Check className="mr-1.5 size-3.5" />}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={item.id}
                    className="group relative overflow-hidden rounded-lg border border-border/80 bg-card/60 transition-colors hover:border-ring/40 hover:bg-muted/40"
                  >
                    <button
                      type="button"
                      onClick={() => pick(item)}
                      className="block w-full px-3 py-2.5 pr-20 text-left"
                      data-testid={`prompt-${tab}-${item.id}`}
                    >
                      <p className="line-clamp-3 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">
                        {item.content}
                      </p>
                    </button>
                    <div className="absolute right-1 top-1 flex gap-0.5">
                      {tab === 'recent' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy}
                          onClick={() => void starRecent(item)}
                          title="Add to favorites"
                          aria-label="Add to favorites"
                          data-testid={`prompt-star-${item.id}`}
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
                              setEditingId(item.id)
                              setEditValue(item.content)
                            }}
                            title="Edit"
                            aria-label="Edit"
                            data-testid={`prompt-edit-${item.id}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={busy}
                            onClick={() => void remove(item)}
                            title="Delete"
                            aria-label="Delete"
                            data-testid={`prompt-delete-${item.id}`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ),
              )
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
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
