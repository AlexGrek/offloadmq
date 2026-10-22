import { useEffect, useId, useRef, useState } from 'react'
import type { ImageCycleJob } from '../../api/imageCycles'

/** Fixed 0–100 scale keeps changes comparable as assessments arrive. */
export function QualityAssessmentGraph({ job }: { job: ImageCycleJob }) {
  const id = useId()
  const container = useRef<HTMLElement>(null)
  const [containerWidth, setContainerWidth] = useState(320)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setContainerWidth(entry.contentRect.width),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const assessments = job.steps.flatMap((step) =>
    step.kind === 'describe' && step.quality != null
      ? [{ cycle: step.cycle, quality: step.quality }]
      : [],
  )
  const target = job.params.expected_quality ?? 95
  const latest = assessments.at(-1)?.quality
  const first = assessments[0]?.quality
  const change = latest != null && first != null ? latest - first : null
  const width = Math.max(containerWidth, assessments.length * 52 + 72)
  const left = 36
  const right = width - 24
  const top = 28
  const bottom = 208
  const x = (index: number) =>
    assessments.length <= 1
      ? (left + right) / 2
      : left + (index / (assessments.length - 1)) * (right - left)
  const y = (quality: number) => bottom - (quality / 100) * (bottom - top)

  return (
    <section
      ref={container}
      className="min-w-0 space-y-3"
      aria-labelledby={`${id}-heading`}
      data-testid="improver-quality-graph"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-heading`} className="font-semibold">
          Quality assessments
        </h3>
        <p
          className="text-sm text-muted-foreground"
          data-testid="improver-quality-summary"
        >
          {latest == null
            ? 'Waiting for the first assessment'
            : `Latest: ${latest}/100`}
          {assessments.length > 1 &&
            change != null &&
            ` · ${change > 0 ? '+' : ''}${change} points from start`}
        </p>
      </div>
      {assessments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Scores will appear here as each image is assessed. Target: {target}/100.
        </p>
      ) : (
        <>
          <div className="max-w-full overflow-x-auto rounded-lg bg-muted/20">
            <svg
              viewBox={`0 0 ${width} 248`}
              className="h-56 w-full"
              style={{ minWidth: width }}
              role="img"
              aria-labelledby={`${id}-title`}
              aria-describedby={`${id}-description`}
              data-testid="improver-quality-chart"
            >
              <title id={`${id}-title`}>Quality by assessment, out of 100</title>
              <desc id={`${id}-description`}>
                Target {target}.{' '}
                {assessments
                  .map((point) => `Quality check ${point.cycle}: ${point.quality}`)
                  .join('; ')}.
              </desc>
              {[0, 25, 50, 75, 100].map((score) => (
                <g key={score}>
                  <line
                    x1={left} x2={right} y1={y(score)} y2={y(score)}
                    className="stroke-border"
                  />
                  <text
                    x={left - 8} y={y(score) + 4} textAnchor="end"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {score}
                  </text>
                </g>
              ))}
              <line
                x1={left} x2={right} y1={y(target)} y2={y(target)}
                strokeDasharray="6 4"
                className="stroke-muted-foreground"
                data-testid="improver-quality-target"
              />
              <polyline
                points={assessments
                  .map((point, index) => `${x(index)},${y(point.quality)}`)
                  .join(' ')}
                fill="none" strokeWidth={2.5} strokeLinejoin="round"
                className="stroke-primary"
              />
              {assessments.map((point, index) => (
                <g
                  key={point.cycle}
                  data-testid={`improver-quality-point-${point.cycle}`}
                >
                  <title>Quality check {point.cycle}: {point.quality}/100</title>
                  <circle
                    cx={x(index)} cy={y(point.quality)} r={4}
                    className="fill-primary stroke-background" strokeWidth={2}
                  />
                  <text
                    x={x(index)} y={y(point.quality) - 10} textAnchor="middle"
                    className="fill-foreground text-xs font-medium"
                  >
                    {point.quality}
                  </text>
                  <text
                    x={x(index)} y={bottom + 20} textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {point.cycle}
                  </text>
                </g>
              ))}
              <text
                x={(left + right) / 2} y={244} textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                Quality check
              </text>
            </svg>
          </div>
          <p className="text-xs text-muted-foreground">
            Dashed line: target {target}/100. Each point is a recorded assessment.
          </p>
        </>
      )}
    </section>
  )
}
