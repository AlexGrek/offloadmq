import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, Check, Copy, Dices } from 'lucide-react'
import { listPromptPlaceholders } from '@/api/promptPlaceholders'
import { Button } from '@/components/ui/button'
import { MorphCollapse } from '@/components/Morph'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'
import { PLACEHOLDER_CATEGORIES } from '@/lib/promptPlaceholders'
import { useRecentPlaceholders } from '@/lib/recentPlaceholders'

const BUILTIN_TOKENS = ['{?}', ...PLACEHOLDER_CATEGORIES.map(name => `{${name}}`)]

export type RecentPlaceholdersProps = {
  /** Called with the token (e.g. `{color}`) when a chip is clicked. */
  onInsert: (token: string) => void
}

/** "{}" toggle below the prompt — expands into a wrapping tag cloud
 *  of the user's most recently used `{placeholder}` tokens (max 7, most
 *  recent first), followed by a random-copy button. History lives in localStorage;
 *  custom definitions are loaded for the random button. */
export function RecentPlaceholders({ onInsert }: RecentPlaceholdersProps) {
  const { token } = useAuth()
  const [open, setOpen] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const [customTokens, setCustomTokens] = useState<string[]>([])
  const [notification, setNotification] = useState<{ message: string; error: boolean; token?: string } | null>(null)
  const recent = useRecentPlaceholders()

  useEffect(() => {
    if (!open || !token) return
    const controller = new AbortController()
    void listPromptPlaceholders(token, controller.signal).then(items => {
      setCustomTokens(items.filter(item => item.variants.length > 0).map(item => `{${item.name}}`))
    }).catch(() => {
      if (!controller.signal.aborted) setCustomTokens([])
    })
    return () => controller.abort()
  }, [open, token])

  useEffect(() => {
    if (!notification) return
    const timeout = window.setTimeout(() => setNotification(null), 3000)
    return () => window.clearTimeout(timeout)
  }, [notification])

  useEffect(() => {
    if (!copiedToken) return
    const timeout = window.setTimeout(() => setCopiedToken(null), 1500)
    return () => window.clearTimeout(timeout)
  }, [copiedToken])

  async function copyToken(token: string) {
    setCopyError(false)
    try {
      await navigator.clipboard.writeText(token)
      setCopiedToken(token)
    } catch {
      setCopyError(true)
    }
  }

  async function copyRandomToken() {
    const available = [...new Set([...BUILTIN_TOKENS, ...customTokens])]
    const selected = available[Math.floor(Math.random() * available.length)]
    try {
      await navigator.clipboard.writeText(selected)
      setNotification({ message: `Copied ${selected}`, error: false, token: selected })
    } catch {
      setNotification({ message: "Couldn't copy. Try again.", error: true })
    }
  }

  return (
    <div className="min-w-0 max-w-full" data-testid="imggen-recent-placeholders">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={open ? 'Hide recent placeholders' : 'Recent placeholders'}
        title="Recently used prompt placeholders"
        data-testid="imggen-recent-placeholders-toggle"
        className={cn(open && 'text-violet-600 dark:text-violet-400')}
      >
        <Braces className="size-3.5" />
      </Button>

      <MorphCollapse show={open}>
        <div
          className="flex min-w-0 flex-wrap gap-1.5 pb-1 pt-1.5"
          data-testid="imggen-recent-placeholders-list"
        >
          {recent.map(token => (
            <div
              key={token}
              className="inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-2xl bg-muted/60 py-1 pr-1 pl-2.5"
            >
              <button
                type="button"
                onClick={() => onInsert(token)}
                className="min-w-0 rounded-sm py-0.5 text-left font-mono text-xs text-muted-foreground outline-none transition-colors [overflow-wrap:anywhere] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`imggen-recent-placeholder-${token}`}
              >
                {token}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void copyToken(token)}
                title={copiedToken === token ? 'Copied' : `Copy ${token}`}
                aria-label={copiedToken === token ? 'Copied' : `Copy ${token}`}
                data-testid={`imggen-recent-placeholder-copy-${token}`}
                className={cn('rounded-full text-muted-foreground', copiedToken === token && 'text-emerald-600 dark:text-emerald-400')}
              >
                {copiedToken === token ? <Check className="size-3" /> : <Copy className="size-3" />}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void copyRandomToken()}
            aria-label="Copy random substitution"
            title="Copy a random available substitution"
            data-testid="imggen-random-placeholder-copy"
            className="self-center rounded-full text-muted-foreground"
          >
            <Dices className="size-4" />
          </Button>
          {notification?.token ? (
            <span
              className="inline-flex items-center gap-1 self-center font-mono text-xs text-emerald-600 dark:text-emerald-400"
              data-testid="imggen-random-placeholder-copied"
            >
              <Check className="size-3" />
              {notification.token}
            </span>
          ) : null}
        </div>
      </MorphCollapse>

      <span className="sr-only" aria-live="polite">{copiedToken ? `Copied ${copiedToken}` : ''}</span>
      {copyError ? <p role="alert" className="text-xs text-destructive">Couldn't copy. Try again.</p> : null}
      {notification && createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex justify-center px-3">
          <div
            role={notification.error ? 'alert' : 'status'}
            data-testid="imggen-random-placeholder-notification"
            className={cn('max-w-md rounded-xl bg-background/95 px-4 py-3 text-sm shadow-lg ring-1 ring-border backdrop-blur [overflow-wrap:anywhere]', notification.error && 'text-destructive')}
          >
            {notification.message}
          </div>
        </div>,
        document.body,
      )}

      <MorphCollapse show={open && recent.length === 0}>
        <p className="pb-1 pt-1.5 text-xs text-muted-foreground">
          Placeholders you use in a prompt (like <span className="font-mono">{'{color}'}</span>) show up
          here after you generate.
        </p>
      </MorphCollapse>
    </div>
  )
}
