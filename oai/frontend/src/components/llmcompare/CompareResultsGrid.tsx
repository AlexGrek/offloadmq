import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  CheckCircle2,
  CircleX,
  Copy,
  Check,
  Loader2,
} from 'lucide-react'
import { useState } from 'react'
import { MarkdownContent } from '../MarkdownContent'
import { SpeechListenWidget } from '../SpeechListenWidget'
import { cn } from '@/lib/utils'
import { capabilityBaseLabel } from '../../lib/modelAvailability'
import type { CompareSlot } from '../../api/llmCompare'

const SLOT_ACCENTS = [
  'border-sky-500/40 bg-gradient-to-br from-sky-500/10 to-transparent',
  'border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-transparent',
  'border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-transparent',
  'border-violet-500/40 bg-gradient-to-br from-violet-500/10 to-transparent',
  'border-rose-500/40 bg-gradient-to-br from-rose-500/10 to-transparent',
  'border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 to-transparent',
] as const

const SLOT_BADGE = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-cyan-500',
] as const

function slotRunning(status: string) {
  return !['completed', 'failed', 'canceled'].includes(status)
}

type CompareResultsGridProps = {
  slots: CompareSlot[]
  layout: 'columns' | 'rows'
  /** Force single-column stacking (mobile). */
  stacked?: boolean
}

function gridClass(slots: CompareSlot[], layout: 'columns' | 'rows', stacked: boolean): string {
  if (layout === 'rows' || stacked) return 'grid-cols-1'
  if (slots.length <= 2) return 'grid-cols-1 lg:grid-cols-2'
  return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
}

export function CompareResultsGrid({ slots, layout, stacked = false }: CompareResultsGridProps) {
  return (
    <motion.div
      layout
      className={cn('grid gap-3', gridClass(slots, layout, stacked))}
      data-testid="llm-compare-results"
    >
      <AnimatePresence mode="popLayout">
        {slots.map((slot, idx) => (
          <CompareResultCard key={`${slot.model}-${idx}`} slot={slot} index={idx} />
        ))}
      </AnimatePresence>
    </motion.div>
  )
}

function CompareResultCard({ slot, index }: { slot: CompareSlot; index: number }) {
  const [copied, setCopied] = useState(false)
  const running = slotRunning(slot.status)
  const accent = SLOT_ACCENTS[index % SLOT_ACCENTS.length]
  const badge = SLOT_BADGE[index % SLOT_BADGE.length]

  function handleCopy() {
    if (!slot.content) return
    void navigator.clipboard.writeText(slot.content).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: index * 0.05 }}
      className={cn(
        'flex min-h-40 flex-col overflow-hidden rounded-2xl border shadow-sm backdrop-blur-sm sm:min-h-48',
        accent,
        running && 'ring-1 ring-primary/20',
      )}
      data-testid={`llm-compare-slot-${index}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
              badge,
            )}
          >
            {index + 1}
          </span>
          <span className="truncate font-mono text-xs font-semibold">
            {capabilityBaseLabel(slot.model)}
          </span>
          <StatusIcon status={slot.status} />
        </div>
        <div className="flex items-center gap-1">
          {slot.content && (
            <>
              <SpeechListenWidget
                text={slot.content}
                triggerVariant="ghost"
                testIdPrefix={`compare-slot-${index}`}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Copy response"
              >
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-sm">
        {running && !slot.log && !slot.content && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs italic capitalize">{slot.status.replace(/_/g, ' ')}…</span>
          </div>
        )}

        {running && slot.log && (
          <motion.div
            animate={{ opacity: [1, 0.55, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          >
            <MarkdownContent>{slot.log}</MarkdownContent>
          </motion.div>
        )}

        {slot.content && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35 }}
          >
            <MarkdownContent>{slot.content}</MarkdownContent>
          </motion.div>
        )}

        {slot.status === 'failed' && slot.error && (
          <p className="text-xs text-destructive">{slot.error}</p>
        )}

        {slot.status === 'canceled' && !slot.content && (
          <p className="text-xs italic text-muted-foreground">Canceled</p>
        )}
      </div>
    </motion.article>
  )
}

function StatusIcon({ status }: { status: string }) {
  if (slotRunning(status)) {
    return <Loader2 className="size-3.5 animate-spin text-primary" />
  }
  if (status === 'completed') {
    return <CheckCircle2 className="size-3.5 text-emerald-500" />
  }
  if (status === 'failed') {
    return <AlertCircle className="size-3.5 text-destructive" />
  }
  if (status === 'canceled') {
    return <CircleX className="size-3.5 text-muted-foreground" />
  }
  return null
}
