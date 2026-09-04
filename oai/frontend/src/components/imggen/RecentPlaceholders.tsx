import { useState } from 'react'
import { Braces } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MorphCollapse } from '@/components/Morph'
import { cn } from '@/lib/utils'
import { useRecentPlaceholders } from '@/lib/recentPlaceholders'

export type RecentPlaceholdersProps = {
  /** Called with the token (e.g. `{color}`) when a chip is clicked. */
  onInsert: (token: string) => void
}

/** "{}" toggle below the prompt — expands into a horizontally scrollable row
 *  of the user's most recently used `{placeholder}` tokens (max 7, most
 *  recent first). History lives entirely in localStorage; nothing here talks
 *  to the server. */
export function RecentPlaceholders({ onInsert }: RecentPlaceholdersProps) {
  const [open, setOpen] = useState(false)
  const recent = useRecentPlaceholders()

  return (
    <div data-testid="imggen-recent-placeholders">
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
          className="flex gap-1.5 overflow-x-auto pb-1 pt-1.5"
          data-testid="imggen-recent-placeholders-list"
        >
          {recent.map(token => (
            <button
              key={token}
              type="button"
              onClick={() => onInsert(token)}
              className="shrink-0 rounded-full bg-muted/60 px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid={`imggen-recent-placeholder-${token}`}
            >
              {token}
            </button>
          ))}
        </div>
      </MorphCollapse>

      <MorphCollapse show={open && recent.length === 0}>
        <p className="pb-1 pt-1.5 text-xs text-muted-foreground">
          Placeholders you use in a prompt (like <span className="font-mono">{'{color}'}</span>) show up
          here after you generate.
        </p>
      </MorphCollapse>
    </div>
  )
}
