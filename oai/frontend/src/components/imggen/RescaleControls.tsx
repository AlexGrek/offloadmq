import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import type { RescaleMode, RescaleState } from '@/lib/imggen'

interface RescaleControlsProps {
  state: RescaleState
  onChange: (patch: Partial<RescaleState>) => void
  label?: string
}

export default function RescaleControls({
  state,
  onChange,
  label = 'Rescale input image',
}: RescaleControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3" data-testid="imggen-rescale">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          className="rounded border-border"
        />
        {label}
      </label>
      {state.enabled && (
        <>
          <select
            value={state.mode}
            onChange={e => onChange({ mode: e.target.value as RescaleMode })}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Rescale mode"
          >
            <option value="exact">exact</option>
            <option value="max">max</option>
          </select>
          {state.mode === 'exact' ? (
            <>
              <Input
                type="number"
                value={state.width}
                onChange={e => onChange({ width: Number(e.target.value) || 768 })}
                className="h-8 w-20 text-xs"
                aria-label="Rescale width"
              />
              <span className="text-xs text-muted-foreground">×</span>
              <Input
                type="number"
                value={state.height}
                onChange={e => onChange({ height: Number(e.target.value) || 768 })}
                className="h-8 w-20 text-xs"
                aria-label="Rescale height"
              />
            </>
          ) : (
            <>
              <Label className="text-xs text-muted-foreground">px</Label>
              <Input
                type="number"
                value={state.px}
                onChange={e =>
                  onChange({ px: e.target.value === '' ? '' : Number(e.target.value) })
                }
                placeholder="—"
                className="h-8 w-20 text-xs"
                aria-label="Max pixels per side"
              />
              <Label className="text-xs text-muted-foreground">mp</Label>
              <Input
                type="number"
                step="0.5"
                value={state.mp}
                onChange={e =>
                  onChange({ mp: e.target.value === '' ? '' : Number(e.target.value) })
                }
                placeholder="—"
                className="h-8 w-20 text-xs"
                aria-label="Max megapixels"
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
