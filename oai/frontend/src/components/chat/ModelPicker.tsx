import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import { modelLabel, sortCapabilitiesForPicker } from '@/lib/modelAvailability'
import type { LlmCapabilityInfo } from '@/types/ws'
import { ModelAvailabilityDot } from './ModelAvailabilityDot'

/** Popover model selector pinned to the chat composer. */
export function ModelPicker({
  capabilities,
  selected,
  onSelect,
  onRefresh,
  wsStatus,
  capabilitiesStatus,
  capabilitiesError,
}: {
  capabilities: LlmCapabilityInfo[]
  selected: string | null
  onSelect: (base: string) => void
  onRefresh: () => void
  wsStatus: string
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const sorted = sortCapabilitiesForPicker(capabilities)
  const selectedCap = sorted.find(c => c.base === selected)
  const modelsLoading = wsStatus === 'connected' && capabilitiesStatus === 'loading'
  const modelsError = wsStatus === 'connected' && capabilitiesStatus === 'error'
  const label =
    wsStatus === 'connecting' ? 'Connecting…' :
    wsStatus !== 'connected'  ? 'Offline' :
    modelsLoading ? 'Loading models…' :
    modelsError ? (capabilitiesError ?? 'Failed to load models') :
    sorted.length === 0 ? 'No models' :
    selectedCap               ? modelLabel(selectedCap) :
                                'Pick model'

  const canOpen = wsStatus === 'connected' && capabilitiesStatus === 'ready' && sorted.length > 0
  const triggerDisabled =
    wsStatus !== 'connected' || modelsLoading || (capabilitiesStatus === 'ready' && sorted.length === 0)

  return (
    <div className="relative" ref={ref} data-testid="model-picker">
      <button
        type="button"
        onClick={() => {
          if (modelsError) {
            onRefresh()
            return
          }
          if (canOpen) setOpen(v => !v)
        }}
        disabled={triggerDisabled}
        data-testid="model-picker-trigger"
        title={modelsError ? capabilitiesError ?? undefined : undefined}
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors max-w-48',
          modelsError
            ? 'text-destructive hover:bg-destructive/10 cursor-pointer'
            : canOpen || modelsError
              ? 'text-foreground hover:bg-muted cursor-pointer'
              : 'text-muted-foreground cursor-default',
        )}
      >
        {modelsLoading && (
          <Loader2 className="size-3 shrink-0 animate-spin" data-testid="model-picker-loading" />
        )}
        {modelsError && (
          <AlertCircle className="size-3 shrink-0" data-testid="model-picker-error" />
        )}
        {!modelsLoading && !modelsError && selectedCap && (
          <ModelAvailabilityDot cap={selectedCap} />
        )}
        <span className="truncate">{label}</span>
        {canOpen && <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} />}
        {modelsError && (
          <RefreshCw className="size-3 shrink-0 opacity-70" aria-hidden />
        )}
      </button>

      <AnimatePresence>
      {open && (
        <motion.div
          className="absolute bottom-full mb-1 left-0 z-50 min-w-45 overflow-hidden rounded-xl border border-border bg-popover shadow-md text-sm"
          data-testid="model-picker-dropdown"
          initial={{ opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>Models</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRefresh() }}
              title="Refresh"
              className="hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
            </button>
          </div>
          <div
            className="max-h-[min(50vh,16rem)] overflow-y-auto overscroll-contain py-1"
            data-testid="model-picker-list"
          >
            {sorted.map(cap => (
              <button
                key={cap.raw}
                type="button"
                onClick={() => { onSelect(cap.base); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted cursor-pointer',
                  cap.base === selected && 'bg-muted font-medium',
                )}
                data-testid={`model-option-${cap.base}`}
              >
                <ModelAvailabilityDot cap={cap} />
                <span className="flex-1 truncate">{modelLabel(cap)}</span>
                {cap.tags.length > 0 && (
                  <span className="flex gap-1 shrink-0">
                    {cap.tags.map(t => (
                      <span
                        key={t}
                        className="rounded px-1 py-0.5 text-[10px] font-medium bg-accent text-accent-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
