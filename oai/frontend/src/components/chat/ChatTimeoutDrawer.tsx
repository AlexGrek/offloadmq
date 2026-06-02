import { AnimatePresence, motion } from 'framer-motion'
import { Clock, RotateCcw, X } from 'lucide-react'

export type ChatTimeoutSettings = {
  timeoutSecs: number | null
  maxWaitSecs: number | null
  runtimeSecs: number | null
}

export const DEFAULT_TIMEOUT_SETTINGS: ChatTimeoutSettings = {
  timeoutSecs: 1500,
  maxWaitSecs: 300,
  runtimeSecs: 1200,
}

const TIMEOUT_DEFS: {
  key: keyof ChatTimeoutSettings
  label: string
  sublabel: string
  description: string
  placeholder: string
}[] = [
  {
    key: 'timeoutSecs',
    label: 'Total timeout',
    sublabel: 'timeoutSecs · server-enforced',
    description:
      'Wall-clock deadline from task creation, covering both the wait-for-agent phase and the execution phase. ' +
      'When this expires while the task is queued, it fails immediately. ' +
      'When it expires while running, the server sends a stop signal (HTTP 499) to the agent. ' +
      'Leave empty for no server deadline — agents fall back to their own defaults (~600 s).',
    placeholder: 'No limit',
  },
  {
    key: 'maxWaitSecs',
    label: 'Max wait for agent',
    sublabel: 'maxWaitSecs · server-enforced',
    description:
      'Maximum seconds to wait for an agent to pick up the task. ' +
      'If no agent claims it within this window the task fails immediately, without ever executing. ' +
      'Useful when you want fast failure rather than indefinite queuing. ' +
      'Leave empty for no wait limit — persistent tasks queue until an agent becomes available.',
    placeholder: 'No limit',
  },
  {
    key: 'runtimeSecs',
    label: 'Agent execution time',
    sublabel: 'runtimeSecs · agent-enforced',
    description:
      'Maximum seconds the agent may spend executing the task after pickup, not counting wait time. ' +
      'The server passes this value to the agent unchanged and never enforces it directly — ' +
      'the agent applies it as a local kill timer: HTTP timeout for LLM inference, process kill for shell tasks, etc. ' +
      'Leave empty to use the agent\'s built-in default (~600 s). ' +
      'Tip: combine with a long timeoutSecs (e.g. 3 h) to allow queuing but cap the actual inference.',
    placeholder: 'Agent default (~600 s)',
  },
]

interface Props {
  open: boolean
  onClose: () => void
  settings: ChatTimeoutSettings
  onChange: (key: keyof ChatTimeoutSettings, value: number | null) => void
}

export function ChatTimeoutDrawer({ open, onClose, settings, onChange }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 bottom-0 z-50 w-84 max-w-[90vw] bg-background border-l border-border flex flex-col shadow-xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
          >
            <div className="flex items-center justify-between px-4 h-11 border-b border-border shrink-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="size-3.5" />
                Timing settings
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded hover:bg-muted transition-colors"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-6">
              <p className="text-xs text-muted-foreground">
                Per-task timeout controls sent to OffloadMQ with each chat message in this chat.
                Leave fields empty to use defaults.
              </p>

              {TIMEOUT_DEFS.map(def => {
                const value = settings[def.key]
                return (
                  <div key={def.key} className="space-y-2">
                    <div>
                      <div className="text-sm font-medium">{def.label}</div>
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {def.sublabel}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {def.description}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        value={value ?? ''}
                        placeholder={def.placeholder}
                        onChange={e => {
                          const raw = e.target.value
                          onChange(def.key, raw === '' ? null : Math.max(1, parseInt(raw, 10)))
                        }}
                        className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground"
                      />
                      <span className="text-xs text-muted-foreground shrink-0">seconds</span>
                      {value !== null && (
                        <button
                          type="button"
                          onClick={() => onChange(def.key, null)}
                          title="Reset to default"
                          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
                        >
                          <RotateCcw className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
