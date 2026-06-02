import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMessagePending, type Message } from '@/lib/chat/messages'
import { MarkdownContent } from '../MarkdownContent'
import { ThinkingBubble } from './ThinkingBubble'

/** A single transcript row: user/assistant bubble, thinking state, and retry affordance. */
export function ChatMessageItem({
  msg,
  showRetry,
  onRetry,
}: {
  msg: Message
  showRetry: boolean
  onRetry: () => void
}) {
  const [copied, setCopied] = useState(false)
  const pending = isMessagePending(msg)
  const canCopy = !pending && msg.content.length > 0

  function handleCopy() {
    void navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <motion.div
      className={cn('flex flex-col', msg.role === 'user' ? 'items-end' : 'items-start')}
      data-testid={`message-${msg.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
    >
      {pending ? (
        <ThinkingBubble statusText={msg.statusText} content={msg.content} />
      ) : (
        <div
          className={cn(
            'max-w-[80%] rounded-2xl px-4 py-2.5',
            msg.role === 'user'
              ? 'bg-primary text-primary-foreground rounded-br-sm'
              : msg.status === 'failed'
                ? 'bg-destructive/10 text-destructive rounded-bl-sm'
                : 'bg-muted text-foreground rounded-bl-sm',
          )}
        >
          <MarkdownContent
            tone={msg.role === 'user' ? 'inverted' : 'default'}
            className={msg.status === 'failed' ? 'text-destructive' : undefined}
          >
            {msg.content}
          </MarkdownContent>
        </div>
      )}
      {(canCopy || showRetry) && (
        <div className="mt-1.5 flex items-center gap-3">
          {canCopy && (
            <button
              type="button"
              onClick={handleCopy}
              data-testid="copy-btn"
              aria-label="Copy message"
              title="Copy message"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {showRetry && (
            <button
              type="button"
              onClick={onRetry}
              data-testid="retry-btn"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          )}
        </div>
      )}
    </motion.div>
  )
}
