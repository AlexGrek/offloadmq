import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2, RefreshCw, Tags, X } from 'lucide-react'
import { fetchRandomNames, type GeneratedName } from '../api/names'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

const BATCH_SIZE = 6

type RandomNamesPanelProps = {
  names: GeneratedName[]
  loading: boolean
  error: string | null
  copiedPhrase: string | null
  token: string | null
  onRefresh: () => void
  onCopy: (phrase: string) => void
  onClose?: () => void
  className?: string
}

function RandomNamesPanel({
  names,
  loading,
  error,
  copiedPhrase,
  token,
  onRefresh,
  onCopy,
  onClose,
  className,
}: RandomNamesPanelProps) {
  return (
    <div className={cn('flex min-h-0 flex-col text-sm', className)} data-testid="random-names-popover">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0 pr-2">
          <p className="font-medium text-foreground">Random names</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Two-word phrases for <span className="font-mono">{`{?}`}</span> in prompts. Jobs also get a slug like{' '}
            <span className="font-mono">rusty-nail</span>.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading || !token}
            title="Generate more"
            aria-label="Generate more names"
            data-testid="random-names-refresh"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close random names"
              data-testid="random-names-close"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error ? (
          <p className="mt-3 text-xs text-destructive" data-testid="random-names-error">
            {error}
          </p>
        ) : (
          <ul className="mt-3 space-y-1" data-testid="random-names-list">
            {names.map(name => {
              const copied = copiedPhrase === name.phrase
              return (
                <li key={name.slug}>
                  <button
                    type="button"
                    onClick={() => onCopy(name.phrase)}
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
      </div>
    </div>
  )
}

export function RandomNamesWidget() {
  const { token } = useAuth()
  const isMobile = useIsMobile()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [names, setNames] = useState<GeneratedName[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedPhrase, setCopiedPhrase] = useState<string | null>(null)

  const loadNames = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchRandomNames(token, BATCH_SIZE)
      setNames(res.names)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate names')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!open || isMobile) return
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, isMobile])

  useEffect(() => {
    if (!open || !token) return
    void loadNames()
  }, [open, token, loadNames])

  useEffect(() => {
    if (!copiedPhrase) return
    const t = window.setTimeout(() => setCopiedPhrase(null), 1500)
    return () => window.clearTimeout(t)
  }, [copiedPhrase])

  useEffect(() => {
    if (!isMobile || !open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isMobile, open])

  function copyPhrase(phrase: string) {
    void navigator.clipboard.writeText(phrase).then(() => {
      setCopiedPhrase(phrase)
    })
  }

  const panelProps = {
    names,
    loading,
    error,
    copiedPhrase,
    token,
    onRefresh: () => void loadNames(),
    onCopy: copyPhrase,
  }

  return (
    <div className="relative" ref={rootRef} data-testid="random-names-widget">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={open ? 'Close random names' : 'Random names'}
        title="Random two-word names for {?} placeholders"
        data-testid="random-names-toggle"
        className={cn(open && 'text-violet-600 dark:text-violet-400')}
      >
        <Tags className="h-4 w-4" />
        <span className="ml-1.5 hidden sm:inline">Names</span>
      </Button>

      {!isMobile && open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-popover p-3 shadow-md">
          <RandomNamesPanel {...panelProps} />
        </div>
      )}

      {isMobile &&
        createPortal(
          <AnimatePresence>
            {open && (
              <>
                <motion.button
                  type="button"
                  className="fixed inset-0 z-50 bg-black/40"
                  aria-label="Close random names"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => setOpen(false)}
                />
                <motion.aside
                  className="fixed inset-x-0 top-14 z-[60] flex max-h-[min(72dvh,calc(100dvh-3.5rem))] flex-col border-b border-border bg-background shadow-xl"
                  initial={{ y: '-100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '-100%' }}
                  transition={{ type: 'spring', damping: 30, stiffness: 320 }}
                  data-testid="random-names-drawer"
                >
                  <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
                  <div className="min-h-0 flex-1 overflow-hidden p-4 pt-3">
                    <RandomNamesPanel {...panelProps} onClose={() => setOpen(false)} className="h-full" />
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
