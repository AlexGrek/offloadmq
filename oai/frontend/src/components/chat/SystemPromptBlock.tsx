import { cn } from '@/lib/utils'
import { MarkdownContent } from '../MarkdownContent'

type SystemPromptBlockProps = {
  content: string
  className?: string
}

/** In-thread system prompt — no chat bubble, no frame. */
export function SystemPromptBlock({ content, className }: SystemPromptBlockProps) {
  if (!content.trim()) return null

  return (
    <div className={cn('min-w-0', className)} data-testid="chat-system-prompt-display">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        System prompt
      </p>
      <div className="mt-2">
        <MarkdownContent tone="muted">{content}</MarkdownContent>
      </div>
    </div>
  )
}
