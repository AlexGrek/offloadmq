import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, RefreshCw, Tags } from 'lucide-react'
import { fetchRandomNames, type GeneratedName } from '../api/names'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

const BATCH_SIZE = 6

export function RandomNamesWidget() {
  const { token } = useAuth()
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
    if (!open) return
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open || !token) return
    void loadNames()
  }, [open, token, loadNames])

  useEffect(() => {
    if (!copiedPhrase) return
    const t = window.setTimeout(() => setCopiedPhrase(null), 1500)
    return () => window.clearTimeout(t)
  }, [copiedPhrase])

  function copyPhrase(phrase: string) {
    void navigator.clipboard.writeText(phrase).then(() => {
      setCopiedPhrase(phrase)
    })
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

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-popover p-3 text-sm shadow-md"
          data-testid="random-names-popover"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-foreground">Random names</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Two-word phrases for <span className="font-mono">{`{?}`}</span> in prompts. Jobs also get a slug like{' '}
                <span className="font-mono">rusty-nail</span>.
              </p>
            </div>
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
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </div>

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
                      onClick={() => copyPhrase(name.phrase)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/70"
                      data-testid={`random-names-item-${name.slug}`}
                    >
                      <span>
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
      )}
    </div>
  )
}
