import Ansi from 'ansi-to-react'
import { cn } from '@/lib/utils'

interface AnsiLogPreProps {
  content: string
  className?: string
  'data-testid'?: string
}

/** Renders pod/container log text with ANSI colors (tracing, sqlx, etc.). */
export function AnsiLogPre({ content, className, ...props }: AnsiLogPreProps) {
  return (
    <pre
      className={cn(
        'max-h-[min(60vh,32rem)] overflow-auto rounded-lg border border-border bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100 sm:text-xs',
        '[&_code]:block [&_code]:whitespace-pre-wrap [&_code]:break-all [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-inherit [&_code]:text-inherit',
        className,
      )}
      {...props}
    >
      <Ansi>{content}</Ansi>
    </pre>
  )
}
