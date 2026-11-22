import { RefreshCw } from 'lucide-react'
import {
  DEFAULT_SOLID_BACKGROUND,
  HEX_COLOR,
  MAX_BG_PADDING,
  type BgFormat,
  type BgRemoverCapability,
  type BgRemoverOptions,
} from '../../api/bgRemover'
import { modelHint, modelLabel } from '../../lib/bgRemover'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

const FORMATS: { value: BgFormat; label: string; hint: string }[] = [
  { value: 'png', label: 'PNG', hint: 'Lossless, transparent' },
  { value: 'webp', label: 'WebP', hint: 'Smaller, transparent' },
  { value: 'jpeg', label: 'JPEG', hint: 'No transparency' },
]

type Props = {
  capabilities: BgRemoverCapability[]
  loading: boolean
  selectedBase: string | null
  onSelectModel: (base: string) => void
  onRefresh: () => void
  options: BgRemoverOptions
  onChange: (patch: Partial<BgRemoverOptions>) => void
  /** Why the options cannot be submitted, or null. */
  error: string | null
}

/** Model picker + output options. Presentational: the page owns the state and persists it. */
export function BgRemoverControls({
  capabilities,
  loading,
  selectedBase,
  onSelectModel,
  onRefresh,
  options,
  onChange,
  error,
}: Props) {
  const transparent = options.background === 'transparent'
  const lossy = options.format !== 'png'
  const active = capabilities.find(c => c.base === selectedBase) ?? null
  // The native colour input only accepts #rrggbb; fall back while a hex is half-typed.
  const pickerColor = HEX_COLOR.test(options.background) ? options.background : DEFAULT_SOLID_BACKGROUND

  function setFormat(format: BgFormat) {
    // JPEG cannot be transparent — move to a solid colour instead of failing on submit.
    onChange({
      format,
      ...(format === 'jpeg' && transparent ? { background: DEFAULT_SOLID_BACKGROUND } : {}),
    })
  }

  return (
    <div className="space-y-5" data-testid="bgremover-controls">
      <div className="space-y-1.5" data-testid="bgremover-model-picker">
        <div className="flex items-center justify-between gap-2">
          <Label>Model</Label>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
            disabled={loading}
            data-testid="bgremover-refresh-capabilities"
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
        {capabilities.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="bgremover-no-models">
            {loading
              ? 'Checking agents…'
              : 'No background-removal model is online. Install one on an agent (Agents → ONNX → bgremove-birefnet-general → Prepare), then rescan its capabilities.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {capabilities.map(cap => (
                <button
                  key={cap.base}
                  type="button"
                  onClick={() => onSelectModel(cap.base)}
                  className={cn(
                    'rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    cap.base === selectedBase
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted',
                  )}
                  data-testid={`bgremover-model-${cap.model}`}
                >
                  {modelLabel(cap.model)}
                </button>
              ))}
            </div>
            {active ? (
              <p className="text-xs text-muted-foreground">
                {modelHint(active.model)} <code className="text-[11px]">{active.base}</code>
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Format</Label>
        <div className="flex gap-2">
          {FORMATS.map(f => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFormat(f.value)}
              className={cn(
                'min-h-11 flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors sm:flex-none',
                options.format === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted',
              )}
              data-testid={`bgremover-format-${f.value}`}
            >
              <span className="block font-medium">{f.label}</span>
              <span className="block text-[10px] opacity-70">{f.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Background</Label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={options.format === 'jpeg'}
            onClick={() => onChange({ background: 'transparent' })}
            className={cn(
              'min-h-11 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              transparent
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
            )}
            data-testid="bgremover-bg-transparent"
          >
            Transparent
          </button>
          <button
            type="button"
            onClick={() => onChange({ background: transparent ? DEFAULT_SOLID_BACKGROUND : options.background })}
            className={cn(
              'min-h-11 rounded-lg px-3 py-1.5 text-sm transition-colors',
              !transparent
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted',
            )}
            data-testid="bgremover-bg-color"
          >
            Solid colour
          </button>
          {!transparent ? (
            <>
              <input
                type="color"
                value={pickerColor}
                onChange={e => onChange({ background: e.target.value.toUpperCase() })}
                className="h-11 w-12 cursor-pointer rounded-lg bg-muted/60 p-1"
                aria-label="Background colour"
                data-testid="bgremover-bg-picker"
              />
              <Input
                value={options.background}
                onChange={e => onChange({ background: e.target.value.trim().toUpperCase() })}
                maxLength={7}
                spellCheck={false}
                className="w-28 font-mono"
                aria-label="Background colour hex"
                data-testid="bgremover-bg-hex"
              />
            </>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={options.crop}
            onChange={e => onChange({ crop: e.target.checked })}
            className="size-4 accent-primary"
            data-testid="bgremover-crop"
          />
          <span>
            Crop to subject
            <span className="block text-xs text-muted-foreground">
              Trim the image to the subject&apos;s bounding box — handy for sprites.
            </span>
          </span>
        </label>
        {options.crop ? (
          <div className="flex items-center gap-2 pl-7">
            <Label htmlFor="bgremover-padding" className="text-xs text-muted-foreground">
              Padding
            </Label>
            <Input
              id="bgremover-padding"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_BG_PADDING}
              value={options.padding}
              onChange={e => onChange({ padding: Number.parseInt(e.target.value, 10) || 0 })}
              className="w-24"
              data-testid="bgremover-padding"
            />
            <span className="text-xs text-muted-foreground">px</span>
          </div>
        ) : null}
      </div>

      <details className="group" data-testid="bgremover-advanced">
        <summary className="min-h-11 cursor-pointer select-none py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          Advanced
        </summary>
        <div className="space-y-4 pt-1">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={options.refine_foreground}
              onChange={e => onChange({ refine_foreground: e.target.checked })}
              className="size-4 accent-primary"
              data-testid="bgremover-refine"
            />
            <span>
              Clean edge colours
              <span className="block text-xs text-muted-foreground">
                Stops the old background haloing around hair. Turn off to keep the raw input colours.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={options.alpha_threshold != null}
                onChange={e => onChange({ alpha_threshold: e.target.checked ? 0.5 : null })}
                className="size-4 accent-primary"
                data-testid="bgremover-hard-edge"
              />
              <span>
                Hard edges
                <span className="block text-xs text-muted-foreground">
                  Fully opaque or fully transparent pixels — for engines and pixel-art pipelines that
                  cannot blend.
                </span>
              </span>
            </label>
            {options.alpha_threshold != null ? (
              <div className="flex items-center gap-3 pl-7">
                <input
                  type="range"
                  min={0.05}
                  max={0.95}
                  step={0.05}
                  value={options.alpha_threshold}
                  onChange={e => onChange({ alpha_threshold: Number(e.target.value) })}
                  className="flex-1 accent-primary"
                  aria-label="Hard edge cut-off"
                  data-testid="bgremover-threshold"
                />
                <span className="w-10 text-right font-mono text-xs text-muted-foreground">
                  {options.alpha_threshold.toFixed(2)}
                </span>
              </div>
            ) : null}
          </div>

          {lossy ? (
            <div className="flex items-center gap-3">
              <Label htmlFor="bgremover-quality" className="text-sm">
                Quality
              </Label>
              <Input
                id="bgremover-quality"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                placeholder="95"
                value={options.quality ?? ''}
                onChange={e => {
                  const n = Number.parseInt(e.target.value, 10)
                  onChange({ quality: Number.isNaN(n) ? null : n })
                }}
                className="w-24"
                data-testid="bgremover-quality"
              />
            </div>
          ) : null}
        </div>
      </details>

      {error ? (
        <p className="text-sm text-destructive" data-testid="bgremover-options-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
