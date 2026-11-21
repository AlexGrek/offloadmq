import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, ExternalLink, Loader2, Shuffle } from 'lucide-react'

import { fetchRandomWikiArticle, type WikiArticle } from '@/api/wiki'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

interface WikiDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  token: string | null
  /** Receives the article intro text to put into the prompt. */
  onUse: (text: string) => void
}

/** Large drawer (full-screen on mobile) previewing a random Wikipedia article intro.
 *  "Randomize" rolls another; "Use" puts the intro into the prompt. A fresh article
 *  is rolled each time the drawer opens. */
export function WikiDrawer({ open, onOpenChange, token, onUse }: WikiDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="max-w-full sm:max-w-2xl lg:max-w-3xl"
        data-testid="imggen-wiki-drawer"
      >
        {/* Mounted only while open, so the first roll is just a mount effect. */}
        <WikiBody token={token} onUse={text => { onUse(text); onOpenChange(false) }} />
      </SheetContent>
    </Sheet>
  )
}

function WikiBody({ token, onUse }: { token: string | null; onUse: (text: string) => void }) {
  const [article, setArticle] = useState<WikiArticle | null>(null)
  const [loading, setLoading] = useState(!!token)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may write state — a slow earlier roll must not clobber a newer one.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    if (!token) return
    const seq = ++requestSeq.current
    try {
      const next = await fetchRandomWikiArticle(token)
      if (seq !== requestSeq.current) return
      setArticle(next)
      setError(null)
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : 'Failed to load article')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [token])

  /* eslint-disable react-hooks/set-state-in-effect -- first roll on mount; state is only
     written after the awaited fetch resolves. */
  useEffect(() => {
    void load()
    // Drop any in-flight roll if the drawer closes.
    const seqRef = requestSeq
    return () => { seqRef.current++ }
  }, [load])
  /* eslint-enable react-hooks/set-state-in-effect */

  function randomize() {
    setLoading(true)
    void load()
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <BookOpen className="size-4" />
          Random Wikipedia article
        </SheetTitle>
        <SheetDescription>The beginning of a random article — use it as your prompt.</SheetDescription>
      </SheetHeader>
      <SheetBody>
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="imggen-wiki-error">
            {error}
          </p>
        )}
        {!article && loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {article && (
          <article className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
            <h3 className="font-display text-xl font-semibold" data-testid="imggen-wiki-title">
              {article.title}
            </h3>
            {article.description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{article.description}</p>
            )}
            {article.thumbnail && (
              <img
                src={article.thumbnail}
                alt=""
                referrerPolicy="no-referrer"
                className="mt-3 max-h-64 rounded-md border border-border object-contain"
              />
            )}
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap" data-testid="imggen-wiki-extract">
              {article.extract}
            </p>
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" /> Read on Wikipedia (CC BY-SA)
            </a>
          </article>
        )}
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          variant="outline"
          onClick={randomize}
          disabled={!token || loading}
          data-testid="imggen-wiki-randomize"
        >
          {loading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Shuffle className="mr-1 size-4" />}
          Randomize
        </Button>
        <Button
          type="button"
          onClick={() => article && onUse(article.extract)}
          disabled={!article || loading}
          data-testid="imggen-wiki-use"
        >
          Use
        </Button>
      </SheetFooter>
    </>
  )
}
