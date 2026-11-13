import type { ReactNode } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { IMAGE_SIZE_PRESETS, rememberImageSize, validImageSize, type ImageSize } from '@/lib/imageSizes'
import { cn } from '@/lib/utils'

/** Orientation is told apart by a faint tint only: square green, portrait blue, landscape orange. */
const ORIENTATIONS = {
  square: 'border-emerald-500/25 bg-emerald-500/10 hover:bg-emerald-500/20 aria-pressed:border-emerald-500/70 aria-pressed:bg-emerald-500/30',
  portrait: 'border-sky-500/25 bg-sky-500/10 hover:bg-sky-500/20 aria-pressed:border-sky-500/70 aria-pressed:bg-sky-500/30',
  landscape: 'border-orange-500/25 bg-orange-500/10 hover:bg-orange-500/20 aria-pressed:border-orange-500/70 aria-pressed:bg-orange-500/30',
} as const
type Orientation = keyof typeof ORIENTATIONS

const orientationOf = (w: number, h: number): Orientation => (w === h ? 'square' : w < h ? 'portrait' : 'landscape')
const ORIENTATION_ORDER: Orientation[] = ['square', 'portrait', 'landscape']
const PRESETS = IMAGE_SIZE_PRESETS
  .map(([w, h]) => ({ w, h, orientation: orientationOf(w, h) }))
  .sort((a, b) => ORIENTATION_ORDER.indexOf(a.orientation) - ORIENTATION_ORDER.indexOf(b.orientation))

interface Props {
  width: number | string
  height: number | string
  onWidthChange: (value: string) => void | ImageSize
  onHeightChange: (value: string) => void | ImageSize
  onChange: (size: ImageSize) => void
  testIdPrefix: string
  presetId?: (w: number, h: number) => string
  widthId?: string
  heightId?: string
  disabled?: boolean
  swapDisabled?: boolean
  min?: number
  max?: number
  children?: ReactNode
  widthLabel?: string
  heightLabel?: string
}

/** Shared output/exact-resize controls. Only deliberate user edits update the global preference. */
export function ImageSizePicker({ width, height, onWidthChange, onHeightChange, onChange,
  testIdPrefix: id, presetId = (w, h) => `${id}-preset-${w}x${h}`,
  widthId = `${id}-width`, heightId = `${id}-height`, disabled, swapDisabled,
  min = 1, max = 8192, children, widthLabel = 'Width', heightLabel = 'Height',
}: Props) {
  const remember = (size: ImageSize) => {
    if (validImageSize(size[0], size[1], max) && size.every(n => n >= min)) rememberImageSize(...size)
  }
  const choose = (size: ImageSize) => { onChange(size); remember(size) }
  return <fieldset disabled={disabled} className="min-w-0 space-y-3" data-testid={`${id}-sizes`}>
    <legend className="sr-only">Image size</legend>
    <div className="flex items-end gap-2">
      <label className="min-w-0 flex-1 space-y-1.5 text-sm" htmlFor={widthId}>{widthLabel}
        <Input id={widthId} type="number" min={min} max={max} value={width} aria-label={widthLabel} data-testid={`${id}-width`} onChange={e => {
          const size = onWidthChange(e.target.value); remember(size ?? [Number(e.target.value), Number(height)])
        }} />
      </label>
      <Button type="button" variant="ghost" className="min-h-11 shrink-0" size="icon" disabled={swapDisabled} aria-label="Swap width and height" data-testid={`${id}-swap-dims`} onClick={() => choose([Number(height), Number(width)])}><ArrowLeftRight className="size-4" /></Button>
      <label className="min-w-0 flex-1 space-y-1.5 text-sm" htmlFor={heightId}>{heightLabel}
        <Input id={heightId} type="number" min={min} max={max} value={height} aria-label={heightLabel} data-testid={`${id}-height`} onChange={e => {
          const size = onHeightChange(e.target.value); remember(size ?? [Number(width), Number(e.target.value)])
        }} />
      </label>
      {children}
    </div>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Size presets">
      {PRESETS.map(({ w, h, orientation }) => {
        const pressed = Number(width) === w && Number(height) === h
        return <button key={`${w}x${h}`} type="button" aria-pressed={pressed} data-orientation={orientation} title={`${w}×${h} · ${orientation}`}
          disabled={w > max || h > max || w < min || h < min} data-testid={presetId(w, h)} onClick={() => choose([w, h])}
          className={cn('h-6 rounded-md border px-1.5 text-[11px] leading-none tabular-nums text-foreground/80 transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 aria-pressed:font-semibold aria-pressed:text-foreground', ORIENTATIONS[orientation])}>{w}×{h}</button>
      })}
    </div>
  </fieldset>
}
