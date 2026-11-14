import { useState } from 'react'
import { FolderOpen, ImageUp, Loader2, Plus, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { cn } from '../../lib/utils'
import type { SetEntry } from '../../hooks/useImageSet'

export type ImageSetSlotProps = {
  label: string
  hint: string
  entries: SetEntry[]
  note?: string | null
  max: number
  testId: string
  onAddFiles: (files: File[]) => void
  onPickFromLibrary: () => void
  onRemove: (key: string) => void
  onClear: () => void
}

/** Multi-image upload area: drop / click / paste (page-level) / library, with a removable
 *  thumbnail per image. Each image becomes its own job on submit. */
export function ImageSetSlot({
  label,
  hint,
  entries,
  note,
  max,
  testId,
  onAddFiles,
  onPickFromLibrary,
  onRemove,
  onClear,
}: ImageSetSlotProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files: FileList | null) {
    const images = Array.from(files ?? []).filter(f => f.type.startsWith('image/'))
    if (images.length > 0) onAddFiles(images)
  }

  const fileInput = (
    <input
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={e => {
        handleFiles(e.target.files)
        e.target.value = ''
      }}
      data-testid={`${testId}-file-input`}
    />
  )

  return (
    <div
      className="space-y-1.5"
      data-testid={testId}
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
    >
      <Label>
        {label}
        {entries.length > 1 ? ` (${entries.length}) · one job per image` : ''}
      </Label>

      {entries.length === 0 ? (
        <div className="space-y-2">
          <label
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-muted/50 px-6 py-8 text-muted-foreground transition-colors hover:bg-muted/70',
              dragOver && 'bg-primary/5 ring-2 ring-primary/30',
            )}
            data-testid={`${testId}-drop-zone`}
          >
            <ImageUp className="size-7 text-muted-foreground/60" />
            <span className="text-sm font-medium">Click, drag or paste images here</span>
            <span className="text-xs">{hint}</span>
            {fileInput}
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
      ) : (
        <div className={cn('space-y-2 rounded-xl p-1 transition-colors', dragOver && 'bg-primary/5 ring-2 ring-primary/30')}>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5" data-testid={`${testId}-grid`}>
            {entries.map(entry => (
              <div
                key={entry.key}
                className={cn(
                  'relative aspect-square overflow-hidden rounded-lg bg-muted/30',
                  entry.error && 'ring-2 ring-destructive',
                )}
                title={entry.error ?? entry.uploaded?.filename}
                data-testid={`${testId}-thumb`}
              >
                <img src={entry.preview} alt="" className="size-full object-cover" />
                {!entry.uploaded && !entry.error ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                ) : null}
                {entry.error ? (
                  <p className="absolute inset-x-0 bottom-0 line-clamp-2 bg-destructive/90 px-1 py-0.5 text-[10px] leading-tight text-destructive-foreground">
                    {entry.error}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="absolute right-1 top-1 rounded-md bg-background/80 p-1 text-foreground backdrop-blur transition-colors hover:bg-background"
                  onClick={() => onRemove(entry.key)}
                  aria-label={`Remove ${entry.uploaded?.filename ?? 'image'}`}
                  data-testid={`${testId}-remove`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entries.length < max ? (
              <>
                <label className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1 text-xs font-medium transition-colors hover:bg-muted/50">
                  <Plus className="size-3.5" />
                  Add
                  {fileInput}
                </label>
                <Button type="button" variant="outline" size="sm" onClick={onPickFromLibrary} data-testid={`${testId}-pick-library`}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  From library
                </Button>
              </>
            ) : null}
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={onClear}
              data-testid={`${testId}-clear`}
            >
              Clear all
            </button>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </div>
        </div>
      )}
      {note ? <p className="text-xs text-muted-foreground" data-testid={`${testId}-note`}>{note}</p> : null}
    </div>
  )
}
