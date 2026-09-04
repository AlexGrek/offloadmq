import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Eye, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
      className={cn('flex min-h-0 flex-col gap-5 overflow-auto overscroll-contain text-sm', className)}
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

function QuickNamesSection({ token }: { token: string | null }) {
  const [names, setNames] = useState<GeneratedName[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedPhrase, setCopiedPhrase] = useState<string | null>(null)

  const loadNames = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchRandomNames(token, QUICK_NAMES_BATCH)
      setNames(res.names)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate names')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadNames()
  }, [loadNames])

  useEffect(() => {
    if (!copiedPhrase) return
    const t = window.setTimeout(() => setCopiedPhrase(null), 1500)
    return () => window.clearTimeout(t)
  }, [copiedPhrase])

  function copyPhrase(phrase: string) {
    void navigator.clipboard.writeText(phrase).then(() => setCopiedPhrase(phrase))
  }

  return (
    <section data-testid="random-names-section">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Quick names for <span className="normal-case">{'{?}'}</span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void loadNames()}
          disabled={loading || !token}
          title="Generate more"
          aria-label="Generate more names"
          data-testid="random-names-refresh"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="random-names-error">
          {error}
        </p>
      ) : (
        <ul className="mt-2 space-y-1" data-testid="random-names-list">
          {names.map(name => {
            const copied = copiedPhrase === name.phrase
            return (
              <li key={name.slug}>
                <button
                  type="button"
                  onClick={() => copyPhrase(name.phrase)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/70"
                  data-testid={`random-names-item-${name.slug}`}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{name.phrase}</span>
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">{name.slug}</span>
                  </span>
                  {copied ? (
                    <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : null}
                </button>
              </li>
            )
          })}
          {!loading && names.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">No names yet.</li>
          ) : null}
        </ul>
      )}
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

  function togglePreview(item: PromptPlaceholder) {
    if (previewId === item.id) {
      setPreviewId(null)
      return
    }
    const defs: Record<string, string[]> = {}
    for (const p of items) defs[p.name.trim().toLowerCase()] = p.variants
    const result = expandPromptPlaceholders(`{${item.name}}`, createPlaceholderUsage(), defs)
    setPreviewId(item.id)
    setPreviewText(result)
  }

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
          <div className="flex flex-col divide-y divide-border rounded-md border border-border/60">
            {items.map(item => (
              <div key={item.id} data-testid={`prompt-placeholders-item-${item.id}`}>
                <div className="group flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-foreground">{`{${item.name}}`}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {item.variants.length} variant{item.variants.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => togglePreview(item)}
                      title="Preview"
                      aria-label="Preview"
                      data-testid={`prompt-placeholders-preview-${item.id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      onClick={() => openEdit(item)}
                      title="Edit"
                      aria-label="Edit"
                      data-testid={`prompt-placeholders-edit-${item.id}`}
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
                      data-testid={`prompt-placeholders-delete-${item.id}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {previewId === item.id ? (
                  <p
                    className="px-2.5 pb-2 font-mono text-[11px] text-muted-foreground"
                    data-testid={`prompt-placeholders-preview-result-${item.id}`}
                  >
                    {previewText}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ReservedNamesSection() {
  return (
    <section data-testid="prompt-placeholders-reserved-list">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Built-in (reserved) names
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-mono">{PLACEHOLDER_CATEGORIES.map(c => `{${c}}`).join(', ')}</span> each resolve
        to a random word from a built-in dictionary, and <span className="font-mono">{'{?}'}</span> resolves to
        a random two-word name on the server. Your own placeholder names can't reuse any of these.
      </p>
    </section>
  )
}
