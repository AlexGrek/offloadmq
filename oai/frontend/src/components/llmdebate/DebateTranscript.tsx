import { AnimatePresence, motion } from 'framer-motion'
import { Gavel } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { MarkdownContent } from '../MarkdownContent'
import { SpeechListenWidget } from '../SpeechListenWidget'
import { cn } from '@/lib/utils'
import { capabilityBaseLabel } from '../../lib/modelAvailability'
import type { DebateMessage, LlmDebateJob } from '../../api/llmDebate'

const SIDE_STYLES = {
  A: {
    align: 'items-start',
    bubble: 'rounded-2xl rounded-bl-sm bg-muted/80 border border-sky-500/25',
    label: 'text-sky-500',
  },
  B: {
    align: 'items-end',
    bubble: 'rounded-2xl rounded-br-sm bg-emerald-500/8 border border-emerald-500/25',
    label: 'text-emerald-500',
  },
  REF: {
    align: 'items-center',
    bubble: '',
    label: 'text-violet-500',
  },
} as const

type DebateTranscriptProps = {
  job: LlmDebateJob
  isRunning: boolean
}

export function DebateTranscript({ job, isRunning }: DebateTranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [job.messages, job.active_log, isRunning])

  const sideName = (side: string) => {
    if (side === 'A') return capabilityBaseLabel(job.model_a)
    if (side === 'B') return capabilityBaseLabel(job.model_b)
    return job.model_ref ? capabilityBaseLabel(job.model_ref) : 'Referee'
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-2">
      <AnimatePresence initial={false}>
        {job.messages.map((msg, i) => (
          <DebateBubble
            key={`${msg.side}-${i}`}
            msg={msg}
            sideName={sideName(msg.side)}
            index={i}
          />
        ))}
      </AnimatePresence>

      {isRunning && job.current_turn && (
        <InFlightBubble
          side={job.current_turn}
          sideName={sideName(job.current_turn)}
          log={job.active_log}
          stage={job.stage}
        />
      )}

      <div ref={endRef} className="h-px shrink-0" aria-hidden />
    </div>
  )
}

function DebateBubble({
  msg,
  sideName,
  index,
}: {
  msg: DebateMessage
  sideName: string
  index: number
}) {
  if (msg.side === 'REF') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto w-full max-w-2xl"
        data-testid={`debate-ref-${index}`}
      >
        <div className="overflow-hidden rounded-2xl border border-violet-500/35 bg-gradient-to-br from-violet-500/10 via-transparent to-fuchsia-500/5 p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gavel className="size-4 text-violet-500" />
              <span className="text-xs font-bold uppercase tracking-wide text-violet-500">
                {sideName} — Verdict
              </span>
            </div>
            <SpeechListenWidget text={msg.content} triggerVariant="ghost" testIdPrefix="debate-ref" />
          </div>
          <MarkdownContent>{msg.content}</MarkdownContent>
        </div>
      </motion.div>
    )
  }

  const style = SIDE_STYLES[msg.side as 'A' | 'B'] ?? SIDE_STYLES.A
  const isA = msg.side === 'A'

  return (
    <motion.div
      initial={{ opacity: 0, x: isA ? -12 : 12, y: 6 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: index * 0.02 }}
      className={cn('flex flex-col', style.align)}
      data-testid={`debate-msg-${msg.side}-${index}`}
    >
      <div className={cn('mb-1 flex w-full max-w-[min(92vw,28rem)] items-center justify-between gap-2 px-1', isA ? '' : 'ml-auto flex-row-reverse')}>
        <span className={cn('text-[11px] font-semibold tracking-wide', style.label)}>{sideName}</span>
        <SpeechListenWidget text={msg.content} triggerVariant="ghost" testIdPrefix={`debate-${msg.side}`} />
      </div>
      <div className={cn('max-w-[min(92vw,28rem)] px-3.5 py-3 text-sm shadow-sm sm:px-4', style.bubble)}>
        <MarkdownContent>{msg.content}</MarkdownContent>
      </div>
    </motion.div>
  )
}

function InFlightBubble({
  side,
  sideName,
  log,
  stage,
}: {
  side: string
  sideName: string
  log: string | null
  stage: string | null
}) {
  if (side === 'REF') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="mx-auto w-full max-w-2xl"
        data-testid="debate-ref-pending"
      >
        <div className="overflow-hidden rounded-2xl border border-violet-500/35 bg-violet-500/5 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Gavel className="size-4 animate-pulse text-violet-500" />
            <span className="text-xs font-bold text-violet-500">Deliberating…</span>
          </div>
          {log ? (
            <motion.div animate={{ opacity: [1, 0.5, 1] }} transition={{ duration: 1.8, repeat: Infinity }}>
              <MarkdownContent>{log}</MarkdownContent>
            </motion.div>
          ) : (
            <ThinkingDots label="Analyzing transcript…" />
          )}
        </div>
      </motion.div>
    )
  }

  const style = SIDE_STYLES[side as 'A' | 'B'] ?? SIDE_STYLES.A
  const isA = side === 'A'

  return (
    <motion.div
      initial={{ opacity: 0, x: isA ? -8 : 8 }}
      animate={{ opacity: 1, x: 0 }}
      className={cn('flex flex-col', style.align)}
      data-testid="debate-turn-pending"
    >
      <span className={cn('mb-1 px-1 text-[11px] font-semibold', style.label)}>{sideName}</span>
      <div className={cn('max-w-[min(92vw,28rem)] px-3.5 py-3 text-sm sm:px-4', style.bubble)}>
        {log ? (
          <motion.div animate={{ opacity: [1, 0.5, 1] }} transition={{ duration: 1.8, repeat: Infinity }}>
            <MarkdownContent>{log}</MarkdownContent>
          </motion.div>
        ) : (
          <ThinkingDots label={stage ? `Status: ${stage}` : 'Thinking…'} />
        )}
      </div>
    </motion.div>
  )
}

function ThinkingDots({ label }: { label: string }) {
  return (
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
      <span className="text-xs italic">{label}</span>
    </div>
  )
}
