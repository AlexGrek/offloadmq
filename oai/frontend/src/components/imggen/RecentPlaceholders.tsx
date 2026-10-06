import { useEffect, useState } from 'react'
import { Braces, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MorphCollapse } from '@/components/Morph'
import { cn } from '@/lib/utils'
import { useRecentPlaceholders } from '@/lib/recentPlaceholders'

export type RecentPlaceholdersProps = {
  /** Called with the token (e.g. `{color}`) when a chip is clicked. */
  onInsert: (token: string) => void
}

/** "{}" toggle below the prompt — expands into a wrapping tag cloud
 *  of the user's most recently used `{placeholder}` tokens (max 7, most
 *  recent first). History lives entirely in localStorage; nothing here talks
 *  to the server. */
export function RecentPlaceholders({ onInsert }: RecentPlaceholdersProps) {
  const [open, setOpen] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const recent = useRecentPlaceholders()

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

      <MorphCollapse show={open && recent.length > 0}>
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
        </div>
      </MorphCollapse>

      <span className="sr-only" aria-live="polite">{copiedToken ? `Copied ${copiedToken}` : ''}</span>
      {copyError ? <p role="alert" className="text-xs text-destructive">Couldn't copy. Try again.</p> : null}

      <MorphCollapse show={open && recent.length === 0}>
        <p className="pb-1 pt-1.5 text-xs text-muted-foreground">
          Placeholders you use in a prompt (like <span className="font-mono">{'{color}'}</span>) show up
          here after you generate.
        </p>
      </MorphCollapse>
    </div>
  )
}
