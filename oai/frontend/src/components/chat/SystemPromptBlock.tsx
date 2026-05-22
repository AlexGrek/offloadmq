import { cn } from '@/lib/utils'

type SystemPromptBlockProps = {
  content: string
  className?: string
}

/** In-thread system prompt — no chat bubble. */
export function SystemPromptBlock({ content, className }: SystemPromptBlockProps) {
  if (!content.trim()) return null

  return (
    <div
      className={cn(
        'rounded-xl border border-dashed border-violet-500/35 bg-violet-500/5 px-4 py-3',
        'dark:border-violet-400/30 dark:bg-violet-500/10',
        className,
      )}
      data-testid="chat-system-prompt-display"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-700/90 dark:text-violet-300/90">
        System prompt
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
        {content}
      </p>
    </div>
  )
}
