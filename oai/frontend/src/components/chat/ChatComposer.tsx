import { motion } from 'framer-motion'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import type { LlmCapabilityInfo } from '@/types/ws'
import { ModelPicker } from './ModelPicker'

/** Pinned message composer: auto-growing textarea, model picker, send/cancel. */
export function ChatComposer({
  value,
  onChange,
  onSend,
  wsStatus,
  hasActiveChat,
  capabilities,
  selectedModel,
  onModelSelect,
  onRefreshCapabilities,
  capabilitiesStatus,
  capabilitiesError,
  isGenerating,
  canSend,
  canCancelTask,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  wsStatus: string
  hasActiveChat: boolean
  capabilities: LlmCapabilityInfo[]
  selectedModel: string | null
  onModelSelect: (base: string) => void
  onRefreshCapabilities: () => void
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  isGenerating: boolean
  canSend: boolean
  canCancelTask: boolean
  onCancel: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [value])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
      <div className="max-w-2xl mx-auto">
        <div
          className="group/input-group rounded-2xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          data-testid="chat-input-box"
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              !hasActiveChat ? 'Select or create a chat first' :
              wsStatus === 'connected' ? 'Message…' : 'Connecting…'
            }
            disabled={wsStatus !== 'connected' || !hasActiveChat}
            rows={1}
            data-testid="chat-input"
            className="block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            style={{ minHeight: '44px', maxHeight: '200px' }}
          />

          <div className="flex items-center gap-2 px-2 pb-2">
            <Button
              variant="outline"
              size="icon-xs"
              title="Attach"
              className="rounded-full shrink-0"
              disabled
            >
              <Plus />
            </Button>

            <ModelPicker
              capabilities={capabilities}
              selected={selectedModel}
              onSelect={onModelSelect}
              onRefresh={onRefreshCapabilities}
              wsStatus={wsStatus}
              capabilitiesStatus={capabilitiesStatus}
              capabilitiesError={capabilitiesError}
            />

            <span className="flex-1" />

            {isGenerating ? (
              <motion.button
                type="button"
                onClick={onCancel}
                disabled={!canCancelTask}
                aria-label="Cancel"
                data-testid="chat-cancel-btn"
                title={canCancelTask ? 'Cancel response' : 'Waiting for task id…'}
                whileTap={canCancelTask ? { scale: 0.85 } : undefined}
                className={cn(
                  'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                  canCancelTask
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
              >
                <Square className="size-3.5 fill-current" />
              </motion.button>
            ) : (
              <motion.button
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send"
                data-testid="send-btn"
                whileTap={canSend ? { scale: 0.85 } : undefined}
                className={cn(
                  'size-7 rounded-full flex items-center justify-center shrink-0 transition-colors',
                  canSend
                    ? 'bg-foreground text-background hover:bg-foreground/80'
                    : 'bg-muted text-muted-foreground cursor-not-allowed',
                )}
              >
                <ArrowUp className="size-4" />
              </motion.button>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-2 select-none">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </div>
  )
}
