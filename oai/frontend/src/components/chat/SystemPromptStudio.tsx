import { useCallback, useEffect, useState } from 'react'
import { Loader2, Sparkles, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  deleteSystemPrompt,
  listSystemPromptLibrary,
  recordSystemPromptUse,
  setSystemPromptStarred,
  type SystemPromptItem,
  type SystemPromptLibrary,
} from '../../api/systemPrompts'

const DEFAULT_PROMPT = 'You are a helpful AI assistant.'

function excerpt(text: string, max = 72): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max).trimEnd()}…`
}

type PromptCardProps = {
  item: SystemPromptItem
  selected: boolean
  onSelect: () => void
  onToggleStar: () => void
  onDelete: () => void
  busy: boolean
}

function PromptCard({ item, selected, onSelect, onToggleStar, onDelete, busy }: PromptCardProps) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border text-left transition-all',
        selected
          ? 'border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/25'
          : 'border-border/80 bg-card/60 hover:border-violet-500/35 hover:bg-muted/40',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={busy}
        className="block w-full px-3 py-2.5 pr-16"
        data-testid={`system-prompt-pick-${item.id}`}
      >
        <p className="line-clamp-3 font-mono text-[11px] leading-relaxed text-foreground/90">
          {excerpt(item.content, 120)}
        </p>
      </button>
      <div className="absolute right-1 top-1 flex gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={e => {
            e.stopPropagation()
            onToggleStar()
          }}
          title={item.starred ? 'Unstar' : 'Save to library'}
          data-testid={`system-prompt-star-${item.id}`}
          className={cn(item.starred && 'text-amber-500 hover:text-amber-600')}
        >
          <Star className={cn('size-3.5', item.starred && 'fill-current')} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={e => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete from library"
          data-testid={`system-prompt-delete-${item.id}`}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

type SystemPromptStudioProps = {
  token: string
  value: string
  onChange: (content: string) => void
  onApply: (content: string) => Promise<void>
  compact?: boolean
}

export function SystemPromptStudio({
  token,
  value,
  onChange,
  onApply,
  compact,
}: SystemPromptStudioProps) {
  const [library, setLibrary] = useState<SystemPromptLibrary>({ recent: [], starred: [] })
  const [loadingLib, setLoadingLib] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshLibrary = useCallback(async () => {
    if (!token) return
    setLoadingLib(true)
    try {
      const lib = await listSystemPromptLibrary(token)
      setLibrary(lib)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prompts')
    } finally {
      setLoadingLib(false)
    }
  }, [token])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  async function handleApply() {
    const text = value.trim() || DEFAULT_PROMPT
    setSaving(true)
    setError(null)
    try {
      await recordSystemPromptUse(token, text)
      await onApply(text)
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function pickItem(item: SystemPromptItem) {
    onChange(item.content)
    setSaving(true)
    setError(null)
    try {
      await recordSystemPromptUse(token, item.content)
      await onApply(item.content)
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply')
    } finally {
      setSaving(false)
    }
  }

  async function toggleStar(item: SystemPromptItem) {
    try {
      await setSystemPromptStarred(token, item.id, !item.starred)
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update star')
    }
  }

  async function removeItem(item: SystemPromptItem) {
    if (!window.confirm('Delete this saved system prompt?')) return
    try {
      await deleteSystemPrompt(token, item.id)
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete')
    }
  }

  const starredIds = new Set(library.starred.map(s => s.id))
  const recentOnly = library.recent.filter(r => !starredIds.has(r.id))

  return (
    <div
      className={cn(
        'flex flex-col gap-4',
        !compact && 'mx-auto w-full max-w-lg rounded-2xl border border-border/80 bg-gradient-to-b from-violet-500/8 via-background to-background p-5 shadow-sm',
      )}
      data-testid="system-prompt-studio"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold tracking-tight">System prompt</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sets behavior for this chat. Recent picks are kept automatically; star favorites to save them.
          </p>
        </div>
      </div>

      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={DEFAULT_PROMPT}
        rows={compact ? 4 : 6}
        data-testid="system-prompt-editor"
        className={cn(
          'w-full resize-y rounded-xl border border-input bg-background/80 px-3 py-2.5 font-mono text-sm leading-relaxed',
          'outline-none transition-[border-color,box-shadow] focus-visible:border-violet-500/50 focus-visible:ring-3 focus-visible:ring-violet-500/20',
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleApply()}
          disabled={saving}
          data-testid="system-prompt-apply"
        >
          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Apply to chat
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange(DEFAULT_PROMPT)}
          disabled={saving}
        >
          Reset default
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive" data-testid="system-prompt-error">
          {error}
        </p>
      )}

      {loadingLib ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {recentOnly.length > 0 && (
            <section data-testid="system-prompt-recent">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </p>
              <div className="grid gap-2 sm:grid-cols-1">
                {recentOnly.map(item => (
                  <PromptCard
                    key={item.id}
                    item={item}
                    selected={value.trim() === item.content.trim()}
                    onSelect={() => void pickItem(item)}
                    onToggleStar={() => void toggleStar(item)}
                    onDelete={() => void removeItem(item)}
                    busy={saving}
                  />
                ))}
              </div>
            </section>
          )}

          {library.starred.length > 0 && (
            <section data-testid="system-prompt-starred">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Saved
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {library.starred.map(item => (
                  <PromptCard
                    key={item.id}
                    item={{ ...item, starred: true }}
                    selected={value.trim() === item.content.trim()}
                    onSelect={() => void pickItem(item)}
                    onToggleStar={() => void toggleStar(item)}
                    onDelete={() => void removeItem(item)}
                    busy={saving}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export { DEFAULT_PROMPT }
