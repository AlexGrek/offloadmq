import { Loader2, MessageCircleMore, Plus } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { LlmDebateJob } from '../../api/llmDebate'
import { capabilityBaseLabel } from '../../lib/modelAvailability'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
export const LLM_DEBATE_NEW_PANEL = 'new' as const

type LlmDebateHistorySidebarProps = {
  jobs: LlmDebateJob[]
  activePanel: string
  loading?: boolean
  onSelectNew: () => void
  onSelectJob: (jobId: string) => void
}

function statusLabel(status: string): string | null {
  if (TERMINAL.has(status)) return null
  return status.replace(/_/g, ' ')
}

function jobTitle(prompt: string, limit = 72): string {
  const trimmed = prompt.trim()
  if (!trimmed) return 'Debate'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export function LlmDebateHistorySidebar({
  jobs,
  activePanel,
  loading,
  onSelectNew,
  onSelectJob,
}: LlmDebateHistorySidebarProps) {
  const isNewActive = activePanel === LLM_DEBATE_NEW_PANEL

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onSelectNew}
        data-testid="llm-debate-new-panel-btn"
        className={cn(
          'mx-1 mt-1 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors',
          isNewActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
        )}
      >
        <Plus className="size-4 shrink-0" />
        New
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No debates yet</p>
        ) : (
          <ul className="space-y-1">
            {jobs.map((job, i) => {
              const active = activePanel === job.job_id
              const inProgress = statusLabel(job.status)
              return (
                <motion.li
                  key={job.job_id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.2 }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.job_id)}
                    data-testid={`llm-debate-item-${job.job_id}`}
                    className={cn(
                      'group relative w-full overflow-hidden rounded-lg text-left transition-colors',
                      'min-h-17 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-sidebar-accent shadow-sm ring-2 ring-sidebar-primary'
                        : 'bg-sidebar-accent/30 ring-1 ring-sidebar-border hover:ring-sidebar-accent',
                    )}
                  >
                    <div className="relative z-10 flex min-h-17 flex-col justify-center gap-0.5 px-3 py-2">
                      <div className="flex items-start gap-1.5">
                        <MessageCircleMore className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <p className="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-snug text-foreground">
                          {jobTitle(job.initial_prompt)}
                        </p>
                      </div>
                      <span className="truncate pl-5 font-mono text-[10px] text-muted-foreground/80">
                        {capabilityBaseLabel(job.model_a)} vs {capabilityBaseLabel(job.model_b)}
                      </span>
                      <span className="pl-5">
                        {inProgress ? (
                          <span className="inline-flex w-fit items-center gap-1 text-[10px] text-muted-foreground">
                            <span className="size-1.5 animate-pulse rounded-full bg-primary/80" />
                            {inProgress}
                          </span>
                        ) : job.status === 'failed' ? (
                          <span className="text-[10px] font-medium text-destructive">Failed</span>
                        ) : job.status === 'completed' ? (
                          <span className="text-[10px] text-muted-foreground">Completed</span>
                        ) : (
                          <span className="text-[10px] capitalize text-muted-foreground">
                            {job.status}
                          </span>
                        )}
                      </span>
                    </div>
                  </button>
                </motion.li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
