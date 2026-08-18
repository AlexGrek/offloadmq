import { RefreshCw } from 'lucide-react'
import { prettyLabel, toolKey, type ImgUtilTool } from '../../api/imgUtils'
import { Label } from '../ui/label'
import { cn } from '../../lib/utils'
import { operationHint } from '../../lib/imgUtilsHints'

export type ImgUtilsToolPickerProps = {
  tools: ImgUtilTool[]
  loading: boolean
  selectedKey: string
  activeTool: ImgUtilTool | null
  onSelect: (key: string) => void
  onRefresh: () => void
  /** Chip-sized layout for the quick-transform popup. */
  compact?: boolean
  /** Prefixes every `data-testid` so page and popup stay distinguishable. */
  testIdPrefix?: string
}

/** Tool chips + the "N tool(s) online / Refresh" status row. */
export function ImgUtilsToolPicker({
  tools,
  loading,
  selectedKey,
  activeTool,
  onSelect,
  onRefresh,
  compact = false,
  testIdPrefix = 'imgutils',
}: ImgUtilsToolPickerProps) {
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-tool-picker`}>
      <div className="flex items-center justify-between gap-2">
        {compact ? (
          <Label>Tool</Label>
        ) : (
          <span className="text-xs text-muted-foreground">
            {loading
              ? 'Checking agents…'
              : tools.length === 0
                ? 'No image tools online — check OffloadMQ agents'
                : `${tools.length} tool(s) online`}
          </span>
        )}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onRefresh}
          disabled={loading}
          data-testid={`${testIdPrefix}-refresh-capabilities`}
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {compact ? null : <Label>Tool</Label>}

      <div className="flex flex-wrap gap-2">
        {tools.map(tool => {
          const key = toolKey(tool)
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={cn(
                'rounded-lg text-left transition-colors',
                compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
                key === selectedKey
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted',
              )}
              data-testid={`${testIdPrefix}-tool-${tool.workflow}`}
            >
              <span className="block">{prettyLabel(tool.workflow)}</span>
              <span className="block truncate text-[10px] opacity-70">{tool.pack}</span>
            </button>
          )
        })}
      </div>

      {compact && !loading && tools.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No image tools online — check OffloadMQ agents.
        </p>
      ) : null}

      {activeTool ? (
        <p className="text-xs text-muted-foreground">
          {operationHint(activeTool.workflow)}{' '}
          <code className="text-[11px]">{activeTool.capability}</code>
        </p>
      ) : null}
    </div>
  )
}
