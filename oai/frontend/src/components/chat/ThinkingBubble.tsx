import { motion } from 'framer-motion'
import { MarkdownContent } from '../MarkdownContent'

/** Assistant bubble shown while a reply streams in or is still pending. */
export function ThinkingBubble({ statusText, content }: { statusText?: string; content?: string }) {
  const streaming = Boolean(content?.trim())
  return (
    <div
      className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm"
      data-testid="message-pending"
      aria-busy="true"
      aria-live="polite"
    >
      {streaming ? (
        <div className="mb-3" data-testid="message-streaming">
          <MarkdownContent>{content!}</MarkdownContent>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex items-center gap-0.75" aria-hidden>
          {[0, 1, 2].map(i => (
            <motion.span
              key={i}
              className="block size-1.5 rounded-full bg-current"
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.14, ease: 'easeInOut' }}
            />
          ))}
        </span>
        {!streaming && <span>{statusText || 'Thinking…'}</span>}
      </div>
    </div>
  )
}
