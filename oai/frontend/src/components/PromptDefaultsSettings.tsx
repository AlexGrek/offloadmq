import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { savePromptDefaults } from '../api/userSettings'
import { BUILTIN_PROMPT_DEFAULTS, type PromptApp, type PromptDefaults } from '../lib/promptDefaults'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Alert, AlertDescription } from './ui/alert'

const apps: { key: PromptApp; label: string }[] = [
  { key: 'describe_image', label: 'Describe Image prompt' },
  { key: 'chat', label: 'Chat system prompt' },
  { key: 'image_cycles', label: 'Image Cycles vision prompt' },
  { key: 'generator_improver', label: 'Generator Improver assessment prompt' },
]

export function PromptDefaultsSettings() {
  const { user, token, setPromptDefaults } = useAuth()
  const [drafts, setDrafts] = useState<PromptDefaults>(() => ({
    describe_image: user?.prompt_defaults?.describe_image ?? null,
    chat: user?.prompt_defaults?.chat ?? null,
    image_cycles: user?.prompt_defaults?.image_cycles ?? null,
    generator_improver: user?.prompt_defaults?.generator_improver ?? null,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!token) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const result = await savePromptDefaults(token, drafts)
      setPromptDefaults(result)
      setDrafts(result)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prompt defaults')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 py-2" data-testid="prompt-defaults-settings">
      <div>
        <h2 className="font-display text-lg font-semibold">Default prompts</h2>
        <p className="text-sm text-muted-foreground">
          Personal defaults for new chats and runs. Leave a field blank to use the built-in prompt.
          Existing chats and runs keep their prompts. New chats carry over the previous system
          prompt, remembered in this browser for 24 hours.
        </p>
      </div>
      <form onSubmit={save} className="flex flex-col gap-5">
        {apps.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-2">
            <Label htmlFor={`default-prompt-${key}`}>{label}</Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
              id={`default-prompt-${key}`}
              data-testid={`default-prompt-${key}`}
              value={drafts[key] ?? ''}
              placeholder={BUILTIN_PROMPT_DEFAULTS[key]}
              rows={key === 'chat' ? 3 : 6}
              maxLength={32000}
              disabled={saving}
              onChange={event => {
                setDrafts(current => ({ ...current, [key]: event.target.value }))
                setSaved(false)
              }}
            />
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">Built-in prompt</summary>
              <p className="mt-2 whitespace-pre-wrap">{BUILTIN_PROMPT_DEFAULTS[key]}</p>
            </details>
            <Button
              type="button" variant="outline" size="sm" className="self-start"
              disabled={saving || !drafts[key]}
              data-testid={`default-prompt-reset-${key}`}
              onClick={() => {
                setDrafts(current => ({ ...current, [key]: null }))
                setSaved(false)
              }}
            >Use built-in prompt</Button>
          </div>
        ))}
        {error && <Alert variant="destructive" data-testid="prompt-defaults-error"><AlertDescription>{error}</AlertDescription></Alert>}
        {saved && <p role="status" className="text-sm" data-testid="prompt-defaults-saved">Default prompts saved.</p>}
        <Button type="submit" className="min-h-11 self-start" disabled={saving} data-testid="prompt-defaults-save">
          {saving ? 'Saving…' : 'Save default prompts'}
        </Button>
      </form>
    </section>
  )
}
