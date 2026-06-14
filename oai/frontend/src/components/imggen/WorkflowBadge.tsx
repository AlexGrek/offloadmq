import { ArrowRight, ImageIcon, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImgGenMode } from '@/lib/imggen'

const WORKFLOW_META: Record<
  ImgGenMode,
  { source: 'text' | 'image'; dest: 'image' | 'video'; title: string }
> = {
  txt2img: { source: 'text', dest: 'image', title: 'Text to image' },
  img2img: { source: 'image', dest: 'image', title: 'Image to image' },
  txt2video: { source: 'text', dest: 'video', title: 'Text to video' },
  img2video: { source: 'image', dest: 'video', title: 'Image to video' },
}

function SourceGlyph({ kind }: { kind: 'text' | 'image' }) {
  if (kind === 'text') {
    return (
      <span className="font-mono text-[8px] font-bold leading-none tracking-tight" aria-hidden>
        T
      </span>
    )
  }
  return <ImageIcon className="size-2.5 shrink-0" aria-hidden />
}

function DestGlyph({ kind }: { kind: 'image' | 'video' }) {
  if (kind === 'video') {
    return <Video className="size-2.5 shrink-0" aria-hidden />
  }
  return (
    <span className="font-mono text-[7px] font-bold leading-none tracking-tight" aria-hidden>
      IMG
    </span>
  )
}

/** Compact workflow indicator for pipeline sidebar rows (not raw `txt2img` labels). */
export function WorkflowBadge({
  workflow,
  className,
}: {
  workflow: string
  className?: string
}) {
  const meta = WORKFLOW_META[workflow as ImgGenMode] ?? WORKFLOW_META.txt2img

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded bg-foreground/8 px-1 py-0.5',
        'text-muted-foreground dark:bg-foreground/12',
        className,
      )}
      title={meta.title}
      aria-label={meta.title}
      data-testid={`workflow-badge-${workflow}`}
    >
      <SourceGlyph kind={meta.source} />
      <ArrowRight className="size-2 shrink-0 opacity-60" aria-hidden />
      <DestGlyph kind={meta.dest} />
    </span>
  )
}
