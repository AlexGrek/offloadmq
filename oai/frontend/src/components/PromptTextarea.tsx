import { useState } from 'react'
import { List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SavedPromptsDialog } from '@/components/SavedPromptsDialog'

type PromptTextareaProps = {
  value: string
  onChange: (value: string) => void
  /** Storage namespace, e.g. `llm-system` or `describe-image-user`. */
  bucket: string
  token: string | null
  placeholder?: string
  rows?: number
  disabled?: boolean
  id?: string
  /** Wrapper classes. */
  className?: string
  /** Extra classes merged onto the textarea. */
  textareaClassName?: string
  'data-testid'?: string
}

/**
 * A textarea with a built-in saved-prompts picker. The list icon opens
 * SavedPromptsDialog, which lets the user browse/star/edit/delete saved
 * prompts and pick one to replace the current text.
 */
export function PromptTextarea({
  value,
  onChange,
  bucket,
  token,
  placeholder,
  rows = 4,
  disabled,
  id,
  className,
  textareaClassName,
  'data-testid': testId,
}: PromptTextareaProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('relative', className)}>
      <textarea
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          'w-full resize-y rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm leading-relaxed',
          'outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
          textareaClassName,
        )}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled || !token}
        onClick={() => setOpen(true)}
        title="Saved prompts"
        aria-label="Saved prompts"
        data-testid="prompt-list-open"
        className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
      >
        <List className="size-4" />
      </Button>

      <SavedPromptsDialog
        open={open}
        onOpenChange={setOpen}
        bucket={bucket}
        token={token}
        value={value}
        onPick={onChange}
      />
    </div>
  )
}
