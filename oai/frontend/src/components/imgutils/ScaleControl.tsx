import {
  MAX_SCALE_MULTIPLIER,
  MIN_SCALE_MULTIPLIER,
} from '../../api/imgUtils'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { cn } from '../../lib/utils'

const PRESETS = [2, 4, 6, 8]

export type ScaleControlProps = {
  value: number
  onChange: (value: number) => void
  /** Prefixes every `data-testid` and the input id. */
  testIdPrefix?: string
  /** Drops the surrounding frame — used inside the quick-transform popup. */
  compact?: boolean
}

/** Scale-multiplier knob for upscale tools (`secondary_prompts.scale_multiplier`). */
export function ScaleControl({
  value,
  onChange,
  testIdPrefix = 'imgutils',
  compact = false,
}: ScaleControlProps) {
  const inputId = `${testIdPrefix}-scale-input`
  return (
    <div
      className={cn('space-y-2', !compact && 'rounded-xl border border-border p-3')}
      data-testid={`${testIdPrefix}-scale`}
    >
      <Label htmlFor={inputId}>Scale multiplier</Label>
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(preset => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              value === preset
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
            )}
            data-testid={`${testIdPrefix}-scale-preset-${preset}`}
          >
            {preset}×
          </button>
        ))}
        <Input
          id={inputId}
          type="number"
          min={MIN_SCALE_MULTIPLIER}
          max={MAX_SCALE_MULTIPLIER}
          step={1}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="h-9 w-24"
          data-testid={`${testIdPrefix}-scale-value`}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Output is roughly {value}× the input on each edge.
      </p>
    </div>
  )
}
