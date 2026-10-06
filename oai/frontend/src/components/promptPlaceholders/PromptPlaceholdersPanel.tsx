import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ChevronDown, Copy, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MorphCollapse } from '@/components/Morph'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { fetchRandomNames, type GeneratedName } from '@/api/names'
import {
  createPromptPlaceholder,
  deletePromptPlaceholder,
  listPromptPlaceholders,
  updatePromptPlaceholder,
  type PromptPlaceholder,
} from '@/api/promptPlaceholders'
import {
  createPlaceholderUsage,
  expandPromptPlaceholders,
  isReservedPlaceholderName,
  isValidPlaceholderName,
  PLACEHOLDER_CATEGORIES,
} from '@/lib/promptPlaceholders'

const QUICK_NAMES_BATCH = 6

type PromptPlaceholdersPanelProps = {
  /** Present only when rendered inside the TopBar drawer; omitted on the standalone page. */
  onClose?: () => void
  className?: string
}

/**
 * Everything needed to use and manage prompt placeholders for image/video
 * generation — quick `{?}` names, built-in `{category}` dictionaries (read-only
 * reference), and the user's own custom recursive `{name}` templates. Rendered
 * both inside the TopBar "Names" drawer and on the standalone
 * `/app/prompt-placeholders` page.
 */
export function PromptPlaceholdersPanel({ onClose, className }: PromptPlaceholdersPanelProps) {
  const { token } = useAuth()

  return (
    <div
      // No overflow/overscroll classes here: this panel is used both as the
      // sole scroll region inside a height-bounded drawer (RandomNamesWidget,
      // which opts in via `className`) and as plain in-flow content on the
      // standalone page (scrolled by the ambient <main>). Hardcoding
      // `overflow-auto overscroll-contain` here used to break both — a
      // non-overflowing `overflow:auto` box with `overscroll-behavior:
      // contain` swallows wheel/touch input instead of chaining it to a
      // scrollable ancestor, and on the standalone page this element never
      // has a bounded height, so it never had real overflow to begin with.
      className={cn('flex min-h-0 min-w-0 max-w-full flex-col gap-5 text-sm [overflow-wrap:anywhere]', className)}
      data-testid="prompt-placeholders-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pr-2">
          <p className="font-medium text-foreground">Prompt placeholders</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Use these in any image/video prompt. Quick names fill <span className="font-mono">{'{?}'}</span>,
            built-in categories like <span className="font-mono">{'{color}'}</span> and your own templates
            below all resolve right here in your browser — every job in a "Generate multiple" batch gets a
            different value.
          </p>
          {onClose ? (
            <Link
              to="/app/prompt-placeholders"
              onClick={onClose}
              className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="prompt-placeholders-open-page"
            >
              Open as full page
            </Link>
          ) : null}
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
            data-testid="prompt-placeholders-close"
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <QuickNamesSection token={token} />
      <CustomPlaceholdersSection token={token} />
      <ReservedNamesSection />
    </div>
  )
}

function CopyTagButton({ text, testId }: { text: string; testId: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    if (status === 'idle') return
    const timeout = window.setTimeout(() => setStatus('idle'), 1500)
    return () => window.clearTimeout(timeout)
  }, [status])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  const label = status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed — try again' : `Copy ${text}`
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn('rounded-full text-muted-foreground', status === 'copied' && 'text-emerald-600 dark:text-emerald-400', status === 'error' && 'text-destructive')}
    >
      {status === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      <span className="sr-only" aria-live="polite">{status === 'idle' ? '' : label}</span>
    </Button>
  )
}

function QuickNamesSection({ token }: { token: string | null }) {
  // Collapsed by default: generating names is a side effect (and a network
  // call) that shouldn't fire just because the panel was opened.
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [names, setNames] = useState<GeneratedName[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadNames = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchRandomNames(token, QUICK_NAMES_BATCH)
      setNames(res.names)
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate names')
    } finally {
      setLoading(false)
    }
  }, [token])

  // First expand triggers the initial fetch; a failed attempt retries next
  // time it's expanded rather than looping (`loaded` only flips on success).
  useEffect(() => {
    if (!expanded || loaded) return
    void loadNames()
  }, [expanded, loaded, loadNames])

  return (
    <section data-testid="random-names-section">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex select-none items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          data-testid="random-names-section-toggle"
        >
          <ChevronDown className={cn('size-3 transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
          Quick names for <span className="normal-case">{'{?}'}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setExpanded(true)
            void loadNames()
          }}
          disabled={loading || !token}
          title="Generate more"
          aria-label="Generate more names"
          data-testid="random-names-refresh"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>
      <MorphCollapse show={expanded}>
        <div className="pt-2">
          {error ? (
            <p className="text-xs text-destructive" data-testid="random-names-error">
              {error}
            </p>
          ) : (
            <ul className="flex min-w-0 flex-wrap gap-2" data-testid="random-names-list">
              {names.map(name => (
                <li
                  key={name.slug}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted/60 py-1 pr-1 pl-3"
                  data-testid={`random-names-item-${name.slug}`}
                >
                  <span className="min-w-0 text-xs text-foreground" title={name.slug}>{name.phrase}</span>
                  <CopyTagButton text={name.phrase} testId={`random-names-copy-${name.slug}`} />
                </li>
              ))}
              {!loading && names.length === 0 ? (
                <li className="px-2 py-1 text-xs text-muted-foreground">No names yet.</li>
              ) : null}
            </ul>
          )}
        </div>
      </MorphCollapse>
    </section>
  )
}

type FormState = {
  /** `null` while creating a new placeholder; the row id while editing one. */
  id: string | null
  name: string
  variantsText: string
}

const EMPTY_FORM: FormState = { id: null, name: '', variantsText: '' }

function CustomPlaceholdersSection({ token }: { token: string | null }) {
  const [items, setItems] = useState<PromptPlaceholder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      setItems(await listPromptPlaceholders(token))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load placeholders')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setFormOpen(true)
  }

  function openEdit(item: PromptPlaceholder) {
    setForm({ id: item.id, name: item.name, variantsText: item.variants.join('\n') })
    setFormError(null)
    setFormOpen(true)
  }

  function closeForm() {
    setFormOpen(false)
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  async function submitForm() {
    if (!token) return
    const name = form.name.trim()
    const variants = form.variantsText
      .split('\n')
      .map(v => v.trim())
      .filter(Boolean)
    if (!isValidPlaceholderName(name)) {
      setFormError("Name may only contain letters, digits, '-', '_' or '.', up to 64 characters.")
      return
    }
    if (isReservedPlaceholderName(name)) {
      setFormError(`'${name}' is a reserved name (a built-in category or '?').`)
      return
    }
    if (variants.length === 0) {
      setFormError('At least one variant is required.')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      if (form.id) {
        await updatePromptPlaceholder(token, form.id, name, variants)
      } else {
        await createPromptPlaceholder(token, name, variants)
      }
      closeForm()
      await refresh()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to save placeholder')
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: PromptPlaceholder) {
    if (!token) return
    if (!window.confirm(`Delete placeholder "{${item.name}}"?`)) return
    setBusy(true)
    setError(null)
    try {
      await deletePromptPlaceholder(token, item.id)
      if (previewId === item.id) setPreviewId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  function togglePreview(item: PromptPlaceholder, regenerate = false) {
    if (previewId === item.id && !regenerate) {
      setPreviewId(null)
      return
    }
    const defs: Record<string, string[]> = {}
    for (const p of items) defs[p.name.trim().toLowerCase()] = p.variants
    const result = expandPromptPlaceholders(`{${item.name}}`, createPlaceholderUsage(), defs)
    setPreviewId(item.id)
    setPreviewText(result)
  }

  const previewItem = items.find(item => item.id === previewId)

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your placeholders</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={openCreate}
          disabled={!token}
          title="Add placeholder"
          aria-label="Add placeholder"
          data-testid="prompt-placeholders-add-open"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="prompt-placeholders-error">
          {error}
        </p>
      ) : null}

      {formOpen ? (
        <div className="mt-2 rounded-lg border border-border bg-card/60 p-2.5">
          <Input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. .cinematic"
            className="h-8 text-xs"
            data-testid="prompt-placeholders-add-name"
          />
          <textarea
            value={form.variantsText}
            onChange={e => setForm(f => ({ ...f, variantsText: e.target.value }))}
            placeholder={'One variant per line, e.g.\nCinematic colors\nCinematic color grading\nCinematic lighting'}
            rows={4}
            className="mt-2 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            data-testid="prompt-placeholders-add-variants"
          />
          {formError ? <p className="mt-1.5 text-xs text-destructive">{formError}</p> : null}
          <div className="mt-2 flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closeForm}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !form.name.trim() || !form.variantsText.trim()}
              onClick={() => void submitForm()}
              data-testid="prompt-placeholders-add-submit"
            >
              {busy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Check className="mr-1.5 size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-2" data-testid="prompt-placeholders-list">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            No custom placeholders yet — add one above, e.g. <span className="font-mono">{'{.cinematic}'}</span>.
          </p>
        ) : (
          <ul className="flex min-w-0 flex-wrap gap-2">
            {items.map(item => (
              <li
                key={item.id}
                className={cn('inline-flex min-w-0 max-w-full items-center gap-1 rounded-2xl bg-muted/60 py-1 pr-1 pl-3', previewId === item.id && 'bg-violet-500/10')}
                data-testid={`prompt-placeholders-item-${item.id}`}
              >
                <button
                  type="button"
                  onClick={() => togglePreview(item)}
                  aria-expanded={previewId === item.id}
                  aria-label={`Preview {${item.name}}`}
                  title={`${item.variants.length} variants — preview and manage`}
                  data-testid={`prompt-placeholders-preview-${item.id}`}
                  className="min-w-0 rounded-sm py-0.5 text-left font-mono text-xs text-foreground outline-none hover:text-violet-600 focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-violet-400"
                >
                  {`{${item.name}}`}
                </button>
                <CopyTagButton text={`{${item.name}}`} testId={`prompt-placeholders-copy-${item.id}`} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {previewItem ? (
        <div className="mt-2 min-w-0 rounded-lg bg-muted/30 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">
              <span className="font-mono text-foreground">{`{${previewItem.name}}`}</span>
              {' · '}{previewItem.variants.length} variant{previewItem.variants.length === 1 ? '' : 's'}
            </p>
            <div className="flex shrink-0 gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => togglePreview(previewItem, true)}
                title="Another preview"
                aria-label="Another preview"
                className="text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                onClick={() => openEdit(previewItem)}
                title="Edit"
                aria-label="Edit"
                data-testid={`prompt-placeholders-edit-${previewItem.id}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                onClick={() => void remove(previewItem)}
                title="Delete"
                aria-label="Delete"
                data-testid={`prompt-placeholders-delete-${previewItem.id}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
          <p
            className="mt-2 min-w-0 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
            data-testid={`prompt-placeholders-preview-result-${previewItem.id}`}
          >
            {previewText}
          </p>
        </div>
      ) : null}
    </section>
  )
}

function ReservedNamesSection() {
  return (
    <section data-testid="prompt-placeholders-reserved-list">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Built-in (reserved) names
      </p>
      <ul className="mt-2 flex min-w-0 flex-wrap gap-2">
        {['?', ...PLACEHOLDER_CATEGORIES].map(name => (
          <li key={name} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted/60 py-1 pr-1 pl-3">
            <span className="min-w-0 font-mono text-xs text-foreground">{`{${name}}`}</span>
            <CopyTagButton text={`{${name}}`} testId={`prompt-placeholders-copy-reserved-${name}`} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Copy a tag into your prompt for a random word or name. These names are reserved for built-in placeholders.
      </p>
    </section>
  )
}
