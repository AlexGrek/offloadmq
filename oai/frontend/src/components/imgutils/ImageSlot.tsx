import { useState } from 'react'
import { FolderOpen, ImageUp, Loader2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { cn } from '../../lib/utils'
import type { Slot } from '../../hooks/useImageSlot'

export type ImageSlotProps = {
  label: string
  hint: string
  slot: Slot | null
  testId: string
  /** Tighter padding for the quick-transform popup. */
  compact?: boolean
  onPick: (file: File) => void
  onPickFromLibrary: () => void
  onClear: () => void
}

export function ImageSlot({
  label,
  hint,
  slot,
  testId,
  compact = false,
  onPick,
  onPickFromLibrary,
  onClear,
}: ImageSlotProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files: FileList | null) {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'))
    if (file) onPick(file)
  }

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <Label>{label}</Label>
      {slot ? (
        <div className="flex items-start gap-3">
          <div className="relative w-24">
            <img src={slot.preview} alt="" className="size-24 rounded-lg object-cover" />
            {!slot.uploaded && !slot.error ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : null}
            <button
              type="button"
              className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground"
              onClick={onClear}
              aria-label={`Remove ${label}`}
              data-testid={`${testId}-clear`}
            >
              <X className="size-3" />
            </button>
          </div>
          {slot.error ? (
            <p className="text-xs text-destructive">{slot.error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <label
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 text-muted-foreground transition-colors hover:bg-muted/70',
              compact ? 'px-4 py-4' : 'px-6 py-8',
              dragOver && 'bg-primary/5 ring-2 ring-primary/30',
            )}
            onDragOver={e => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault()
              setDragOver(false)
              handleFiles(e.dataTransfer.files)
            }}
            data-testid={`${testId}-drop-zone`}
          >
            <ImageUp className={cn('text-muted-foreground/60', compact ? 'size-5' : 'size-7')} />
            <span className="text-sm font-medium">Click or drag an image here</span>
            <span className="text-xs">{hint}</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onPickFromLibrary}
            data-testid={`${testId}-pick-library`}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            From library
          </Button>
        </div>
      )}
    </div>
  )
}
