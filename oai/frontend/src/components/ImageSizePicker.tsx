import type { ReactNode } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { IMAGE_SIZE_PRESETS, rememberImageSize, validImageSize, type ImageSize } from '@/lib/imageSizes'
import { cn } from '@/lib/utils'

const GROUPS = [
  { label: 'Square', color: 'border-violet-500', match: (w: number, h: number) => w === h },
  { label: 'Portrait', color: 'border-rose-500', match: (w: number, h: number) => w < h },
  { label: 'Landscape', color: 'border-cyan-500', match: (w: number, h: number) => w > h },
]

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
    {GROUPS.map(group => {
      const sizes = IMAGE_SIZE_PRESETS.filter(([w, h]) => group.match(w, h))
      if (!sizes.length) return null
      return <div key={group.label} role="group" aria-label={group.label} className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{group.label}</p>
        <div className="flex flex-wrap gap-1.5">{sizes.map(([w, h]) => <button key={`${w}x${h}`} type="button" aria-pressed={Number(width) === w && Number(height) === h} disabled={w > max || h > max || w < min || h < min} data-testid={presetId(w, h)} onClick={() => choose([w, h])} className={cn('min-h-11 rounded-md border-2 px-2 text-xs tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40', group.color, Number(width) === w && Number(height) === h ? 'bg-foreground text-background' : 'bg-background hover:bg-muted')}>{w}×{h}</button>)}</div>
      </div>
    })}
  </fieldset>
}
