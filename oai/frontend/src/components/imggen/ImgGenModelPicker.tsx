import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CapabilitiesStatus } from '../../lib/capabilitiesStatus'
import {
  sortCapabilitiesForPicker,
  unavailableModelDotOpacity,
} from '../../lib/modelAvailability'
import { modelNameFromCapability } from '../../lib/imggen'
import type { ImgGenCapability } from '../../api/images'
import type { LlmCapabilityInfo } from '../../types/ws'

function AvailabilityDot({ cap }: { cap: ImgGenCapability }) {
  if (cap.online) {
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-emerald-500"
        aria-hidden
        data-testid="imggen-model-dot-online"
      />
    )
  }
  const opacity = unavailableModelDotOpacity(cap.last_available_at)
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-amber-400"
      style={{ opacity }}
      aria-hidden
      data-testid="imggen-model-dot-offline"
    />
  )
}

function capLabel(cap: ImgGenCapability): string {
  return modelNameFromCapability(cap.base)
}

// ImgGenCapability is structurally compatible with LlmCapabilityInfo for sorting
function toSortable(cap: ImgGenCapability): LlmCapabilityInfo {
  return cap as unknown as LlmCapabilityInfo
}

interface ImgGenModelPickerProps {
  capabilities: ImgGenCapability[]
  selected: string
  onSelect: (base: string) => void
  onRefresh: () => void
  capabilitiesStatus: CapabilitiesStatus
  capabilitiesError: string | null
}

export function ImgGenModelPicker({
  capabilities,
  selected,
  onSelect,
  onRefresh,
  capabilitiesStatus,
  capabilitiesError,
}: ImgGenModelPickerProps) {
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

  const sorted = sortCapabilitiesForPicker(
    capabilities.map(toSortable),
  ) as unknown as ImgGenCapability[]

  const selectedCap = sorted.find(c => c.base === selected)
  const modelsLoading = capabilitiesStatus === 'loading'
  const modelsError = capabilitiesStatus === 'error'
  const label =
    modelsLoading ? 'Loading models…' :
    modelsError ? (capabilitiesError ?? 'Failed to load models') :
    sorted.length === 0 ? 'No models' :
    selectedCap         ? capLabel(selectedCap) :
                          'Pick model'

  const canOpen = capabilitiesStatus === 'ready' && sorted.length > 0
  const triggerDisabled =
    modelsLoading || (capabilitiesStatus === 'ready' && sorted.length === 0)

  return (
    <div className="relative" ref={ref} data-testid="imggen-model-picker">
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
        data-testid="imggen-model-picker-trigger"
        title={modelsError ? capabilitiesError ?? undefined : undefined}
        className={cn(
          'flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm transition-colors',
          modelsError
            ? 'border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer'
            : canOpen
              ? 'text-foreground hover:bg-muted/50 cursor-pointer'
              : 'text-muted-foreground cursor-default opacity-60',
        )}
      >
        {modelsLoading && (
          <Loader2 className="size-3.5 shrink-0 animate-spin" data-testid="imggen-model-picker-loading" />
        )}
        {modelsError && (
          <AlertCircle className="size-3.5 shrink-0" data-testid="imggen-model-picker-error" />
        )}
        {!modelsLoading && !modelsError && selectedCap && (
          <AvailabilityDot cap={selectedCap} />
        )}
        <span className="flex-1 truncate text-left">{label}</span>
        {canOpen && (
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        )}
        {modelsError && (
          <RefreshCw className="size-3.5 shrink-0 opacity-70" aria-hidden />
        )}
      </button>

      {open && (
        <div
          className="absolute top-full mt-1 left-0 z-50 min-w-full overflow-hidden rounded-xl border border-border bg-popover shadow-md text-sm"
          data-testid="imggen-model-picker-dropdown"
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
            data-testid="imggen-model-picker-list"
          >
            {sorted.map(cap => (
              <button
                key={cap.raw}
                type="button"
                onClick={() => { onSelect(cap.base); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted cursor-pointer',
                  cap.base === selected && 'bg-muted font-medium',
                  !cap.online && 'opacity-70',
                )}
                data-testid={`imggen-model-option-${cap.base}`}
              >
                <AvailabilityDot cap={cap} />
                <span className="flex-1 truncate">{capLabel(cap)}</span>
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
        </div>
      )}
    </div>
  )
}
