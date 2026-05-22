import { useCallback, useEffect, useState } from 'react'
import { Bug, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { fetchOffloadPoll } from '../api/debug'
import type { ServerEvent } from '../types/ws'

export type ToolDebugModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  cap: string | null | undefined
  taskId: string | null | undefined
  wsEvents?: ServerEvent[]
  disabledReason?: string
  /** e.g. chat title or "Image job 42" */
  subject?: string
}

export function toolDebugReady(cap: string | null | undefined, taskId: string | null | undefined): boolean {
  return Boolean(cap?.trim() && taskId?.trim())
}

export function ToolDebugHeaderButton({
  onClick,
  disabled,
  active,
  className,
}: {
  onClick: () => void
  disabled?: boolean
  /** Task ids available — highlight button */
  active?: boolean
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Debug unavailable' : 'OffloadMQ task debug'}
      aria-label="Open debug"
      data-testid="tool-debug-open"
      className={cn(
        active && 'text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <Bug className="size-4" />
      <span className="ml-1.5 hidden sm:inline">Debug</span>
    </Button>
  )
}

export function ToolDebugModal({
  open,
  onOpenChange,
  cap,
  taskId,
  wsEvents = [],
  disabledReason,
  subject,
}: ToolDebugModalProps) {
  const { token } = useAuth()
  const [pollJson, setPollJson] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canPoll = Boolean(token && toolDebugReady(cap, taskId))

  const refreshPoll = useCallback(async () => {
    if (!token || !cap || !taskId) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchOffloadPoll(token, cap, taskId)
      setPollJson(JSON.stringify(data, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Poll failed')
    } finally {
      setLoading(false)
    }
  }, [token, cap, taskId])

  useEffect(() => {
    if (!open) {
      setPollJson('')
      setError(null)
      setLoading(false)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0"
        data-testid="tool-debug-modal"
        onOpenAutoFocus={e => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-4 text-amber-600 dark:text-amber-400" />
            Debug
          </DialogTitle>
          <DialogDescription className="space-y-1">
            {subject && <span className="block truncate font-medium text-foreground">{subject}</span>}
            {cap && taskId ? (
              <span className="block font-mono text-xs break-all">
                {cap} / {taskId}
              </span>
            ) : (
              <span>No OffloadMQ task linked yet.</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {disabledReason && (
            <p className="text-xs text-muted-foreground">{disabledReason}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canPoll || loading}
              onClick={() => void refreshPoll()}
              data-testid="tool-debug-fetch-poll"
            >
              {loading ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 size-3.5" />
              )}
              Fetch OffloadMQ poll
            </Button>
            <span className="text-[10px] text-muted-foreground">Client API · works when completed</span>
          </div>
          {error && (
            <p className="text-xs text-destructive" data-testid="tool-debug-error">
              {error}
            </p>
          )}
          {wsEvents.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">WebSocket events</p>
              <pre
                className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed"
                data-testid="tool-debug-ws"
              >
                {JSON.stringify(wsEvents, null, 2)}
              </pre>
            </div>
          )}
          {pollJson && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">OffloadMQ poll response</p>
              <pre
                className="max-h-[40dvh] overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words"
                data-testid="tool-debug-poll"
              >
                {pollJson}
              </pre>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
