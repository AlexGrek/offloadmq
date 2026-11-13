import { useState } from 'react'
import { Highlighter, ImagePlus, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { QuickGenerateDialog } from '../imggen/QuickGenerateDialog'
import { PromptEditor } from './PromptEditor'

/**
 * The three actions every Prompt Studio prompt gets:
 * **Generate** (quick txt2img dialog), **Edit** (smart prompt editor) and
 * **Use** (open Image Generation with the prompt).
 */
export function PromptActions({
  token,
  prompt,
  onUse,
  onApply,
  applyLabel,
  testIdPrefix = 'prompt-studio',
  tone = 'default',
  className,
}: {
  token: string
  prompt: string
  onUse: (prompt: string) => void
  /** When set, the editor offers an Apply button that writes the edit back. */
  onApply?: (prompt: string) => void
  applyLabel?: string
  testIdPrefix?: string
  /** `muted` keeps the row quiet (under user messages); `default` is the studio blue. */
  tone?: 'default' | 'muted'
  className?: string
}) {
  const [generateOpen, setGenerateOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const disabled = !prompt.trim()
  const buttonClass = cn(
    'flex items-center gap-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
    tone === 'muted'
      ? 'text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400'
      : 'text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300',
  )

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        type="button"
        onClick={() => setGenerateOpen(true)}
        disabled={disabled}
        className={buttonClass}
        title="Generate an image from this prompt"
        data-testid={`${testIdPrefix}-generate`}
      >
        <Zap className="size-3" />
        Generate
      </button>
      <button
        type="button"
        onClick={() => setEditorOpen(true)}
        disabled={disabled}
        className={buttonClass}
        title="Open in the prompt editor"
        data-testid={`${testIdPrefix}-edit`}
      >
        <Highlighter className="size-3" />
        Edit
      </button>
      <button
        type="button"
        onClick={() => onUse(prompt)}
        disabled={disabled}
        className={buttonClass}
        title="Open Image Generation with this prompt"
        data-testid={`${testIdPrefix}-use-as-prompt`}
      >
        <ImagePlus className="size-3" />
        Use
      </button>

      {generateOpen && (
        <QuickGenerateDialog
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          prompt={prompt}
          token={token}
          description="Start a text-to-image job with this prompt."
          testIdPrefix={`${testIdPrefix}-generate`}
        />
      )}
      {editorOpen && (
        <PromptEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          token={token}
          prompt={prompt}
          onUse={edited => {
            setEditorOpen(false)
            onUse(edited)
          }}
          onApply={onApply}
          applyLabel={applyLabel}
        />
      )}
    </div>
  )
}
