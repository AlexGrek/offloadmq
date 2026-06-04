import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PromptTextarea } from '@/components/PromptTextarea'

const DEFAULT_PROMPT = 'You are a helpful AI assistant.'

type SystemPromptStudioProps = {
  token: string
  value: string
  onChange: (content: string) => void
  onApply: (content: string) => Promise<void>
  compact?: boolean
}

/**
 * Empty-thread system prompt editor: a single prompt textarea (with its built-in
 * recent/starred picker) plus apply/reset. Recents are recorded server-side when
 * the prompt is applied or a message is sent — nothing to record here.
 */
export function SystemPromptStudio({
  token,
  value,
  onChange,
  onApply,
  compact,
}: SystemPromptStudioProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleApply() {
    const text = value.trim() || DEFAULT_PROMPT
    setSaving(true)
    setError(null)
    try {
      await onApply(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-4',
        !compact &&
          'mx-auto w-full max-w-lg rounded-2xl border border-border/80 bg-gradient-to-b from-violet-500/8 via-background to-background p-5 shadow-sm',
      )}
      data-testid="system-prompt-studio"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold tracking-tight">System prompt</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sets behavior for this chat. Open the list to reuse a recent or starred prompt.
          </p>
        </div>
      </div>

      <PromptTextarea
        token={token}
        value={value}
        onChange={onChange}
        bucket="llm-system"
        placeholder={DEFAULT_PROMPT}
        rows={compact ? 4 : 6}
        data-testid="system-prompt-editor"
        textareaClassName="font-mono"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleApply()}
          disabled={saving}
          data-testid="system-prompt-apply"
        >
          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Apply to chat
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange(DEFAULT_PROMPT)}
          disabled={saving}
        >
          Reset default
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive" data-testid="system-prompt-error">
          {error}
        </p>
      )}
    </div>
  )
}

export { DEFAULT_PROMPT }
