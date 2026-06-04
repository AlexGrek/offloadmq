import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ModelAvailabilityDot } from '@/components/chat/ModelAvailabilityDot'
import type { CapabilitiesStatus } from '@/lib/capabilitiesStatus'
import { capabilityBaseLabel, sortCapabilitiesForPicker } from '@/lib/modelAvailability'
import { cn } from '@/lib/utils'
import type { LlmCapabilityInfo } from '@/types/ws'

export type PickerCapability = LlmCapabilityInfo

export interface CapabilityModelPickerProps {
  capabilities: PickerCapability[]
  selected: string
  onSelect: (base: string) => void
  onRefresh: () => void
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
  /** `form` — full-width bordered control (job pages). `inline` — compact trigger (chat composer). */
  variant?: 'form' | 'inline'
  /** Dropdown opens above or below the trigger. */
  placement?: 'above' | 'below'
  formatLabel?: (cap: PickerCapability) => string
  filterTags?: (tags: string[]) => string[]
  testIdPrefix?: string
  /** When set, trigger stays disabled until WebSocket is connected (chat). */
  connectionLabel?: string | null
}

export function CapabilityModelPicker({
  capabilities,
  selected,
  onSelect,
  onRefresh,
  capabilitiesStatus,
  capabilitiesError,
  variant = 'form',
  placement = 'below',
  formatLabel = cap => capabilityBaseLabel(cap.base),
  filterTags = tags => tags,
  testIdPrefix = 'capability-model-picker',
  connectionLabel = null,
}: CapabilityModelPickerProps) {
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
  const modelsLoading = capabilitiesStatus === 'loading'
  const modelsError = capabilitiesStatus === 'error'
  const offline = Boolean(connectionLabel)
  const label =
    offline ? connectionLabel :
    modelsLoading ? 'Loading models…' :
    modelsError ? (capabilitiesError ?? 'Failed to load models') :
    sorted.length === 0 ? 'No models' :
    selectedCap ? formatLabel(selectedCap) :
    'Pick model'

  const canOpen =
    !offline && capabilitiesStatus === 'ready' && sorted.length > 0
  const triggerDisabled =
    offline ||
    modelsLoading ||
    (capabilitiesStatus === 'ready' && sorted.length === 0)

  const dropdownPosition =
    placement === 'above'
      ? 'absolute bottom-full mb-1 left-0'
      : 'absolute top-full mt-1 left-0'

  const isForm = variant === 'form'

  return (
    <div className="relative" ref={ref} data-testid={testIdPrefix}>
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
        data-testid={`${testIdPrefix}-trigger`}
        title={modelsError ? capabilitiesError ?? undefined : undefined}
        className={cn(
          'flex items-center gap-1.5 transition-colors',
          isForm
            ? 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm'
            : 'rounded-md px-2 py-1 text-xs max-w-48',
          modelsError
            ? isForm
              ? 'border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer'
              : 'text-destructive hover:bg-destructive/10 cursor-pointer'
            : canOpen
              ? isForm
                ? 'text-foreground hover:bg-muted/50 cursor-pointer'
                : 'text-foreground hover:bg-muted cursor-pointer'
              : isForm
                ? 'text-muted-foreground cursor-default opacity-60'
                : 'text-muted-foreground cursor-default',
        )}
      >
        {modelsLoading && (
          <Loader2
            className={cn('shrink-0 animate-spin', isForm ? 'size-3.5' : 'size-3')}
            data-testid={`${testIdPrefix}-loading`}
          />
        )}
        {modelsError && (
          <AlertCircle
            className={cn('shrink-0', isForm ? 'size-3.5' : 'size-3')}
            data-testid={`${testIdPrefix}-error`}
          />
        )}
        {!modelsLoading && !modelsError && selectedCap && (
          <ModelAvailabilityDot cap={selectedCap} />
        )}
        <span className={cn('truncate', isForm && 'flex-1 text-left')}>{label}</span>
        {canOpen && (
          <ChevronDown
            className={cn(
              'shrink-0 text-muted-foreground transition-transform',
              isForm ? 'size-3.5' : 'size-3',
              open && 'rotate-180',
            )}
          />
        )}
        {modelsError && (
          <RefreshCw className={cn('shrink-0 opacity-70', isForm ? 'size-3.5' : 'size-3')} aria-hidden />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={cn(
              dropdownPosition,
              'z-50 min-w-full overflow-hidden rounded-xl border border-border bg-popover shadow-md text-sm',
              !isForm && 'min-w-45',
            )}
            data-testid={`${testIdPrefix}-dropdown`}
            initial={{ opacity: 0, y: placement === 'above' ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: placement === 'above' ? 6 : -6, scale: 0.96 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              <span>Models</span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onRefresh() }}
                title="Refresh"
                className="hover:text-foreground transition-colors"
              >
                <RefreshCw className="size-3" />
              </button>
            </div>
            <div
              className="max-h-[min(50vh,16rem)] overflow-y-auto overscroll-contain py-1"
              data-testid={`${testIdPrefix}-list`}
            >
              {sorted.map(cap => {
                const tags = filterTags(cap.tags)
                return (
                  <button
                    key={cap.raw}
                    type="button"
                    onClick={() => { onSelect(cap.base); setOpen(false) }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted cursor-pointer',
                      cap.base === selected && 'bg-muted font-medium',
                      !cap.online && 'opacity-70',
                    )}
                    data-testid={`${testIdPrefix}-option-${cap.base}`}
                  >
                    <ModelAvailabilityDot cap={cap} />
                    <span className="flex-1 truncate">{formatLabel(cap)}</span>
                    {tags.length > 0 && (
                      <span className="flex gap-1 shrink-0">
                        {tags.map(t => (
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
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
