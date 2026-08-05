import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MAX_RESIZE_EDGE,
  RESIZE_FIT_MODES,
  type ResizeFitMode,
  type ResizeFormState,
  type ResizeOutputFormat,
  type ResizeSizeMode,
} from '@/api/imgUtils'
import { cn } from '@/lib/utils'

/** Quick targets for the pixel presets — long edge of a `fit` box. */
const PIXEL_PRESETS = [512, 768, 1024, 1920]
const PERCENT_PRESETS = [25, 50, 75]

interface ResizeControlsProps {
  state: ResizeFormState
  onChange: (patch: Partial<ResizeFormState>) => void
  /** Resampling filters the online agent advertised. */
  methods: string[]
  /** Dimensions of the picked input, when one is loaded — shown as the "from" size. */
  inputSize?: { width: number; height: number } | null
  error?: string | null
}

export default function ResizeControls({
  state,
  onChange,
  methods,
  inputSize,
  error,
}: ResizeControlsProps) {
  const dimensionsDisabled = state.sizeMode === 'percent'

  return (
    <div className="space-y-4 rounded-xl border border-border p-3" data-testid="imgutils-resize">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Target size</Label>
        <Segmented<ResizeSizeMode>
          value={state.sizeMode}
          options={[
            { value: 'pixels', label: 'Pixels' },
            { value: 'percent', label: 'Percent' },
          ]}
          onChange={sizeMode => onChange({ sizeMode })}
          testId="imgutils-resize-size-mode"
        />
      </div>

      {dimensionsDisabled ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={400}
              value={state.percent}
              onChange={e => onChange({ percent: Number(e.target.value) || 0 })}
              className="h-9 w-24"
              aria-label="Scale percent"
              data-testid="imgutils-resize-percent"
            />
            <span className="text-sm text-muted-foreground">% of the original</span>
            <div className="flex gap-1">
              {PERCENT_PRESETS.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onChange({ percent: p })}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs transition-colors',
                    state.percent === p
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                  )}
                  data-testid={`imgutils-resize-percent-${p}`}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
          {inputSize ? (
            <p className="text-xs text-muted-foreground">
              {inputSize.width}×{inputSize.height} →{' '}
              {Math.max(1, Math.round((inputSize.width * state.percent) / 100))}×
              {Math.max(1, Math.round((inputSize.height * state.percent) / 100))}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={MAX_RESIZE_EDGE}
              value={state.width}
              onChange={e =>
                onChange({ width: e.target.value === '' ? '' : Number(e.target.value) })
              }
              placeholder="auto"
              className="h-9 w-24"
              aria-label="Width"
              data-testid="imgutils-resize-width"
            />
            <span className="text-sm text-muted-foreground">×</span>
            <Input
              type="number"
              min={1}
              max={MAX_RESIZE_EDGE}
              value={state.height}
              onChange={e =>
                onChange({ height: e.target.value === '' ? '' : Number(e.target.value) })
              }
              placeholder="auto"
              className="h-9 w-24"
              aria-label="Height"
              data-testid="imgutils-resize-height"
            />
            <div className="flex gap-1">
              {PIXEL_PRESETS.map(px => (
                <button
                  key={px}
                  type="button"
                  onClick={() => onChange({ width: px, height: px })}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs transition-colors',
                    state.width === px && state.height === px
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                  )}
                  data-testid={`imgutils-resize-preset-${px}`}
                >
                  {px}
                </button>
              ))}
            </div>
          </div>
          {state.mode === 'fit' ? (
            <p className="text-xs text-muted-foreground">
              Leave one field blank to size by the other edge alone.
            </p>
          ) : null}
        </div>
      )}

      {!dimensionsDisabled ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">How to fit the box</Label>
          <Segmented<ResizeFitMode>
            value={state.mode}
            options={RESIZE_FIT_MODES.map(m => ({ value: m.value, label: m.label }))}
            onChange={mode => onChange({ mode })}
            testId="imgutils-resize-mode"
          />
          <p className="text-xs text-muted-foreground">
            {RESIZE_FIT_MODES.find(m => m.value === state.mode)?.hint}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        {methods.length > 0 ? (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Filter</Label>
            <select
              value={state.method}
              onChange={e => onChange({ method: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              aria-label="Resampling filter"
              data-testid="imgutils-resize-method"
            >
              {methods.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Format</Label>
          <select
            value={state.format}
            onChange={e => onChange({ format: e.target.value as ResizeOutputFormat })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Output format"
            data-testid="imgutils-resize-format"
          >
            <option value="">Same as input</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
        </div>

        {state.format === 'jpeg' || state.format === 'webp' ? (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Quality</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={state.quality}
              onChange={e => onChange({ quality: Number(e.target.value) || 90 })}
              className="h-9 w-20"
              aria-label="Encoder quality"
              data-testid="imgutils-resize-quality"
            />
          </div>
        ) : null}
      </div>

      {!dimensionsDisabled && state.mode === 'fit' ? (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={state.allowUpscale}
            onChange={e => onChange({ allowUpscale: e.target.checked })}
            className="rounded border-border"
            data-testid="imgutils-resize-allow-upscale"
          />
          Enlarge images that are already smaller
        </label>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Results are stored at up to {MAX_RESIZE_EDGE}px on the long edge, like every image in
        the app.
      </p>

      {error ? (
        <p className="text-xs text-destructive" data-testid="imgutils-resize-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  testId: string
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted/60 p-0.5" data-testid={testId}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            option.value === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid={`${testId}-${option.value}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
