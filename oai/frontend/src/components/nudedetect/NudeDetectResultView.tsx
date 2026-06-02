import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { NudeDetectImageResult } from '@/api/nudeDetect'
import {
  hasExposedDetections,
  nudeLabelBgColor,
  nudeLabelShort,
  resultBorderClass,
} from '@/lib/nudeDetectLabels'
import { cn } from '@/lib/utils'

interface NudeDetectResultViewProps {
  imageResult: NudeDetectImageResult
  previewUrl?: string | null
  filename?: string
  className?: string
}

export function NudeDetectResultView({
  imageResult,
  previewUrl,
  filename,
  className,
}: NudeDetectResultViewProps) {
  const [expanded, setExpanded] = useState(false)
  const displayName = filename ?? imageResult.file
  const border = resultBorderClass(
    imageResult.error,
    imageResult.detection_count,
    imageResult.detections,
  )

  return (
    <section
      className={cn(
        'rounded-lg border border-border border-l-[3px] bg-muted/30 p-3',
        border,
        className,
      )}
      data-testid="nudedetect-result-card"
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => imageResult.detection_count > 0 && setExpanded(v => !v)}
        disabled={imageResult.detection_count === 0}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className="size-12 shrink-0 rounded-md object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="text-xs text-muted-foreground">
            {imageResult.error ? (
              <span className="text-destructive">{imageResult.error}</span>
            ) : (
              `${imageResult.detection_count} detection${imageResult.detection_count !== 1 ? 's' : ''}`
            )}
          </p>
        </div>
        {imageResult.detection_count > 0 ? (
          expanded ? (
            <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )
        ) : null}
      </button>

      {imageResult.detections.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {imageResult.detections.map((d, i) => (
            <span
              key={`${d.label}-${i}`}
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                nudeLabelBgColor(d.label),
              )}
            >
              {nudeLabelShort(d.label)} ({Math.round(d.confidence * 100)}%)
            </span>
          ))}
        </div>
      ) : null}

      {expanded && imageResult.detections.length > 0 ? (
        <div className="mt-2 max-h-48 overflow-y-auto overscroll-contain rounded-md bg-background/60 p-2 font-mono text-[11px]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1">Label</th>
                <th className="px-2 py-1">Conf.</th>
                <th className="px-2 py-1">Box</th>
              </tr>
            </thead>
            <tbody>
              {imageResult.detections.map((d, i) => (
                <tr key={i}>
                  <td className={cn('px-2 py-1', nudeLabelBgColor(d.label))}>
                    {d.label}
                  </td>
                  <td className="px-2 py-1">{(d.confidence * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {d.box.x1},{d.box.y1} → {d.box.x2},{d.box.y2}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {hasExposedDetections(imageResult.detections) ? (
        <p className="mt-2 text-xs font-medium text-red-500">Exposed content detected</p>
      ) : null}
    </section>
  )
}

interface NudeDetectResultsListProps {
  results: NudeDetectImageResult[]
  previewUrl?: string | null
  className?: string
}

export function NudeDetectResultsList({
  results,
  previewUrl,
  className,
}: NudeDetectResultsListProps) {
  return (
    <div className={cn('space-y-2', className)} data-testid="nudedetect-results-list">
      {results.map((r, idx) => (
        <NudeDetectResultView
          key={`${r.file}-${idx}`}
          imageResult={r}
          previewUrl={previewUrl}
        />
      ))}
    </div>
  )
}
