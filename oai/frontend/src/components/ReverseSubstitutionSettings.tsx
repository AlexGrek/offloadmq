import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getReverseExclusions, saveReverseExclusions } from '../api/userSettings'
import { PLACEHOLDER_CATEGORIES } from '../lib/promptPlaceholders'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Alert, AlertDescription } from './ui/alert'

const toLines = (items: string[]) => items.join('\n')
const fromLines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean)

const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60'

/** Registry for the prompt "magic" reverse-substitutions button (✨). */
export function ReverseSubstitutionSettings() {
  const { token } = useAuth()
  const [words, setWords] = useState('')
  const [placeholders, setPlaceholders] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    getReverseExclusions(token, controller.signal)
      .then(value => {
        setWords(toLines(value.words))
        setPlaceholders(toLines(value.placeholders))
      })
      .catch(err => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [token])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!token) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const result = await saveReverseExclusions(token, {
        words: fromLines(words),
        placeholders: fromLines(placeholders),
      })
      setWords(toLines(result.words))
      setPlaceholders(toLines(result.placeholders))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const busy = loading || saving

  return (
    <section className="flex flex-col gap-4 py-2" data-testid="reverse-substitution-settings">
      <div>
        <h2 className="font-display text-lg font-semibold">Reverse substitutions</h2>
        <p className="text-sm text-muted-foreground">
          The ✨ button in prompt fields swaps words like “red” for placeholders like{' '}
          <code>{'{color}'}</code>. Tell it what to leave alone — one entry per line, case-insensitive.
        </p>
      </div>
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="reverse-never-words">Words to never substitute</Label>
          <textarea
            id="reverse-never-words"
            data-testid="reverse-never-words"
            className={textareaClass}
            rows={5}
            value={words}
            placeholder={'red\nblack and white'}
            disabled={busy}
            onChange={e => { setWords(e.target.value); setSaved(false) }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reverse-never-placeholders">Substitutions to never try to match</Label>
          <textarea
            id="reverse-never-placeholders"
            data-testid="reverse-never-placeholders"
            className={textareaClass}
            rows={4}
            value={placeholders}
            placeholder={'adjective\n.my-style'}
            disabled={busy}
            onChange={e => { setPlaceholders(e.target.value); setSaved(false) }}
          />
          <p className="text-xs text-muted-foreground">
            Placeholder names, with or without braces. Built-in: {PLACEHOLDER_CATEGORIES.join(', ')}; or any of your
            custom placeholders.
          </p>
        </div>
        {error && (
          <Alert variant="destructive" data-testid="reverse-substitution-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && (
          <p role="status" className="text-sm" data-testid="reverse-substitution-saved">
            Reverse substitution settings saved.
          </p>
        )}
        <Button type="submit" className="min-h-11 self-start" disabled={busy} data-testid="reverse-substitution-save">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </section>
  )
}
