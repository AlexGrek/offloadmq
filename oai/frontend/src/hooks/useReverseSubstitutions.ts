import { useCallback, useEffect, useRef, useState } from 'react'
import { listPromptPlaceholders } from '@/api/promptPlaceholders'
import { reversePromptSubstitutions } from '@/lib/promptPlaceholders'

export type ReverseEffect = 'hit' | 'miss' | null

const EFFECT_MS = 1000

/**
 * "Reverse substitutions" for a prompt field: swaps literal values for the
 * `{placeholder}`s they could have come from. `effectClass` goes on the textarea
 * — a magic sweep when something was replaced, a small nudge when nothing was.
 */
export function useReverseSubstitutions(
  token: string | null,
  value: string,
  onChange: (next: string) => void,
) {
  const [effect, setEffect] = useState<ReverseEffect>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const play = useCallback((kind: Exclude<ReverseEffect, null>) => {
    window.clearTimeout(timer.current)
    setEffect(null)
    // One frame with no class so the same animation can replay on a repeat click.
    requestAnimationFrame(() => {
      setEffect(kind)
      timer.current = window.setTimeout(() => setEffect(null), EFFECT_MS)
    })
  }, [])

  const run = useCallback(async () => {
    if (!token || !value.trim() || busy) return
    setBusy(true)
    let defs: Record<string, string[]> = {}
    try {
      const items = await listPromptPlaceholders(token)
      defs = Object.fromEntries(items.map(i => [i.name.trim().toLowerCase(), i.variants]))
    } catch {
      // Custom placeholders are additive — builtin categories still work.
    }
    const { text, count } = reversePromptSubstitutions(value, defs)
    setBusy(false)
    if (count === 0) {
      play('miss')
      return
    }
    onChange(text)
    play('hit')
  }, [token, value, busy, onChange, play])

  const effectClass =
    effect === 'hit' ? 'magic-reverse-hit' : effect === 'miss' ? 'magic-reverse-miss' : ''
  return { run, busy, effect, effectClass }
}
