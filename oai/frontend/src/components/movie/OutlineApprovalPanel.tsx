import { useEffect, useState } from 'react'
import { Check, Loader2, RotateCcw } from 'lucide-react'
import { approveMovieJob, type MovieJobView } from '../../api/movie'
import { JobErrorBanner } from '../JobErrorBanner'
import { Button } from '../ui/button'

export interface OutlineApprovalPanelProps {
  job: MovieJobView
  token: string | null
  onApproved: (job: MovieJobView) => void
}

export function OutlineApprovalPanel({ job, token, onApproved }: OutlineApprovalPanelProps) {
  const [lines, setLines] = useState<string[]>(job.outline)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLines(job.outline)
  }, [job.job_id, job.outline])

  function updateLine(index: number, value: string) {
    setLines(prev => prev.map((line, i) => (i === index ? value : line)))
  }

  function resetLines() {
    setLines(job.outline)
  }

  async function approve() {
    if (!token) return
    setApproving(true)
    setError(null)
    try {
      const updated = await approveMovieJob(token, job.job_id, lines)
      onApproved(updated)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setApproving(false)
    }
  }

  const dirty = lines.some((line, i) => line !== job.outline[i])

  return (
    <div
      className="space-y-3 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/8 to-transparent p-3"
      data-testid="movie-outline-approval"
    >
      <div className="space-y-1">
        <h3 className="font-display text-sm font-semibold">Review the outline</h3>
        <p className="text-xs text-muted-foreground">
          Edit each scene before rendering begins, or approve it as written.
        </p>
      </div>
      <div className="space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-2 w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
              {i + 1}.
            </span>
            <textarea
              value={line}
              onChange={e => updateLine(i, e.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              data-testid={`movie-outline-line-${i}`}
            />
          </div>
        ))}
      </div>
      {error && <JobErrorBanner message={error} testId="movie-outline-error" />}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="min-h-10"
          disabled={approving}
          onClick={() => void approve()}
          data-testid="movie-approve-btn"
        >
          {approving ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Check className="mr-1 size-3.5" />
          )}
          Approve
        </Button>
        {dirty && (
          <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={resetLines}>
            <RotateCcw className="mr-1 size-3.5" />
            Reset
          </Button>
        )}
      </div>
    </div>
  )
}
