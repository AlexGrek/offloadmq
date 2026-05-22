import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

export type MarkdownTone = 'default' | 'inverted' | 'muted'

type MarkdownContentProps = {
  children: string
  className?: string
  tone?: MarkdownTone
}

const toneRoot: Record<MarkdownTone, string> = {
  default: 'markdown-body',
  inverted: 'markdown-body markdown-body-inverted',
  muted: 'markdown-body markdown-body-muted',
}

function componentsForTone(tone: MarkdownTone): Components {
  const linkClass =
    tone === 'inverted'
      ? 'underline underline-offset-2 opacity-90 hover:opacity-100'
      : tone === 'muted'
        ? 'text-foreground/80 underline underline-offset-2 hover:text-foreground'
        : 'text-primary underline underline-offset-2 hover:text-primary/80'

  return {
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {children}
      </a>
    ),
    pre: ({ children }) => (
      <pre className="markdown-pre overflow-x-auto rounded-lg border border-border/60 p-3 text-[13px]">
        {children}
      </pre>
    ),
    code: ({ className, children, ...rest }) => {
      const isBlock = typeof className === 'string' && className.includes('language-')
      if (isBlock) {
        return (
          <code className={cn('font-mono', className)} {...rest}>
            {children}
          </code>
        )
      }
      return (
        <code className="markdown-inline-code rounded px-1 py-0.5 font-mono text-[0.9em]" {...rest}>
          {children}
        </code>
      )
    },
  }
}

/** Renders GFM markdown for chat messages, system prompts, and streamed LLM output. */
export function MarkdownContent({ children, className, tone = 'default' }: MarkdownContentProps) {
  const text = children.trim()
  if (!text) return null

  return (
    <div className={cn(toneRoot[tone], className)} data-markdown-tone={tone}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={componentsForTone(tone)}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
