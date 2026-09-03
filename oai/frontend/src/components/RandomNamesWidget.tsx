import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Tags } from 'lucide-react'
import { PromptPlaceholdersPanel } from './promptPlaceholders/PromptPlaceholdersPanel'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

/**
 * TopBar entry point for prompt placeholders (quick `{?}` names, built-in
 * `{category}` dictionaries, and the user's own custom recursive placeholders).
 * Opens `PromptPlaceholdersPanel` as a top-down drawer on all screen sizes — the
 * same management UI also lives at the standalone `/app/prompt-placeholders` route.
 */
export function RandomNamesWidget() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef} data-testid="random-names-widget">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={open ? 'Close prompt placeholders' : 'Prompt placeholders'}
        title="Prompt placeholders — {?}, {color}, and your own custom placeholders"
        data-testid="random-names-toggle"
        className={cn(open && 'text-violet-600 dark:text-violet-400')}
      >
        <Tags className="h-4 w-4" />
        <span className="ml-1.5 hidden sm:inline">Names</span>
      </Button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <>
              <motion.button
                type="button"
                className="fixed inset-0 z-50 bg-black/40"
                aria-label="Close prompt placeholders"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setOpen(false)}
              />
              <motion.aside
                className="fixed inset-x-0 top-14 z-[60] mx-auto flex w-full max-w-2xl max-h-[min(80dvh,calc(100dvh-3.5rem))] flex-col border-x border-b border-border bg-background shadow-xl sm:rounded-b-2xl"
                initial={{ y: '-100%' }}
                animate={{ y: 0 }}
                exit={{ y: '-100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 320 }}
                data-testid="prompt-placeholders-drawer"
              >
                <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
                <div className="min-h-0 flex-1 overflow-hidden p-4 pt-3">
                  <PromptPlaceholdersPanel onClose={() => setOpen(false)} className="h-full" />
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
